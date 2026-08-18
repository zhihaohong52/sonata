import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from 'node:net';
import { spawn } from 'node:child_process';
import type { HarnessAdapter, HarnessProblem, LaunchPlan, PlanInput } from './types.js';
import type { ModelRef } from '../types.js';
import { isReadOnlyRole } from '../config.js';

const run = promisify(execFile);

/**
 * Codex model discovery.
 *
 * Codex has no `models` subcommand, which is why its models were hand-written
 * into sonata.toml. It does have `codex app-server`, a JSON-RPC service whose
 * `model/list` method returns the catalogue the picker needs. The protocol is
 * not guesswork: `codex app-server generate-json-schema` emits it, and the
 * response captured from a real call is in
 * `tests/fixtures/codex/model-list.json`.
 *
 * Unlike opencode and pi, codex has no provider dimension — ids are bare
 * (`gpt-5.6-sol`), which `parseConfig` enforces. `provider` is set to `codex`
 * for grouping in the picker only; `ref` stays bare so the config key comes
 * out as `codex-gpt-5.6-sol`.
 */
export function parseCodexModels(stdout: string): ModelRef[] {
  let parsed: any;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }

  // Accept either the whole JSON-RPC response or the result object alone.
  const data = parsed?.result?.data ?? parsed?.data;
  if (!Array.isArray(data)) return [];

  const out: ModelRef[] = [];
  for (const m of data) {
    // `hidden` marks models the picker is meant not to offer (internal or
    // review-only entries). A missing id is not a model.
    if (m === null || typeof m !== 'object') continue;
    if (typeof m.id !== 'string' || m.id.length === 0) continue;
    if (m.hidden === true) continue;
    out.push({
      harness: 'codex',
      provider: 'codex',
      id: m.id,
      ref: m.id,
      name: typeof m.displayName === 'string' ? m.displayName : undefined,
    });
  }
  return out;
}

/**
 * Asks a short-lived `codex app-server` for its catalogue.
 *
 * The server speaks newline-delimited JSON-RPC and requires `initialize`
 * before any other method. Everything is bounded by a timeout and the child is
 * always killed: `sonata doctor` must never hang on a harness.
 */
export function codexModelList(timeoutMs = 15_000): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }

    let buf = '';
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);
    child.on('error', () => finish(null));
    child.on('exit', () => finish(null));

    child.stdout?.on('data', (d: Buffer) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim().length === 0) continue;
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg?.id === 1) {
          child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'model/list', params: {} })}\n`);
        } else if (msg?.id === 2) {
          finish(line);
        }
      }
    });

    child.stdin?.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'sonata', version: '0.0.1', title: 'sonata' } },
    })}\n`);
  });
}

/**
 * Codex CLI adapter.
 *
 * Codex maps onto sonata's permission modes more directly than OpenCode does,
 * because `codex exec` takes an explicit sandbox policy. It also writes its
 * final message to a file on request, which gives sonata a harness-guaranteed
 * report instead of relying on the model to write one.
 *
 * `codex exec` is strictly non-interactive and cannot raise an approval prompt,
 * so `default` mode uses the interactive TUI with `approval_policy=on-request`
 * — otherwise a sonata agent in `default` mode would be able to write without
 * ever asking, which is more permissive than the session that spawned it.
 */

/**
 * Every pattern here was written from real captured codex output, which lives
 * in tests/fixtures/panes/. The previous set was written from imagination and
 * matched none of what codex actually prints: a run waiting for approval was
 * reported as STALLED rather than PAUSED.
 *
 * Deliberately absent are loose patterns like /approve.*\?/ — codex relays the
 * model's own prose to the pane, and a model that writes "shall I approve the
 * PR?" would otherwise park the run in a PAUSED state nobody can clear.
 */
const PROMPT_PATTERNS: RegExp[] = [
  // Codex phrases every approval this way: "Would you like to run the
  // following command?", and the same shape for other escalations.
  /^\s*would you like to .*\?\s*$/i,
  // The footer under any codex selection list.
  /press enter to confirm/i,
  // Shown on first entry to a directory codex has not been trusted in. Not an
  // approval of the model's work — the run has not started yet.
  /do you trust the contents of this directory\?/i,
];

/** Longest prompt block worth relaying; codex lists are far shorter than this. */
const MAX_PROMPT_LINES = 14;

/** `codex exec -s <mode>`; `default` is handled separately via the TUI. */
function sandboxFor(mode: PlanInput['mode']): string {
  switch (mode) {
    case 'plan':
      return 'read-only';
    case 'acceptEdits':
      return 'workspace-write';
    case 'bypassPermissions':
      return 'danger-full-access';
    default:
      return 'read-only';
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function buildScript(input: PlanInput): LaunchPlan {
  // A read-only role must never be able to write, whatever the permission mode
  // says: force the read-only sandbox and the non-interactive `codex exec`,
  // which never raises an approval prompt.
  const readOnly = isReadOnlyRole(input.role);
  const interactive = input.mode === 'default' && !readOnly;
  const lastMessage = `${input.runDir}/last-message.txt`;
  const message = 'Follow the instructions in the attached file.';

  // The instructions path is given in the prompt rather than piped, so stdin
  // stays free and the prompt survives the harness's own formatting.
  const prompt = `${message}\n\nInstructions file: ${input.instructionsPath}`;

  // `--skip-git-repo-check` is accepted by `codex exec` only; passing it to the
  // interactive TUI is a hard argument error. Keep it out of the shared flags.
  const common = [`-m ${shellQuote(input.modelId)}`];

  let invocation: string;
  if (interactive) {
    // The user's config may set approval_policy=never globally; override it so
    // approvals actually surface and sonata's watcher can escalate them.
    invocation = [
      'codex',
      ...common,
      '-c approval_policy="on-request"',
      '-s workspace-write',
      shellQuote(prompt),
    ].join(' ');
  } else {
    invocation = [
      'codex exec',
      ...common,
      '--skip-git-repo-check',
      '-c approval_policy="never"',
      `-s ${readOnly ? 'read-only' : sandboxFor(input.mode)}`,
      `-o ${shellQuote(lastMessage)}`,
      shellQuote(prompt),
    ].join(' ');
  }

  const script = interactive ? interactiveScript(input, invocation) : [
    '#!/bin/bash',
    'set -o pipefail',
    `cd ${shellQuote(input.cwd)} || exit 97`,
    `${invocation} 2>&1 | tee -a ${shellQuote(`${input.runDir}/harness.log`)}`,
    `echo $? > ${shellQuote(`${input.runDir}/exit`)}`,
    '',
  ].join('\n');

  // Read-only roles and plan mode both invoke Codex with a read-only sandbox,
  // so the model cannot write report.md. Default-mode code runs use the
  // interactive workspace-write TUI instead of sandboxFor() and can write it.
  const canWriteReport = interactive || (!readOnly && sandboxFor(input.mode) !== 'read-only');
  return { script, interactive, canWriteReport };
}

/** `default` mode needs Codex's interactive TUI to surface approvals. */
function interactiveScript(input: PlanInput, invocation: string): string {
  const reportPath = `${input.runDir}/report.md`;
  const exitPath = `${input.runDir}/exit`;

  return [
    '#!/bin/bash',
    'set -o pipefail',
    `cd ${shellQuote(input.cwd)} || exit 97`,
    `SESSION="$(tmux display-message -p '#S')"`,
    '(',
    // The report is the harness's own "task over" signal. Until it lands, the
    // model may still be working or waiting on an approval.
    `  while [ ! -f ${shellQuote(reportPath)} ]; do sleep 2; done`,
    // See reasonix's interactiveScript for why the composer is cleared before
    // each quit attempt and why the exit sentinel acknowledges the quit.
    '  for _ in $(seq 1 20); do',
    `    [ -f ${shellQuote(exitPath)} ] && break`,
    '    tmux send-keys -t "$SESSION" C-u',
    '    tmux send-keys -t "$SESSION" C-d',
    '    sleep 3',
    '  done',
    ') >/dev/null 2>&1 &',
    // Codex refuses a TUI whose stdout is redirected: "Error: stdout is not a terminal".
    invocation,
    `echo $? > ${shellQuote(exitPath)}`,
    '',
  ].join('\n');
}

/** Base URL codex is configured to talk to, if it overrides the default. */
export function configuredBaseUrl(configText: string): string | null {
  const m = configText.match(/^\s*openai_base_url\s*=\s*"([^"]+)"/m);
  return m ? m[1] : null;
}

/**
 * Whether codex has been granted trust for a directory. On first entry to an
 * unseen directory the TUI blocks on "Do you trust the contents of this
 * directory?" before running anything, which strands a `default`-mode run at a
 * prompt that has nothing to do with the task.
 */
export function projectTrusted(configText: string, cwd: string): boolean {
  const section = new RegExp(
    `^\\s*\\[projects\\.(?:"${cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}")\\]\\s*$`,
    'm',
  );
  const m = configText.match(section);
  if (!m) return false;
  const rest = configText.slice(m.index! + m[0].length);
  // Only the keys belonging to this section, i.e. up to the next section head.
  const body = rest.split(/^\s*\[/m)[0];
  return /^\s*trust_level\s*=\s*"trusted"/m.test(body);
}

/** Resolves once we know whether something is accepting connections. */
function portOpen(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function codexHealth(env: { home: string; cwd: string }): Promise<HarnessProblem[]> {
  const problems: HarnessProblem[] = [];

  try {
    // Hard timeout: `codex login status` can block indefinitely when the
    // configured endpoint is unreachable, and doctor must never hang.
    // `codex login status` reports on stderr, not stdout — checking only
    // stdout produces a false "not logged in".
    const { stdout, stderr } = await run('codex', ['login', 'status'], { timeout: 5_000 });
    if (!/logged in/i.test(`${stdout}${stderr}`)) {
      problems.push({
        severity: 'error',
        message: 'codex is not logged in',
        fix: 'codex login',
      });
    }
  } catch {
    problems.push({
      severity: 'error',
      message: 'codex login status failed or timed out — the token may need refreshing',
      fix: 'codex logout && codex login',
    });
  }

  // A custom base URL means codex depends on something local being up. A run
  // against a dead proxy burns minutes retrying before failing, so check first.
  const configPath = join(env.home, '.codex', 'config.toml');
  const configText = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  const baseUrl = configText ? configuredBaseUrl(configText) : null;

  if (!projectTrusted(configText, env.cwd)) {
    problems.push({
      severity: 'warn',
      message: `codex has not been granted trust for ${env.cwd}, so a default-mode run will block on its trust prompt`,
      fix: `run \`codex\` once in ${env.cwd} and answer "Yes, continue"`,
    });
  }

  if (baseUrl) {
    try {
      const url = new URL(baseUrl);
      const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
      if (!(await portOpen(url.hostname, port))) {
        problems.push({
          severity: 'error',
          message: `codex is configured to use ${baseUrl}, but nothing is listening there`,
          fix: 'Start the proxy (e.g. `headroom proxy`), or remove openai_base_url from ~/.codex/config.toml',
        });
      }
    } catch {
      problems.push({
        severity: 'warn',
        message: `codex has an unparseable openai_base_url: ${baseUrl}`,
      });
    }
  }

  return problems;
}

export const codexAdapter: HarnessAdapter = {
  name: 'codex',
  versionCommand: ['codex', '--version'],
  supportedVersions: '>=0.140.0 <1.0.0',
  pathPrepend: [],
  plan: buildScript,
  canPromptForApproval: true,
  promptPatterns: PROMPT_PATTERNS,
  /**
   * Returns the whole prompt block, not just the line that matched. A codex
   * approval spans several lines — the question, the command, and the numbered
   * options — and the matched line alone ("Would you like to run the following
   * command?") omits the one thing the caller needs to decide: the command.
   */
  describePrompt(lines: string[]): string | null {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!PROMPT_PATTERNS.some((re) => re.test(lines[i]))) continue;
      // The match may land on the footer below the question, so walk back up
      // over the option list to the question that introduced it.
      let start = i;
      while (start > 0 && start > i - MAX_PROMPT_LINES && !/^\s*would you like to |do you trust the contents/i.test(lines[start])) {
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
   * `y` is the accelerator codex prints beside "Yes, proceed"; it acts at once,
   * so no Enter follows — a trailing Enter would fall through to the composer.
   * Verified against a live TUI to clear the directory-trust prompt too, whose
   * options are numbered and print no `y`. There is no `n` accelerator: the
   * deny path is esc.
   */
  approveKeys: { yes: ['y'], no: ['Escape'] },
  /**
   * Codex writes its final message here via `-o`. Used when the model did not
   * write a report of its own, which is far better than scraping the pane.
   */
  fallbackReportFile: 'last-message.txt',
  health: codexHealth,
};
