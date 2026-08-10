import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig } from '../config.js';
import { getAdapter } from '../adapters/index.js';
import { tmuxVersion } from '../tmux.js';
import { modeHookPresent, readSettings, settingsPath } from '../settings.js';
import { homedir } from 'node:os';

const run = promisify(execFile);

function triple(v: string): [number, number, number] {
  const m = v.replace(/^v/, '').match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function cmp(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** Supports ranges of the form ">=X.Y.Z <A.B.C". */
export function checkVersion(actual: string, range: string): boolean {
  const a = triple(actual);
  for (const part of range.trim().split(/\s+/)) {
    const m = part.match(/^(>=|<)(.+)$/);
    if (!m) continue;
    const bound = triple(m[2]);
    if (m[1] === '>=' && cmp(a, bound) < 0) return false;
    if (m[1] === '<' && cmp(a, bound) >= 0) return false;
  }
  return true;
}

export interface Check { name: string; ok: boolean; detail: string }

export async function cmdDoctor(opts: { cwd: string }): Promise<{ ok: boolean; checks: Check[] }> {
  const checks: Check[] = [];

  try {
    checks.push({ name: 'tmux', ok: true, detail: await tmuxVersion() });
  } catch {
    checks.push({ name: 'tmux', ok: false, detail: 'not installed — `brew install tmux`' });
  }

  let config;
  try {
    config = loadConfig(opts.cwd);
    checks.push({ name: 'sonata.toml', ok: true, detail: `${Object.keys(config.models).length} models` });
  } catch (err) {
    checks.push({ name: 'sonata.toml', ok: false, detail: (err as Error).message });
    return { ok: false, checks };
  }

  const harnesses = new Set(Object.values(config.models).map((m) => m.harness));

  // Without the hook sonata cannot read the session's permission mode and
  // assumes `default` — which opencode cannot honour, so every opencode
  // dispatch refuses. Say that here rather than letting it surface as a
  // confusing failure on first use.
  if (harnesses.has('opencode')) {
    const installed = (['project', 'global'] as const).some((scope) =>
      modeHookPresent(readSettings(settingsPath(scope, opts.cwd, homedir()))),
    );
    checks.push({
      name: 'permission hook',
      ok: installed,
      detail: installed
        ? 'installed — the session permission mode is visible to sonata'
        : 'not installed, so sonata assumes `default`, which opencode cannot ' +
          'honour — every opencode dispatch will refuse. Run `sonata init`',
    });
  }
  for (const name of harnesses) {
    const adapter = getAdapter(name);
    try {
      const env = { ...process.env, PATH: `${process.env.HOME}/.opencode/bin:${process.env.PATH}` };
      const { stdout } = await run(adapter.versionCommand[0], adapter.versionCommand.slice(1), { env });
      const version = stdout.trim();
      const ok = checkVersion(version, adapter.supportedVersions);
      checks.push({
        name,
        ok,
        detail: ok ? version : `${version} outside tested range ${adapter.supportedVersions}`,
      });

      // Version alone does not mean usable: a harness can be installed, current
      // and still unable to reach a model.
      if (adapter.health) {
        for (const p of await adapter.health({ home: homedir(), cwd: opts.cwd })) {
          checks.push({
            name: `${name} health`,
            ok: p.severity !== 'error',
            detail: p.fix ? `${p.message} — ${p.fix}` : p.message,
          });
        }
      }
    } catch {
      checks.push({ name, ok: false, detail: 'not found on PATH' });
    }
  }

  return { ok: checks.every((c) => c.ok), checks };
}
