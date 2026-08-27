import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { spawn as spawnType } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  cmdServe, serveHealthUrl, type ServeHandle, isSonataRouter, occupiedPortMessage, startServeDaemon,
  serveStatePath, stopServe, cmdRestart, sonataRouterInstanceId,
} from '../../src/commands/serve.js';
import { writeSonataKey } from '../../src/native/credentials.js';
import { clearCooldowns } from '../../src/native/router.js';

let cwd: string;
let home: string;
let handles: ServeHandle[];

/** Every cmdServe call in this file writes here, never into the real tmpdir. */
const tempDirFor = () => join(cwd, 'litellm');

beforeEach(() => {
  // Cooldowns are module-level state (see router.ts), so a candidate key
  // reused across tests in this file (e.g. "first"/"second") would otherwise
  // carry a cooldown set by an earlier test's failed forward — silently
  // skipping that candidate here instead of exercising it.
  clearCooldowns();
  cwd = mkdtempSync(join(tmpdir(), 'sonata-serve-cwd-'));
  home = mkdtempSync(join(tmpdir(), 'sonata-serve-home-'));
  handles = [];
  writeFileSync(join(cwd, 'sonata.toml'), `
[native.models."deepseek-v4-flash"]
gateway = "acme"
id = "deepseek-v4-flash-0731"
context_window = 128000

[native.gateways."acme"]
base_url = "https://gateway.example/v1"

[native.ports]
router = 0
litellm = 4000
`);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(handles.map((handle) => handle.stop()));
  rmSync(cwd, { force: true, recursive: true });
  rmSync(home, { force: true, recursive: true });
});

/** Writes a codex login credential in codex's own nested shape. */
function writeCodexAuth(at: string, tokens: Record<string, unknown>): void {
  mkdirSync(join(at, '.codex'), { recursive: true });
  writeFileSync(join(at, '.codex', 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens }));
}

/** A JWT whose payload carries `exp`; only the payload is ever read. */
function jwt(exp: number): string {
  const body = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  return `header.${body}.signature`;
}

const CODEX_CONFIG = `
[native.models."gpt-5.6-luna"]
gateway = "codex"
id = "gpt-5.6-luna"
context_window = 128000

[native.gateways."codex"]
auth = "codex-oauth"

[native.ports]
router = 0
litellm = 4000
`;

// Runs cmdServe far enough to capture the env it built for litellm, then stops.
async function serveWith(
  gatewayToml: string,
  o: { withCodexAuth?: boolean; withSonataCredential?: boolean } = {},
) {
  const home = mkdtempSync(join(tmpdir(), 'serve-src-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'serve-src-cwd-'));
  const tempDir = mkdtempSync(join(tmpdir(), 'serve-src-temp-'));
  writeFileSync(join(cwd, 'sonata.toml'),
    `[native]\n[native.ports]\nrouter = 0\nlitellm = 4101\n${gatewayToml}`);
  if (o.withCodexAuth) {
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex/auth.json'), JSON.stringify({ tokens: { access_token: 'x' } }));
  }
  if (o.withSonataCredential !== false) {
    mkdirSync(join(home, '.config/sonata/credentials/codex'), { recursive: true });
    writeFileSync(join(home, '.config/sonata/credentials/codex/auth.json'), '{}');
  }
  let env: NodeJS.ProcessEnv = {};
  const stop = await cmdServe({
    home, cwd, tempDir,
    spawnLitellm: (_c, e) => { env = e; return { pid: 1, kill() {} }; },
    waitForLitellm: async () => {},
  });
  const cleanup = async () => {
    await stop.stop();
    rmSync(home, { force: true, recursive: true });
    rmSync(cwd, { force: true, recursive: true });
  };
  return { home, cwd, tempDir, env, cleanup };
}

describe('cmdServe', () => {
  it('resolves keys into the LiteLLM child environment under the gateway variable', async () => {
    writeSonataKey(home, 'acme', 'the-key');
    let captured: NodeJS.ProcessEnv = {};

    const handle = await cmdServe({
      cwd,
      home,
      tempDir: tempDirFor(),
      waitForLitellm: async () => {}, spawnLitellm: (_configPath, env) => {
        captured = env;
        return { pid: 1, kill() {} };
      },
    });
    handles.push(handle);

    expect(captured.SONATA_KEY_ACME).toBe('the-key');
    expect(captured).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('honors an api-key gateway credential_source over automatic precedence', async () => {
    writeFileSync(join(cwd, 'sonata.toml'), `
[native.models."deepseek-v4-flash"]
gateway = "acme"
id = "deepseek-v4-flash-0731"
context_window = 128000

[native.gateways."acme"]
base_url = "https://gateway.example/v1"
credential_source = "opencode"

[native.ports]
router = 0
litellm = 4000
`);
    writeSonataKey(home, 'acme', 'sonata-key');
    mkdirSync(join(home, '.local/share/opencode'), { recursive: true });
    writeFileSync(join(home, '.local/share/opencode/auth.json'), JSON.stringify({ acme: { key: 'opencode-key' } }));
    let captured: NodeJS.ProcessEnv = {};

    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(),
      waitForLitellm: async () => {}, spawnLitellm: (_configPath, env) => {
        captured = env;
        return { pid: 1, kill() {} };
      },
    });
    handles.push(handle);

    expect(captured.SONATA_KEY_ACME).toBe('opencode-key');
  });

  it('refuses an api-key gateway with a missing configured credential source', async () => {
    writeFileSync(join(cwd, 'sonata.toml'), `
[native.models."deepseek-v4-flash"]
gateway = "acme"
id = "deepseek-v4-flash-0731"
context_window = 128000

[native.gateways."acme"]
base_url = "https://gateway.example/v1"
credential_source = "opencode"

[native.ports]
router = 0
litellm = 4000
`);
    writeSonataKey(home, 'acme', 'sonata-key');

    await expect(cmdServe({
      cwd, home, tempDir: tempDirFor(),
      waitForLitellm: async () => {}, spawnLitellm: () => ({ pid: 1, kill() {} }),
    })).rejects.toThrow(/takes its credential from opencode but none was found/);
  });

  it('serves a health endpoint on the router port', async () => {
    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(),
      waitForLitellm: async () => {}, spawnLitellm: () => ({ pid: 1, kill() {} }),
    });
    handles.push(handle);

    const response = await fetch(serveHealthUrl(handle.routerPort));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      status: 'ok', sonata: true, configPath: join(cwd, 'sonata.toml'),
    });
    expect(typeof body.instanceId).toBe('string');
    expect(body.instanceId.length).toBeGreaterThan(0);
  });

  it('reads its instance id from the environment when set, for a daemon-spawned process', async () => {
    const previous = process.env.SONATA_SERVE_INSTANCE_ID;
    process.env.SONATA_SERVE_INSTANCE_ID = 'fixed-test-id';
    try {
      const handle = await cmdServe({
        cwd, home, tempDir: tempDirFor(),
        waitForLitellm: async () => {}, spawnLitellm: () => ({ pid: 1, kill() {} }),
      });
      handles.push(handle);

      const response = await fetch(serveHealthUrl(handle.routerPort));
      const body = await response.json();
      expect(body.instanceId).toBe('fixed-test-id');
    } finally {
      if (previous === undefined) delete process.env.SONATA_SERVE_INSTANCE_ID;
      else process.env.SONATA_SERVE_INSTANCE_ID = previous;
    }
  });

  it('prefers an injected instance id over the environment variable', async () => {
    const previous = process.env.SONATA_SERVE_INSTANCE_ID;
    process.env.SONATA_SERVE_INSTANCE_ID = 'env-value';
    try {
      const handle = await cmdServe({
        cwd, home, tempDir: tempDirFor(),
        waitForLitellm: async () => {}, spawnLitellm: () => ({ pid: 1, kill() {} }),
        instanceId: 'injected-value',
      });
      handles.push(handle);

      const response = await fetch(serveHealthUrl(handle.routerPort));
      const body = await response.json();
      expect(body.instanceId).toBe('injected-value');
    } finally {
      if (previous === undefined) delete process.env.SONATA_SERVE_INSTANCE_ID;
      else process.env.SONATA_SERVE_INSTANCE_ID = previous;
    }
  });

  it('generates its own instance id when neither the env var nor an injected one is present', async () => {
    const previous = process.env.SONATA_SERVE_INSTANCE_ID;
    delete process.env.SONATA_SERVE_INSTANCE_ID;
    try {
      const handle = await cmdServe({
        cwd, home, tempDir: tempDirFor(),
        waitForLitellm: async () => {}, spawnLitellm: () => ({ pid: 1, kill() {} }),
      });
      handles.push(handle);

      const response = await fetch(serveHealthUrl(handle.routerPort));
      const body = await response.json();
      expect(typeof body.instanceId).toBe('string');
      expect(body.instanceId.length).toBeGreaterThan(0);
    } finally {
      if (previous === undefined) delete process.env.SONATA_SERVE_INSTANCE_ID;
      else process.env.SONATA_SERVE_INSTANCE_ID = previous;
    }
  });

  it('refuses to start when [native] is absent', async () => {
    const noNative = mkdtempSync(join(tmpdir(), 'sonata-serve-no-native-'));
    writeFileSync(join(noNative, 'sonata.toml'), '[models."x"]\nharness = "codex"\nid = "gpt"\n');

    await expect(cmdServe({ cwd: noNative, home })).rejects.toThrow(/no \[native\]/);
    rmSync(noNative, { force: true, recursive: true });
  });

  it('removes its temp directory when startup fails', async () => {
    const tempDir = tempDirFor();
    await expect(cmdServe({
      cwd, home, tempDir,
      spawnLitellm: () => ({ pid: 1, kill() {} }),
      waitForLitellm: async () => { throw new Error('never came up'); },
    })).rejects.toThrow(/never came up/);

    // The generated config carries a master key; a failed start must not leave it.
    expect(existsSync(tempDir)).toBe(false);
  });

  it('never writes into the real system temp directory when a tempDir is given', async () => {
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith('sonata-litellm-'));
    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(),
      waitForLitellm: async () => {}, spawnLitellm: () => ({ pid: 1, kill() {} }),
    });
    handles.push(handle);

    const after = readdirSync(tmpdir()).filter((n) => n.startsWith('sonata-litellm-'));
    expect(after).toEqual(before);
  });

  it('records its own pid as routerPid once the router is listening, alongside the litellm pid', async () => {
    // `sonata restart` reads this to kill a stale router without scanning the
    // OS for a pid to guess at.
    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(),
      waitForLitellm: async () => {}, spawnLitellm: () => ({ pid: 4242, kill() {} }),
    });
    handles.push(handle);

    const state = JSON.parse(readFileSync(serveStatePath(home), 'utf8'));
    expect(state.routerPid).toBe(process.pid);
    expect(state.litellmPid).toBe(4242);
  });

  it('stop() resolves promptly even with an open idle keep-alive connection', async () => {
    // Plain server.close() waits for every open connection to end on its
    // own — an idle keep-alive socket that outlives the request it served
    // can sit open indefinitely, which is what made a live restart wait
    // past its own timeout for a router that had actually been told to
    // stop. Simulate that lingering socket directly with net, since a real
    // keep-alive HTTP client would close it once idle and hide the bug.
    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(),
      waitForLitellm: async () => {}, spawnLitellm: () => ({ pid: 1, kill() {} }),
    });

    const net = await import('node:net');
    const socket = net.connect(handle.routerPort, 'localhost');
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('error', reject);
    });
    // Give the server side a moment to register the connection — otherwise
    // stop() can race ahead of the server's own 'connection' event.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const started = Date.now();
    await handle.stop();
    expect(Date.now() - started).toBeLessThan(1500);

    socket.destroy();
  });
});

describe('cmdServe — litellm respawn', () => {
  it('respawns litellm when it exits on its own, and updates the recorded pid', async () => {
    let spawnCount = 0;
    let exitCb: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(),
      waitForLitellm: async () => {},
      respawnDelayMs: 0,
      spawnLitellm: () => {
        spawnCount += 1;
        const pid = spawnCount;
        return { pid, kill() {}, onExit: (cb) => { exitCb = cb; } };
      },
    });
    handles.push(handle);
    expect(spawnCount).toBe(1);

    exitCb?.(1, null);
    // Respawn is scheduled via a microtask/timer chain (respawnDelayMs: 0 still awaits a tick).
    await new Promise((r) => setTimeout(r, 10));

    expect(spawnCount).toBe(2);
    const state = JSON.parse(readFileSync(serveStatePath(home), 'utf8'));
    expect(state.litellmPid).toBe(2);
  });

  it('gives up after too many respawns within the window, without spawning again', async () => {
    let spawnCount = 0;
    let exitCb: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(),
      waitForLitellm: async () => {},
      respawnDelayMs: 0,
      maxRespawns: 2,
      spawnLitellm: () => {
        spawnCount += 1;
        return { pid: spawnCount, kill() {}, onExit: (cb) => { exitCb = cb; } };
      },
    });
    handles.push(handle);

    for (let i = 0; i < 3; i++) {
      exitCb?.(1, null);
      await new Promise((r) => setTimeout(r, 10));
    }

    // 1 initial + 2 tolerated respawns = 3 spawns; the 3rd crash is not retried.
    expect(spawnCount).toBe(3);
  });

  it('does not respawn after stop() has been called', async () => {
    let spawnCount = 0;
    let exitCb: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(),
      waitForLitellm: async () => {},
      respawnDelayMs: 0,
      spawnLitellm: () => {
        spawnCount += 1;
        return { pid: spawnCount, kill() {}, onExit: (cb) => { exitCb = cb; } };
      },
    });
    await handle.stop();

    exitCb?.(0, null);
    await new Promise((r) => setTimeout(r, 10));

    expect(spawnCount).toBe(1);
  });

  it('does not schedule a respawn when the child exits while startup itself is failing', async () => {
    let spawnCount = 0;
    const handle = cmdServe({
      cwd, home, tempDir: tempDirFor(),
      respawnDelayMs: 0,
      // waitForLitellm throwing simulates a startup failure after the child
      // spawned; kill() firing its own exit synchronously simulates the real
      // child process actually dying when told to.
      waitForLitellm: async () => { throw new Error('never came up'); },
      spawnLitellm: () => {
        spawnCount += 1;
        let onExit: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
        return {
          pid: spawnCount,
          kill: () => onExit?.(null, 'SIGTERM'),
          onExit: (cb) => { onExit = cb; },
        };
      },
    });
    await expect(handle).rejects.toThrow(/never came up/);

    await new Promise((r) => setTimeout(r, 10));
    expect(spawnCount).toBe(1);
  });

  it('gates litellm-bound requests on the respawned child, not just the crashed one', async () => {
    // Without gating, a request landing in the gap between the crash and the
    // respawned child answering gets a connection-refused failure instead of
    // waiting the brief moment for the recovery already in flight — which
    // would cool the candidate down for a crash it had nothing to do with.
    // Uses its own unlikely-to-collide litellm port rather than the shared
    // beforeEach fixture's 4000, since nothing must actually be listening
    // there for the post-release request to still fail on its own merits.
    writeFileSync(join(cwd, 'sonata.toml'), `
[native.models."deepseek-v4-flash"]
gateway = "acme"
id = "deepseek-v4-flash-0731"
context_window = 128000

[native.gateways."acme"]
base_url = "https://gateway.example/v1"

[native.ports]
router = 0
litellm = 39217
`);

    let waitCalls = 0;
    let releaseRespawnWait: () => void = () => {};
    let exitCb: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;

    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(),
      respawnDelayMs: 0,
      waitForLitellm: async () => {
        waitCalls += 1;
        if (waitCalls === 1) return;
        await new Promise<void>((resolve) => { releaseRespawnWait = resolve; });
      },
      spawnLitellm: () => ({ pid: 1, kill() {}, onExit: (cb) => { exitCb = cb; } }),
    });
    handles.push(handle);
    expect(waitCalls).toBe(1);

    exitCb?.(1, null);
    // Let the respawnDelayMs:0 tick fire and the second waitForLitellm start.
    await new Promise((r) => setTimeout(r, 10));
    expect(waitCalls).toBe(2);

    let settled = false;
    const req = fetch(`http://localhost:${handle.routerPort}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'deepseek-v4-flash' }),
    }).then((res) => { settled = true; return res; });

    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);

    releaseRespawnWait();
    const res = await req;
    expect(settled).toBe(true);
    // Nothing is actually listening on the litellm port in this test, so the
    // request still fails once released — the point is it waited for the gate.
    expect(res.status).toBe(502);
  });
});

describe('cmdServe — tier resolution', () => {
  it('restarts litellm when the unified model registry changes, but not for an unchanged config', async () => {
    const config = (model: string) => `
[models."${model}"]
gateway = "acme"
id = "${model}-upstream"
context_window = 128000

[tiers.code]
simple = ["${model}"]
complex = ["${model}"]

[native.gateways."acme"]
base_url = "https://gateway.example/v1"

[native.ports]
router = 0
litellm = 43120
`;
    writeFileSync(join(cwd, 'sonata.toml'), config('first'));

    let spawnCount = 0;
    const configs: string[] = [];
    const exits: Array<Array<(code: number | null, signal: NodeJS.Signals | null) => void>> = [];
    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(),
      waitForLitellm: async () => {},
      spawnLitellm: (configPath) => {
        spawnCount += 1;
        configs.push(readFileSync(configPath, 'utf8'));
        return {
          pid: spawnCount,
          kill: () => exits[spawnCount - 1]?.forEach((cb) => cb(null, 'SIGTERM')),
          onExit: (cb) => { (exits[spawnCount - 1] ??= []).push(cb); },
        };
      },
    });
    handles.push(handle);
    expect(spawnCount).toBe(1);

    writeFileSync(join(cwd, 'sonata.toml'), config('second'));
    const changed = await fetch(`http://localhost:${handle.routerPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'sonata-code-simple', messages: [] }),
    });
    expect(changed.status).toBe(529);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(spawnCount).toBe(2);
    expect(configs[1]).toContain('second-upstream');

    const unchanged = await fetch(`http://localhost:${handle.routerPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'sonata-code-simple', messages: [] }),
    });
    expect(unchanged.status).toBe(529);
    expect(spawnCount).toBe(2);
  });

  it('restarts litellm when only a gateway field changes, even if the model list is untouched', async () => {
    // Rerunning `sonata init` without touching model selection can still
    // rewrite a gateway's base_url, wire_format, auth, or credential_source.
    // Comparing only `unifiedModels` (not gateways too) would leave litellm's
    // generated config — and its credential environment — stale indefinitely
    // in that case, since the model list itself never changed.
    const config = (baseUrl: string) => `
[models."fixed"]
gateway = "acme"
id = "fixed-upstream"
context_window = 128000

[tiers.code]
simple = ["fixed"]
complex = ["fixed"]

[native.gateways."acme"]
base_url = "${baseUrl}"

[native.ports]
router = 0
litellm = 43115
`;
    writeFileSync(join(cwd, 'sonata.toml'), config('https://gateway-one.example/v1'));

    let spawnCount = 0;
    const exits: Array<Array<(code: number | null, signal: NodeJS.Signals | null) => void>> = [];
    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(),
      waitForLitellm: async () => {},
      spawnLitellm: () => {
        spawnCount += 1;
        return {
          pid: spawnCount,
          kill: () => exits[spawnCount - 1]?.forEach((cb) => cb(null, 'SIGTERM')),
          onExit: (cb) => { (exits[spawnCount - 1] ??= []).push(cb); },
        };
      },
    });
    handles.push(handle);
    expect(spawnCount).toBe(1);

    // Only the gateway's base_url changes — "fixed" stays the only model.
    writeFileSync(join(cwd, 'sonata.toml'), config('https://gateway-two.example/v1'));
    const response = await fetch(`http://localhost:${handle.routerPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'sonata-code-simple', messages: [] }),
    });
    expect(response.status).toBe(529);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(spawnCount).toBe(2);
  });

  it('restarts litellm when a legacy [native.models] entry changes, not just unified [models]', async () => {
    // litellmConfig (native/litellm.ts) builds its model list from
    // `native.models` first, unconditionally — a transitional config with a
    // tiered unified model AND a separate untracked legacy model both feed
    // litellm's config, so editing the legacy entry alone must restart it
    // too, even though `unifiedModels` and `gateways` are both unchanged.
    const config = (legacyId: string) => `
[models."current"]
gateway = "acme"
id = "current-upstream"
context_window = 128000

[tiers.code]
simple = ["current"]
complex = ["current"]

[native.models."legacy"]
gateway = "acme"
id = "${legacyId}"
context_window = 128000

[native.gateways."acme"]
base_url = "https://gateway.example/v1"

[native.ports]
router = 0
litellm = 43114
`;
    writeFileSync(join(cwd, 'sonata.toml'), config('legacy-upstream-v1'));

    let spawnCount = 0;
    const configs: string[] = [];
    const exits: Array<Array<(code: number | null, signal: NodeJS.Signals | null) => void>> = [];
    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(),
      waitForLitellm: async () => {},
      spawnLitellm: (configPath) => {
        spawnCount += 1;
        configs.push(readFileSync(configPath, 'utf8'));
        return {
          pid: spawnCount,
          kill: () => exits[spawnCount - 1]?.forEach((cb) => cb(null, 'SIGTERM')),
          onExit: (cb) => { (exits[spawnCount - 1] ??= []).push(cb); },
        };
      },
    });
    handles.push(handle);
    expect(spawnCount).toBe(1);

    // Only the legacy entry's id changes — unifiedModels and gateways don't.
    writeFileSync(join(cwd, 'sonata.toml'), config('legacy-upstream-v2'));
    const response = await fetch(`http://localhost:${handle.routerPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // A direct model request, exactly what `sonata dispatch --model legacy` sends.
      body: JSON.stringify({ model: 'legacy', messages: [] }),
    });
    expect(response.status).toBe(502);
    expect(spawnCount).toBe(2);
    expect(configs[1]).toContain('legacy-upstream-v2');
  });

  it('rebuilds the LiteLLM child environment when a new gateway is added', async () => {
    const config = (includeOther: boolean) => `
[models."first"]
gateway = "acme"
id = "first-upstream"
context_window = 128000

${includeOther ? `[models."second"]
gateway = "other"
id = "second-upstream"
context_window = 128000
` : ''}
[tiers.code]
simple = ["${includeOther ? 'second' : 'first'}"]
complex = ["${includeOther ? 'second' : 'first'}"]

[native.gateways."acme"]
base_url = "https://gateway.example/v1"

${includeOther ? `[native.gateways."other"]
base_url = "https://other-gateway.example/v1"
` : ''}
[native.ports]
router = 0
litellm = 43122
`;
    writeSonataKey(home, 'acme', 'acme-key');
    writeSonataKey(home, 'other', 'other-key');
    writeFileSync(join(cwd, 'sonata.toml'), config(false));

    const envs: NodeJS.ProcessEnv[] = [];
    const exits: Array<Array<(code: number | null, signal: NodeJS.Signals | null) => void>> = [];
    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(),
      waitForLitellm: async () => {},
      spawnLitellm: (_configPath, env) => {
        const index = envs.push({ ...env }) - 1;
        return {
          pid: index + 1,
          kill: () => exits[index]?.forEach((cb) => cb(null, 'SIGTERM')),
          onExit: (cb) => { (exits[index] ??= []).push(cb); },
        };
      },
    });
    handles.push(handle);
    expect(envs[0]).toMatchObject({ SONATA_KEY_ACME: 'acme-key' });
    expect(envs[0]).not.toHaveProperty('SONATA_KEY_OTHER');

    writeFileSync(join(cwd, 'sonata.toml'), config(true));
    const response = await fetch(`http://localhost:${handle.routerPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'sonata-code-simple', messages: [] }),
    });

    expect(response.status).toBe(529);
    expect(envs).toHaveLength(2);
    expect(envs[1]).toMatchObject({
      SONATA_KEY_ACME: 'acme-key',
      SONATA_KEY_OTHER: 'other-key',
    });
  });

  it('waits for the old litellm child to exit before spawning its replacement', async () => {
    const config = (model: string) => `
[models."${model}"]
gateway = "acme"
id = "${model}-upstream"
context_window = 128000

[tiers.code]
simple = ["${model}"]
complex = ["${model}"]

[native.gateways."acme"]
base_url = "https://gateway.example/v1"

[native.ports]
router = 0
litellm = 43121
`;
    writeFileSync(join(cwd, 'sonata.toml'), config('first'));

    let spawnCount = 0;
    const exits: Array<Array<(code: number | null, signal: NodeJS.Signals | null) => void>> = [];
    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(),
      waitForLitellm: async () => {},
      spawnLitellm: () => {
        spawnCount += 1;
        return {
          pid: spawnCount,
          kill: () => {},
          onExit: (cb) => { (exits[spawnCount - 1] ??= []).push(cb); },
        };
      },
    });
    handles.push(handle);
    expect(spawnCount).toBe(1);

    writeFileSync(join(cwd, 'sonata.toml'), config('second'));
    const request = fetch(`http://localhost:${handle.routerPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'sonata-code-simple', messages: [] }),
    });
    // Let the request enter the router and register the restart's exit
    // listener, but do not fire that event yet. Polled rather than a fixed
    // sleep: the request reaches the router only after a real loopback HTTP
    // round trip, whose timing is not bounded tightly enough by a flat delay
    // to avoid flaking under load.
    const deadline = Date.now() + 2000;
    while ((exits[0]?.length ?? 0) < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(spawnCount).toBe(1);
    expect(exits[0]?.length).toBeGreaterThanOrEqual(2);

    exits[0]?.forEach((cb) => cb(null, 'SIGTERM'));
    const response = await request;
    expect(response.status).toBe(529);
    expect(spawnCount).toBe(2);
  });

  it('wires resolveTier so a sonata-<role>-<tier> alias resolves against the config', async () => {
    writeFileSync(join(cwd, 'sonata.toml'), `
[models."flash"]
gateway = "acme"
id = "deepseek-v4-flash-0731"

[tiers.code]
simple = ["flash"]
complex = ["flash"]

[native.gateways."acme"]
base_url = "https://gateway.example/v1"

[native.ports]
router = 0
litellm = 43119
`);
    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(),
      waitForLitellm: async () => {}, spawnLitellm: () => ({ pid: 1, kill() {} }),
    });
    handles.push(handle);

    const res = await fetch(`http://localhost:${handle.routerPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'sonata-code-simple', messages: [] }),
    });
    // Nothing is actually listening on the (distinctly unused) litellm port in
    // this test, so the request cannot succeed — but a resolved alias fails as
    // an upstream connection error (529, every candidate exhausted), never the
    // "unknown alias" 400 an unresolved one would produce.
    expect(res.status).toBe(529);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain('unknown sonata tier alias');
    expect(JSON.stringify(body)).toContain('sonata dispatch --tier code-simple');
  });

  it('restarts litellm for a direct --model request too, not just a sonata-<tier> alias', async () => {
    // A direct request naming a native-only unified model key never goes
    // through resolveTier at all (the key is not a `sonata-*` alias), so this
    // is the one path that would still see litellm's startup-era model list
    // if the config-change check only fired from tier resolution.
    const config = (model: string) => `
[models."${model}"]
gateway = "acme"
id = "${model}-upstream"
context_window = 128000

[native.gateways."acme"]
base_url = "https://gateway.example/v1"

[native.ports]
router = 0
litellm = 43118
`;
    writeFileSync(join(cwd, 'sonata.toml'), config('direct-model'));

    let spawnCount = 0;
    const configs: string[] = [];
    const exits: Array<Array<(code: number | null, signal: NodeJS.Signals | null) => void>> = [];
    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(),
      waitForLitellm: async () => {},
      spawnLitellm: (configPath) => {
        spawnCount += 1;
        configs.push(readFileSync(configPath, 'utf8'));
        // kill() fires the registered exit callback, so the restart's
        // bounded wait for the old child resolves without needing the real
        // 5s default timeout — this test isn't exercising that wait.
        return {
          pid: spawnCount,
          kill: () => exits[spawnCount - 1]?.forEach((cb) => cb(null, 'SIGTERM')),
          onExit: (cb) => { (exits[spawnCount - 1] ??= []).push(cb); },
        };
      },
    });
    handles.push(handle);
    expect(spawnCount).toBe(1);

    writeFileSync(join(cwd, 'sonata.toml'), config('direct-model-renamed'));
    const response = await fetch(`http://localhost:${handle.routerPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Not a sonata-* alias — a plain native model key, exactly what
      // `sonata dispatch --model <key>` sends.
      body: JSON.stringify({ model: 'direct-model-renamed', messages: [] }),
    });
    expect(response.status).toBe(502);
    expect(spawnCount).toBe(2);
    expect(configs[1]).toContain('direct-model-renamed-upstream');
  });

  it('escalates to forceKill and proceeds once the old litellm child never exits on its own', async () => {
    const config = (model: string) => `
[models."${model}"]
gateway = "acme"
id = "${model}-upstream"
context_window = 128000

[tiers.code]
simple = ["${model}"]
complex = ["${model}"]

[native.gateways."acme"]
base_url = "https://gateway.example/v1"

[native.ports]
router = 0
litellm = 43117
`;
    writeFileSync(join(cwd, 'sonata.toml'), config('first'));

    let spawnCount = 0;
    let forceKillCalls = 0;
    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(),
      waitForLitellm: async () => {},
      litellmExitTimeoutMs: 20,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      spawnLitellm: () => {
        spawnCount += 1;
        return {
          pid: spawnCount,
          kill: () => {},
          // Never fires its exit callback — simulates a child that ignores
          // SIGTERM entirely, the case the bounded wait exists for.
          onExit: () => {},
          forceKill: () => { forceKillCalls += 1; },
        };
      },
    });
    handles.push(handle);
    expect(spawnCount).toBe(1);

    writeFileSync(join(cwd, 'sonata.toml'), config('second'));
    const response = await fetch(`http://localhost:${handle.routerPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'sonata-code-simple', messages: [] }),
    });
    // Never resolves the request forever: it proceeds past both bounded
    // waits (escalating to forceKill once), spawns the replacement anyway,
    // and the request completes with the usual upstream-failure response.
    expect(response.status).toBe(529);
    expect(forceKillCalls).toBe(1);
    expect(spawnCount).toBe(2);
  });

  it('retries the restart on the next request after a failed one, instead of marking the change handled', async () => {
    // A gateway added with `credential_source = "sonata"` but no key stored
    // yet makes buildChildEnv throw. If the model snapshot were committed
    // before that point, a later request — after the credential is fixed —
    // would see no difference from the (already-updated) snapshot and skip
    // the restart forever, leaving the new model unreachable short of a
    // manual `sonata restart`.
    writeSonataKey(home, 'acme', 'acme-key');
    writeFileSync(join(cwd, 'sonata.toml'), `
[models."first"]
gateway = "acme"
id = "first-upstream"
context_window = 128000

[tiers.code]
simple = ["first"]
complex = ["first"]

[native.gateways."acme"]
base_url = "https://gateway.example/v1"

[native.ports]
router = 0
litellm = 43116
`);

    let spawnCount = 0;
    const configs: string[] = [];
    const exits: Array<Array<(code: number | null, signal: NodeJS.Signals | null) => void>> = [];
    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(),
      waitForLitellm: async () => {},
      spawnLitellm: (configPath) => {
        spawnCount += 1;
        configs.push(readFileSync(configPath, 'utf8'));
        return {
          pid: spawnCount,
          kill: () => exits[spawnCount - 1]?.forEach((cb) => cb(null, 'SIGTERM')),
          onExit: (cb) => { (exits[spawnCount - 1] ??= []).push(cb); },
        };
      },
    });
    handles.push(handle);
    expect(spawnCount).toBe(1);

    const configWithNewGateway = `
[models."first"]
gateway = "acme"
id = "first-upstream"
context_window = 128000

[models."second"]
gateway = "newgw"
id = "second-upstream"
context_window = 128000

[tiers.code]
simple = ["second"]
complex = ["second"]

[native.gateways."acme"]
base_url = "https://gateway.example/v1"

[native.gateways."newgw"]
base_url = "https://newgw.example/v1"
credential_source = "sonata"

[native.ports]
router = 0
litellm = 43116
`;
    writeFileSync(join(cwd, 'sonata.toml'), configWithNewGateway);

    const firstAttempt = await fetch(`http://localhost:${handle.routerPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'sonata-code-simple', messages: [] }),
    });
    // "newgw" has no stored key yet, so the restart's buildChildEnv step
    // throws internally (logged, not surfaced) and no restart happens —
    // the request still resolves the "second" tier candidate fine (config
    // parsing doesn't require the credential to exist) and fails the same
    // way any candidate with nothing listening does.
    expect(firstAttempt.status).toBe(529);
    expect(spawnCount).toBe(1);

    writeSonataKey(home, 'newgw', 'new-key');
    const secondAttempt = await fetch(`http://localhost:${handle.routerPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'sonata-code-simple', messages: [] }),
    });
    expect(secondAttempt.status).toBe(529);
    // The one candidate ("second") is still cooling down from the first
    // attempt's real connection failure, so this response returns without
    // attempting a forward at all — the restart itself runs fire-and-forget
    // from checkModelChange and is not on the response's critical path, so
    // poll for it rather than assume it's finished the instant the response
    // itself resolves.
    const deadline = Date.now() + 2000;
    while (spawnCount < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(spawnCount).toBe(2);
    expect(configs[1]).toContain('second-upstream');
  });
});

describe('cmdServe — codex-oauth gateways', () => {
  it('writes the flattened ChatGPT credential and points LiteLLM at it', async () => {
    writeFileSync(join(cwd, 'sonata.toml'), CODEX_CONFIG);
    const exp = Math.floor(Date.now() / 1000) + 3600;
    writeCodexAuth(home, {
      access_token: jwt(exp), refresh_token: 'rt.1.abc',
      id_token: 'id.token', account_id: 'acct-42',
    });

    let captured: NodeJS.ProcessEnv = {};
    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(),
      waitForLitellm: async () => {},
      spawnLitellm: (_c, env) => { captured = env; return { pid: 1, kill() {} }; },
    });
    handles.push(handle);

    const tokenDir = captured.CHATGPT_TOKEN_DIR!;
    expect(tokenDir).toBeDefined();
    const record = JSON.parse(readFileSync(join(tokenDir, 'auth.json'), 'utf8'));

    // Codex nests these under `tokens`; LiteLLM's Authenticator reads them flat.
    expect(record.access_token).toBe(jwt(exp));
    expect(record.refresh_token).toBe('rt.1.abc');
    expect(record.account_id).toBe('acct-42');
    // Derived from the JWT so LiteLLM does not have to re-decode it.
    expect(record.expires_at).toBe(exp);

    // A credential file must not be world-readable.
    expect(statSync(join(tokenDir, 'auth.json')).mode & 0o077).toBe(0);
  });

  it('does not invent a SONATA_KEY for a gateway that carries no key', async () => {
    writeFileSync(join(cwd, 'sonata.toml'), CODEX_CONFIG);
    writeCodexAuth(home, { access_token: jwt(Math.floor(Date.now() / 1000) + 3600) });

    let captured: NodeJS.ProcessEnv = {};
    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(),
      waitForLitellm: async () => {},
      spawnLitellm: (_c, env) => { captured = env; return { pid: 1, kill() {} }; },
    });
    handles.push(handle);

    expect(captured).not.toHaveProperty('SONATA_KEY_CODEX');
  });

  it('refuses to start when codex is not logged in, naming the file and the fix', async () => {
    writeFileSync(join(cwd, 'sonata.toml'), CODEX_CONFIG);

    await expect(cmdServe({
      cwd, home, tempDir: tempDirFor(),
      waitForLitellm: async () => {}, spawnLitellm: () => ({ pid: 1, kill() {} }),
    })).rejects.toThrow(/codex login/);
  });

  it('removes the credential file when serve stops', async () => {
    writeFileSync(join(cwd, 'sonata.toml'), CODEX_CONFIG);
    writeCodexAuth(home, { access_token: jwt(Math.floor(Date.now() / 1000) + 3600) });

    let captured: NodeJS.ProcessEnv = {};
    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(),
      waitForLitellm: async () => {},
      spawnLitellm: (_c, env) => { captured = env; return { pid: 1, kill() {} }; },
    });
    const authFile = join(captured.CHATGPT_TOKEN_DIR!, 'auth.json');
    expect(existsSync(authFile)).toBe(true);

    await handle.stop();
    expect(existsSync(authFile)).toBe(false);
  });
});

const COPILOT_CONFIG = `
[native.models."gpt4o-copilot"]
gateway = "copilot"
id = "gpt-4o"
context_window = 128000

[native.gateways."copilot"]
auth = "copilot-oauth"

[native.ports]
router = 0
litellm = 4000
`;

function writeOpencodeAuth(at: string, entries: Record<string, unknown>): void {
  mkdirSync(join(at, '.local', 'share', 'opencode'), { recursive: true });
  writeFileSync(join(at, '.local', 'share', 'opencode', 'auth.json'), JSON.stringify(entries));
}

describe('credential source', () => {
  it('points the token dir at the persistent path and writes no temp copy', async () => {
    const { home, tempDir, env, cleanup } = await serveWith(`
[native.gateways.codex]
auth = "codex-oauth"
credential_source = "sonata"
`);
    try {
      expect(env.CHATGPT_TOKEN_DIR).toBe(join(home, '.config/sonata/credentials/codex'));
      // LiteLLM refreshes tokens into this file; a temp copy throws that away.
      expect(existsSync(join(tempDir, 'chatgpt'))).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('still flattens codex auth into the temp dir for the codex source', async () => {
    const { tempDir, env, home, cleanup } = await serveWith(`
[native.gateways.codex]
auth = "codex-oauth"
credential_source = "codex"
`, { withCodexAuth: true });
    try {
      expect(env.CHATGPT_TOKEN_DIR).toBe(join(tempDir, 'chatgpt'));
      expect(statSync(join(tempDir, 'chatgpt/auth.json')).mode & 0o777).toBe(0o600);
      expect(home).toBeTruthy();
    } finally {
      await cleanup();
    }
  });

  it('refuses with the login remedy when the sonata credential is missing', async () => {
    await expect(serveWith(`
[native.gateways.codex]
auth = "codex-oauth"
credential_source = "sonata"
`, { withSonataCredential: false })).rejects.toThrow(/sonata auth login codex/);
  });
});

describe('cmdServe — copilot-oauth gateways', () => {
  it('writes the GitHub token where LiteLLM expects it and points at the dir', async () => {
    writeFileSync(join(cwd, 'sonata.toml'), COPILOT_CONFIG);
    writeOpencodeAuth(home, { 'github-copilot': { type: 'oauth', access: 'gho_tok', refresh: 'r' } });

    let captured: NodeJS.ProcessEnv = {};
    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(),
      waitForLitellm: async () => {},
      spawnLitellm: (_c, env) => { captured = env; return { pid: 1, kill() {} }; },
    });
    handles.push(handle);

    const dir = captured.GITHUB_COPILOT_TOKEN_DIR!;
    expect(dir).toBeDefined();
    // LiteLLM's provider reads the GitHub token from a plain `access-token`
    // file and exchanges it for a Copilot key itself.
    expect(readFileSync(join(dir, 'access-token'), 'utf8')).toBe('gho_tok');
    expect(statSync(join(dir, 'access-token')).mode & 0o077).toBe(0);
    expect(captured).not.toHaveProperty('SONATA_KEY_COPILOT');
  });

  it('refuses to start without a Copilot login, naming the fix', async () => {
    writeFileSync(join(cwd, 'sonata.toml'), COPILOT_CONFIG);
    await expect(cmdServe({
      cwd, home, tempDir: tempDirFor(),
      waitForLitellm: async () => {}, spawnLitellm: () => ({ pid: 1, kill() {} }),
    })).rejects.toThrow(/opencode auth login/);
  });

  it('sources a ChatGPT credential from opencode when codex has none', async () => {
    writeFileSync(join(cwd, 'sonata.toml'), CODEX_CONFIG);
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const body = Buffer.from(JSON.stringify({
      exp, client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
    })).toString('base64url');
    writeOpencodeAuth(home, {
      openai: { type: 'oauth', access: `h.${body}.s`, refresh: 'rt-oc', accountId: 'acct-oc' },
    });

    let captured: NodeJS.ProcessEnv = {};
    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(),
      waitForLitellm: async () => {},
      spawnLitellm: (_c, env) => { captured = env; return { pid: 1, kill() {} }; },
    });
    handles.push(handle);

    const record = JSON.parse(readFileSync(join(captured.CHATGPT_TOKEN_DIR!, 'auth.json'), 'utf8'));
    expect(record.refresh_token).toBe('rt-oc');
    expect(record.account_id).toBe('acct-oc');
  });
});

describe('occupiedPortMessage', () => {
  const health = (body: unknown, ok = true): typeof fetch =>
    (async () => new Response(JSON.stringify(body), { status: ok ? 200 : 500 })) as unknown as typeof fetch;

  it('names sonata when the port is held by a sonata router', async () => {
    // Health probing distinguishes a Sonata router from an unrelated listener.
    const message = await occupiedPortMessage(4100, health({ status: 'ok', sonata: true }));
    expect(message).toMatch(/another sonata router/);
    expect(message).toMatch(/restart it/);
    expect(message).not.toMatch(/non-sonata/);
  });

  it('says non-sonata when something else holds the port', async () => {
    const message = await occupiedPortMessage(4100, health({ hello: 'world' }));
    expect(message).toMatch(/occupied by a non-sonata listener/);
  });

  it('says non-sonata when nothing answers the health endpoint', async () => {
    const dead = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    expect(await occupiedPortMessage(4100, dead)).toMatch(/non-sonata/);
  });

  it('says non-sonata when the endpoint errors', async () => {
    const message = await occupiedPortMessage(4100, health({ sonata: true }, false));
    expect(message).toMatch(/non-sonata/);
  });
});

describe('isSonataRouter', () => {
  it('is true only for the sonata health payload', async () => {
    const ok = (async () => new Response(JSON.stringify({ status: 'ok', sonata: true }))) as unknown as typeof fetch;
    const notJson = (async () => new Response('<html>')) as unknown as typeof fetch;
    expect(await isSonataRouter(4100, ok)).toBe(true);
    expect(await isSonataRouter(4100, notJson)).toBe(false);
  });
});

describe('sonataRouterInstanceId', () => {
  it('resolves the instance id from the sonata health payload', async () => {
    const ok = (async () =>
      new Response(JSON.stringify({ status: 'ok', sonata: true, instanceId: 'abc-123' }))) as unknown as typeof fetch;
    expect(await sonataRouterInstanceId(4100, ok)).toBe('abc-123');
  });

  it('returns null for a non-sonata or malformed response', async () => {
    const notSonata = (async () => new Response(JSON.stringify({ status: 'ok' }))) as unknown as typeof fetch;
    const notJson = (async () => new Response('<html>')) as unknown as typeof fetch;
    const noId = (async () => new Response(JSON.stringify({ status: 'ok', sonata: true }))) as unknown as typeof fetch;
    expect(await sonataRouterInstanceId(4100, notSonata)).toBeNull();
    expect(await sonataRouterInstanceId(4100, notJson)).toBeNull();
    expect(await sonataRouterInstanceId(4100, noId)).toBeNull();
  });
});

describe('startServeDaemon', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sonata-daemon-home-'));
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(join(home, '.config', 'sonata', 'sonata.toml'), `
[native.gateways."g"]
base_url = "http://gateway.example/v1"
[native.models."m"]
gateway = "g"
id = "model"
context_window = 128000
`);
  });
  afterEach(() => { rmSync(home, { force: true, recursive: true }); });

  const fakeSpawn = (pid = 4242) => (() => ({
    pid,
    unref: () => {},
  })) as unknown as typeof spawnType;

  it('spawns the daemon with the provided cwd, not the caller cwd', async () => {
    // Global routing is one shared router for every project; the daemon must
    // resolve the machine config regardless of which project's session
    // triggered the start, which requires spawning from an explicit cwd
    // rather than inheriting process.cwd().
    const opts: Parameters<typeof spawnType>[2][] = [];
    const spy = ((_cmd: string, _args: string[], o: never) => {
      opts.push(o);
      return { pid: 4242, unref: () => {} };
    }) as unknown as typeof spawnType;

    await startServeDaemon(home, ['node', 'cli.js', 'serve'], {
      spawn: spy,
      probe: async () => true,
    }, '/some/other/cwd');

    expect(opts[0]).toMatchObject({ cwd: '/some/other/cwd' });
  });

  it('detaches and returns once the router answers', async () => {
    // The flag used to be parsed, handed to cmdServe and ignored, so
    // `sonata serve --daemon` blocked exactly like the foreground command.
    const opts: Parameters<typeof spawnType>[2][] = [];
    const spy = ((_cmd: string, _args: string[], o: never) => {
      opts.push(o);
      return { pid: 4242, unref: () => {} };
    }) as unknown as typeof spawnType;

    const result = await startServeDaemon(home, ['node', 'cli.js', 'serve'], {
      spawn: spy,
      probe: async () => true,
    });

    expect(result.pid).toBe(4242);
    expect(result.port).toBe(4100);
    expect(opts[0]).toMatchObject({ detached: true });
    expect(existsSync(result.logPath)).toBe(true);
  });

  it('waits for the router rather than reporting success immediately', async () => {
    // A detached child that fails would otherwise leave the user with a
    // success message and no server.
    let attempts = 0;
    const result = await startServeDaemon(home, ['node', 'cli.js', 'serve'], {
      spawn: fakeSpawn(),
      probe: async () => ++attempts >= 3,
      sleep: async () => {},
    });
    expect(attempts).toBe(3);
    expect(result.port).toBe(4100);
  });

  it('does not accept a stale router with a different instance id as its own', async () => {
    // The exact bug this fixes: a stale daemon from a previous run is still
    // answering `sonata:true` on the port when a fresh spawn's poll begins.
    // The old check (`sonata === true`) would have accepted it immediately;
    // the fix must keep waiting until the id it generated itself is the one
    // reported back.
    let calls = 0;
    const result = await startServeDaemon(home, ['node', 'cli.js', 'serve'], {
      spawn: fakeSpawn(),
      // First two probes see the stale router (wrong id); the third sees the
      // freshly-spawned one (matching id, since the real default probe reads
      // the id this call generated and passed to the child's env).
      probe: async (_port, id) => {
        calls += 1;
        return calls >= 3 ? true : false;
      },
      sleep: async () => {},
    });
    expect(calls).toBe(3);
    expect(result.port).toBe(4100);
  });

  it('sets SONATA_SERVE_INSTANCE_ID on the spawned child so it can report back the matching id', async () => {
    const envs: (NodeJS.ProcessEnv | undefined)[] = [];
    const spy = ((_cmd: string, _args: string[], o: { env?: NodeJS.ProcessEnv }) => {
      envs.push(o.env);
      return { pid: 4242, unref: () => {} };
    }) as unknown as typeof spawnType;

    await startServeDaemon(home, ['node', 'cli.js', 'serve'], {
      spawn: spy,
      probe: async () => true,
    });

    expect(typeof envs[0]?.SONATA_SERVE_INSTANCE_ID).toBe('string');
    expect(envs[0]?.SONATA_SERVE_INSTANCE_ID?.length).toBeGreaterThan(0);
    expect(envs[0]?.PATH).toBe(process.env.PATH);
  });

  it('waits for the real default probe to see its own instance id, not just any healthy router', async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const spy = ((_cmd: string, _args: string[], o: { env?: NodeJS.ProcessEnv }) => {
      capturedEnv = o.env;
      return { pid: 4242, unref: () => {} };
    }) as unknown as typeof spawnType;

    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      if (calls < 3) {
        return new Response(JSON.stringify({ status: 'ok', sonata: true, instanceId: 'stale-id' }));
      }
      return new Response(JSON.stringify({
        status: 'ok', sonata: true, instanceId: capturedEnv?.SONATA_SERVE_INSTANCE_ID,
      }));
    }) as unknown as typeof fetch);

    const result = await startServeDaemon(home, ['node', 'cli.js', 'serve'], {
      spawn: spy,
      sleep: async () => {},
    });
    expect(calls).toBe(3);
    expect(result.port).toBe(4100);
  });

  it('gives up with the log path when the daemon never answers', async () => {
    let clock = 0;
    await expect(startServeDaemon(home, ['node', 'cli.js', 'serve'], {
      spawn: fakeSpawn(),
      probe: async () => false,
      sleep: async () => { clock += 500; },
      now: () => clock,
      timeoutMs: 2000,
    })).rejects.toThrow(/did not answer on port 4100.*serve-/s);
  });

  it('writes the daemon log into the shared log directory', async () => {
    const result = await startServeDaemon(home, ['node', 'cli.js', 'serve'], {
      spawn: fakeSpawn(), probe: async () => true,
    });
    expect(result.logPath).toContain(join('.config', 'sonata', 'logs'));
    expect(result.logPath).toMatch(/serve-.*\.log$/);
  });
});

const notSonataFetch: typeof fetch = (async () => new Response('', { status: 500 })) as unknown as typeof fetch;

describe('stopServe', () => {
  let cwd: string;
  let home: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'sonata-stop-cwd-'));
    home = mkdtempSync(join(tmpdir(), 'sonata-stop-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), `
[native.gateways."g"]
base_url = "http://gateway.example/v1"
[native.models."m"]
gateway = "g"
id = "model"
context_window = 128000
[native.ports]
router = 4100
litellm = 4000
`);
  });

  afterEach(() => {
    rmSync(cwd, { force: true, recursive: true });
    rmSync(home, { force: true, recursive: true });
  });

  const notSonata: typeof fetch = (async () => new Response('', { status: 500 })) as unknown as typeof fetch;
  const sonataHealth: typeof fetch = (async () =>
    new Response(JSON.stringify({ status: 'ok', sonata: true }))) as unknown as typeof fetch;

  it('is a no-op when nothing is running on the port', async () => {
    const result = await stopServe({ cwd, home, probeHealth: notSonata });
    expect(result.killed).toBe(false);
  });

  it('kills the recorded router and litellm pids and clears the state file', async () => {
    mkdirSync(dirname(serveStatePath(home)), { recursive: true });
    writeFileSync(serveStatePath(home), JSON.stringify({ routerPid: 111, litellmPid: 222 }));
    const killed: number[] = [];

    const result = await stopServe({
      cwd, home, probeHealth: sonataHealth, kill: (pid) => killed.push(pid), sleep: async () => {},
      isAlive: () => false,
    });

    expect(result.killed).toBe(true);
    expect(killed.sort()).toEqual([111, 222]);
    expect(existsSync(serveStatePath(home))).toBe(false);
  });

  it('refuses to kill when the port answers sonata but no pid was ever recorded', async () => {
    // Never guess a pid by scanning the OS — only a pid sonata itself
    // recorded is ever killed. `findPortPid` here simulates the lookup
    // itself failing (or finding nothing), so the message falls back to the
    // generic wording rather than naming a pid.
    await expect(stopServe({ cwd, home, probeHealth: sonataHealth, findPortPid: () => undefined }))
      .rejects.toThrow(/no recorded pid/);
  });

  it('names a killable pid when the port lookup finds exactly one', async () => {
    // Sonata still never kills this pid itself — the message only prints it,
    // as a copy-pasteable next step for the user.
    const result = await stopServe({
      cwd, home, probeHealth: sonataHealth, findPortPid: () => '48213',
    }).catch((e) => e as Error);
    expect((result as Error).message).toMatch(/kill 48213/);
  });

  it('falls back to the generic message when the port lookup is unavailable or ambiguous', async () => {
    const result = await stopServe({
      cwd, home, probeHealth: sonataHealth, findPortPid: () => undefined,
    }).catch((e) => e as Error);
    expect((result as Error).message).toMatch(/no recorded pid/);
    expect((result as Error).message).not.toMatch(/kill \d/);
  });

  it('throws if the killed pid is still alive, rather than reporting success', async () => {
    mkdirSync(dirname(serveStatePath(home)), { recursive: true });
    writeFileSync(serveStatePath(home), JSON.stringify({ routerPid: 111 }));
    const result = await stopServe({
      cwd, home, probeHealth: sonataHealth, kill: () => {}, sleep: async () => {},
      now: (() => { let t = 0; return () => (t += 1000); })(), timeoutMs: 2000,
      isAlive: () => true,
    }).catch((e) => e as Error);
    expect((result as Error).message).toMatch(/still running/);
  });

  it('does not mistake a supervisor-respawned router for the old one still dying', async () => {
    // A terminal running a keep-alive loop around `sonata serve` can grab the
    // port again within ~1s of it freeing — a brand-new, legitimate router.
    // The port never goes quiet, but the pids we killed are genuinely gone,
    // so this must report success rather than timing out.
    mkdirSync(dirname(serveStatePath(home)), { recursive: true });
    writeFileSync(serveStatePath(home), JSON.stringify({ routerPid: 111, litellmPid: 222 }));

    const result = await stopServe({
      cwd, home, probeHealth: sonataHealth, kill: () => {}, sleep: async () => {},
      isAlive: () => false,
    });

    expect(result.killed).toBe(true);
  });
});

describe('cmdRestart', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sonata-restart-home-'));
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(join(home, '.config', 'sonata', 'sonata.toml'), `
[native.gateways."g"]
base_url = "http://gateway.example/v1"
[native.models."m"]
gateway = "g"
id = "model"
context_window = 128000
`);
  });
  afterEach(() => { rmSync(home, { force: true, recursive: true }); });

  it('stops a stale router before starting a fresh daemon', async () => {
    writeFileSync(join(home, '.config', 'sonata', 'serve-state.json'), JSON.stringify({ routerPid: 111 }));
    const killed: number[] = [];
    let healthCalls = 0;
    // First call (inside stopServe): reports the stale router alive, then
    // gone. Later calls (inside startServeDaemon's probe): the fresh one.
    const probeHealth: typeof fetch = (async () => {
      healthCalls += 1;
      return healthCalls === 1 ? new Response(JSON.stringify({ sonata: true })) : new Response('', { status: 500 });
    }) as unknown as typeof fetch;

    const spawnSpy = (() => ({ pid: 999, unref: () => {} })) as unknown as typeof spawnType;

    const result = await cmdRestart(home, ['node', 'cli.js', 'serve'], {
      cwd: home,
      probeHealth, kill: (pid) => killed.push(pid), sleep: async () => {},
      spawn: spawnSpy, probe: async () => true,
      // Never assert real OS process liveness on a fake pid — 111 happens to
      // be a real, running process on at least one CI runner, which turned
      // this into a 10s timeout there while passing instantly on macOS.
      isAlive: () => false,
    });

    expect(killed).toEqual([111]);
    expect(result.pid).toBe(999);
  });

  it('starts fresh with nothing to stop when the port was already clear', async () => {
    const spawnSpy = (() => ({ pid: 777, unref: () => {} })) as unknown as typeof spawnType;
    const result = await cmdRestart(home, ['node', 'cli.js', 'serve'], {
      cwd: home,
      probeHealth: notSonataFetch, sleep: async () => {},
      spawn: spawnSpy, probe: async () => true,
    });
    expect(result.pid).toBe(777);
  });
});
