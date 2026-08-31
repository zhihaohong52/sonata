import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import {
  planRouteOn,
  planRouteOff,
  planRouteAuto,
  planRouteManual,
  autoInstalled,
  routeStatus,
  routeSettingsFile,
  routeSessionsFile,
  readSessions,
  writeSessions,
  sessionHookCommand,
  ensureServeCommand,
  routeEnv,
  cmdRoute,
  cmdRouteSession,
  cmdRouteSubagent,
  routeSubagentsFile,
  subagentHookCommand,
  SONATA_AGENT_MATCHER,
  diagnoseRouteAuto,
} from '../../src/commands/route.js';
import type { Settings, HookEntry } from '../../src/settings.js';
import { readSettings } from '../../src/settings.js';

const NATIVE_TOML = `
[native.models."deepseek"]
gateway = "g"
id = "deepseek-v4-flash"
context_window = 64000
[native.gateways."g"]
base_url = "http://gateway.example/v1"
`;

let cwd: string;
let home: string;
const PACKAGE_ROOT = '/repo/root';

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'sonata-route-cwd-'));
  home = mkdtempSync(join(tmpdir(), 'sonata-route-home-'));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Global routing resolves the *machine* config (`~/.config/sonata/sonata.toml`),
 * not whichever project's session happens to manage it — writes there, not
 * into `cwd`, so global-scope tests exercise the config path that actually
 * governs the shared daemon.
 */
function writeMachineConfig(toml: string): void {
  const dir = join(home, '.config', 'sonata');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'sonata.toml'), toml);
}

describe('routeSettingsFile', () => {
  it('always points at the project-local settings, never the shared file', () => {
    expect(routeSettingsFile(cwd)).toBe(join(cwd, '.claude', 'settings.local.json'));
  });
});


describe('global route scope', () => {
  it('targets the shared settings file without changing the project file', async () => {
    writeMachineConfig(NATIVE_TOML);
    const opts = { cwd, home, packageRoot: PACKAGE_ROOT, scope: 'global' as const };
    const result = await cmdRoute('on', opts);

    expect(result?.on).toBe(true);
    expect(routeSettingsFile(cwd, 'global', home)).toBe(join(home, '.claude', 'settings.json'));
    expect(existsSync(routeSettingsFile(cwd))).toBe(false);
    expect(JSON.parse(readFileSync(routeSettingsFile(cwd, 'global', home), 'utf8'))).toMatchObject({
      env: { ANTHROPIC_BASE_URL: 'http://localhost:4100' },
    });

    await cmdRoute('off', opts);
    expect(JSON.parse(readFileSync(routeSettingsFile(cwd, 'global', home), 'utf8')).env).toBeUndefined();
    expect(existsSync(routeSettingsFile(cwd))).toBe(false);
  });

  it('installs auto hooks in the shared settings file', async () => {
    writeMachineConfig(NATIVE_TOML);
    const result = await cmdRoute('auto', { cwd, home, packageRoot: PACKAGE_ROOT, scope: 'global' });
    expect(result?.auto).toBe(true);
    expect(existsSync(routeSettingsFile(cwd))).toBe(false);
    const settings = JSON.parse(readFileSync(routeSettingsFile(cwd, 'global', home), 'utf8')) as Settings;
    expect(settings.hooks?.SessionStart).toBeDefined();
    expect(settings.hooks?.SessionEnd).toBeDefined();
    const command = (settings.hooks!.SessionStart as HookEntry[]).flatMap((e) => e.hooks)
      .map((h) => h.command);
    // Without --global, route-session.mjs calls `sonata route session-start`
    // with no scope, the CLI defaults that to project, and a global auto
    // session silently falls back to project-local routing.
    expect(command).toContain(sessionHookCommand(PACKAGE_ROOT, 'start', 'global'));
  });

  it('reports a global-only install in the scope report', async () => {
    writeMachineConfig(NATIVE_TOML);
    await cmdRoute('on', { cwd, home, packageRoot: PACKAGE_ROOT, scope: 'global' });
    const result = await cmdRoute('status', { cwd, home, packageRoot: PACKAGE_ROOT });
    expect(result?.scopes.global.on).toBe(true);
    expect(result?.scopes.project.on).toBe(false);
  });

  it('resolves global status and port from the machine config, never the invoking project\'s own', async () => {
    // A project's own sonata.toml can configure a different router port than
    // the machine config; global status/on must reflect the machine port the
    // shared daemon (per bd72ec4) actually resolves, not the project's.
    writeFileSync(join(cwd, 'sonata.toml'), NATIVE_TOML.replace(
      '[native.gateways."g"]', '[native.ports]\nrouter = 5100\n[native.gateways."g"]',
    ));
    writeMachineConfig(NATIVE_TOML.replace(
      '[native.gateways."g"]', '[native.ports]\nrouter = 4200\n[native.gateways."g"]',
    ));
    const result = await cmdRoute('on', { cwd, home, packageRoot: PACKAGE_ROOT, scope: 'global' });
    expect(result?.port).toBe(4200);
    expect(JSON.parse(readFileSync(routeSettingsFile(cwd, 'global', home), 'utf8'))).toMatchObject({
      env: { ANTHROPIC_BASE_URL: 'http://localhost:4200' },
    });
  });

  it('global routing still reads the machine config when a stray ~/sonata.toml exists', async () => {
    // A stray `~/sonata.toml` is config-looking but governs nothing; the
    // global router resolves `~/.config/sonata/sonata.toml`. Loading the
    // machine config by treating `home` as a project cwd (`configPath(home,
    // home)`) would prefer the stray file, so global routing must read the
    // machine path directly instead of baking the stray port into settings.
    writeFileSync(join(home, 'sonata.toml'), NATIVE_TOML.replace(
      '[native.gateways."g"]', '[native.ports]\nrouter = 5100\n[native.gateways."g"]',
    ));
    writeMachineConfig(NATIVE_TOML.replace(
      '[native.gateways."g"]', '[native.ports]\nrouter = 4200\n[native.gateways."g"]',
    ));
    const result = await cmdRoute('on', { cwd, home, packageRoot: PACKAGE_ROOT, scope: 'global' });
    expect(result?.port).toBe(4200);
    expect(JSON.parse(readFileSync(routeSettingsFile(cwd, 'global', home), 'utf8'))).toMatchObject({
      env: { ANTHROPIC_BASE_URL: 'http://localhost:4200' },
    });
  });
});

describe('ensureServeCommand', () => {
  it('resolves its hook path and port into a node session-start command', () => {
    const cmd = ensureServeCommand(PACKAGE_ROOT, 4100);
    expect(cmd).toContain(`node ${JSON.stringify(join(PACKAGE_ROOT, 'hooks', 'ensure-serve.mjs'))} 4100`);
  });

  it('marks a global-scope command so the daemon it starts is not bound to whichever project triggers it first', () => {
    const cmd = ensureServeCommand(PACKAGE_ROOT, 4100, 'global');
    expect(cmd).toBe(`node ${JSON.stringify(join(PACKAGE_ROOT, 'hooks', 'ensure-serve.mjs'))} 4100 --global`);
    expect(ensureServeCommand(PACKAGE_ROOT, 4100, 'project')).not.toContain('--global');
  });
});

describe('routeEnv', () => {
  it('reads string env entries and ignores anything else', () => {
    const settings: Settings = { env: { A: '1', N: 5 as unknown as string } };
    expect(routeEnv(settings)).toEqual({ A: '1' });
  });

  it('returns an empty map without an env block', () => {
    expect(routeEnv({})).toEqual({});
  });
});

describe('planRouteOn', () => {
  it('adds the routing env and a SessionStart hook to an empty settings file', () => {
    const config = loadNativeConfig();
    const plan = planRouteOn({}, config, PACKAGE_ROOT);

    expect(plan.changed).toBe(true);
    expect(plan.settings.env?.ANTHROPIC_BASE_URL).toBe('http://localhost:4100');
    expect(plan.settings.env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('64000');
    expect(plan.settings.hooks?.SessionStart).toBeDefined();
    const hook = (plan.settings.hooks!.SessionStart as HookEntry[]).flatMap((e) => e.hooks);
    expect(hook.map((h) => h.command)).toContain(ensureServeCommand(PACKAGE_ROOT, 4100));
  });

  it('is a no-op when already routed', () => {
    const config = loadNativeConfig();
    const once = planRouteOn({}, config, PACKAGE_ROOT);
    const twice = planRouteOn(once.settings, config, PACKAGE_ROOT);
    expect(twice.changed).toBe(false);
  });

  it('refuses to clobber a base URL sonata did not write', () => {
    const config = loadNativeConfig();
    const settings: Settings = { env: { ANTHROPIC_BASE_URL: 'https://gateway.corp.example/v1' } };
    expect(() => planRouteOn(settings, config, PACKAGE_ROOT))
      .toThrow(/already set to https:\/\/gateway\.corp\.example\/v1/);
  });

  it('installs the --global marker in the hook command at global scope', () => {
    const config = loadNativeConfig();
    const plan = planRouteOn({}, config, PACKAGE_ROOT, 'global');
    const hook = (plan.settings.hooks!.SessionStart as HookEntry[]).flatMap((e) => e.hooks);
    expect(hook.map((h) => h.command)).toContain(ensureServeCommand(PACKAGE_ROOT, 4100, 'global'));
  });

  it('rewrites a stale localhost router port — the drift doctor sends people here for', () => {
    const config = loadNativeConfig();
    const settings: Settings = { env: { ANTHROPIC_BASE_URL: 'http://localhost:9999' } };
    const plan = planRouteOn(settings, config, PACKAGE_ROOT);
    expect(plan.changed).toBe(true);
    expect(plan.settings.env?.ANTHROPIC_BASE_URL).toBe('http://localhost:4100');
  });

  it('preserves unrelated env vars while routing', () => {
    const config = loadNativeConfig();
    const plan = planRouteOn({ env: { CUSTOM: 'keep' } }, config, PACKAGE_ROOT);
    expect(plan.settings.env?.CUSTOM).toBe('keep');
  });

  it('throws when the config has no native table', () => {
    expect(() => planRouteOn({}, { native: undefined } as never, PACKAGE_ROOT)).toThrow(/no \[native\] table/);
  });
});

describe('planRouteOff', () => {
  it('refuses to remove a base URL sonata did not write', () => {
    const settings: Settings = { env: { ANTHROPIC_BASE_URL: 'https://gateway.corp.example/v1' } };
    expect(() => planRouteOff(settings, PACKAGE_ROOT))
      .toThrow(/sonata did not write/);
  });

  it('removes the routing env and its hook, preserving other env and hooks', () => {
    const config = loadNativeConfig();
    const on = planRouteOn({ env: { CUSTOM: 'keep' } }, config, PACKAGE_ROOT);
    const off = planRouteOff(on.settings, PACKAGE_ROOT);

    expect(off.changed).toBe(true);
    expect(off.settings.env?.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(off.settings.env?.CUSTOM).toBe('keep');
    expect(off.settings.hooks?.SessionStart ?? []).toHaveLength(0);
  });

  it('drops the env block when routing leaves nothing else in it', () => {
    const config = loadNativeConfig();
    const on = planRouteOn({}, config, PACKAGE_ROOT);
    const off = planRouteOff(on.settings, PACKAGE_ROOT);
    expect('env' in off.settings).toBe(false);
  });

  it('is a no-op when not routed', () => {
    const off = planRouteOff({ env: { CUSTOM: 'keep' } }, PACKAGE_ROOT);
    expect(off.changed).toBe(false);
  });
});

describe('routeStatus', () => {
  it('reports on when env and hook both match the router', () => {
    const config = loadNativeConfig();
    const on = planRouteOn({}, config, PACKAGE_ROOT);
    const status = routeStatus(on.settings, config, PACKAGE_ROOT);
    expect(status.on).toBe(true);
    expect(status.port).toBe(4100);
    expect(status.hook.installed).toBe(true);
  });

  it('reports off when the env points elsewhere', () => {
    const config = loadNativeConfig();
    const settings = {
      env: { ANTHROPIC_BASE_URL: 'http://localhost:9999' },
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: ensureServeCommand(PACKAGE_ROOT, 4100) }] }] },
    } as unknown as Settings;
    expect(routeStatus(settings, config, PACKAGE_ROOT).on).toBe(false);
  });
});

/** Minimal native config; the port comes from the default (4100). */
function loadNativeConfig() {
  // The planners only read `config.native.ports.router` and
  // `config.native.models`, so a minimal object suffices.
  return {
    native: {
      ports: { router: 4100, litellm: 4000 },
      models: { deepseek: { gateway: 'g', id: 'deepseek-v4-flash', contextWindow: 64000 } },
      gateways: {},
    },
    unifiedModels: {},
  } as never;
}

describe('cmdRoute', () => {
  it('on writes the routing env and SessionStart hook, off removes them, status reflects state', async () => {
    writeFileSync(join(cwd, 'sonata.toml'), NATIVE_TOML);
    const opts = { cwd, home, packageRoot: PACKAGE_ROOT };
    const file = routeSettingsFile(cwd);

    const on = await cmdRoute('on', opts);
    expect(on?.on).toBe(true);
    const written = JSON.parse(readFileSync(file, 'utf8')) as Settings;
    expect((written.env as Record<string, string>).ANTHROPIC_BASE_URL).toBe('http://localhost:4100');

    expect((await cmdRoute('status', opts))?.on).toBe(true);

    const off = await cmdRoute('off', opts);
    expect(off?.on).toBe(false);
    const after = JSON.parse(readFileSync(file, 'utf8')) as Settings;
    expect(after.env).toBeUndefined();
    expect(after.hooks?.SessionStart ?? []).toHaveLength(0);
  });

  it('off leaves the file alone when nothing was routed', async () => {
    writeFileSync(join(cwd, 'sonata.toml'), NATIVE_TOML);
    const opts = { cwd, home, packageRoot: PACKAGE_ROOT };
    await cmdRoute('off', opts);
    expect(existsSync(routeSettingsFile(cwd))).toBe(false);
  });

  it('auto rejects when the config does not load, instead of installing silently-broken hooks', async () => {
    // No sonata.toml in cwd or home: `route auto` installs lifecycle hooks
    // whose SessionEnd/SessionStart commands swallow their own load error, so
    // the only loud failure is refusing up front.
    await expect(cmdRoute('auto', { cwd, home, packageRoot: PACKAGE_ROOT })).rejects.toThrow();
  });

  it('preserves route-on state when live auto sessions are registered, but clears it otherwise', async () => {
    writeFileSync(join(cwd, 'sonata.toml'), NATIVE_TOML);
    const opts = { cwd, home, packageRoot: PACKAGE_ROOT };
    const file = routeSettingsFile(cwd);

    await cmdRoute('on', opts);
    writeSessions(routeSessionsFile(cwd), ['live-session']);
    await cmdRoute('auto', opts);

    const withLiveSession = JSON.parse(readFileSync(file, 'utf8')) as Settings;
    expect(withLiveSession.env?.ANTHROPIC_BASE_URL).toBe('http://localhost:4100');
    expect(autoInstalled(withLiveSession, PACKAGE_ROOT)).toBe(true);

    writeSessions(routeSessionsFile(cwd), []);
    await cmdRoute('auto', opts);

    const withoutLiveSession = JSON.parse(readFileSync(file, 'utf8')) as Settings;
    expect(withoutLiveSession.env?.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(autoInstalled(withoutLiveSession, PACKAGE_ROOT)).toBe(true);
  });
});

describe('the session registry', () => {
  it('round-trips ids and deletes the file once the last one leaves', () => {
    const file = routeSessionsFile(cwd);
    writeSessions(file, ['a', 'b']);
    expect(readSessions(file)).toEqual(['a', 'b']);
    writeSessions(file, []);
    expect(existsSync(file)).toBe(false);
    expect(readSessions(file)).toEqual([]);
  });

  it('reads a corrupt registry as empty rather than failing a session start', () => {
    const file = routeSessionsFile(cwd);
    writeSessions(file, ['a']);
    writeFileSync(file, '{ not json');
    expect(readSessions(file)).toEqual([]);
  });
});

describe('planRouteAuto / planRouteManual', () => {
  it('installs both lifecycle hooks and removes exactly them', () => {
    const auto = planRouteAuto({}, PACKAGE_ROOT);
    expect(auto.changed).toBe(true);
    expect(autoInstalled(auto.settings, PACKAGE_ROOT)).toBe(true);
    const start = (auto.settings.hooks!.SessionStart as HookEntry[]).flatMap((e) => e.hooks);
    expect(start.map((h) => h.command)).toContain(sessionHookCommand(PACKAGE_ROOT, 'start'));

    const manual = planRouteManual(auto.settings, PACKAGE_ROOT);
    expect(manual.changed).toBe(true);
    expect(autoInstalled(manual.settings, PACKAGE_ROOT)).toBe(false);
    expect('hooks' in manual.settings).toBe(false);
  });

  it('is idempotent in both directions', () => {
    const once = planRouteAuto({}, PACKAGE_ROOT);
    expect(planRouteAuto(once.settings, PACKAGE_ROOT).changed).toBe(false);
    expect(planRouteManual({}, PACKAGE_ROOT).changed).toBe(false);
  });

  it('leaves auto mode installed when route off runs — that is how SessionEnd survives', () => {
    const config = loadNativeConfig();
    const auto = planRouteAuto({}, PACKAGE_ROOT);
    const on = planRouteOn(auto.settings, config, PACKAGE_ROOT);
    const off = planRouteOff(on.settings, PACKAGE_ROOT);
    expect(autoInstalled(off.settings, PACKAGE_ROOT)).toBe(true);
    expect(off.settings.env?.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it('clears persistent route-on state when switching to auto — sessions must launch clean', () => {
    const config = loadNativeConfig();
    // Simulate `route on` having left persistent routing + its ensure-serve hook.
    const on = planRouteOn({}, config, PACKAGE_ROOT);
    expect(on.settings.env?.ANTHROPIC_BASE_URL).toBeDefined();

    const auto = planRouteAuto(on.settings, PACKAGE_ROOT);
    // The old persistent env and ensure-serve hook are gone...
    expect(auto.settings.env?.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(auto.changed).toBe(true);
    // ...and both auto lifecycle hooks are installed.
    expect(autoInstalled(auto.settings, PACKAGE_ROOT)).toBe(true);
    const start = (auto.settings.hooks!.SessionStart as HookEntry[]).flatMap((e) => e.hooks);
    const end = (auto.settings.hooks!.SessionEnd as HookEntry[]).flatMap((e) => e.hooks);
    expect(start.map((h) => h.command)).toContain(sessionHookCommand(PACKAGE_ROOT, 'start'));
    expect(end.map((h) => h.command)).toContain(sessionHookCommand(PACKAGE_ROOT, 'end'));
  });

  it('preserves persistent route-on state while registered auto sessions are live', () => {
    const config = loadNativeConfig();
    const on = planRouteOn({}, config, PACKAGE_ROOT);

    const auto = planRouteAuto(on.settings, PACKAGE_ROOT, 'project', true);

    expect(auto.settings.env?.ANTHROPIC_BASE_URL).toBe('http://localhost:4100');
    expect(autoInstalled(auto.settings, PACKAGE_ROOT)).toBe(true);
  });
});

describe('cmdRouteSession', () => {
  /** Never probes or spawns: the router's real state is irrelevant to counting. */
  const deps = { probe: async () => true, startDaemon: async () => ({}) };

  function opts() {
    writeFileSync(join(cwd, 'sonata.toml'), NATIVE_TOML);
    return { cwd, home, packageRoot: PACKAGE_ROOT, serveArgv: ['node', 'cli.js', 'serve'] };
  }

  it('counts a session without routing it — routing follows subagents, not sessions', async () => {
    // Routing on at SessionStart is what made `route auto` degrade into
    // `route on`: it stayed on while any session lived, so every session
    // after the first launched into a dirty file and lost Remote Control.
    const o = opts();
    const started = await cmdRouteSession('start', 's1', o, deps);
    expect(started).toEqual({ sessions: 1, routing: 'off' });
    expect((await cmdRoute('status', o))?.on).toBe(false);

    const ended = await cmdRouteSession('end', 's1', o, deps);
    expect(ended).toEqual({ sessions: 0, routing: 'off' });
    expect((await cmdRoute('status', o))?.on).toBe(false);
  });

  it('keeps counting a sibling session after one ends', async () => {
    const o = opts();
    await cmdRouteSession('start', 's1', o, deps);
    await cmdRouteSession('start', 's2', o, deps);

    const first = await cmdRouteSession('end', 's1', o, deps);
    expect(first.sessions).toBe(1);

    const last = await cmdRouteSession('end', 's2', o, deps);
    expect(last.sessions).toBe(0);
    expect((await cmdRoute('status', o))?.on).toBe(false);
  });

  it('does not double-register a repeated session id', async () => {
    const o = opts();
    await cmdRouteSession('start', 's1', o, deps);
    const again = await cmdRouteSession('start', 's1', o, deps);
    expect(again.sessions).toBe(1);
  });

  it('cleans up an ended session even after its config disappears, while start still validates', async () => {
    const o = opts();
    await cmdRouteSession('start', 's1', o, deps);
    rmSync(join(cwd, 'sonata.toml'));

    await expect(cmdRouteSession('end', 's1', o, deps)).resolves.toEqual({
      sessions: 0,
      routing: 'off',
    });
    expect(readSessions(routeSessionsFile(cwd))).toEqual([]);
    expect((await cmdRoute('status', o))?.on).toBe(false);

    await expect(cmdRouteSession('start', 's2', o, deps)).rejects.toThrow();
    expect(readSessions(routeSessionsFile(cwd))).toEqual([]);
  });

  it('starts the router only when it is not already answering', async () => {
    const o = opts();
    const started: string[] = [];
    await cmdRouteSession('start', 's1', o, {
      probe: async () => false,
      startDaemon: async () => { started.push('spawned'); return {}; },
    });
    expect(started).toEqual(['spawned']);
  });

  it('explicit route off clears the registry so a stale id cannot re-route', async () => {
    const o = opts();
    await cmdRouteSession('start', 'crashed', o, deps);
    await cmdRoute('off', o);
    expect(readSessions(routeSessionsFile(cwd))).toEqual([]);
  });

  it('serializes a last-session end against a concurrent start through the lock', async () => {
    const o = opts();
    await cmdRouteSession('start', 's1', o, deps);

    // Issue the last-session end and a new SessionStart back to back. The end's
    // critical section acquires the lock synchronously and runs read-write-decide
    // atomically, so it sees only s1 and commits to `off`; the start blocks on
    // the lock and, once released, registers s2 and turns routing back on. Under
    // the old two-lock code the end's recheck ran on a later tick and observed
    // s2 written in the gap — leaving routing silently off while s2 was counted.
    const endPromise = cmdRouteSession('end', 's1', o, deps);
    const startPromise = cmdRouteSession('start', 's2', o, deps);

    const ended = await endPromise;
    // The end ran first and committed against the empty registry.
    expect(ended).toEqual({ sessions: 0, routing: 'off' });
    const started = await startPromise;
    // The start then re-registered on top of the completed write, not mid-write.
    expect(started).toEqual({ sessions: 1, routing: 'off' });
    // The registry is consistent: s2 is counted, exactly once.
    expect(readSessions(routeSessionsFile(cwd))).toEqual(['s2']);

    const last = await cmdRouteSession('end', 's2', o, deps);
    expect(last).toEqual({ sessions: 0, routing: 'off' });
    expect((await cmdRoute('status', o))?.on).toBe(false);
  });

  it('starts a global-scope daemon from the machine config directory, not the triggering project\'s cwd', async () => {
    const o = { ...opts(), scope: 'global' as const };
    writeMachineConfig(NATIVE_TOML);
    const seenCwds: (string | undefined)[] = [];
    await cmdRouteSession('start', 's1', o, {
      probe: async () => false,
      startDaemon: async (_home, _argv, _deps, daemonCwd) => { seenCwds.push(daemonCwd); return {}; },
    });
    expect(seenCwds).toEqual([join(home, '.config', 'sonata')]);
  });

  it('validates the machine config for global sessions but the local config for project sessions', async () => {
    // The malformed local config is irrelevant to the shared global router,
    // whose daemon and lifecycle hook resolve only the machine config.
    writeFileSync(join(cwd, 'sonata.toml'), '[native\n');
    writeMachineConfig(NATIVE_TOML);
    const base = { cwd, home, packageRoot: PACKAGE_ROOT, serveArgv: ['node', 'cli.js', 'serve'] };

    await expect(cmdRouteSession('start', 'global', { ...base, scope: 'global' }, deps)).resolves.toEqual({
      sessions: 1,
      routing: 'off',
    });
    await expect(cmdRouteSession('start', 'project', { ...base, scope: 'project' }, deps)).rejects.toThrow();
  });

  it('probes the machine config\'s port at global scope, not the invoking project\'s own', async () => {
    const o = { ...opts(), scope: 'global' as const };
    writeFileSync(join(cwd, 'sonata.toml'), NATIVE_TOML.replace(
      '[native.gateways."g"]', '[native.ports]\nrouter = 5100\n[native.gateways."g"]',
    ));
    writeMachineConfig(NATIVE_TOML.replace(
      '[native.gateways."g"]', '[native.ports]\nrouter = 4200\n[native.gateways."g"]',
    ));
    const probedPorts: number[] = [];
    await cmdRouteSession('start', 's1', o, {
      probe: async (port) => { probedPorts.push(port); return true; },
      startDaemon: async () => ({}),
    });
    expect(probedPorts).toEqual([4200]);
  });

  it('probes the machine config\'s port at global scope even when a stray ~/sonata.toml exists', async () => {
    // A stray `~/sonata.toml` (a known leftover some upgrades produce) is
    // config-looking but governs nothing: the global router resolves the real
    // machine config at `~/.config/sonata/sonata.toml`. Resolving `configCwd`
    // as `home` itself would make configPath()'s first `join(cwd, 'sonata.toml')`
    // check land on the stray file and bake its 5100 port into the session
    // start — so `configCwd` must be the machine config's own directory, whose
    // first check lands on the real file instead.
    const o = { ...opts(), scope: 'global' as const };
    writeFileSync(join(home, 'sonata.toml'), NATIVE_TOML.replace(
      '[native.gateways."g"]', '[native.ports]\nrouter = 5100\n[native.gateways."g"]',
    ));
    writeMachineConfig(NATIVE_TOML.replace(
      '[native.gateways."g"]', '[native.ports]\nrouter = 4200\n[native.gateways."g"]',
    ));
    const probedPorts: number[] = [];
    await cmdRouteSession('start', 's1', o, {
      probe: async (port) => { probedPorts.push(port); return true; },
      startDaemon: async () => ({}),
    });
    expect(probedPorts).toEqual([4200]);
  });

  it('shares one session count across projects at global scope, so one project ending does not clear another\'s', async () => {
    // A per-project registry would let project A's own count hit zero and
    // call `route off` against the single shared global router, even though
    // project B's global session (tracked in a registry A never sees) is
    // still live.
    const cwdA = mkdtempSync(join(tmpdir(), 'sonata-route-projA-'));
    const cwdB = mkdtempSync(join(tmpdir(), 'sonata-route-projB-'));
    writeFileSync(join(cwdA, 'sonata.toml'), NATIVE_TOML);
    writeFileSync(join(cwdB, 'sonata.toml'), NATIVE_TOML);
    writeMachineConfig(NATIVE_TOML);
    const deps = { probe: async () => true, startDaemon: async () => ({}) };

    const oA = { cwd: cwdA, home, packageRoot: PACKAGE_ROOT, serveArgv: ['node', 'cli.js', 'serve'], scope: 'global' as const };
    const oB = { cwd: cwdB, home, packageRoot: PACKAGE_ROOT, serveArgv: ['node', 'cli.js', 'serve'], scope: 'global' as const };

    await cmdRouteSession('start', 'sessA', oA, deps);
    await cmdRouteSession('start', 'sessB', oB, deps);

    const endedA = await cmdRouteSession('end', 'sessA', oA, deps);
    // A per-project registry would have hit zero here and cleared the shared
    // global state out from under project B's still-live session.
    expect(endedA).toEqual({ sessions: 1, routing: 'off' });

    const endedB = await cmdRouteSession('end', 'sessB', oB, deps);
    expect(endedB).toEqual({ sessions: 0, routing: 'off' });
  });

  it('starts a project-scope daemon from the session\'s own cwd', async () => {
    const o = opts(); // scope defaults to undefined -> 'project'
    const seenCwds: (string | undefined)[] = [];
    await cmdRouteSession('start', 's1', o, {
      probe: async () => false,
      startDaemon: async (_home, _argv, _deps, daemonCwd) => { seenCwds.push(daemonCwd); return {}; },
    });
    expect(seenCwds).toEqual([cwd]);
  });

  it('refuses to share a router port already serving a different project\'s config', async () => {
    // Two projects, each with a sonata.toml resolving to the same default port.
    // With no injected probe/startDaemon, the real network path is exercised:
    // `probe` is `isSonataRouter` (fetch), then the identity check calls
    // `sonataRouterConfigPath` (also fetch). Stub global.fetch to answer like a
    // router started by a *different* config dir is already running.
    const otherCwd = mkdtempSync(join(tmpdir(), 'sonata-route-other-'));
    writeFileSync(join(cwd, 'sonata.toml'), NATIVE_TOML);
    writeFileSync(join(otherCwd, 'sonata.toml'), NATIVE_TOML);
    const otherConfigPath = join(otherCwd, 'sonata.toml');

    vi.stubGlobal('fetch', vi.fn(async () =>
      // A real running sonata router's health payload, reporting the config
      // that started it — a different project's sonata.toml.
      new Response(JSON.stringify({ status: 'ok', sonata: true, configPath: otherConfigPath })),
    ) as unknown as typeof fetch);

    const o = { cwd, home, packageRoot: PACKAGE_ROOT, serveArgv: ['node', 'cli.js', 'serve'] };
    await expect(cmdRouteSession('start', 's1', o)).rejects.toThrow(/different sonata configuration/);
    // The identity collision is detected before any state is written: the
    // session is not registered and routing is not turned on for a router that
    // would serve the wrong config.
    expect(existsSync(routeSessionsFile(cwd))).toBe(false);
    expect(existsSync(routeSettingsFile(cwd))).toBe(false);
  });

  it('refuses a running router that reports no configPath at all', async () => {
    writeFileSync(join(cwd, 'sonata.toml'), NATIVE_TOML);

    vi.stubGlobal('fetch', vi.fn(async () =>
      // A sonata router that answers but does not name its configPath is
      // indistinguishable from a different project's router — reject it
      // rather than silently trust it.
      new Response(JSON.stringify({ status: 'ok', sonata: true })),
    ) as unknown as typeof fetch);

    const o = { cwd, home, packageRoot: PACKAGE_ROOT, serveArgv: ['node', 'cli.js', 'serve'] };
    await expect(cmdRouteSession('start', 's1', o)).rejects.toThrow(/did not report which sonata configuration/);
    expect(existsSync(routeSessionsFile(cwd))).toBe(false);
    expect(existsSync(routeSettingsFile(cwd))).toBe(false);
  });

});
describe('configless route sessions', () => {
  it('throws before writing a registry or settings file', async () => {
    const o = { cwd, home, packageRoot: PACKAGE_ROOT, serveArgv: ['node', 'cli.js', 'serve'] };
    await expect(cmdRouteSession('start', 'orphan', o, {
      probe: async () => true,
      startDaemon: async () => ({}),
    })).rejects.toThrow();
    expect(existsSync(routeSessionsFile(cwd))).toBe(false);
    expect(existsSync(routeSettingsFile(cwd))).toBe(false);
  });
});


describe('cmdRouteSubagent', () => {
  const deps = { probe: async () => true, startDaemon: async () => ({}) };

  function opts() {
    writeMachineConfig(NATIVE_TOML);
    return { cwd, home, packageRoot: PACKAGE_ROOT, scope: 'global' as const };
  }

  it('routes on for the first subagent and off when the last one stops', async () => {
    const o = opts();
    const started = await cmdRouteSubagent('start', 'a1', o);
    expect(started).toEqual({ subagents: 1, routing: 'on' });
    expect((await cmdRoute('status', o))?.scopes.global.on).toBe(true);

    const stopped = await cmdRouteSubagent('stop', 'a1', o);
    expect(stopped).toEqual({ subagents: 0, routing: 'off' });
    expect((await cmdRoute('status', o))?.scopes.global.on).toBe(false);
  });

  it('keeps routing while a sibling subagent is still running', async () => {
    const o = opts();
    await cmdRouteSubagent('start', 'a1', o);
    await cmdRouteSubagent('start', 'a2', o);

    const first = await cmdRouteSubagent('stop', 'a1', o);
    expect(first).toEqual({ subagents: 1, routing: 'on' });
    // Un-routing here would cut a2 off mid-task, and its sonata-* alias would
    // reach api.anthropic.com as an unknown model.
    expect((await cmdRoute('status', o))?.scopes.global.on).toBe(true);

    const last = await cmdRouteSubagent('stop', 'a2', o);
    expect(last).toEqual({ subagents: 0, routing: 'off' });
  });

  it('does not double-count a repeated agent id', async () => {
    const o = opts();
    await cmdRouteSubagent('start', 'a1', o);
    expect((await cmdRouteSubagent('start', 'a1', o)).subagents).toBe(1);
  });

  it('tolerates a stop for an id it never saw', async () => {
    const o = opts();
    await expect(cmdRouteSubagent('stop', 'ghost', o)).resolves.toEqual({ subagents: 0, routing: 'off' });
  });

  it('leaves the session registry alone when the last subagent stops', async () => {
    const o = opts();
    const sessionOpts = { ...o, serveArgv: ['node', 'cli.js', 'serve'] };
    await cmdRouteSession('start', 's1', sessionOpts, deps);
    await cmdRouteSubagent('start', 'a1', o);
    await cmdRouteSubagent('stop', 'a1', o);

    // A finishing subagent must not erase session liveness, or the next
    // SessionEnd believes it was the last one.
    expect(readSessions(routeSessionsFile(cwd, 'global', home))).toEqual(['s1']);
  });

  it('clears leaked subagent references when the last session ends', async () => {
    const o = opts();
    const sessionOpts = { ...o, serveArgv: ['node', 'cli.js', 'serve'] };
    await cmdRouteSession('start', 's1', sessionOpts, deps);
    await cmdRouteSubagent('start', 'a1', o);
    // a1 never stops — a killed subagent leaks its reference. Bounding that by
    // the session's lifetime is what stops it becoming permanent.
    await cmdRouteSession('end', 's1', sessionOpts, deps);

    expect(readSessions(routeSubagentsFile(cwd, 'global', home))).toEqual([]);
    expect((await cmdRoute('status', o))?.scopes.global.on).toBe(false);
  });
});

describe('subagent hook installation', () => {
  it('installs the subagent pair under the sonata agent matcher', () => {
    const auto = planRouteAuto({}, PACKAGE_ROOT);
    const start = (auto.settings.hooks!.SubagentStart as HookEntry[]);
    const stop = (auto.settings.hooks!.SubagentStop as HookEntry[]);
    expect(start[0].matcher).toBe(SONATA_AGENT_MATCHER);
    expect(start.flatMap((e) => e.hooks).map((h) => h.command))
      .toContain(subagentHookCommand(PACKAGE_ROOT, 'start'));
    expect(stop.flatMap((e) => e.hooks).map((h) => h.command))
      .toContain(subagentHookCommand(PACKAGE_ROOT, 'stop'));
  });

  it('matches sonata agents but not Claude Code built-ins', () => {
    const re = new RegExp(SONATA_AGENT_MATCHER);
    for (const name of ['code-simple', 'review-complex', 'explore-simple', 'plan-simple', 'native-code-gpt-5.6-luna']) {
      expect(re.test(name)).toBe(true);
    }
    for (const name of ['general-purpose', 'Explore', 'Plan', 'statusline-setup']) {
      expect(re.test(name)).toBe(false);
    }
  });

  it('route manual removes the subagent pair too', () => {
    const auto = planRouteAuto({}, PACKAGE_ROOT);
    const manual = planRouteManual(auto.settings, PACKAGE_ROOT);
    expect(manual.settings.hooks?.SubagentStart ?? []).toHaveLength(0);
    expect(manual.settings.hooks?.SubagentStop ?? []).toHaveLength(0);
  });
});

describe('diagnoseRouteAuto — why routing is not detected', () => {
  // `sonata doctor` reported every one of these as
  // "tier agents need a routed session — run `sonata route auto`", which is
  // the right instruction for exactly one of them and a dead end for the
  // rest: a user who has just run that command is told to run it again, with
  // nothing naming what is actually wrong.
  const OTHER_ROOT = '/somewhere/else/sonata';

  it('reports a complete install as installed', () => {
    const { settings } = planRouteAuto({}, PACKAGE_ROOT);
    expect(diagnoseRouteAuto(settings, PACKAGE_ROOT)).toEqual({ kind: 'installed' });
  });

  it('reports settings with no sonata routing hooks as absent', () => {
    expect(diagnoseRouteAuto({}, PACKAGE_ROOT)).toEqual({ kind: 'absent' });
  });

  it('leaves an unrelated hook classified as absent rather than partial', () => {
    const settings: Settings = {
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node /some/other/tool.mjs' }] }] },
    };
    expect(diagnoseRouteAuto(settings, PACKAGE_ROOT)).toEqual({ kind: 'absent' });
  });

  it('names the other install when the hooks belong to a different sonata', () => {
    // The case that made this worth fixing: `route auto` really has been run,
    // the hooks really are there, and they run a sonata at a different path —
    // an npm-global install after a source checkout, a moved clone, a worktree.
    const { settings } = planRouteAuto({}, OTHER_ROOT);
    expect(diagnoseRouteAuto(settings, PACKAGE_ROOT)).toEqual({
      kind: 'other-install', roots: [OTHER_ROOT],
    });
  });

  it('reports an install carrying only the session pair as partial, naming the subagent hooks', () => {
    // The pre-subagent install: the session pair alone never routes anything,
    // because the subagent pair is what actually turns routing on.
    const { settings } = planRouteAuto({}, PACKAGE_ROOT);
    delete settings.hooks!.SubagentStart;
    delete settings.hooks!.SubagentStop;
    expect(diagnoseRouteAuto(settings, PACKAGE_ROOT)).toEqual({
      kind: 'partial', missing: ['SubagentStart', 'SubagentStop'],
    });
  });

  it('prefers the other-install diagnosis over partial when both could apply', () => {
    // A foreign install is also, technically, "missing" every expected
    // command. Saying so would send the user to re-run a command whose real
    // effect is repointing the hooks — true, but it never names why.
    const { settings } = planRouteAuto({}, OTHER_ROOT);
    delete settings.hooks!.SubagentStop;
    expect(diagnoseRouteAuto(settings, PACKAGE_ROOT).kind).toBe('other-install');
  });

  it('does not confuse the two scopes: a global install is not this project install', () => {
    const { settings } = planRouteAuto({}, PACKAGE_ROOT, 'global');
    expect(diagnoseRouteAuto(settings, PACKAGE_ROOT, 'global')).toEqual({ kind: 'installed' });
    expect(diagnoseRouteAuto(settings, PACKAGE_ROOT, 'project').kind).toBe('partial');
  });
});

describe('Defect B — the registry that pins routing on', () => {
  const deps = { probe: async () => true, startDaemon: async () => ({}) };
  const base = () => {
    writeMachineConfig(NATIVE_TOML);
    return { cwd, home, packageRoot: PACKAGE_ROOT, serveArgv: [] as string[] };
  };

  it('the writer and the cleaner of route-subagents.json default to the same file', async () => {
    // The latent trap: `cmdRouteSession('end')` cleared with `?? 'project'`
    // while `cmdRouteSubagent` wrote with `?? 'global'`. Same kind of file,
    // opposite defaults — so a caller omitting `scope` writes one registry and
    // clears another, and ids accumulate permanently in the one never cleared.
    //
    // The existing suite always passes `scope: 'global'` explicitly, which is
    // exactly why this was invisible to it. This test must omit `scope`.
    const o = base();
    await cmdRouteSubagent('start', 'a1', o);

    const written = [routeSubagentsFile(cwd, 'project', home), routeSubagentsFile(cwd, 'global', home)]
      .filter((f) => existsSync(f) && readSessions(f).includes('a1'));
    expect(written).toHaveLength(1);

    // Now the cleaner, also with no scope: it must clear the very file above.
    await cmdRouteSession('start', 's1', o, deps);
    await cmdRouteSession('end', 's1', o, deps);
    expect(readSessions(written[0])).toEqual([]);
  });

  it('route off clears the subagent registry, not just the session one', async () => {
    // The documented recovery. Measured on 2026-08-30 against a project with
    // six leaked ids: the env was removed and route-sessions.json cleared, but
    // route-subagents.json still held all six — so the pin survived its own
    // fix, and the next SubagentStart took the count 6 -> 7, never 0.
    const o = base();
    const subagents = routeSubagentsFile(cwd, 'project', home);
    writeSessions(subagents, ['leaked-1', 'leaked-2', 'leaked-3']);
    writeSessions(routeSessionsFile(cwd, 'project', home), ['s-old']);

    await cmdRoute('off', o);

    expect(readSessions(subagents)).toEqual([]);
    expect(readSessions(routeSessionsFile(cwd, 'project', home))).toEqual([]);
  });

  it('the final SessionEnd completes instead of deadlocking on its own lock', async () => {
    // `cmdRouteSession('end')` holds the SESSION lock and, on the last session
    // out, delegates to the clear path. `withSessionLock` is a non-reentrant
    // mkdirSync mutex that throws at a 2000 ms deadline, so a clear that
    // re-acquires the session lock deadlocks exactly here — and only here,
    // which is why this drives the last session out specifically.
    const o = base();
    await cmdRouteSession('start', 'only', o, deps);
    writeSessions(routeSubagentsFile(cwd, 'project', home), ['leaked']);

    const started = Date.now();
    const res = await cmdRouteSession('end', 'only', o, deps);

    expect(res).toEqual({ sessions: 0, routing: 'off' });
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(readSessions(routeSubagentsFile(cwd, 'project', home))).toEqual([]);
  });

  it('applies route off to the settings as they are when the lock is taken, not as they were before', async () => {
    // `cmdRoute` reads settings ~60 lines before this branch takes its lock,
    // and `SubagentStart` writes settings while holding the subagent lock. A
    // plan computed from that early copy is stale by the time it is applied:
    // `planRouteOff` on already-off settings reports `changed: false`, nothing
    // is written, and routing is left ON while both registries are cleared —
    // routing on, count zero, and nothing left that could ever turn it off.
    //
    // Racing two promises does not reliably hit that window (measured: 0/10),
    // so the interleaving is forced. Holding the subagent lock parks `route
    // off` exactly between its settings read and its settings write, which is
    // the whole window.
    const o = base();
    const subagents = routeSubagentsFile(cwd, 'project', home);
    mkdirSync(dirname(subagents), { recursive: true });
    mkdirSync(`${subagents}.lock`);

    const off = cmdRoute('off', o);
    await new Promise((r) => setTimeout(r, 50));
    // What a concurrent SubagentStart does while `route off` is parked.
    await cmdRoute('on', o);
    rmSync(`${subagents}.lock`, { recursive: true, force: true });
    await off;

    // `route off` must act on the routing it found when it took the lock.
    expect(routeEnv(readSettings(routeSettingsFile(cwd, 'project', home))).ANTHROPIC_BASE_URL)
      .toBeUndefined();
  });

  it('a SubagentStart racing the clear cannot resurrect the cleared ids', async () => {
    // The split-lock defect: SessionEnd wrote route-subagents.json under the
    // SESSION lock while cmdRouteSubagent writes it under the SUBAGENT lock.
    // Two locks on one file do not exclude each other, so SubagentStart could
    // read the pre-clear list, pause, and write it back after the clear —
    // restoring every id and re-pinning routing, from the cleanup path meant
    // to prevent it.
    const o = base();
    writeSessions(routeSubagentsFile(cwd, 'project', home), ['leaked-1', 'leaked-2']);
    await cmdRouteSession('start', 'only', o, deps);

    await Promise.all([
      cmdRouteSession('end', 'only', o, deps),
      cmdRouteSubagent('start', 'fresh', o),
    ]);

    // Either order is legal; what is not legal is a leaked id coming back.
    const left = readSessions(routeSubagentsFile(cwd, 'project', home));
    expect(left).not.toContain('leaked-1');
    expect(left).not.toContain('leaked-2');
  });
});
