import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
} from '../../src/commands/route.js';
import type { Settings, HookEntry } from '../../src/settings.js';

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
});

describe('cmdRouteSession', () => {
  /** Never probes or spawns: the router's real state is irrelevant to counting. */
  const deps = { probe: async () => true, startDaemon: async () => ({}) };

  function opts() {
    writeFileSync(join(cwd, 'sonata.toml'), NATIVE_TOML);
    return { cwd, home, packageRoot: PACKAGE_ROOT, serveArgv: ['node', 'cli.js', 'serve'] };
  }

  it('routes on the first session start and off when the last one ends', async () => {
    const o = opts();
    const started = await cmdRouteSession('start', 's1', o, deps);
    expect(started).toEqual({ sessions: 1, routing: 'on' });
    expect((await cmdRoute('status', o))?.on).toBe(true);

    const ended = await cmdRouteSession('end', 's1', o, deps);
    expect(ended).toEqual({ sessions: 0, routing: 'off' });
    expect((await cmdRoute('status', o))?.on).toBe(false);
  });

  it('keeps routing while a sibling session is still live', async () => {
    const o = opts();
    await cmdRouteSession('start', 's1', o, deps);
    await cmdRouteSession('start', 's2', o, deps);

    const first = await cmdRouteSession('end', 's1', o, deps);
    expect(first).toEqual({ sessions: 1, routing: 'on' });
    expect((await cmdRoute('status', o))?.on).toBe(true);

    const last = await cmdRouteSession('end', 's2', o, deps);
    expect(last.routing).toBe('off');
    expect((await cmdRoute('status', o))?.on).toBe(false);
  });

  it('does not double-register a repeated session id', async () => {
    const o = opts();
    await cmdRouteSession('start', 's1', o, deps);
    const again = await cmdRouteSession('start', 's1', o, deps);
    expect(again.sessions).toBe(1);
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
    // The end ran first and committed to off against the empty registry.
    expect(ended).toEqual({ sessions: 0, routing: 'off' });
    const started = await startPromise;
    // The start then re-registered on top of the completed write, not mid-write.
    expect(started).toEqual({ sessions: 1, routing: 'on' });
    // Registry and routing agree: s2 is counted and routing is on.
    expect(readSessions(routeSessionsFile(cwd))).toEqual(['s2']);
    expect((await cmdRoute('status', o))?.on).toBe(true);

    // Now genuinely the last session — routing turns off.
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

  it('shares one session count across projects at global scope, so one project ending does not turn off another\'s routing', async () => {
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
    expect(endedA).toEqual({ sessions: 1, routing: 'on' });
    expect((await cmdRoute('status', { cwd: cwdB, home, packageRoot: PACKAGE_ROOT, scope: 'global' }))?.scopes.global.on).toBe(true);

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

  it('re-checks identity after starting a daemon, catching a racing project that won the port', async () => {
    // A SessionStart that sees nothing listening yet (probe false) spawns its
    // own daemon — but between that probe and the daemon's bind, another
    // project's router can win the shared default port. `startServeDaemon` only
    // confirms *a* sonata router answered, so the loser must re-verify whose
    // config now holds the port before trusting what answered. `startDaemon` is
    // injected to resolve without a real spawn, but `probe` is left undefined
    // so the post-spawn identity check still runs against the real network
    // probe — driven here by the stateful fetch stub below.
    const otherCwd = mkdtempSync(join(tmpdir(), 'sonata-route-other-'));
    writeFileSync(join(cwd, 'sonata.toml'), NATIVE_TOML);
    writeFileSync(join(otherCwd, 'sonata.toml'), NATIVE_TOML);
    const otherConfigPath = join(otherCwd, 'sonata.toml');

    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        // The initial probe finds nothing listening on the port yet.
        throw new Error('ECONNREFUSED');
      }
      // By the time the daemon's poll completes, the *other* project's router
      // holds the port.
      return new Response(JSON.stringify({ status: 'ok', sonata: true, configPath: otherConfigPath }));
    }) as unknown as typeof fetch);

    const o = { cwd, home, packageRoot: PACKAGE_ROOT, serveArgv: ['node', 'cli.js', 'serve'] };
    await expect(
      cmdRouteSession('start', 's1', o, { startDaemon: async () => ({}) }),
    ).rejects.toThrow(/different sonata configuration/);
    // The post-spawn identity collision aborts before any state is written.
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

  it('re-checks identity after starting a daemon, refusing a router that reports no configPath', async () => {
    writeFileSync(join(cwd, 'sonata.toml'), NATIVE_TOML);

    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error('ECONNREFUSED');
      }
      return new Response(JSON.stringify({ status: 'ok', sonata: true }));
    }) as unknown as typeof fetch);

    const o = { cwd, home, packageRoot: PACKAGE_ROOT, serveArgv: ['node', 'cli.js', 'serve'] };
    await expect(
      cmdRouteSession('start', 's1', o, { startDaemon: async () => ({}) }),
    ).rejects.toThrow(/did not report which sonata configuration/);
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
