import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
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

describe('routeSettingsFile', () => {
  it('always points at the project-local settings, never the shared file', () => {
    expect(routeSettingsFile(cwd)).toBe(join(cwd, '.claude', 'settings.local.json'));
  });
});

describe('ensureServeCommand', () => {
  it('resolves its hook path and port into a node session-start command', () => {
    const cmd = ensureServeCommand(PACKAGE_ROOT, 4100);
    expect(cmd).toContain(`node ${JSON.stringify(join(PACKAGE_ROOT, 'hooks', 'ensure-serve.mjs'))} 4100`);
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
});