import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { HarnessAdapter, HarnessProblem, LaunchPlan, PlanInput } from './types.js';
import type { ModelRef } from '../types.js';
import { isReadOnlyRole } from '../config.js';

const run = promisify(execFile);

/**
 * Pi adapter.
 *
 * Pi "intentionally does not include built-in MCP, sub-agents, permission
 * popups, plan mode, to-dos, or background bash" — there are no approval
 * prompts and no sandbox to lean on. A write-capable role therefore runs with
 * all of pi's built-in tools or not at all, and sonata must map `default` mode
 * the same way it does for opencode: refuse rather than run ungated.
 *
 * `--mode json` emits a working NDJSON event stream, which would give sonata
 * machine-readable output, but text mode keeps `tmux attach` readable — so
 * sonata sticks with `-p`. JSON mode remains a seam for future work.
 */

/**
 * Empty, and that is the finding rather than an omission.
 *
 * Pi documents that it has no permission popups, so no pattern could ever
 * fire. Its non-interactive modes (`-p`, `--mode json`, `--mode rpc`) never
 * show a project-trust prompt either, so there is no codex-style trust blocker
 * to match.
 */
const PROMPT_PATTERNS: RegExp[] = [];

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function buildScript(input: PlanInput): LaunchPlan {
  const readOnly = isReadOnlyRole(input.role) || input.mode === 'plan';

  // `default` means "ask before doing anything irreversible". Pi cannot ask —
  // it has no approval prompts and no sandbox — so honouring the mode is
  // impossible. Running anyway would make a sonata subagent more permissive
  // than the session that dispatched it, silently. Refuse instead, and say why.
  //
  // Read-only roles are exempt: there is nothing for them to ask about.
  if (input.mode === 'default' && !readOnly) {
    throw new Error(
      'sonata: pi cannot ask for approval, so it cannot honour `default` ' +
      'permission mode. Re-dispatch in acceptEdits or bypassPermissions to run ' +
      'it ungated, or use a codex model, whose TUI does prompt.',
    );
  }

  // `--model` accepts a combined provider/id form as a single flag, e.g.
  // opencode-go/deepseek-v4-flash; no separate `--provider` flag is needed.
  // `--no-context-files` stops pi re-reading AGENTS.md / CLAUDE.md: sonata
  // composes its own instructions and injects repo context, so pi would just
  // duplicate it.
  const flags = ['-p', `--model ${shellQuote(input.modelId)}`, '--no-context-files'];
  // `--tools` is an allowlist, genuinely enforced: a read-only role gets only
  // the read-side tools and cannot write even in bypassPermissions.
  if (readOnly) flags.push('--tools read,grep,find,ls');

  // The instructions path is given in the prompt rather than piped, so stdin
  // stays free and the prompt survives the harness's own formatting.
  const prompt = 'Follow the instructions in the attached file.\n\n' +
    `Instructions file: ${input.instructionsPath}`;

  const script = [
    '#!/bin/bash',
    'set -o pipefail',
    'export PATH="$HOME/.local/bin:$PATH"',
    `cd ${shellQuote(input.cwd)} || exit 97`,
    `pi ${flags.join(' ')} ${shellQuote(prompt)} 2>&1 | tee -a ${shellQuote(`${input.runDir}/harness.log`)}`,
    `echo $? > ${shellQuote(`${input.runDir}/exit`)}`,
    '',
  ].join('\n');

  // A read-only allowlist removes the write tool outright, so the model cannot
  // write report.md either. That is the cost of pi's enforcement being real
  // rather than advisory, and sonata must not report such a run as degraded.
  return { script, interactive: false, canWriteReport: !readOnly };
}

const NO_PROVIDER: HarnessProblem = {
  severity: 'error',
  message: 'pi has no usable model provider configured',
  fix: 'pi auth check --provider <name>',
};

/**
 * The listing always starts with a `provider  model  context ...` header, so
 * "output is non-empty" is not evidence that any model exists — the header
 * alone would report a broken install as healthy.
 */
const PI_HEADER = /^provider\s+model\b/;

/**
 * Parses `pi --list-models`, a whitespace-aligned table whose first two
 * columns are the provider and the model.
 *
 * Rows are read only AFTER the header, because pi does not always print a
 * table. With no provider configured it prints prose, captured verbatim in
 * `tests/fixtures/pi/no-models.txt`:
 *
 *     No models available. Use /login to log into a provider via OAuth or …
 *
 * Splitting that on whitespace yielded the phantom model `No/models`, which
 * `countModelRows` then counted as one real row — so `piHealth` reported an
 * unconfigured pi as healthy, and `sonata init` offered `No/models` for
 * selection. Gating on the header rejects every prose form at once, including
 * `No models matching "<pattern>"` from a search that matched nothing.
 */
export function parsePiRefs(stdout: string): ModelRef[] {
  const out: ModelRef[] = [];
  let inTable = false;
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (!inTable) {
      // Anything before the header is prose, not a truncated table.
      if (PI_HEADER.test(line)) inTable = true;
      continue;
    }
    const cols = line.split(/\s+/);
    // A real row carries all six columns. Fewer means the line is not a row,
    // and must not become a ref with an undefined id.
    if (cols.length < 2) continue;
    const [provider, id] = cols;
    out.push({ harness: 'pi', provider, id, ref: `${provider}/${id}` });
  }
  return out;
}

/** Counts real model rows, for the health check. */
export function countModelRows(stdout: string): number {
  return parsePiRefs(stdout).length;
}

async function piHealth(_env: { home: string; cwd: string }): Promise<HarnessProblem[]> {
  try {
    // Hard timeout: pi can block when a provider is unreachable, and doctor
    // must never hang. `--list-models` needs a configured provider, so an
    // empty list means there is nothing to run against.
    const { stdout } = await run('pi', ['--list-models'], { timeout: 5_000 });
    return countModelRows(stdout) > 0 ? [] : [NO_PROVIDER];
  } catch {
    return [NO_PROVIDER];
  }
}

export const piAdapter: HarnessAdapter = {
  name: 'pi',
  versionCommand: ['pi', '--version'],
  supportedVersions: '>=0.84.0 <1.0.0',
  pathPrepend: ['$HOME/.local/bin'],
  plan: buildScript,
  canPromptForApproval: false,
  promptPatterns: PROMPT_PATTERNS,
  describePrompt(): string | null {
    return null;
  },
  /** Nothing to send: pi never waits for an answer. */
  approveKeys: { yes: [], no: [] },
  health: piHealth,
};
