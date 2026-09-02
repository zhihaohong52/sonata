import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig } from '../config.js';
import { litellmRequired } from '../native/providers.js';
import {
  installLitellm, litellmStatus, type InstallerDeps, type LitellmStatus,
  LITELLM_VERSION, PYTHON_RANGE,
} from '../native/litellm-venv.js';

const runCommand = promisify(execFile);

/**
 * How this command probes the machine, injectable so the tests never shell out.
 *
 * `require` is deliberately absent: this package is ESM (`"type": "module"`,
 * NodeNext), where `require` is undefined at runtime — but @types/node declares
 * it globally, so a `require('node:child_process')` here would typecheck
 * cleanly and fail only on a user's machine, at the moment they try to install.
 */
export const defaultInstallerDeps: InstallerDeps = {
  which: (bin) => {
    try { return execFileSync('which', [bin], { encoding: 'utf8' }).trim() || undefined; } catch { return undefined; }
  },
  pythonVersion: () => {
    try {
      return execFileSync(
        'python3', ['-c', 'import sys;print("%d.%d.%d"%sys.version_info[:3])'], { encoding: 'utf8' },
      ).trim();
    } catch { return undefined; }
  },
  run: async (cmd, args) => { await runCommand(cmd, args); },
};

/** One sentence per state, naming the repair rather than restating the fault. */
export function describeStatus(status: LitellmStatus): string {
  switch (status.state) {
    case 'not-required': return 'not needed — no gateway in this config routes through it';
    case 'ok': return `${status.path} (${status.version})`;
    case 'stale':
      return `installed ${status.installed}, but this sonata pins ${status.expected}`
        + ' — run `sonata litellm install`';
    case 'missing': return 'required by this config but not installed — run `sonata litellm install`';
    case 'broken': return `installed but unusable (${status.reason}) — run \`sonata litellm install\``;
    case 'no-python':
      return `no usable Python (needs ${PYTHON_RANGE}${status.pythonVersion !== undefined ? `, found ${status.pythonVersion}` : ''})`
        + ' — install uv, which can fetch a conforming one';
  }
}

/** `stale` still serves, so it is not a failure — only a report. */
export function statusIsHealthy(status: LitellmStatus): boolean {
  return status.state === 'ok' || status.state === 'not-required' || status.state === 'stale';
}

export async function cmdLitellm(
  action: 'install' | 'status',
  opts: { cwd: string; home: string; write?: (line: string) => void; deps?: InstallerDeps },
): Promise<number> {
  const out = opts.write ?? ((line: string) => console.log(line));
  const deps = opts.deps ?? defaultInstallerDeps;
  const required = litellmRequired(loadConfig(opts.cwd, opts.home));

  if (action === 'status') {
    const status = litellmStatus(opts.home, required, deps);
    out(`litellm: ${status.state} — ${describeStatus(status)}`);
    return statusIsHealthy(status) ? 0 : 1;
  }

  if (!required) {
    out('No gateway in this config routes through LiteLLM — nothing to install.');
    return 0;
  }
  out(`Installing litellm[proxy]==${LITELLM_VERSION} into ~/.config/sonata/litellm`);
  out(deps.which('uv') !== undefined ? '  (uv: seconds)' : '  (pip: a few minutes)');
  await installLitellm(opts.home, deps);
  out(`Done — ${describeStatus(litellmStatus(opts.home, true, deps))}`);
  return 0;
}
