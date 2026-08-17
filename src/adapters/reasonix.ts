import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HarnessAdapter, HarnessProblem, LaunchPlan, PlanInput } from './types.js';
import type { ModelRef } from '../types.js';
import { isReadOnlyRole } from '../config.js';

const run = promisify(execFile);

/**
 * Reasonix adapter.
 *
 * Reasonix is the second harness after codex that can genuinely ask a human for
 * approval, so it is the second that can honour `default` mode instead of
 * refusing it. Everything below was probed against reasonix v1.26.0; the
 * captured panes are in tests/fixtures/panes/reasonix-*.txt.
 *
 * The mode mapping is not the obvious one:
 *
 * - `plan` is REFUSED by `reasonix run` — "--permission-mode plan requires an
 *   interactive session", exit 2. Read-only work therefore uses `dontAsk`,
 *   which denies without prompting, rather than plan mode.
 * - `dontAsk` is real enforcement. Probed: a run asked to read a file and then
 *   write one read it fine and was refused both the write tool AND the shell
 *   fallback (`printf … > report.md`), reporting "denied by permission policy".
 *   It cannot write report.md either, hence `canWriteReport: false`.
 * - `acceptEdits` and `bypassPermissions` write unprompted, probed both ways.
 * - `-y` / `--auto` is NOT used anywhere here. It is an alias for reasonix's
 *   own `auto` mode, which is wider than Claude Code's `auto` — it skips
 *   risk-based prompts for things like `git push`. Since sonata maps Claude's
 *   `auto` onto `acceptEdits`, reaching for the similarly named flag would
 *   silently widen permissions. Always pass `--permission-mode` explicitly.
 */

/**
 * Written from real captured output, never from the docs. Three shapes block a
 * run, and the third is the one that would otherwise be missed: the model
 * asking the *user* a question stops a dispatch just as hard as an approval.
 *
 * Deliberately narrow. Reasonix relays the model's own prose into the pane, so
 * a loose /allow|deny/ would park a run in PAUSED over a sentence the model
 * merely wrote.
 */
const PROMPT_PATTERNS: RegExp[] = [
  // The tool approval card: "Will call tool write file report.md."
  /^\s*will call tool\b/i,
  // Every reasonix selection list prints this footer, and only when waiting.
  /↑\/↓\s*navigate\s*·\s*enter select/i,
  // The plan-confirmation prompt. The adapter never selects plan mode, but a
  // user attached to the pane can switch into it with Shift+Tab, and a run
  // parked here is stalled until somebody answers.
  /^\s*⏸\s*plan ready above/i,
  // The model asking the user a multi-select question mid-run.
  /↑\/↓\s*move\s*·\s*number to pick/i,
];

/** Longest prompt block worth relaying; reasonix's lists are far shorter. */
const MAX_PROMPT_LINES = 14;

/** Line that introduces a block, used to walk back up from a matched footer. */
const PROMPT_HEAD = /^\s*(will call tool\b|⏸\s*plan ready above)/i;

/**
 * The pane text reasonix prints only when it is idle and ready for input.
 *
 * Used by the interactive launch script to know when the composer exists.
 * Matching the composer glyph instead would fire on any selection list, which
 * also draws `❯`.
 */
const READY_MARKER = 'Shift+Tab ask/auto/plan';

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * `reasonix run --permission-mode <x>`, for everything except `default`.
 *
 * Read-only roles pin `dontAsk` whatever the session mode says, so a review or
 * explore dispatch can never write even under bypassPermissions.
 */
function permissionModeFor(input: PlanInput, readOnly: boolean): string {
  if (readOnly) return 'dontAsk';
  switch (input.mode) {
    case 'acceptEdits':
      return 'acceptEdits';
    case 'bypassPermissions':
      return 'bypassPermissions';
    default:
      // `plan` never reaches here — it is read-only, so it took the branch
      // above. Anything unrecognised fails closed.
      return 'dontAsk';
  }
}

function buildScript(input: PlanInput): LaunchPlan {
  // A read-only role must never be able to write, whatever the session mode
  // says. `plan` mode is read-only for every role.
  const readOnly = isReadOnlyRole(input.role) || input.mode === 'plan';
  const interactive = input.mode === 'default' && !readOnly;

  const script = interactive ? interactiveScript(input) : headlessScript(input, readOnly);

  // Under `dontAsk` the model is refused the write tool and the shell fallback
  // alike, so it cannot write report.md. Nothing went wrong; sonata takes the
  // terminal output as the report and must not mark such a run degraded.
  return { script, interactive, canWriteReport: !readOnly };
}

function headlessScript(input: PlanInput, readOnly: boolean): string {
  // The instructions path is given in the prompt rather than piped, so stdin
  // stays free and the prompt survives the harness's own formatting.
  const prompt = 'Follow the instructions in the attached file.\n\n' +
    `Instructions file: ${input.instructionsPath}`;

  // `--output-format text` rather than json: the pane is what `tmux attach` and
  // sonata's progress diffing both read, and json collapses a whole run into a
  // single unreadable line at the end. The final message is the last thing
  // printed either way.
  const flags = [
    'run',
    `--dir ${shellQuote(input.cwd)}`,
    `--model ${shellQuote(input.modelId)}`,
    `--permission-mode ${permissionModeFor(input, readOnly)}`,
    '--output-format text',
  ];

  return [
    '#!/bin/bash',
    'set -o pipefail',
    `cd ${shellQuote(input.cwd)} || exit 97`,
    `reasonix ${flags.join(' ')} ${shellQuote(prompt)} 2>&1 | tee -a ${shellQuote(`${input.runDir}/harness.log`)}`,
    `echo $? > ${shellQuote(`${input.runDir}/exit`)}`,
    '',
  ].join('\n');
}

/**
 * `default` mode: the interactive TUI, which is the only way reasonix will ask
 * before acting.
 *
 * Two things make this script unlike every other adapter's.
 *
 * First, the TUI ignores positional task text — probed, the composer comes up
 * empty — so the task has to be typed in. The script addresses its own tmux
 * session (`display-message -p '#S'` resolves from inside the pane) and types
 * the prompt once the composer exists. It polls for the ready marker rather
 * than sleeping a fixed interval, because model and machine both move the
 * startup time around.
 *
 * Second, there is no `tee`. Probed: piping the TUI's stdout leaves the pane
 * completely blank — the renderer needs a terminal. A log file is not worth a
 * run nobody can see or answer, and nothing reads harness.log as the report.
 *
 * Third, the TUI is a chat session: it does not exit when the task is done, it
 * waits for the next message. Left alone it never writes the exit sentinel, so
 * a finished run sits at PROGRESS until the stall timeout and is then killed
 * and reported degraded — with its report sitting right there. The same
 * watcher therefore quits the TUI once the report appears, which is the
 * harness's own signal that the task is over.
 */
function interactiveScript(input: PlanInput): string {
  // Single line: send-keys types this literally, so an embedded newline would
  // submit the message halfway through.
  const prompt = `Follow the instructions in the attached file: ${input.instructionsPath}`;
  const reportPath = `${input.runDir}/report.md`;
  const exitPath = `${input.runDir}/exit`;

  const flags = [
    `--dir ${shellQuote(input.cwd)}`,
    `--model ${shellQuote(input.modelId)}`,
    // Explicit, because the user's own config may default to another mode.
    '--permission-mode ask',
  ];

  return [
    '#!/bin/bash',
    'set -o pipefail',
    `cd ${shellQuote(input.cwd)} || exit 97`,
    `SESSION="$(tmux display-message -p '#S')"`,
    '(',
    // 60 seconds of half-second polls. If the TUI never becomes ready the
    // prompt is simply never typed, and the run stalls visibly rather than
    // typing a task into whatever is on screen instead.
    '  for _ in $(seq 1 120); do',
    `    tmux capture-pane -p -t "$SESSION" | grep -qF ${shellQuote(READY_MARKER)} && break`,
    '    sleep 0.5',
    '  done',
    `  tmux send-keys -t "$SESSION" -l ${shellQuote(prompt)}`,
    // Enter is sent separately: -l types literally, and the composer needs a
    // beat to register the text before it will submit it.
    '  sleep 1',
    '  tmux send-keys -t "$SESSION" Enter',
    // The report is the harness's own "task over" signal. Until it lands, the
    // model may still be working or waiting on an approval, and quitting would
    // throw the run away. If it never lands, this waits forever and the
    // watchdog ends the run — the same outcome as any harness that hangs.
    `  while [ ! -f ${shellQuote(reportPath)} ]; do sleep 2; done`,
    // Ctrl-D, never the documented `exit` + Enter. Typing blind into a TUI
    // races with it: if a selection list happens to be open, the letters are
    // swallowed by the list and the Enter picks whatever row is highlighted.
    // Observed — a run typed `exit` into an approval card and carried on.
    // Ctrl-D cannot select anything, so at worst it is ignored and retried.
    //
    // The exit sentinel is the acknowledgement: it is written the moment
    // reasonix returns, so it doubles as "the quit landed".
    '  for _ in $(seq 1 20); do',
    `    [ -f ${shellQuote(exitPath)} ] && break`,
    '    tmux send-keys -t "$SESSION" C-d',
    '    sleep 3',
    '  done',
    ') >/dev/null 2>&1 &',
    `reasonix ${flags.join(' ')}`,
    `echo $? > ${shellQuote(`${input.runDir}/exit`)}`,
    '',
  ].join('\n');
}

/**
 * Parses `reasonix doctor --json` into refs.
 *
 * Reasonix's `--model` takes `<provider>` or `<provider>/<model>`, and a
 * provider can serve many models — the probe machine had one serving twelve —
 * so the qualified form is what sonata stores. That makes reasonix
 * opencode-shaped rather than codex-shaped, which `parseConfig` enforces.
 *
 * Read `models[]`, never the singular `model`: that key is absent entirely from
 * a provider entry that serves more than one model, so keying off it would drop
 * every multi-model provider and keep only the single-model ones.
 */
export function parseReasonixRefs(stdout: string): ModelRef[] {
  let parsed: any;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }

  const providers = parsed?.providers;
  if (!Array.isArray(providers)) return [];

  const out: ModelRef[] = [];
  for (const p of providers) {
    if (p === null || typeof p !== 'object') continue;
    if (typeof p.name !== 'string' || p.name.length === 0) continue;
    // A provider whose key is missing cannot run anything. Offering it would
    // put a model in the picker that fails on first dispatch.
    if (p.key_present !== true) continue;
    const models = Array.isArray(p.models) ? p.models : [];
    for (const id of models) {
      if (typeof id !== 'string' || id.length === 0) continue;
      out.push({
        harness: 'reasonix',
        provider: p.name,
        id,
        ref: `${p.name}/${id}`,
      });
    }
  }
  return out;
}

/** Asks reasonix for its own diagnostics, bounded so doctor never hangs. */
export async function reasonixDoctorJson(timeoutMs = 10_000): Promise<string | null> {
  try {
    const { stdout } = await run('reasonix', ['doctor', '--json'], { timeout: timeoutMs });
    return stdout;
  } catch {
    return null;
  }
}

const NO_PROVIDER: HarnessProblem = {
  severity: 'error',
  message: 'reasonix has no provider with a usable API key',
  fix: 'reasonix setup',
};

/**
 * Whether the telemetry consent question has been answered.
 *
 * On a machine that has never answered it, the very first invocation blocks on
 * "Allow anonymous CLI usage statistics? [Y/n]:" before the agent starts at
 * all — so an unattended dispatch hangs there forever, which looks exactly like
 * a model that never said anything. Probed on a fresh install.
 */
export function telemetryAnswered(configText: string): boolean {
  return /^\s*cli_metrics\s*=/m.test(configText);
}

async function reasonixHealth(env: { home: string; cwd: string }): Promise<HarnessProblem[]> {
  const problems: HarnessProblem[] = [];

  const configPath = join(env.home, '.reasonix', 'config.toml');
  const configText = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  if (!telemetryAnswered(configText)) {
    problems.push({
      severity: 'error',
      message: 'reasonix has not been told whether it may send usage statistics, so its first run will block on that question before starting',
      fix: 'reasonix config telemetry off',
    });
  }

  const json = await reasonixDoctorJson();
  if (json === null) {
    problems.push({
      severity: 'error',
      message: 'reasonix doctor failed or timed out',
      fix: 'reasonix doctor',
    });
    return problems;
  }
  if (parseReasonixRefs(json).length === 0) problems.push(NO_PROVIDER);

  // Reasonix loads the working directory's .mcp.json on top of its own config.
  // In this repository that hands a foreign model sonata's own run/tail/approve
  // tools, so a dispatched model can dispatch further models. Probed: `doctor`
  // in /tmp lists no plugins; the same command here lists `sonata`.
  if (existsSync(join(env.cwd, '.mcp.json'))) {
    problems.push({
      severity: 'warn',
      message: `reasonix will load the MCP servers in ${join(env.cwd, '.mcp.json')} — a dispatched model gets those tools too`,
      fix: 'Check what they expose. If one of them is sonata itself, a run can dispatch further runs.',
    });
  }

  return problems;
}

export const reasonixAdapter: HarnessAdapter = {
  name: 'reasonix',
  versionCommand: ['reasonix', '--version'],
  supportedVersions: '>=1.26.0 <2.0.0',
  pathPrepend: [],
  plan: buildScript,
  canPromptForApproval: true,
  promptPatterns: PROMPT_PATTERNS,
  /**
   * Returns the whole block rather than the matched line. The line that matches
   * is often the footer, and "↑/↓ navigate · Enter select" tells the caller
   * nothing about what it is being asked to allow.
   */
  describePrompt(lines: string[]): string | null {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!PROMPT_PATTERNS.some((re) => re.test(lines[i]))) continue;
      let start = i;
      while (start > 0 && start > i - MAX_PROMPT_LINES && !PROMPT_HEAD.test(lines[start])) {
        start--;
      }
      const block = lines
        .slice(start, start + MAX_PROMPT_LINES)
        .map((l) => l.trimEnd())
        .filter((l) => l.length > 0);
      return block.length > 0 ? block.join('\n') : lines[i].trim();
    }
    return null;
  },
  /**
   * `1` is "Allow once" on the tool approval card, and the digits on that card
   * act immediately — no trailing Enter, which would fall through to the
   * composer and submit an empty message.
   *
   * `Escape` rather than `4` for deny, even though `4` is the Deny row and was
   * probed to work. Escape is the documented deny key on the approval card
   * ("n/Esc deny") AND the only key that behaves correctly on the plan
   * confirmation prompt: there, selecting the third option records
   * `revise_plan` and silently flips the session from Plan to Auto, whether it
   * is chosen by digit or by arrow keys. One key that is right everywhere beats
   * two that are right in one place each.
   */
  approveKeys: { yes: ['1'], no: ['Escape'] },
  health: reasonixHealth,
};
