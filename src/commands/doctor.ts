import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import {
  loadConfig,
  configPath,
  GLOBAL_CONFIG_RELATIVE,
  generatedAgents,
} from '../config.js';
import { staleAgents, disabledOpencodeAgents, enableOpencodeAgent,
} from '../detect.js';
import { getAdapter } from '../adapters/index.js';
import { tmuxVersion } from '../tmux.js';
import {
  modeHookPresent,
  readSettings,
  settingsPath,
  
  mcpRegistered,
} from '../settings.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

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

export async function cmdDoctor(
  opts: { cwd: string; home?: string; packageRoot?: string },
): Promise<{ ok: boolean; checks: Check[] }> {
  const home = opts.home ?? homedir();
  const checks: Check[] = [];

  try {
    checks.push({ name: 'tmux', ok: true, detail: await tmuxVersion() });
  } catch {
    checks.push({ name: 'tmux', ok: false, detail: 'not installed — `brew install tmux`' });
  }

  let config;
  const resolved = configPath(opts.cwd, home);
  try {
    config = loadConfig(opts.cwd, home);
    checks.push({
      name: 'sonata.toml',
      ok: true,
      detail: `${resolved} · ${Object.keys(config.models).length} models`,
    });
  } catch (err) {
    checks.push({ name: 'sonata.toml', ok: false, detail: (err as Error).message });
    return { ok: false, checks };
  }

  // `sonata init` run in $HOME used to write here, and nothing reads it. It
  // looks exactly like configuration, which is worse than not existing.
  const stray = join(home, 'sonata.toml');
  if (existsSync(stray) && resolved !== stray) {
    checks.push({
      name: 'stray config',
      ok: false,
      detail: `${stray} is not read by sonata — mv it to ${join(home, GLOBAL_CONFIG_RELATIVE)}`,
    });
  }

  const agentsDir = join(opts.cwd, '.claude', 'agents');
  const wanted = generatedAgents(config).map((a) => `${a.role}-${a.model}`);
  const stale = staleAgents(agentsDir, wanted);
  checks.push(stale.length === 0
    ? { name: 'agents', ok: true, detail: `${wanted.length} generated, none stale` }
    : {
        name: 'agents',
        ok: false,
        detail: `${stale.length} stale agent file(s) name models the config does not ` +
          `define — run \`sonata sync\` to remove them: ${stale.slice(0, 3).join(', ')}` +
          (stale.length > 3 ? ', …' : ''),
      });

  const withBash = existsSync(agentsDir)
    ? readdirSync(agentsDir).filter((f) => f.endsWith('.md')).filter((f) => {
        const body = readFileSync(join(agentsDir, f), 'utf8');
        return body.includes('forwarding wrapper around the sonata runtime')
          && /^tools:\s*Bash\s*$/m.test(body);
      })
    : [];
  checks.push(withBash.length === 0
    ? { name: 'agent tools', ok: true, detail: 'no wrapper grants Bash' }
    : {
        name: 'agent tools',
        ok: false,
        detail: `${withBash.length} wrapper(s) still grant Bash and can do the work ` +
          'themselves — run `sonata sync`, then restart Claude Code',
      });

  // Agents sonata dispatches to. A disabled one is not an error opencode
  // reports: `--agent explore` falls back to the write-capable `build` with a
  // warning in the pane that nothing parses, so a read-only role silently
  // stops being read-only. Corrected rather than reported, because the
  // failure is invisible and the fix is one field.
  const NEEDED_OPENCODE_AGENTS = ['explore', 'plan', 'build'];
  const disabled = disabledOpencodeAgents(home).filter((a) => NEEDED_OPENCODE_AGENTS.includes(a));
  if (disabled.length === 0) {
    checks.push({ name: 'opencode agents', ok: true, detail: 'none sonata needs are disabled' });
  } else {
    const fixed = disabled.filter((a) => enableOpencodeAgent(home, a));
    checks.push({
      name: 'opencode agents',
      ok: fixed.length === disabled.length,
      detail: fixed.length > 0
        ? `re-enabled ${fixed.join(', ')} in opencode.json — disabled, a read-only role ` +
          'silently runs under the write-capable `build`'
        : `${disabled.join(', ')} disabled in opencode.json and could not be re-enabled`,
    });
  }

  // Where Claude Code would look depends on which config is in effect: a
  // project config pairs with ./.mcp.json, a machine config with the user
  // scope in ~/.claude.json.
  const mcpScope = resolved === join(opts.cwd, 'sonata.toml') ? 'project' : 'user';
  const registered = opts.packageRoot !== undefined
    && mcpRegistered(mcpScope, opts.cwd, home, opts.packageRoot);
  checks.push(registered
    ? { name: 'mcp server', ok: true, detail: `registered at ${mcpScope} scope` }
    : {
        name: 'mcp server',
        ok: false,
        detail: `not registered at ${mcpScope} scope — wrappers would have no tools at all; ` +
          'run `sonata init`',
      });

  const harnesses = new Set(Object.values(config.models).map((m) => m.harness));

  // Without the hook sonata cannot read the session's permission mode and
  // assumes `default` — which a harness that cannot ask for approval refuses
  // outright, so every dispatch to it fails. Say that here rather than letting
  // it surface as a confusing failure on first use.
  const cannotAsk = [...harnesses].filter((h) => !getAdapter(h).canPromptForApproval);
  if (cannotAsk.length > 0) {
    const installed = (['project', 'global'] as const).some((scope) =>
      modeHookPresent(readSettings(settingsPath(scope, opts.cwd, homedir()))),
    );
    checks.push({
      name: 'permission hook',
      ok: installed,
      detail: installed
        ? 'installed — the session permission mode is visible to sonata'
        : `not installed, so sonata assumes \`default\`, which ${cannotAsk.join(' and ')} ` +
          'cannot honour — those dispatches will refuse. Run `sonata init`',
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
