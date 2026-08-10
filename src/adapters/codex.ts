import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from 'node:net';
import type { HarnessAdapter, HarnessProblem, LaunchPlan, PlanInput } from './types.js';
import { isReadOnlyRole } from '../config.js';

const run = promisify(execFile);

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

const PROMPT_PATTERNS: RegExp[] = [
  /\ballow\b.*\?/i,
  /\bapprove\b.*\?/i,
  /\(y\/n\)/i,
  /\[y\/N\]/,
  /press enter to continue/i,
  /waiting for approval/i,
];

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

  const script = [
    '#!/bin/bash',
    'set -o pipefail',
    `cd ${shellQuote(input.cwd)} || exit 97`,
    `${invocation} 2>&1 | tee -a ${shellQuote(`${input.runDir}/harness.log`)}`,
    `echo $? > ${shellQuote(`${input.runDir}/exit`)}`,
    '',
  ].join('\n');

  return { script, interactive };
}

/** Base URL codex is configured to talk to, if it overrides the default. */
export function configuredBaseUrl(configText: string): string | null {
  const m = configText.match(/^\s*openai_base_url\s*=\s*"([^"]+)"/m);
  return m ? m[1] : null;
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

async function codexHealth(env: { home: string }): Promise<HarnessProblem[]> {
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
  const baseUrl = existsSync(configPath)
    ? configuredBaseUrl(readFileSync(configPath, 'utf8'))
    : null;

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
  promptPatterns: PROMPT_PATTERNS,
  describePrompt(lines: string[]): string | null {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (PROMPT_PATTERNS.some((re) => re.test(lines[i]))) return lines[i];
    }
    return null;
  },
  approveKeys: { yes: 'y', no: 'n' },
  /**
   * Codex writes its final message here via `-o`. Used when the model did not
   * write a report of its own, which is far better than scraping the pane.
   */
  fallbackReportFile: 'last-message.txt',
  health: codexHealth,
};
