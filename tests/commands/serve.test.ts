import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import type { spawn as spawnType } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  cmdServe as realCmdServe, listenOn, killRecordedOrphan, mergeTenantGateways, resolvedOauthIdentity, serveHealthUrl, type ServeHandle, isSonataRouter, healthReportsUi, sonataRouterHasUi, occupiedPortMessage, startServeDaemon,
  serveStatePath, stopServe, cmdRestart, defaultWaitForLitellm, sonataRouterMultiTenant, processCommand,
  budgetStatusesFor,
} from '../../src/commands/serve.js';
import type { RouterTenant } from '../../src/native/router.js';
import { writeSonataKey } from '../../src/native/credentials.js';
import { credentialDir } from '../../src/native/oauth-login.js';
import { recordSession } from '../../src/sessions.js';
import { managedLitellmPath, venvDir, LITELLM_VERSION } from '../../src/native/litellm-venv.js';
import { clearCooldowns } from '../../src/native/router.js';
import { ensureRouterToken } from '../../src/native/router-token.js';
import { tenantId } from '../../src/native/tenants.js';
import { appendRow } from '../../src/ledger.js';
import { freePort } from '../free-port.js';
import { TORN_REPEAT_MS, UNREADABLE_STORE_WINDOW_MS } from '../../src/native/credential-reads.js';
import { sqliteAvailable, writeOpencodeCredDb } from '../opencode-db-fixture.js';

// Every cmdServe starts the models.dev price refresh, and a fresh test home has
// no cache, so each one fetched models.dev over the real network — unawaited
// and uncancellable, landing in whichever test was running when it resolved.
// The file's calls go through this, which swaps in a no-op.
const cmdServe: typeof realCmdServe = (opts) => realCmdServe({ refreshPrices: async () => {}, ...opts });

let cwd: string;

/**
 * A `process.kill` stand-in for a recorded orphan (pid 222): signal 0 answers
 * "alive" until the orphan has been sent `diesOn`. Every other pid behaves as
 * a live process that ignores signals. Pids and signals are recorded as
 * `signalled` (pids) and on the returned function's `signals`.
 */
function orphanKill(signalled: number[], diesOn: 'SIGTERM' | 'SIGKILL' | 'never', signals: string[] = []): typeof process.kill {
  let dead = false;
  return ((pid: number, signal?: string | number) => {
    if (signal === 0) {
      if (pid === 222 && dead) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      return true;
    }
    signalled.push(pid);
    const name = signal === undefined ? 'SIGTERM' : String(signal);
    if (pid === 222) signals.push(name);
    if (pid === 222 && diesOn !== 'never' && name === diesOn) dead = true;
    return true;
  }) as unknown as typeof process.kill;
}

let home: string;
let handles: ServeHandle[];
/** This test's LiteLLM port: free, and never the machine's real 4000. */
let litellmPort: number;

/** Every cmdServe call in this file writes here, never into the real tmpdir. */
const tempDirFor = () => join(cwd, 'litellm');

/**
 * The headers that name a project AND authorise the naming.
 *
 * The router honours `x-sonata-project` only from a caller holding the 0600
 * router token, so a test that omits it is testing the unauthorised path.
 */
function projectHeaders(project: string): Record<string, string> {
  return { 'x-sonata-project': project, 'x-sonata-token': ensureRouterToken(home) };
}

/** The machine config — the only file `serve` reads its own ports from, and the default tenant for a request naming no project. */
const machineConfigPath = () => join(home, '.config', 'sonata', 'sonata.toml');
function writeMachineConfig(toml: string): void {
  mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
  writeFileSync(machineConfigPath(), toml);
}

/**
 * A managed venv that satisfies `cmdServe`'s start gate.
 *
 * `serve` refuses to run when a config routes through LiteLLM and no managed
 * venv is installed — it never installs one itself, because
 * `hooks/ensure-serve.mjs` starts it headless where a multi-minute install
 * looks exactly like a hang. Every test in this file is about something else,
 * so they all get one; the gate has its own tests.
 */
function installFakeVenv(at: string): void {
  mkdirSync(join(venvDir(at), 'bin'), { recursive: true });
  writeFileSync(managedLitellmPath(at), '#!/bin/sh\n', { mode: 0o755 });
  writeFileSync(join(venvDir(at), '.sonata-pin'), LITELLM_VERSION);
}

beforeEach(async () => {
  // Cooldowns are module-level state (see router.ts), so a candidate key
  // reused across tests in this file (e.g. "first"/"second") would otherwise
  // carry a cooldown set by an earlier test's failed forward — silently
  // skipping that candidate here instead of exercising it.
  clearCooldowns();
  cwd = mkdtempSync(join(tmpdir(), 'sonata-serve-cwd-'));
  home = mkdtempSync(join(tmpdir(), 'sonata-serve-home-'));
  handles = [];
  litellmPort = await freePort();
  installFakeVenv(home);
  writeMachineConfig(`
[native.models."deepseek-v4-flash"]
gateway = "acme"
id = "deepseek-v4-flash-0731"
context_window = 128000

[native.gateways."acme"]
base_url = "https://gateway.example/v1"

[native.ports]
router = 0
litellm = ${litellmPort}
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

const CODEX_CONFIG = () => `
[native.models."gpt-5.6-luna"]
gateway = "codex"
id = "gpt-5.6-luna"
context_window = 128000

[native.gateways."codex"]
auth = "codex-oauth"

[native.ports]
router = 0
litellm = ${litellmPort}
`;

// Runs cmdServe far enough to capture the env it built for litellm, then stops.
async function serveWith(
  gatewayToml: string,
  o: { withCodexAuth?: boolean; withSonataCredential?: boolean } = {},
) {
  const home = mkdtempSync(join(tmpdir(), 'serve-src-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'serve-src-cwd-'));
  const tempDir = mkdtempSync(join(tmpdir(), 'serve-src-temp-'));
  installFakeVenv(home);
  // A gateway with nothing routing to it needs no litellm child, so there
  // would be no env to capture. These tests are about the credentials serve
  // builds FOR that child, which presupposes a model reaching the gateway.
  mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
  writeFileSync(join(home, '.config', 'sonata', 'sonata.toml'),
    `[native]\n[native.ports]\nrouter = 0\nlitellm = ${await freePort()}\n`
    + `[native.models."m"]\ngateway = "codex"\nid = "m-1"\ncontext_window = 1\n${gatewayToml}`);
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
    writeMachineConfig( `
[native.models."deepseek-v4-flash"]
gateway = "acme"
id = "deepseek-v4-flash-0731"
context_window = 128000

[native.gateways."acme"]
base_url = "https://gateway.example/v1"
credential_source = "opencode"

[native.ports]
router = 0
litellm = ${litellmPort}
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
    writeMachineConfig( `
[native.models."deepseek-v4-flash"]
gateway = "acme"
id = "deepseek-v4-flash-0731"
context_window = 128000

[native.gateways."acme"]
base_url = "https://gateway.example/v1"
credential_source = "opencode"

[native.ports]
router = 0
litellm = ${litellmPort}
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
      status: 'ok', sonata: true, multiTenant: true,
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
    writeMachineConfig('[models."x"]\nharness = "codex"\nid = "gpt"\n');

    await expect(cmdServe({ cwd, home })).rejects.toThrow(/no \[native\]/);
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

  it('closes the router when eager LiteLLM startup fails after binding', async () => {
    const net = await import('node:net');
    const routerPort = await freePort();

    await expect(cmdServe({
      cwd, home, tempDir: tempDirFor(), ports: { router: routerPort, litellm: litellmPort },
      spawnLitellm: () => ({ pid: 4242, kill: () => {} }),
      waitForLitellm: async () => { throw new Error('LiteLLM never came up'); },
    })).rejects.toThrow('LiteLLM never came up');

    expect(existsSync(serveStatePath(home, routerPort))).toBe(false);
    // Released on both families, not just the one `localhost` names.
    for (const host of ['127.0.0.1', '::1']) {
      const rebound = net.createServer();
      await new Promise<void>((resolve, reject) => {
        rebound.once('error', reject);
        rebound.listen(routerPort, host, () => resolve());
      });
      await new Promise<void>((resolve, reject) => rebound.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('preserves a replacement router record when eager startup later fails', async () => {
    const routerPort = await freePort();

    await expect(cmdServe({
      cwd, home, tempDir: tempDirFor(), ports: { router: routerPort, litellm: litellmPort },
      spawnLitellm: () => ({ pid: 4242, kill: () => {} }),
      waitForLitellm: async () => {
        // A replacement cannot bind while this router owns the port, so this
        // seam models the state rewrite directly; the catch must not clobber it.
        mkdirSync(dirname(serveStatePath(home, routerPort)), { recursive: true });
        writeFileSync(serveStatePath(home, routerPort), JSON.stringify({ routerPid: 999 }));
        throw new Error('LiteLLM never came up');
      },
    })).rejects.toThrow('LiteLLM never came up');

    expect(JSON.parse(readFileSync(serveStatePath(home, routerPort), 'utf8'))).toMatchObject({ routerPid: 999 });
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

    const state = JSON.parse(readFileSync(serveStatePath(home, 0), 'utf8'));
    expect(state.routerPid).toBe(process.pid);
    expect(state.litellmPid).toBe(4242);
  });

  it('does not touch the winner state when a second serve loses the router port race', async () => {
    const routerPort = await freePort();

    const winner = await cmdServe({
      cwd, home, tempDir: join(cwd, 'winner'), ports: { router: routerPort, litellm: litellmPort },
      waitForLitellm: async () => {}, spawnLitellm: () => ({ pid: 4242, kill: () => {} }),
    });
    handles.push(winner);
    const path = serveStatePath(home, routerPort);
    const before = JSON.parse(readFileSync(path, 'utf8'));

    await expect(cmdServe({
      cwd, home, tempDir: join(cwd, 'loser'), ports: { router: routerPort, litellm: litellmPort },
      waitForLitellm: async () => {}, spawnLitellm: () => ({ pid: 4343, kill: () => {} }),
    })).rejects.toThrow(/already served by another sonata router/);

    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      routerPid: before.routerPid,
      litellmPid: before.litellmPid,
    });
  });

  it('leaves the legacy unkeyed record alone when cleaning up its own orphan', async () => {
    // killRecordedOrphan is scoped to this router's port on purpose. The
    // legacy file names no port, so reading it here made that scoping
    // nominal: a daemon coming up on a port with no record of its own would
    // adopt a pre-upgrade record belonging to some other port's daemon and
    // kill its litellm child — and delete the record that daemon's own
    // `sonata restart` still needs.
    const legacy = join(home, '.config', 'sonata', 'serve-state.json');
    mkdirSync(dirname(legacy), { recursive: true });
    // Pids far past any real one, so the kill this test proves does NOT happen
    // could not have hit a live process even if the scoping were wrong.
    writeFileSync(legacy, JSON.stringify({ routerPid: 2147483646, litellmPid: 2147483647 }));

    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(),
      waitForLitellm: async () => {}, spawnLitellm: () => ({ pid: 1, kill() {} }),
    });
    handles.push(handle);

    expect(existsSync(legacy)).toBe(true);
    expect(JSON.parse(readFileSync(legacy, 'utf8')).litellmPid).toBe(2147483647);
  });

  it('does not kill a recorded litellm pid whose process is no longer LiteLLM', async () => {
    // `killRecordedOrphan` runs on the startup path against whatever the
    // previous daemon recorded — and that record outlives its child, so the
    // number can belong to an unrelated process the OS has since assigned it
    // to. Same "refuse only on POSITIVE evidence" rule as the routerPid check
    // in `stopServe`: a command line naming no litellm is that evidence, and
    // signalling the stranger is what this refuses.
    mkdirSync(dirname(serveStatePath(home, 0)), { recursive: true });
    writeFileSync(serveStatePath(home, 0), JSON.stringify({ litellmPid: 222 }));

    const signalled: number[] = [];
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(
      ((pid: number) => { signalled.push(pid); return true; }) as unknown as typeof process.kill,
    );
    const notes: string[] = [];
    const errorSpy = vi.spyOn(console, 'error')
      .mockImplementation((...args: unknown[]) => { notes.push(args.map(String).join(' ')); });
    try {
      const handle = await cmdServe({
        cwd, home, tempDir: tempDirFor(),
        waitForLitellm: async () => {}, spawnLitellm: () => ({ pid: 4242, kill() {} }),
        processCommand: () => '/usr/bin/vim notes.txt',
      });
      handles.push(handle);
    } finally {
      killSpy.mockRestore();
      errorSpy.mockRestore();
    }

    expect(signalled).not.toContain(222);
    expect(notes.join('\n')).toMatch(/222/);
    expect(notes.join('\n')).toMatch(/no longer LiteLLM/i);
  });

  it('kills the recorded litellm pid when it is still LiteLLM', async () => {
    mkdirSync(dirname(serveStatePath(home, 0)), { recursive: true });
    writeFileSync(serveStatePath(home, 0), JSON.stringify({ litellmPid: 222 }));

    const signalled: number[] = [];
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(orphanKill(signalled, 'SIGTERM'));
    try {
      const handle = await cmdServe({
        cwd, home, tempDir: tempDirFor(),
        waitForLitellm: async () => {}, spawnLitellm: () => ({ pid: 4242, kill() {} }),
        processCommand: () => '/usr/bin/python /opt/venv/bin/litellm --config x',
      });
      handles.push(handle);
    } finally {
      killSpy.mockRestore();
    }

    expect(signalled).toContain(222);
  });

  it('starts, signals nothing and forgets the record when ps cannot say what the pid is', async () => {
    // No procps, hidepid, a ps timeout: the recorded pid may since have been
    // reused by anything long-lived. Signalling it risks a stranger; blocking
    // on it would wedge every start (Anthropic and direct routing included)
    // on a process sonata cannot even name. Neither is acceptable.
    mkdirSync(dirname(serveStatePath(home, 0)), { recursive: true });
    writeFileSync(serveStatePath(home, 0), JSON.stringify({ litellmPid: 222 }));
    const signals: string[] = [];
    const notes: string[] = [];
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(orphanKill([], 'never', signals));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { notes.push(args.map(String).join(' ')); });
    try {
      const handle = await cmdServe({
        cwd, home, tempDir: tempDirFor(), litellmExitTimeoutMs: 100,
        waitForLitellm: async () => {}, spawnLitellm: () => ({ pid: 4242, kill() {} }),
        processCommand: () => undefined,
      });
      handles.push(handle);
    } finally {
      killSpy.mockRestore();
      errorSpy.mockRestore();
    }
    expect(signals).toEqual([]);
    expect(notes.join('\n')).toMatch(/222 could not be verified/);
    // The new child is on record; the unverified pid is not.
    expect(JSON.parse(readFileSync(serveStatePath(home, 0), 'utf8')).litellmPid).toBe(4242);
  });

  it('refuses to start over a recorded LiteLLM that survives SIGKILL, and keeps its record', async () => {
    mkdirSync(dirname(serveStatePath(home, 0)), { recursive: true });
    writeFileSync(serveStatePath(home, 0), JSON.stringify({ litellmPid: 222 }));
    const signals: string[] = [];
    let spawned = 0;
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(orphanKill([], 'never', signals));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(cmdServe({
        cwd, home, tempDir: tempDirFor(), litellmExitTimeoutMs: 100,
        waitForLitellm: async () => {}, spawnLitellm: () => { spawned += 1; return { pid: 4242, kill() {} }; },
        processCommand: () => '/opt/venv/bin/python /opt/venv/bin/litellm --config x',
      })).rejects.toThrow(new RegExp(
        'pid 222, running `/opt/venv/bin/python /opt/venv/bin/litellm --config x`.*kill -9 222.*' +
        `delete ${serveStatePath(home, 0).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 's'));
    } finally {
      killSpy.mockRestore();
      errorSpy.mockRestore();
    }
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(spawned).toBe(0);
    expect(JSON.parse(readFileSync(serveStatePath(home, 0), 'utf8')).litellmPid).toBe(222);
  });

  it('starts even when a state file parses to something that is not a record', async () => {
    // `JSON.parse('null')` returns null rather than throwing, so the cast to
    // ServeState succeeded and `found.state.litellmPid` threw a TypeError out
    // of the startup path — one malformed file stopped serve booting.
    mkdirSync(dirname(serveStatePath(home, 0)), { recursive: true });
    writeFileSync(serveStatePath(home, 0), 'null');

    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(),
      waitForLitellm: async () => {}, spawnLitellm: () => ({ pid: 7, kill() {} }),
    });
    handles.push(handle);

    expect(handle.routerPort).toBeGreaterThan(0);
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

describe('defaultWaitForLitellm', () => {
  const ok = () => new Response('{}', { status: 200 });
  const noDb = () => new Response(
    JSON.stringify({ error: { message: 'No connected db.' } }), { status: 400 },
  );

  it('resolves once the instance answers with this router\'s own master key', async () => {
    const seen: string[] = [];
    const doFetch = (async (url: string) => {
      seen.push(url);
      return ok();
    }) as unknown as typeof fetch;

    await defaultWaitForLitellm(4010, 'sk-sonata-ours', { doFetch, sleep: async () => {} });

    expect(seen).toEqual([
      'http://127.0.0.1:4010/health/liveliness',
      'http://127.0.0.1:4010/v1/models',
    ]);
  });

  it('rejects, naming the port clash, when the live instance is another daemon\'s', async () => {
    // Liveness needs no credential, so any litellm answers it. Two configs
    // naming different `ports.router` but the same `ports.litellm` are not
    // covered by killRecordedOrphan — correctly, since it is scoped to this
    // router's own port — so our child loses the bind and this poll would
    // otherwise accept the *other* daemon's child as ours. Serve then came up
    // "successfully" forwarding a master key that instance has never seen, and
    // every routed request failed authentication naming neither cause.
    // Measured against litellm 1.98.0: a foreign key gets 400 'No connected
    // db.' here, the configured one gets 200.
    let clock = 0;
    const doFetch = (async (url: string) => (
      String(url).endsWith('/v1/models') ? noDb() : ok()
    )) as unknown as typeof fetch;

    const err = await defaultWaitForLitellm(4010, 'sk-sonata-ours', {
      doFetch,
      now: () => clock,
      sleep: async () => { clock += 500; },
      timeoutMs: 2000,
    }).catch((e) => e as Error);

    expect((err as Error).message).toMatch(/does not accept this router's master key/);
    expect((err as Error).message).toMatch(/native\.ports/);
  });

  it('reports a plain startup failure when nothing answers at all', async () => {
    let clock = 0;
    const doFetch = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;

    const err = await defaultWaitForLitellm(4010, 'sk-sonata-ours', {
      doFetch,
      now: () => clock,
      sleep: async () => { clock += 500; },
      timeoutMs: 2000,
    }).catch((e) => e as Error);

    // Not the port-clash message: nothing was there to clash with.
    expect((err as Error).message).toMatch(/did not come up/);
  });
});

/**
 * Wait for a condition the respawn path reaches asynchronously.
 *
 * A fixed sleep is the wrong instrument for an assertion that a count *rises*:
 * it encodes a guess about how long a timer chain takes, and a loaded CI runner
 * makes that guess wrong (observed on run 34457294908 — `expected 1 to be 2`).
 * Polling waits exactly as long as needed and no longer. Assertions that a
 * count *stays* put keep their fixed sleep, since a poll would return
 * immediately and prove nothing.
 */
async function waitFor(cond: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * A fake child's `onExit` that keeps only the FIRST listener — the crash
 * watcher `cmdServe` registers at spawn. `stop()` registers a second one to
 * wait for the exit; a fake that let it overwrite the watcher would make a
 * later simulated crash call the wrong listener.
 */
function firstExitOnly(
  register: (cb: (code: number | null, signal: NodeJS.Signals | null) => void) => void,
): (cb: (code: number | null, signal: NodeJS.Signals | null) => void) => void {
  let registered = false;
  return (cb) => { if (!registered) { registered = true; register(cb); } };
}

describe('cmdServe — litellm respawn', () => {
  it('respawns litellm when it exits on its own, and updates the recorded pid', async () => {
    let spawnCount = 0;
    let exitCb: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(),
      litellmExitTimeoutMs: 20, // its fake children never exit on SIGTERM; stop() would wait out the default
      waitForLitellm: async () => {},
      respawnDelayMs: 0,
      spawnLitellm: () => {
        spawnCount += 1;
        const pid = spawnCount;
        return { pid, kill() {}, onExit: firstExitOnly((cb) => { exitCb = cb; }) };
      },
    });
    handles.push(handle);
    expect(spawnCount).toBe(1);

    exitCb?.(1, null);
    // Respawn is scheduled via a microtask/timer chain (respawnDelayMs: 0 still awaits a tick).
    await waitFor(() => spawnCount === 2, 'the respawn');

    expect(spawnCount).toBe(2);
    const state = JSON.parse(readFileSync(serveStatePath(home, 0), 'utf8'));
    expect(state.litellmPid).toBe(2);
  });

  it('gives up after too many respawns within the window, without spawning again', async () => {
    let spawnCount = 0;
    let exitCb: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(),
      litellmExitTimeoutMs: 20, // its fake children never exit on SIGTERM; stop() would wait out the default
      waitForLitellm: async () => {},
      respawnDelayMs: 0,
      maxRespawns: 2,
      spawnLitellm: () => {
        spawnCount += 1;
        return { pid: spawnCount, kill() {}, onExit: firstExitOnly((cb) => { exitCb = cb; }) };
      },
    });
    handles.push(handle);

    for (let i = 0; i < 3; i++) {
      const before = spawnCount;
      exitCb?.(1, null);
      // The third crash is deliberately not retried, so only the first two
      // waits may expect a new spawn; the last one has nothing to wait for.
      if (i < 2) await waitFor(() => spawnCount > before, `respawn ${i + 1}`);
      else await new Promise((r) => setTimeout(r, 10));
    }

    // 1 initial + 2 tolerated respawns = 3 spawns; the 3rd crash is not retried.
    expect(spawnCount).toBe(3);
  });

  it('does not respawn after stop() has been called', async () => {
    let spawnCount = 0;
    let exitCb: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(),
      litellmExitTimeoutMs: 20, // its fake children never exit on SIGTERM; stop() would wait out the default
      waitForLitellm: async () => {},
      respawnDelayMs: 0,
      spawnLitellm: () => {
        spawnCount += 1;
        return { pid: spawnCount, kill() {}, onExit: firstExitOnly((cb) => { exitCb = cb; }) };
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
    // Nothing must actually be listening on the litellm port for the
    // post-release request to still fail on its own merits — which the
    // beforeEach's free port guarantees.
    writeMachineConfig( `
[native.models."deepseek-v4-flash"]
gateway = "acme"
id = "deepseek-v4-flash-0731"
context_window = 128000

[native.gateways."acme"]
base_url = "https://gateway.example/v1"

[native.ports]
router = 0
litellm = ${litellmPort}
`);

    let waitCalls = 0;
    let releaseRespawnWait: () => void = () => {};
    let exitCb: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;

    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(),
      litellmExitTimeoutMs: 20, // its fake children never exit on SIGTERM; stop() would wait out the default
      respawnDelayMs: 0,
      waitForLitellm: async () => {
        waitCalls += 1;
        if (waitCalls === 1) return;
        await new Promise<void>((resolve) => { releaseRespawnWait = resolve; });
      },
      spawnLitellm: () => ({ pid: 1, kill() {}, onExit: firstExitOnly((cb) => { exitCb = cb; }) }),
    });
    handles.push(handle);
    expect(waitCalls).toBe(1);

    exitCb?.(1, null);
    // Let the respawnDelayMs:0 tick fire and the second waitForLitellm start.
    // Polled rather than slept for, same as the respawn assertions above: a
    // fixed delay here is a guess about scheduling that a loaded CI runner
    // makes wrong.
    await waitFor(() => waitCalls === 2, 'the second waitForLitellm');
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
litellm = ${litellmPort}
`;
    writeMachineConfig( config('first'));

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

    writeMachineConfig( config('second'));
    const changed = await fetch(`http://localhost:${handle.routerPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'sonata-code-simple', messages: [] }),
    });
    expect(changed.status).toBe(529);
    await waitFor(() => spawnCount === 2, 'the restarted litellm child');
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
litellm = ${litellmPort}
`;
    writeMachineConfig( config('https://gateway-one.example/v1'));

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
    writeMachineConfig( config('https://gateway-two.example/v1'));
    const response = await fetch(`http://localhost:${handle.routerPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'sonata-code-simple', messages: [] }),
    });
    expect(response.status).toBe(529);
    await waitFor(() => spawnCount === 2, 'the restarted litellm child');
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
litellm = ${litellmPort}
`;
    writeMachineConfig( config('legacy-upstream-v1'));

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
    writeMachineConfig( config('legacy-upstream-v2'));
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
litellm = ${litellmPort}
`;
    writeSonataKey(home, 'acme', 'acme-key');
    writeSonataKey(home, 'other', 'other-key');
    writeMachineConfig( config(false));

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

    writeMachineConfig( config(true));
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
litellm = ${litellmPort}
`;
    writeMachineConfig( config('first'));

    let spawnCount = 0;
    const exits: Array<Array<(code: number | null, signal: NodeJS.Signals | null) => void>> = [];
    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(),
      litellmExitTimeoutMs: 20, // its fake children never exit on SIGTERM; stop() would wait out the default
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

    writeMachineConfig( config('second'));
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
    writeMachineConfig( `
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
litellm = ${litellmPort}
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
litellm = ${litellmPort}
`;
    writeMachineConfig( config('direct-model'));

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

    writeMachineConfig( config('direct-model-renamed'));
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
litellm = ${litellmPort}
`;
    writeMachineConfig( config('first'));

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

    writeMachineConfig( config('second'));
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

  it('stop() escalates to forceKill for a litellm child that ignores SIGTERM, before removing its temp dir', async () => {
    // stop() sent SIGTERM once and then deleted the child's config directory
    // and the state file naming its pid: a SIGTERM-deaf child (one blocked on a
    // device-code login) survived as an orphan nothing could find again.
    writeMachineConfig(`
[models."m"]
gateway = "acme"
id = "m-upstream"
context_window = 128000

[native.gateways."acme"]
base_url = "https://gateway.example/v1"

[native.ports]
router = 0
litellm = ${litellmPort}
`);
    const exits: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
    const events: string[] = [];
    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(),
      waitForLitellm: async () => {},
      litellmExitTimeoutMs: 20,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      spawnLitellm: () => ({
        pid: 1,
        kill: () => { events.push('term'); },
        onExit: (cb) => { exits.push(cb); },
        forceKill: () => {
          events.push(`kill:tempDir=${existsSync(tempDirFor())}`);
          for (const cb of exits) cb(null, 'SIGKILL');
        },
      }),
    });
    await handle.stop();
    expect(events).toEqual(['term', 'kill:tempDir=true']);
    expect(existsSync(tempDirFor())).toBe(false);
  });

  it('retries a model-change restart whose replacement never became ready', async () => {
    // The new registry was committed before the replacement child answered
    // its readiness probe, so a replacement that never came up was never
    // tried again: the next request saw "no change" and used a dead upstream.
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
litellm = ${litellmPort}
`;
    writeSonataKey(home, 'acme', 'acme-key');
    writeMachineConfig(config('first'));
    let spawnCount = 0;
    let waits = 0;
    const exits: Array<Array<(code: number | null, signal: NodeJS.Signals | null) => void>> = [];
    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(),
      litellmExitTimeoutMs: 20,
      // Startup's child is ready; the first replacement never is.
      waitForLitellm: async () => { waits += 1; if (waits === 2) throw new Error('never came up'); },
      spawnLitellm: () => {
        spawnCount += 1;
        const index = spawnCount - 1;
        return {
          pid: spawnCount,
          kill: () => exits[index]?.forEach((cb) => cb(null, 'SIGTERM')),
          onExit: (cb) => { (exits[index] ??= []).push(cb); },
        };
      },
    });
    handles.push(handle);
    const send = () => fetch(`http://localhost:${handle.routerPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'sonata-code-simple', messages: [] }),
    });

    writeMachineConfig(config('second'));
    await send();
    expect(spawnCount).toBe(2);

    // No further edit: the change is still unapplied, so it is tried again.
    await send();
    const deadline = Date.now() + 2000;
    while (spawnCount < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    expect(spawnCount).toBe(3);
  });

  it('retries the restart on the next request after a failed one, instead of marking the change handled', async () => {
    // A gateway added with `credential_source = "sonata"` but no key stored
    // yet cannot be loaded. If the snapshot recorded only the configs, a
    // later request — after the credential is fixed — would see no
    // difference and skip the restart forever, leaving the new model
    // unreachable short of a manual `sonata restart`. The failed-credential
    // set is part of the snapshot, so its clearing is a change.
    writeSonataKey(home, 'acme', 'acme-key');
    writeMachineConfig( `
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
litellm = ${litellmPort}
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
litellm = ${litellmPort}
`;
    writeMachineConfig( configWithNewGateway);

    const firstAttempt = await fetch(`http://localhost:${handle.routerPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'sonata-code-simple', messages: [] }),
    });
    // "newgw" has no stored key yet, so its model is left out of LiteLLM's
    // config and the router answers it by name rather than forwarding it to
    // a LiteLLM that never loaded it.
    expect(firstAttempt.status).toBe(502);
    const message = (await firstAttempt.json() as { error: { message: string } }).error.message;
    expect(message).toContain('newgw');
    expect(message).toContain('sonata auth add newgw');
    expect(configs.every((config) => !config.includes('second-upstream'))).toBe(true);

    writeSonataKey(home, 'newgw', 'new-key');
    await fetch(`http://localhost:${handle.routerPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'sonata-code-simple', messages: [] }),
    });
    // The restart runs fire-and-forget from checkModelChange and is not on
    // the response's critical path, so poll for it rather than assume it's
    // finished the instant the response itself resolves.
    const deadline = Date.now() + 2000;
    while (!configs.some((config) => config.includes('second-upstream')) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(configs.at(-1)).toContain('second-upstream');
  });
});

describe('cmdServe — codex-oauth gateways', () => {
  it('writes the flattened ChatGPT credential and points LiteLLM at it', async () => {
    writeMachineConfig( CODEX_CONFIG());
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
    writeMachineConfig( CODEX_CONFIG());
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
    writeMachineConfig( CODEX_CONFIG());

    await expect(cmdServe({
      cwd, home, tempDir: tempDirFor(),
      waitForLitellm: async () => {}, spawnLitellm: () => ({ pid: 1, kill() {} }),
    })).rejects.toThrow(/codex login/);
  });

  it('removes the credential file when serve stops', async () => {
    writeMachineConfig( CODEX_CONFIG());
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

const COPILOT_CONFIG = () => `
[native.models."gpt4o-copilot"]
gateway = "copilot"
id = "gpt-4o"
context_window = 128000

[native.gateways."copilot"]
auth = "copilot-oauth"

[native.ports]
router = 0
litellm = ${litellmPort}
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
    writeMachineConfig( COPILOT_CONFIG());
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
    writeMachineConfig( COPILOT_CONFIG());
    await expect(cmdServe({
      cwd, home, tempDir: tempDirFor(),
      waitForLitellm: async () => {}, spawnLitellm: () => ({ pid: 1, kill() {} }),
    })).rejects.toThrow(/opencode auth login/);
  });

  it('sources a ChatGPT credential from opencode when codex has none', async () => {
    writeMachineConfig( CODEX_CONFIG());
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

  it('names a starting sonata router when the port is held during startup', async () => {
    const message = await occupiedPortMessage(4100, health({ status: 'starting', sonata: true }, false));
    expect(message).toMatch(/another sonata router/);
    expect(message).not.toMatch(/non-sonata/);
  });

  it('names sonata when the endpoint is starting or otherwise non-2xx', async () => {
    const message = await occupiedPortMessage(4100, health({ sonata: true }, false));
    expect(message).toMatch(/another sonata router/);
  });
});

describe('isSonataRouter', () => {
  it('identifies a starting router independently of its readiness status', async () => {
    const starting = (async () => new Response(JSON.stringify({ status: 'starting', sonata: true }), { status: 503 })) as unknown as typeof fetch;
    expect(await isSonataRouter(4100, starting)).toBe(true);
  });

  it('keeps non-sonata, malformed, and unreachable endpoints negative', async () => {
    const nonSonata = (async () => new Response(JSON.stringify({ status: 'starting' }), { status: 503 })) as unknown as typeof fetch;
    const notJson = (async () => new Response('<html>', { status: 503 })) as unknown as typeof fetch;
    const unreachable = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    expect(await isSonataRouter(4100, nonSonata)).toBe(false);
    expect(await isSonataRouter(4100, notJson)).toBe(false);
    expect(await isSonataRouter(4100, unreachable)).toBe(false);
  });
});

describe('the ui capability on the health payload', () => {
  /**
   * `sonata: true` alone passes for a router built before the UI existed, so
   * advertising the URL on that basis sends the user to a 404. Absent means
   * absent: the field is required, never inferred.
   */
  it('is true only when the payload says ui: true', () => {
    expect(healthReportsUi({ status: 'ok', sonata: true, ui: true })).toBe(true);
    expect(healthReportsUi({ status: 'ok', sonata: true })).toBe(false);
    expect(healthReportsUi({ status: 'ok', sonata: true, ui: false })).toBe(false);
    expect(healthReportsUi({ status: 'ok', ui: true })).toBe(false);
    expect(healthReportsUi(null)).toBe(false);
    expect(healthReportsUi('<html>')).toBe(false);
  });

  it('probes a live port through the same predicate', async () => {
    const withUi = (async () => new Response(JSON.stringify({ sonata: true, ui: true }))) as unknown as typeof fetch;
    const without = (async () => new Response(JSON.stringify({ sonata: true }))) as unknown as typeof fetch;
    const broken = (async () => { throw new Error('refused'); }) as unknown as typeof fetch;
    expect(await sonataRouterHasUi(4100, withUi)).toBe(true);
    expect(await sonataRouterHasUi(4100, without)).toBe(false);
    expect(await sonataRouterHasUi(4100, broken)).toBe(false);
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

  it('spawns the daemon from the machine config directory', async () => {
    const opts: Parameters<typeof spawnType>[2][] = [];
    const spy = ((_cmd: string, _args: string[], o: never) => {
      opts.push(o);
      return { pid: 4242, unref: () => {} };
    }) as unknown as typeof spawnType;

    await startServeDaemon(home, ['node', 'cli.js', 'serve'], {
      spawn: spy,
      probe: async () => true,
    }, '/some/other/cwd');

    expect(opts[0]).toMatchObject({ cwd: join(home, '.config', 'sonata') });
  });

  it('spawns from the caller\'s cwd when there is no machine config file', async () => {
    // Only the machine config FILE may move the daemon. The log directory is
    // created inside ~/.config/sonata before the check used to run, so the
    // directory always existed and a project-only machine started its router
    // in a directory with no config — which `serve` refuses outright.
    rmSync(join(home, '.config'), { force: true, recursive: true });
    const opts: Parameters<typeof spawnType>[2][] = [];
    const spy = ((_cmd: string, _args: string[], o: never) => {
      opts.push(o);
      return { pid: 4242, unref: () => {} };
    }) as unknown as typeof spawnType;

    await startServeDaemon(home, ['node', 'cli.js', 'serve'], { spawn: spy, probe: async () => true }, '/some/project');

    expect(opts[0]).toMatchObject({ cwd: '/some/project' });
  });

  it('closes its own copy of the log fd, on success and on timeout', async () => {
    const fdDir = existsSync('/proc/self/fd') ? '/proc/self/fd' : '/dev/fd';
    const before = readdirSync(fdDir).length;
    await startServeDaemon(home, ['node', 'cli.js', 'serve'], { spawn: fakeSpawn(), probe: async () => true }, home);
    let clock = 0;
    await expect(startServeDaemon(home, ['node', 'cli.js', 'serve'], {
      spawn: fakeSpawn(), probe: async () => false,
      sleep: async () => { clock += 500; }, now: () => clock, timeoutMs: 1000,
    }, home)).rejects.toThrow(/did not answer/);
    expect(readdirSync(fdDir).length).toBe(before);
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
    }, home);

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
    }, home);
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
    }, home);
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
    }, home);

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
    }, home);
    expect(calls).toBe(3);
    expect(result.port).toBe(4100);
  });

  // The old instance-id probe also waited through 503 responses; this test
  // guards the readiness contract without claiming to prove the identity fix.
  it('does not accept a starting router as ready', async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const spy = ((_cmd: string, _args: string[], o: { env?: NodeJS.ProcessEnv }) => {
      capturedEnv = o.env;
      return { pid: 4242, unref: () => {} };
    }) as unknown as typeof spawnType;

    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      return new Response(JSON.stringify({
        status: calls < 3 ? 'starting' : 'ok', sonata: true,
        ready: calls < 3 ? false : true,
        instanceId: capturedEnv?.SONATA_SERVE_INSTANCE_ID,
      }), { status: calls < 3 ? 503 : 200 });
    }) as unknown as typeof fetch);

    const result = await startServeDaemon(home, ['node', 'cli.js', 'serve'], {
      spawn: spy,
      sleep: async () => {},
    }, home);
    expect(calls).toBe(3);
    expect(result.pid).toBe(4242);
  });

  it('gives up with the log path when the daemon never answers', async () => {
    let clock = 0;
    await expect(startServeDaemon(home, ['node', 'cli.js', 'serve'], {
      spawn: fakeSpawn(),
      probe: async () => false,
      sleep: async () => { clock += 500; },
      now: () => clock,
      timeoutMs: 2000,
    }, home)).rejects.toThrow(/did not answer on port 4100.*serve-/s);
  });

  it('writes the daemon log into the shared log directory', async () => {
    const result = await startServeDaemon(home, ['node', 'cli.js', 'serve'], {
      spawn: fakeSpawn(), probe: async () => true,
    }, home);
    expect(result.logPath).toContain(join('.config', 'sonata', 'logs'));
    expect(result.logPath).toMatch(/serve-.*\.log$/);
  });
});

const notSonataFetch: typeof fetch = (async () => new Response('', { status: 500 })) as unknown as typeof fetch;

describe('processCommand', () => {
  it('reports a live pid\'s command line and nothing for one that cannot exist', () => {
    // The real `ps` invocation is half the fix; the seams below only prove
    // what callers do with its answer. This pins the answer shape: trimmed
    // text for a pid the OS knows, `undefined` when ps fails or says nothing
    // — 2147483647 is past pid_max on macOS and Linux alike, so ps errors out.
    const command = processCommand(process.pid);
    expect(typeof command).toBe('string');
    expect((command as string).length).toBeGreaterThan(0);
    expect(processCommand(2147483647)).toBeUndefined();
  });
});

describe('stopServe', () => {
  let cwd: string;
  let home: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'sonata-stop-cwd-'));
    home = mkdtempSync(join(tmpdir(), 'sonata-stop-home-'));
    writeMachineConfig( `
[native.gateways."g"]
base_url = "http://gateway.example/v1"
[native.models."m"]
gateway = "g"
id = "model"
context_window = 128000
[native.ports]
router = 4100
litellm = ${litellmPort}
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
    mkdirSync(dirname(serveStatePath(home, 4100)), { recursive: true });
    writeFileSync(serveStatePath(home, 4100), JSON.stringify({ routerPid: 111, litellmPid: 222 }));
    const killed: number[] = [];

    const result = await stopServe({
      cwd, home, probeHealth: sonataHealth,
      // The recorded router pid must own the port, so the seam has to agree
      // with the fixture — otherwise the real `lsof` on the developer's
      // machine answers about a real router and the guard refuses.
      findPortPid: () => '111', kill: (pid) => killed.push(pid), sleep: async () => {},
      isAlive: () => false,
      // The recorded litellm pid is the genuine child here, so the command
      // line check lets it be signalled.
      processCommand: () => '/usr/bin/python /opt/venv/bin/LiteLLM --config x.yaml',
    });

    expect(result.killed).toBe(true);
    expect(killed.sort()).toEqual([111, 222]);
    expect(existsSync(serveStatePath(home, 4100))).toBe(false);
  });

  it('refuses to kill when only litellm has a recorded pid', async () => {
    mkdirSync(dirname(serveStatePath(home, 4100)), { recursive: true });
    writeFileSync(serveStatePath(home, 4100), JSON.stringify({ litellmPid: 222 }));

    // This assertion is a guard for the existing refusal path: the state
    // check happens before the kill list is built, and predates this fix.
    const killed: number[] = [];
    const result = await stopServe({
      cwd, home, probeHealth: sonataHealth, findPortPid: () => '48213', kill: (pid) => killed.push(pid),
    }).catch((e) => e as Error);

    expect((result as Error).message).toMatch(/no recorded pid/);
    expect((result as Error).message).toMatch(/kill 48213/);
    expect(killed).toEqual([]);
    expect(existsSync(serveStatePath(home, 4100))).toBe(true);
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
    mkdirSync(dirname(serveStatePath(home, 4100)), { recursive: true });
    writeFileSync(serveStatePath(home, 4100), JSON.stringify({ routerPid: 111 }));
    const result = await stopServe({
      cwd, home, probeHealth: sonataHealth,
      // The recorded router pid must own the port, so the seam has to agree
      // with the fixture — otherwise the real `lsof` on the developer's
      // machine answers about a real router and the guard refuses.
      findPortPid: () => '111', kill: () => {}, sleep: async () => {},
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
    mkdirSync(dirname(serveStatePath(home, 4100)), { recursive: true });
    writeFileSync(serveStatePath(home, 4100), JSON.stringify({ routerPid: 111, litellmPid: 222 }));

    const result = await stopServe({
      cwd, home, probeHealth: sonataHealth,
      // The recorded router pid must own the port, so the seam has to agree
      // with the fixture — otherwise the real `lsof` on the developer's
      // machine answers about a real router and the guard refuses.
      findPortPid: () => '111', kill: () => {}, sleep: async () => {},
      isAlive: () => false,
      processCommand: () => '/usr/bin/python /opt/venv/bin/litellm',
    });

    expect(result.killed).toBe(true);
  });

  it('refuses to signal a recorded pid that does not own the port', async () => {
    // `isSonataRouter` proves a sonata router answers, not that the RECORDED
    // pid is the one answering. A record outlives a daemon that died hard,
    // and the OS reuses pid numbers — so a stale record can name a number
    // belonging to something else entirely. Before the SIGKILL escalation
    // that meant a signal the stranger could ignore; now it means a process
    // that dies, which is why this guard earns its place.
    mkdirSync(dirname(serveStatePath(home, 4100)), { recursive: true });
    writeFileSync(serveStatePath(home, 4100), JSON.stringify({ routerPid: 111, litellmPid: 222 }));

    const signalled: number[] = [];
    const err = await stopServe({
      cwd, home, probeHealth: sonataHealth, sleep: async () => {},
      kill: (pid) => signalled.push(pid),
      forceKill: (pid) => signalled.push(pid),
      isAlive: () => false,
      findPortPid: () => '999',
    }).catch((e) => e as Error);

    expect((err as Error).message).toMatch(/records router pid 111.*held by pid 999/s);
    // Nothing was signalled, and the record is left for the user to inspect.
    expect(signalled).toEqual([]);
    expect(existsSync(serveStatePath(home, 4100))).toBe(true);
  });

  it('proceeds when the port holder cannot be determined', async () => {
    // `findPortPid` answers undefined for every failure and ambiguity — no
    // lsof, no permission, two holders. Treating "cannot tell" as a mismatch
    // would refuse every restart on a machine without lsof, breaking the
    // working case to guard the rare one, so unknown proceeds as before.
    mkdirSync(dirname(serveStatePath(home, 4100)), { recursive: true });
    writeFileSync(serveStatePath(home, 4100), JSON.stringify({ routerPid: 111, litellmPid: 222 }));

    const killed: number[] = [];
    const result = await stopServe({
      cwd, home, probeHealth: sonataHealth, sleep: async () => {},
      kill: (pid) => killed.push(pid), isAlive: () => false,
      findPortPid: () => undefined,
      processCommand: () => '/usr/bin/python /opt/venv/bin/litellm',
    });

    expect(killed).toEqual([111, 222]);
    expect(result.killed).toBe(true);
  });

  it('treats an unparseable port holder as unknown, not as a mismatch', async () => {
    // The seam answers a string. A non-numeric one compared as a number is
    // NaN, which mismatches everything — so a garbled `lsof` line would
    // refuse every restart rather than falling back to the old behaviour.
    mkdirSync(dirname(serveStatePath(home, 4100)), { recursive: true });
    writeFileSync(serveStatePath(home, 4100), JSON.stringify({ routerPid: 111 }));

    const killed: number[] = [];
    const result = await stopServe({
      cwd, home, probeHealth: sonataHealth, sleep: async () => {},
      kill: (pid) => killed.push(pid), isAlive: () => false,
      findPortPid: () => 'not-a-pid',
    });

    expect(killed).toEqual([111]);
    expect(result.killed).toBe(true);
  });

  it('escalates to SIGKILL when a recorded pid ignores SIGTERM', async () => {
    // The measured case, 2026-09-21: LiteLLM blocked on an interactive
    // ChatGPT device-code login does not act on SIGTERM — it sits in its
    // 15-minute poll. `sonata restart` waited out its window and threw,
    // leaving the process alive and the port unusable, so the next restart
    // added another one. Six were found on one machine, oldest six hours.
    mkdirSync(dirname(serveStatePath(home, 4100)), { recursive: true });
    writeFileSync(serveStatePath(home, 4100), JSON.stringify({ routerPid: 111, litellmPid: 222 }));

    const termed: number[] = [];
    const killed: number[] = [];
    // Alive until SIGKILL lands, which is exactly what SIGTERM-deaf means.
    const dead = new Set<number>();
    const result = await stopServe({
      cwd, home, probeHealth: sonataHealth,
      // The recorded router pid must own the port, so the seam has to agree
      // with the fixture — otherwise the real `lsof` on the developer's
      // machine answers about a real router and the guard refuses.
      findPortPid: () => '111', sleep: async () => {},
      kill: (pid) => termed.push(pid),
      forceKill: (pid) => { killed.push(pid); dead.add(pid); },
      isAlive: (pid) => !dead.has(pid),
      timeoutMs: 0,
      processCommand: () => '/usr/bin/python /opt/venv/bin/litellm',
    });

    expect(termed).toEqual([111, 222]);
    expect(killed).toEqual([111, 222]);
    expect(result.killed).toBe(true);
  });

  it('still reports failure for a pid that survives even SIGKILL', async () => {
    // SIGKILL is not refusable, so this is an unkillable-state pid (uninterruptible
    // I/O, say). It must still be reported rather than looped on forever — and
    // the message must say SIGKILL was tried, or the obvious next step looks
    // like the one already taken.
    mkdirSync(dirname(serveStatePath(home, 4100)), { recursive: true });
    writeFileSync(serveStatePath(home, 4100), JSON.stringify({ routerPid: 111 }));

    const err = await stopServe({
      cwd, home, probeHealth: sonataHealth,
      // The recorded router pid must own the port, so the seam has to agree
      // with the fixture — otherwise the real `lsof` on the developer's
      // machine answers about a real router and the guard refuses.
      findPortPid: () => '111', sleep: async () => {},
      kill: () => {}, forceKill: () => {}, isAlive: () => true, timeoutMs: 0,
    }).catch((e) => e as Error);

    expect((err as Error).message).toMatch(/did not respond to SIGKILL/);
  });

  it('ignores another port\'s record rather than killing that daemon', async () => {
    // The reason state is keyed by port at all. One global file meant the
    // second project's daemon overwrote the first's pids, and a restart in
    // either project then killed whichever process was recorded last — or
    // refused, having lost the record it needed.
    mkdirSync(dirname(serveStatePath(home, 4110)), { recursive: true });
    writeFileSync(serveStatePath(home, 4110), JSON.stringify({ routerPid: 999, litellmPid: 998 }));

    const killed: number[] = [];
    const result = await stopServe({
      cwd, home, probeHealth: sonataHealth, kill: (pid) => killed.push(pid),
      findPortPid: () => undefined,
    }).catch((e) => e as Error);

    // cwd's config is on 4100, so 4110's record is not its own to act on.
    expect((result as Error).message).toMatch(/no recorded pid/);
    expect(killed).toEqual([]);
    expect(existsSync(serveStatePath(home, 4110))).toBe(true);
  });

  it('still stops a daemon recorded by a version that predates per-port state', async () => {
    // Upgrading sonata must not strand the daemon already running: it wrote
    // the legacy path, and refusing to read it would hand the user the
    // "no recorded pid" dead end this file exists to prevent.
    const legacy = join(home, '.config', 'sonata', 'serve-state.json');
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(legacy, JSON.stringify({ routerPid: 111, litellmPid: 222 }));

    const killed: number[] = [];
    const result = await stopServe({
      cwd, home, probeHealth: sonataHealth, kill: (pid) => killed.push(pid),
      sleep: async () => {}, isAlive: () => false,
      // The ordinary upgrade case: the legacy record's router is the process
      // actually holding the port its own config named. Stubbed rather than
      // left to the real `lsof`, which answered with whatever unrelated
      // process happened to hold 4100 on the developer's machine.
      findPortPid: () => '111',
      processCommand: () => '/usr/bin/python /opt/venv/bin/litellm',
    });

    expect(result.killed).toBe(true);
    expect(killed).toEqual([111, 222]);
    // Cleared the file it actually read, not the port-keyed one it never wrote.
    expect(existsSync(legacy)).toBe(false);
  });

  it('refuses a legacy record whose router does not hold the port', async () => {
    // The legacy file names no port, so it cannot say which router it
    // describes. Trusting it unconditionally meant a pre-upgrade record left
    // by a daemon on another port was read as this port's: `restart` killed
    // that unrelated daemon and its litellm, reported success, and left the
    // port it was actually asked about still held.
    const legacy = join(home, '.config', 'sonata', 'serve-state.json');
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(legacy, JSON.stringify({ routerPid: 111, litellmPid: 222 }));

    const killed: number[] = [];
    const result = await stopServe({
      cwd, home, probeHealth: sonataHealth, kill: (pid) => killed.push(pid),
      sleep: async () => {}, isAlive: () => false,
      // Someone else holds 4100 — so the legacy record is not about it.
      findPortPid: () => '777',
    }).catch((e) => e as Error);

    expect((result as Error).message).toMatch(/no recorded pid/);
    expect(killed).toEqual([]);
    expect(existsSync(legacy)).toBe(true);
  });

  it('ignores a state file that parses to something other than a record', async () => {
    // `JSON.parse('null')` does not throw, so the old `catch` never saw this.
    // The value was cast to ServeState and dereferenced, and the TypeError
    // came out of the startup path — one stray file stopped serve booting.
    mkdirSync(dirname(serveStatePath(home, 4100)), { recursive: true });
    writeFileSync(serveStatePath(home, 4100), 'null');

    const killed: number[] = [];
    const result = await stopServe({
      cwd, home, probeHealth: sonataHealth, kill: (pid) => killed.push(pid),
      findPortPid: () => undefined,
    }).catch((e) => e as Error);

    expect((result as Error).message).toMatch(/no recorded pid/);
    expect(killed).toEqual([]);
  });

  it('does not signal a recorded litellm pid whose process is no longer LiteLLM', async () => {
    // A serve-state file outlives its LiteLLM child, and the OS reuses pids:
    // the recorded number can belong to an unrelated process that has nothing
    // to do with sonata. Signalling it is what this refuses — while the router
    // pid, already proven against the port holder above, is still stopped.
    mkdirSync(dirname(serveStatePath(home, 4100)), { recursive: true });
    writeFileSync(serveStatePath(home, 4100), JSON.stringify({ routerPid: 111, litellmPid: 222 }));

    const killed: number[] = [];
    const notes: string[] = [];
    const errorSpy = vi.spyOn(console, 'error')
      .mockImplementation((...args: unknown[]) => { notes.push(args.map(String).join(' ')); });
    try {
      const result = await stopServe({
        cwd, home, probeHealth: sonataHealth, sleep: async () => {},
        findPortPid: () => '111', kill: (pid) => killed.push(pid), isAlive: () => false,
        processCommand: () => '/usr/bin/vim notes.txt',
      });
      expect(result.killed).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }

    expect(killed).toEqual([111]);
    // The note names the pid and says why it was left alone.
    expect(notes.join('\n')).toMatch(/222/);
    expect(notes.join('\n')).toMatch(/no longer LiteLLM/i);
  });

  it('signals a recorded litellm pid whose command line still runs litellm', async () => {
    // Case-insensitive: sonata's own managed venv spells it `LiteLLM`.
    mkdirSync(dirname(serveStatePath(home, 4100)), { recursive: true });
    writeFileSync(serveStatePath(home, 4100), JSON.stringify({ routerPid: 111, litellmPid: 222 }));

    const killed: number[] = [];
    const result = await stopServe({
      cwd, home, probeHealth: sonataHealth, sleep: async () => {},
      findPortPid: () => '111', kill: (pid) => killed.push(pid), isAlive: () => false,
      processCommand: () => '/usr/bin/python /opt/venv/bin/LiteLLM --config x.yaml',
    });

    expect(result.killed).toBe(true);
    expect(killed.sort()).toEqual([111, 222]);
  });

  it('signals the recorded litellm pid when its command cannot be read', async () => {
    // `processCommand` answers undefined for any failure — no ps, no
    // permission, pid already gone. Treating "cannot tell" as "reused" would
    // strand a real orphan litellm on every machine where ps is unavailable:
    // the same "refuse only on POSITIVE evidence" rule as `findPortPid`
    // above. Unknown proceeds exactly as before.
    mkdirSync(dirname(serveStatePath(home, 4100)), { recursive: true });
    writeFileSync(serveStatePath(home, 4100), JSON.stringify({ routerPid: 111, litellmPid: 222 }));

    const killed: number[] = [];
    const result = await stopServe({
      cwd, home, probeHealth: sonataHealth, sleep: async () => {},
      findPortPid: () => '111', kill: (pid) => killed.push(pid), isAlive: () => false,
      processCommand: () => undefined,
    });

    expect(result.killed).toBe(true);
    expect(killed.sort()).toEqual([111, 222]);
  });

  it('does not escalate to SIGKILL against a reused litellm pid', async () => {
    // The wait/escalate loop below kills whatever is still on its pid list.
    // A reused pid that is simply alive (it is someone else's long-running
    // process) must be off that list entirely — otherwise the timeout makes
    // this send SIGKILL at a stranger and then report failure for it.
    mkdirSync(dirname(serveStatePath(home, 4100)), { recursive: true });
    writeFileSync(serveStatePath(home, 4100), JSON.stringify({ routerPid: 111, litellmPid: 222 }));

    const killed: number[] = [];
    const forced: number[] = [];
    const result = await stopServe({
      cwd, home, probeHealth: sonataHealth, sleep: async () => {},
      findPortPid: () => '111', kill: (pid) => killed.push(pid),
      forceKill: (pid) => forced.push(pid),
      // The stranger is alive the whole time; the router exits at once.
      isAlive: (pid) => pid === 222,
      timeoutMs: 0,
      processCommand: () => '/usr/bin/vim notes.txt',
    });

    expect(result.killed).toBe(true);
    expect(killed).toEqual([111]);
    expect(forced).toEqual([]);
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
      // The legacy record is only usable against proof it owns the port.
      findPortPid: () => '111',
    });

    expect(killed).toEqual([111]);
    expect(result.pid).toBe(999);
  });

  it('forwards its liveness seam to stopServe', async () => {
    // `cmdRestart` used to enumerate the deps it passed on, so `isAlive` —
    // added to `StopDeps` later — was silently dropped and every caller fell
    // back to probing the real OS. The test above could not catch that: a fake
    // pid reads as dead on a developer machine either way, so it passed
    // locally and timed out for 10s on a CI runner where pid 111 is a live
    // process. Asserting the seam is *used* fails everywhere instead.
    writeFileSync(join(home, '.config', 'sonata', 'serve-state.json'), JSON.stringify({ routerPid: 111 }));
    const probed: number[] = [];
    let healthCalls = 0;
    await cmdRestart(home, ['node', 'cli.js', 'serve'], {
      cwd: home,
      probeHealth: (async () => {
        healthCalls += 1;
        return healthCalls === 1 ? new Response(JSON.stringify({ sonata: true })) : new Response('', { status: 500 });
      }) as unknown as typeof fetch,
      kill: () => {}, sleep: async () => {},
      spawn: (() => ({ pid: 999, unref: () => {} })) as unknown as typeof spawnType,
      probe: async () => true,
      isAlive: (pid) => { probed.push(pid); return false; },
      findPortPid: () => '111',
    });

    expect(probed).toContain(111);
  });

  it('forwards findPortPid when the router pid is unrecorded', async () => {
    writeFileSync(join(home, '.config', 'sonata', 'serve-state.json'), JSON.stringify({ litellmPid: 222 }));
    const result = await cmdRestart(home, ['node', 'cli.js', 'serve'], {
      cwd: home,
      probeHealth: (async () => new Response(JSON.stringify({ sonata: true }))) as unknown as typeof fetch,
      findPortPid: () => '48213',
    }).catch((e) => e as Error);

    expect((result as Error).message).toMatch(/kill 48213/);
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

describe('cmdServe — litellm is conditional', () => {
  /** Every routable model sits on an Anthropic-native gateway, so nothing needs translating. */
  const ANTHROPIC_ONLY = () => `
[models."or-flash"]
gateway = "openrouter"
id = "deepseek/deepseek-v4-flash"
context_window = 128000

[tiers.code]
simple = ["or-flash"]
complex = ["or-flash"]

[native.gateways."openrouter"]
base_url = "https://openrouter.ai/api/v1"
provider = "anthropic"

[native.ports]
router = 0
litellm = ${litellmPort}
`;

  it('starts no litellm child when no gateway needs one', async () => {
    // Asserted on the spawn seam, not by absence of an error: "it did not
    // crash" is no evidence that nothing was spawned.
    writeMachineConfig( ANTHROPIC_ONLY());
    let spawned = 0;
    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(),
      waitForLitellm: async () => { throw new Error('must not wait for a child that was never started'); },
      spawnLitellm: () => { spawned += 1; return { pid: 1, kill() {} }; },
    });
    handles.push(handle);
    expect(spawned).toBe(0);
    expect(handle.routerPort).toBeGreaterThan(0);
  });

  it('needs no managed venv at all in that case', async () => {
    // The point of the whole exercise: such a user runs sonata on Node and
    // tmux, with no Python anywhere.
    rmSync(venvDir(home), { force: true, recursive: true });
    writeMachineConfig( ANTHROPIC_ONLY());
    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(),
      waitForLitellm: async () => {},
      spawnLitellm: () => ({ pid: 1, kill() {} }),
    });
    handles.push(handle);
    expect(handle.routerPort).toBeGreaterThan(0);
  });

  it('refuses to start, naming the repair, when litellm is required but missing', async () => {
    // It must never install here: `hooks/ensure-serve.mjs` starts serve
    // headless from a SessionStart hook, where a silent multi-minute install
    // is indistinguishable from a hang.
    rmSync(venvDir(home), { force: true, recursive: true });
    await expect(cmdServe({
      cwd, home, tempDir: tempDirFor(),
      waitForLitellm: async () => {},
      spawnLitellm: () => ({ pid: 1, kill() {} }),
    })).rejects.toThrow(/sonata litellm install/);
  });

  it('still starts on a stale pin rather than refusing to serve', async () => {
    // An older pinned version is something for `doctor` to report, not a
    // reason to take the router down.
    writeFileSync(join(venvDir(home), '.sonata-pin'), '1.0.0');
    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(),
      waitForLitellm: async () => {}, spawnLitellm: () => ({ pid: 1, kill() {} }),
    });
    handles.push(handle);
    expect(handle.routerPort).toBeGreaterThan(0);
  });

  it('spawns the managed binary, never whatever `litellm` PATH resolves to', async () => {
    let bin = '';
    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(),
      waitForLitellm: async () => {},
      spawnLitellm: (_c, _e, _p, b) => { bin = b; return { pid: 1, kill() {} }; },
    });
    handles.push(handle);
    expect(bin).toBe(managedLitellmPath(home));
  });

  it('hands the router each direct gateway’s own key', async () => {
    // Without this the direct transport reaches the gateway with an empty
    // credential: `forwardDirect` strips the caller's (it is Claude Code's
    // own Anthropic credential, and forwarding it would be a leak) and has
    // nothing to put in its place.
    writeMachineConfig( ANTHROPIC_ONLY());
    writeSonataKey(home, 'openrouter', 'OPENROUTER-KEY');
    let seen: { url: string; auth?: string } | undefined;
    // Captured before the stub, so the request that drives the router is a
    // real one and only the router's own upstream call is intercepted.
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      seen = { url, auth: (init.headers as Record<string, string>).authorization };
      return new Response('{}', { status: 200 });
    });
    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(),
      waitForLitellm: async () => {}, spawnLitellm: () => ({ pid: 1, kill() {} }),
    });
    handles.push(handle);
    await realFetch(`http://localhost:${handle.routerPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer CALLER-SECRET' },
      body: JSON.stringify({ model: 'sonata-code-simple', messages: [] }),
    });
    // The gateway's own `/v1` is stripped before `/v1/messages` is appended,
    // which is exactly OpenRouter's real Anthropic endpoint.
    expect(seen?.url).toBe('https://openrouter.ai/api/v1/messages');
    expect(seen?.auth).toBe('Bearer OPENROUTER-KEY');
  });
});

describe('cmdServe — a config change refreshes direct credentials', () => {
  it('picks up a rotated gateway key on the litellm-restart path too', async () => {
    // A mixed config restarts litellm for its translated gateways, and that
    // path rebuilds `childEnv`. The direct gateways' keys are read off that
    // env, so missing the refresh there leaves them serving the old key
    // indefinitely — the one branch where "stays current" was not true.
    const mixed = (id: string) => `
[models."or-flash"]
gateway = "openrouter"
id = "deepseek/deepseek-v4-flash"
context_window = 128000

[models."acme-${id}"]
gateway = "acme"
id = "${id}"
context_window = 128000

[tiers.code]
simple = ["or-flash"]
complex = ["or-flash"]

[native.gateways."openrouter"]
base_url = "https://openrouter.ai/api/v1"
provider = "anthropic"

[native.gateways."acme"]
base_url = "https://gateway.example/v1"

[native.ports]
router = 0
litellm = ${litellmPort}
`;
    writeMachineConfig( mixed('first'));
    writeSonataKey(home, 'openrouter', 'OLD-KEY');
    const auths: (string | undefined)[] = [];
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      auths.push((init.headers as Record<string, string>).authorization);
      return new Response('{}', { status: 200 });
    });
    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(),
      waitForLitellm: async () => {},
      spawnLitellm: () => ({ pid: 1, kill() {}, onExit: (cb) => cb(null, 'SIGTERM') }),
    });
    handles.push(handle);
    const send = () => realFetch(`http://localhost:${handle.routerPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'sonata-code-simple', messages: [] }),
    });
    await send();
    // Rotate the credential and change the model registry, which is what
    // triggers the litellm restart branch.
    writeSonataKey(home, 'openrouter', 'NEW-KEY');
    writeMachineConfig( mixed('second'));
    await send();
    await send();
    expect(auths[0]).toBe('Bearer OLD-KEY');
    expect(auths.at(-1)).toBe('Bearer NEW-KEY');
  });
});

describe('cmdServe — what the startup line may claim', () => {
  it('reports no litellm port when no child was started', async () => {
    // The line a user reads to find out what came up must not name a port
    // nothing is listening on. Measured live 2026-09-01: an Anthropic-only
    // config printed "litellm listening on 4178" with no child anywhere.
    writeMachineConfig( `
[models."or-flash"]
gateway = "openrouter"
id = "deepseek/deepseek-v4-flash"
context_window = 128000

[tiers.code]
simple = ["or-flash"]
complex = ["or-flash"]

[native.gateways."openrouter"]
base_url = "https://openrouter.ai/api/v1"
provider = "anthropic"

[native.ports]
router = 0
litellm = ${litellmPort}
`);
    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(),
      waitForLitellm: async () => {}, spawnLitellm: () => ({ pid: 1, kill() {} }),
    });
    handles.push(handle);
    expect(handle.litellmPort).toBeUndefined();
  });

  it('still reports the port when a child is running', async () => {
    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(),
      waitForLitellm: async () => {}, spawnLitellm: () => ({ pid: 1, kill() {} }),
    });
    handles.push(handle);
    expect(handle.litellmPort).toBe(litellmPort);
  });
});

describe('cmdServe — tenants', () => {
  const TENANT = (id: string, port = litellmPort) => `
[models."flash"]
gateway = "acme"
id = "${id}"
[tiers.code]
simple = ["flash"]
complex = ["flash"]
[native.gateways."acme"]
base_url = "https://gateway.example/v1"
[native.ports]
router = 0
litellm = ${port}
`;

  it('serves a project by its header with that project\'s own config, and namespaces the litellm model', async () => {
    writeMachineConfig(TENANT('machine-model'));
    const project = mkdtempSync(join(tmpdir(), 'serve-tenant-a-'));
    writeFileSync(join(project, 'sonata.toml'), TENANT('a-model'));
    const forwarded: string[] = [];
    const downstream = vi.fn(async (_url: string, init: RequestInit) => {
      forwarded.push((JSON.parse(init.body as string) as { model: string }).model);
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', downstream);
    const configs: string[] = [];
    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(), waitForLitellm: async () => {},
      spawnLitellm: (configPath) => {
        configs.push(readFileSync(configPath, 'utf8'));
        return { pid: 1, kill: () => {} };
      },
    });
    handles.push(handle);
    vi.unstubAllGlobals();
    const res = await fetch(`http://localhost:${handle.routerPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...projectHeaders(project) },
      body: JSON.stringify({ model: 'sonata-code-simple', messages: [] }),
    });
    expect(res.status).toBe(200);
    // Canonical: a tenant is identified by the realpath of its config, so two
    // spellings of one project cannot become two tenants.
    const projectId = tenantId(realpathSync(join(project, 'sonata.toml')));
    expect(forwarded).toEqual([`${projectId}/flash`]);
    await waitFor(() => configs.at(-1)?.includes(`${projectId}/flash`) === true, "the project's litellm config");
    expect(configs.at(-1)).toContain(`${projectId}/flash`);
    expect(configs.at(-1)).toContain('a-model');
  });

  it('starts litellm lazily when the first tenant needing it appears after startup', async () => {
    writeMachineConfig(`
[models."sonnet-like"]
gateway = "anth"
id = "some-model"
[tiers.code]
simple = ["sonnet-like"]
complex = ["sonnet-like"]
[native.gateways."anth"]
base_url = "https://anth.example"
provider = "anthropic"
[native.ports]
router = 0
litellm = ${litellmPort}
`);
    writeSonataKey(home, 'anth', 'k');
    const project = mkdtempSync(join(tmpdir(), 'serve-tenant-lazy-'));
    writeFileSync(join(project, 'sonata.toml'), TENANT('needs-litellm'));
    let spawns = 0;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(), waitForLitellm: async () => {},
      spawnLitellm: () => { spawns += 1; return { pid: spawns, kill: () => {} }; },
    });
    handles.push(handle);
    expect(handle.litellmPort).toBeUndefined();
    expect(spawns).toBe(0);
    vi.unstubAllGlobals();
    await fetch(`http://localhost:${handle.routerPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...projectHeaders(project) },
      body: JSON.stringify({ model: 'sonata-code-simple', messages: [] }),
    });
    await waitFor(() => spawns === 1, 'the lazy litellm child');
    expect(spawns).toBe(1);
    const state = JSON.parse(readFileSync(serveStatePath(home, 0), 'utf8'));
    expect(state.routerPid).toBe(process.pid);
    expect(state.litellmPid).toBe(1);
  });

  const LAZY_MACHINE = () => `
[models."sonnet-like"]
gateway = "anth"
id = "some-model"
[tiers.code]
simple = ["sonnet-like"]
complex = ["sonnet-like"]
[native.gateways."anth"]
base_url = "https://anth.example"
provider = "anthropic"
[native.ports]
router = 0
litellm = ${litellmPort}
`;

  it('clears a crashed daemon\'s recorded LiteLLM before the lazy start spawns', async () => {
    writeMachineConfig(LAZY_MACHINE());
    writeSonataKey(home, 'anth', 'k');
    mkdirSync(dirname(serveStatePath(home, 0)), { recursive: true });
    writeFileSync(serveStatePath(home, 0), JSON.stringify({ litellmPid: 222 }));
    const project = mkdtempSync(join(tmpdir(), 'serve-tenant-lazy-orphan-'));
    writeFileSync(join(project, 'sonata.toml'), TENANT('needs-litellm'));
    const signals: string[] = [];
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(orphanKill([], 'SIGTERM', signals));
    let spawns = 0;
    try {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
      const handle = await cmdServe({
        cwd, home, tempDir: tempDirFor(), waitForLitellm: async () => {},
        spawnLitellm: () => { spawns += 1; return { pid: 7000 + spawns, kill: () => {} }; },
        processCommand: () => 'litellm --config x',
      });
      handles.push(handle);
      vi.unstubAllGlobals();
      expect(signals).toEqual([]);
      await fetch(`http://localhost:${handle.routerPort}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...projectHeaders(project) },
        body: JSON.stringify({ model: 'sonata-code-simple', messages: [] }),
      });
      await waitFor(() => spawns === 1, 'the lazy litellm child');
    } finally {
      killSpy.mockRestore();
    }
    expect(signals).toEqual(['SIGTERM']);
    expect(JSON.parse(readFileSync(serveStatePath(home, 0), 'utf8')).litellmPid).toBe(7001);
  });

  it('does not lazily spawn over a recorded LiteLLM that survives, and says why', async () => {
    writeMachineConfig(LAZY_MACHINE());
    writeSonataKey(home, 'anth', 'k');
    mkdirSync(dirname(serveStatePath(home, 0)), { recursive: true });
    writeFileSync(serveStatePath(home, 0), JSON.stringify({ litellmPid: 222 }));
    const project = mkdtempSync(join(tmpdir(), 'serve-tenant-lazy-survivor-'));
    writeFileSync(join(project, 'sonata.toml'), TENANT('needs-litellm'));
    const signals: string[] = [];
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(orphanKill([], 'never', signals));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let spawns = 0;
    try {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
      const handle = await cmdServe({
        cwd, home, tempDir: tempDirFor(), waitForLitellm: async () => {}, litellmExitTimeoutMs: 100,
        spawnLitellm: () => { spawns += 1; return { pid: 7000 + spawns, kill: () => {} }; },
        processCommand: () => 'litellm --config x',
      });
      handles.push(handle);
      vi.unstubAllGlobals();
      const send = () => fetch(`http://localhost:${handle.routerPort}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...projectHeaders(project) },
        body: JSON.stringify({ model: 'sonata-code-simple', messages: [] }),
      });
      await send();
      await waitFor(() => signals.length === 2, 'the escalation');
      // Every later LiteLLM-bound request is refused with the reason, not
      // forwarded to whatever holds the port.
      let res = await send();
      for (let i = 0; i < 50 && res.status !== 502; i += 1) {
        await new Promise((r) => setTimeout(r, 20));
        res = await send();
      }
      expect(res.status).toBe(502);
      const text = await res.text();
      expect(text).toContain('kill -9 222');
      expect(text).toContain('sonata restart');
      // This router is live and holds routerPid in that file: deleting it is
      // not a remedy here.
      expect(text).not.toContain('delete');
      expect(text).not.toContain(serveStatePath(home, 0));
    } finally {
      killSpy.mockRestore();
      errorSpy.mockRestore();
    }
    expect(spawns).toBe(0);
    expect(JSON.parse(readFileSync(serveStatePath(home, 0), 'utf8')).litellmPid).toBe(222);
  });

  it('never serves a direct request on another project\'s key when the re-merge cannot resolve its own', async () => {
    // A defines direct `acme` (opencode, A-KEY), then drops it. B defines its
    // own `acme` elsewhere, sonata-sourced, with no key stored yet. The
    // re-merge throws for B's missing key; the child env it would have
    // replaced still held A's SONATA_KEY_ACME, and B's request carried it.
    const machineA = (withAcme: boolean) => `
[models."a-flash"]
gateway = "${withAcme ? 'acme' : 'other'}"
id = "a-model"
${withAcme
    ? '[native.gateways."acme"]\nbase_url = "https://a.example/v1"\nprovider = "anthropic"\ncredential_source = "opencode"'
    : '[native.gateways."other"]\nbase_url = "https://other.example/v1"\nprovider = "anthropic"'}
[native.ports]
router = 0
litellm = ${litellmPort}
`;
    writeMachineConfig(machineA(true));
    mkdirSync(join(home, '.local', 'share', 'opencode'), { recursive: true });
    writeFileSync(join(home, '.local', 'share', 'opencode', 'auth.json'), JSON.stringify({ acme: { type: 'api', key: 'A-KEY' } }));
    const project = mkdtempSync(join(tmpdir(), 'serve-tenant-failed-rebuild-'));
    writeFileSync(join(project, 'sonata.toml'), `
[models."b-flash"]
gateway = "acme"
id = "b-model"
[native.gateways."acme"]
base_url = "https://b.example/v1"
provider = "anthropic"
credential_source = "sonata"
`);
    const forwarded: { url: string; auth?: string; xkey?: string }[] = [];
    const errors: string[] = [];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.join(' ')); });
    try {
      vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
        const headers = init.headers as Record<string, string>;
        forwarded.push({ url, auth: headers.authorization, xkey: headers['x-api-key'] });
        return new Response('{}', { status: 200 });
      }));
      const handle = await cmdServe({
        cwd, home, tempDir: tempDirFor(), waitForLitellm: async () => {},
        spawnLitellm: () => ({ pid: 1, kill: () => {} }),
      });
      handles.push(handle);
      vi.unstubAllGlobals();
      const send = () => fetch(`http://localhost:${handle.routerPort}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...projectHeaders(project) },
        body: JSON.stringify({ model: 'b-flash', messages: [] }),
      });
      writeMachineConfig(machineA(false));
      await send();
      await send();
      expect(JSON.stringify(forwarded)).not.toContain('A-KEY');
      // Logged once per distinct failure, not once per request, and with one prefix.
      const failures = errors.filter((line) => line.includes('gateway "acme" takes its credential from sonata'));
      expect(failures).toHaveLength(1);
      expect(failures[0]).not.toContain('sonata serve: sonata serve:');
      // `sonata auth add acme` changes no config: the next request retries anyway.
      writeSonataKey(home, 'acme', 'B-KEY');
      forwarded.length = 0;
      await send();
      expect(forwarded).toHaveLength(1);
      expect(forwarded[0].url).toContain('https://b.example/v1');
      expect(JSON.stringify(forwarded[0])).toContain('B-KEY');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('never forwards to a direct gateway whose credential did not resolve, on the tier path or the bare one', async () => {
    // With no key the request went out with an empty bearer: the upstream
    // answered 401, the tier path turned that into a 529 pointing at `sonata
    // dispatch`, and the bare path handed Claude Code a 401 it reads as its
    // own login failing. Either way the conversation had already been sent.
    writeMachineConfig(`
[models."mm"]
gateway = "machdirect"
id = "x-1"
[native.gateways."machdirect"]
base_url = "https://direct.example"
provider = "anthropic"
[native.ports]
router = 0
litellm = ${litellmPort}
`);
    writeSonataKey(home, 'machdirect', 'sk-machine-key');
    const project = mkdtempSync(join(tmpdir(), 'serve-direct-no-key-'));
    writeFileSync(join(project, 'sonata.toml'), `
[models."pdm"]
gateway = "pd"
id = "pd-1"
[tiers.code]
simple = ["pdm"]
complex = ["pdm"]
[native.gateways."pd"]
base_url = "https://pd.example"
provider = "anthropic"
credential_source = "sonata"
`);
    const forwarded: string[] = [];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        forwarded.push(String(url));
        return new Response('{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', { status: 401 });
      }));
      const handle = await cmdServe({
        cwd, home, tempDir: tempDirFor(), waitForLitellm: async () => {},
        spawnLitellm: () => ({ pid: 1, kill: () => {} }),
      });
      handles.push(handle);
      vi.unstubAllGlobals();
      const send = async (model: string) => {
        const res = await fetch(`http://localhost:${handle.routerPort}/v1/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...projectHeaders(project) },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: 'secret prompt' }] }),
        });
        return { status: res.status, message: (await res.json() as { error: { message: string } }).error.message };
      };
      for (const model of ['sonata-code-simple', 'pdm']) {
        const { status, message } = await send(model);
        expect(status).toBe(502);
        expect(message).toContain('gateway "pd"');
        expect(message).toContain('sonata auth add pd');
      }
      expect(forwarded.filter((url) => url.includes('pd.example'))).toEqual([]);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('keeps every other gateway\'s direct key when one unrelated project\'s credential cannot resolve', async () => {
    // The machine serves direct `machdirect` on its own sonata key. Project B,
    // unrelated, arrives with a sonata-sourced codex-oauth gateway and no login
    // yet. B's failure used to strip every direct key in every tenant, so the
    // machine's next request went out with no credential at all.
    writeMachineConfig(`
[models."mm"]
gateway = "machdirect"
id = "x-1"
[tiers.code]
simple = ["mm"]
complex = ["mm"]
[native.gateways."machdirect"]
base_url = "https://direct.example"
provider = "anthropic"
[native.ports]
router = 0
litellm = ${litellmPort}
`);
    writeSonataKey(home, 'machdirect', 'sk-machine-key');
    const project = mkdtempSync(join(tmpdir(), 'serve-tenant-unrelated-failure-'));
    writeFileSync(join(project, 'sonata.toml'), `
[models."luna"]
gateway = "bcodex"
id = "gpt-5.6-luna"
[tiers.code]
simple = ["luna"]
complex = ["luna"]
[native.gateways."bcodex"]
auth = "codex-oauth"
credential_source = "sonata"
`);
    const keys: string[] = [];
    const errors: string[] = [];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.join(' ')); });
    try {
      vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
        if (String(url).startsWith('https://direct.example')) {
          const headers = init.headers as Record<string, string>;
          keys.push(headers['x-api-key'] ?? headers.authorization ?? '(none)');
        }
        return new Response('{}', { status: 200 });
      }));
      const handle = await cmdServe({
        cwd, home, tempDir: tempDirFor(), waitForLitellm: async () => {},
        spawnLitellm: () => ({ pid: 1, kill: () => {} }),
      });
      handles.push(handle);
      vi.unstubAllGlobals();
      const send = (headers: Record<string, string> = {}) => fetch(`http://localhost:${handle.routerPort}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ model: 'sonata-code-simple', messages: [] }),
      });
      await send();
      expect(keys.at(-1)).toContain('sk-machine-key');
      await send(projectHeaders(project));
      await send();
      await send();
      expect(keys).toHaveLength(3);
      for (const key of keys) expect(key).toContain('sk-machine-key');
      // B's failure is still reported, once, naming its gateway.
      expect(errors.filter((line) => line.includes('bcodex'))).toHaveLength(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  describe('a LiteLLM gateway whose credential cannot resolve', () => {
    // One project's missing login used to make every LiteLLM (re)spawn throw,
    // so no project's new model was ever loaded, and the missing one reached
    // LiteLLM anyway to be answered "Invalid model name". Its models are now
    // left out of LiteLLM's config like a dropped gateway's, answered with a
    // 502 naming the credential, and loaded once it appears.
    const B_CONFIG = `
[models."luna"]
gateway = "bcodex"
id = "gpt-5.6-luna"
[models."bflash"]
gateway = "bgw"
id = "b-flash-1"
[tiers.code]
simple = ["luna"]
complex = ["bflash"]
[native.gateways."bcodex"]
auth = "codex-oauth"
credential_source = "sonata"
[native.gateways."bgw"]
base_url = "https://bgw.example/v1"
`;
    const run = async (machineToml: string) => {
      writeMachineConfig(machineToml);
      const project = mkdtempSync(join(tmpdir(), 'serve-tenant-litellm-credential-'));
      writeFileSync(join(project, 'sonata.toml'), B_CONFIG);
      writeSonataKey(home, 'bgw', 'bgw-key');
      writeSonataKey(home, 'acme', 'acme-key');
      const tempDir = tempDirFor();
      const configJson = () => (existsSync(join(tempDir, 'config.json')) ? readFileSync(join(tempDir, 'config.json'), 'utf8') : '');
      let spawns = 0;
      vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        const model = (JSON.parse(String(init.body)) as { model: string }).model;
        return configJson().includes(`"${model}"`)
          ? new Response('{}', { status: 200 })
          : new Response('{"error":{"message":"Invalid model name"}}', { status: 400 });
      }));
      const handle = await cmdServe({
        cwd, home, tempDir, waitForLitellm: async () => {},
        spawnLitellm: () => { spawns += 1; return { pid: spawns, kill: () => {} }; },
      });
      handles.push(handle);
      vi.unstubAllGlobals();
      const send = (model: string, headers: Record<string, string> = {}) => fetch(`http://localhost:${handle.routerPort}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ model, messages: [] }),
      });
      return { project, send, spawns: () => spawns };
    };
    const login = () => {
      mkdirSync(credentialDir(home, 'bcodex'), { recursive: true });
      writeFileSync(join(credentialDir(home, 'bcodex'), 'auth.json'), JSON.stringify({ access_token: 'x', refresh_token: 'r' }));
    };
    let errors: string[];
    let errorSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      errors = [];
      errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.join(' ')); });
    });
    afterEach(() => { errorSpy.mockRestore(); });

    it('restart: keeps serving everyone else, answers the missing one with a named 502, and loads it after login', async () => {
      const { project, send, spawns } = await run(`
[models."mflash"]
gateway = "acme"
id = "m-flash-1"
[tiers.code]
simple = ["mflash"]
complex = ["mflash"]
[native.gateways."acme"]
base_url = "https://acme.example/v1"
[native.ports]
router = 0
litellm = ${litellmPort}
`);
      expect(spawns()).toBe(1);
      const b = projectHeaders(project);
      const missing = await send('sonata-code-simple', b);
      expect(missing.status).toBe(502);
      const message = (await missing.json() as { error: { message: string } }).error.message;
      expect(message).toContain('bcodex');
      expect(message).toContain('sonata auth login bcodex');
      await waitFor(() => spawns() === 2, 'the restart that loads B\'s other gateway');
      // B's other gateway, and the machine's, are served by the restarted LiteLLM.
      expect((await send('sonata-code-complex', b)).status).toBe(200);
      expect((await send('sonata-code-simple')).status).toBe(200);
      for (let i = 0; i < 3; i++) expect((await send('sonata-code-simple', b)).status).toBe(502);
      expect(errors.filter((line) => line.includes('failed to restart litellm'))).toHaveLength(0);
      expect(errors.filter((line) => line.includes('bcodex'))).toHaveLength(1);
      expect(spawns()).toBe(2);
      // B logs in: the next request picks it up, and LiteLLM is respawned with it.
      login();
      await send('sonata-code-simple', b);
      await waitFor(() => spawns() === 3, 'the respawn after login');
      expect((await send('sonata-code-simple', b)).status).toBe(200);
    });

    it('startup: a registered session\'s missing login does not stop the router starting', async () => {
      // Startup fails outright only for the machine config's own gateways;
      // before, any registered project's missing credential killed the daemon.
      const project = mkdtempSync(join(tmpdir(), 'serve-tenant-startup-credential-'));
      writeFileSync(join(project, 'sonata.toml'), B_CONFIG);
      await recordSession(home, { session: 'SB', cwd: project, started: new Date().toISOString() });
      const { send, spawns } = await run(`
[models."mflash"]
gateway = "acme"
id = "m-flash-1"
[tiers.code]
simple = ["mflash"]
complex = ["mflash"]
[native.gateways."acme"]
base_url = "https://acme.example/v1"
[native.ports]
router = 0
litellm = ${litellmPort}
`);
      expect(spawns()).toBe(1);
      expect((await send('sonata-code-simple')).status).toBe(200);
      expect((await send('sonata-code-simple', { 'x-claude-code-session-id': 'SB' })).status).toBe(502);
    });

    it('startup: retries a credential that failed at startup, so a later login is loaded', async () => {
      // The startup merge committed its fingerprint even when a credential
      // failed, and a sonata OAuth login moves no fingerprint — so with no
      // tenant or config changing afterwards, the failure was never retried.
      const project = mkdtempSync(join(tmpdir(), 'serve-tenant-startup-retry-'));
      writeFileSync(join(project, 'sonata.toml'), B_CONFIG);
      await recordSession(home, { session: 'SB', cwd: project, started: new Date().toISOString() });
      const { send, spawns } = await run(`
[models."mflash"]
gateway = "acme"
id = "m-flash-1"
[tiers.code]
simple = ["mflash"]
complex = ["mflash"]
[native.gateways."acme"]
base_url = "https://acme.example/v1"
[native.ports]
router = 0
litellm = ${litellmPort}
`);
      const b = { 'x-claude-code-session-id': 'SB' };
      expect(spawns()).toBe(1);
      expect((await send('sonata-code-simple', b)).status).toBe(502);
      login();
      await send('sonata-code-simple', b);
      await waitFor(() => spawns() === 2, 'the respawn after login');
      expect((await send('sonata-code-simple', b)).status).toBe(200);
    });

    it('lazy start: starts LiteLLM for the gateways that resolve, and loads the missing one after login', async () => {
      const { project, send, spawns } = await run(`
[models."mm"]
gateway = "machdirect"
id = "x-1"
[tiers.code]
simple = ["mm"]
complex = ["mm"]
[native.gateways."machdirect"]
base_url = "https://direct.example"
provider = "anthropic"
[native.ports]
router = 0
litellm = ${litellmPort}
`);
      writeSonataKey(home, 'machdirect', 'sk-machine-key');
      expect(spawns()).toBe(0);
      const b = projectHeaders(project);
      expect((await send('sonata-code-simple', b)).status).toBe(502);
      await waitFor(() => spawns() === 1, 'the lazy start');
      expect((await send('sonata-code-complex', b)).status).toBe(200);
      expect((await send('sonata-code-simple', b)).status).toBe(502);
      login();
      await send('sonata-code-simple', b);
      await waitFor(() => spawns() === 2, 'the respawn after login');
      expect((await send('sonata-code-simple', b)).status).toBe(200);
    });

    it('startup: spawns no LiteLLM when the only gateway needing one is left out', async () => {
      // Whether LiteLLM is needed was asked of the configs before any gateway
      // was excluded, so a union whose one LiteLLM gateway had no credential
      // started a child with an empty model list.
      const project = mkdtempSync(join(tmpdir(), 'serve-tenant-only-litellm-excluded-'));
      writeFileSync(join(project, 'sonata.toml'), `
[models."luna"]
gateway = "bcodex"
id = "gpt-5.6-luna"
[tiers.code]
simple = ["luna"]
complex = ["luna"]
[native.gateways."bcodex"]
auth = "codex-oauth"
credential_source = "sonata"
`);
      await recordSession(home, { session: 'SB', cwd: project, started: new Date().toISOString() });
      const { send, spawns } = await run(`
[models."mm"]
gateway = "machdirect"
id = "x-1"
[tiers.code]
simple = ["mm"]
complex = ["mm"]
[native.gateways."machdirect"]
base_url = "https://direct.example"
provider = "anthropic"
[native.ports]
router = 0
litellm = ${litellmPort}
`);
      const b = { 'x-claude-code-session-id': 'SB' };
      expect(spawns()).toBe(0);
      expect((await send('sonata-code-simple', b)).status).toBe(502);
      expect(spawns()).toBe(0);
      login();
      await send('sonata-code-simple', b);
      await waitFor(() => spawns() === 1, 'the lazy start after login');
      expect((await send('sonata-code-simple', b)).status).toBe(200);
    });
  });

  it('re-merges before routing a newly noted tenant, so its conflicting direct gateway is never served', async () => {
    // A: machine config, direct `acme` whose key comes from opencode. B: a
    // project that also names `acme`, default-sourced, pointing elsewhere. B
    // is unknown at startup; its FIRST request is a bare direct key. Merged
    // stale, B's request would carry A's key (SONATA_KEY_ACME) to B's base_url.
    writeMachineConfig(`
[models."a-flash"]
gateway = "acme"
id = "a-model"
[native.gateways."acme"]
base_url = "https://a.example/v1"
provider = "anthropic"
credential_source = "opencode"
[native.ports]
router = 0
litellm = ${litellmPort}
`);
    mkdirSync(join(home, '.local', 'share', 'opencode'), { recursive: true });
    writeFileSync(join(home, '.local', 'share', 'opencode', 'auth.json'), JSON.stringify({ acme: { type: 'api', key: 'A-KEY' } }));
    const project = mkdtempSync(join(tmpdir(), 'serve-tenant-late-conflict-'));
    writeFileSync(join(project, 'sonata.toml'), `
[models."b-flash"]
gateway = "acme"
id = "b-model"
[native.gateways."acme"]
base_url = "https://b.example/v1"
provider = "anthropic"
`);
    const forwarded: { url: string; auth?: string }[] = [];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
        forwarded.push({ url, auth: (init.headers as Record<string, string>).authorization });
        return new Response('{}', { status: 200 });
      }));
      const handle = await cmdServe({
        cwd, home, tempDir: tempDirFor(), waitForLitellm: async () => {},
        spawnLitellm: () => ({ pid: 1, kill: () => {} }),
      });
      handles.push(handle);
      vi.unstubAllGlobals();
      const res = await fetch(`http://localhost:${handle.routerPort}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...projectHeaders(project) },
        body: JSON.stringify({ model: 'b-flash', messages: [] }),
      });
      expect(res.status).toBe(502);
      const message = (await res.json() as { error: { message: string } }).error.message;
      expect(message).toContain('gateway "acme"');
      expect(forwarded).toEqual([]);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('re-resolves which ChatGPT store the default reads when `codex login` changes it while serving', async () => {
    writeMachineConfig(`
[models."luna"]
gateway = "codex"
id = "gpt-5.6-luna"
[models."byok"]
gateway = "openai"
id = "gpt-5.6-luna"
[tiers.code]
simple = ["luna", "byok"]
complex = ["luna", "byok"]
[native.gateways."codex"]
auth = "codex-oauth"
credential_source = "codex"
[native.gateways."openai"]
auth = "codex-oauth"
[native.ports]
router = 0
litellm = ${litellmPort}
`);
    const codexAuth = join(home, '.codex', 'auth.json');
    const login = () => {
      mkdirSync(join(home, '.codex'), { recursive: true });
      writeFileSync(codexAuth, JSON.stringify({ tokens: { access_token: 'x', refresh_token: 'r' } }));
    };
    login();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
      const handle = await cmdServe({
        cwd, home, tempDir: tempDirFor(), waitForLitellm: async () => {},
        spawnLitellm: () => ({ pid: 1, kill: () => {} }),
      });
      handles.push(handle);
      vi.unstubAllGlobals();
      const send = () => fetch(`http://localhost:${handle.routerPort}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'sonata-code-simple', messages: [] }),
      });
      // Both read the codex store: one account, served.
      expect((await send()).status).not.toBe(502);
      // `codex logout`: the default now falls through to opencode's store.
      rmSync(codexAuth);
      expect((await send()).status).toBe(502);
      // `codex login` again: one account once more.
      login();
      expect((await send()).status).not.toBe(502);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('regenerates LiteLLM\'s model list and starts it when `codex login` un-drops the gateways', async () => {
    // Started logged OUT: the two gateways read different stores, so both are
    // dropped — no model is left for LiteLLM, so none is started, and
    // config.json has neither's models. A login un-drops them — but the
    // configs are untouched, so a restart keyed on the configs alone never
    // fired, and requests reached a LiteLLM that answered "Invalid model name".
    writeMachineConfig(`
[models."luna"]
gateway = "codex"
id = "gpt-5.6-luna"
[models."byok"]
gateway = "openai"
id = "gpt-5.6-luna"
[tiers.code]
simple = ["luna", "byok"]
complex = ["luna", "byok"]
[native.gateways."codex"]
auth = "codex-oauth"
credential_source = "codex"
[native.gateways."openai"]
auth = "codex-oauth"
[native.ports]
router = 0
litellm = ${litellmPort}
`);
    const tempDir = tempDirFor();
    const configJson = () => readFileSync(join(tempDir, 'config.json'), 'utf8');
    const spawnEnvs: NodeJS.ProcessEnv[] = [];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // Answers like LiteLLM: a model its config does not list is a 400.
      vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        const model = (JSON.parse(String(init.body)) as { model: string }).model;
        return configJson().includes(`"${model}"`)
          ? new Response('{}', { status: 200 })
          : new Response('{"error":{"message":"Invalid model name"}}', { status: 400 });
      }));
      const handle = await cmdServe({
        cwd, home, tempDir, waitForLitellm: async () => {},
        spawnLitellm: (_config, env) => { spawnEnvs.push(env); return { pid: 1, kill: () => {} }; },
      });
      handles.push(handle);
      vi.unstubAllGlobals();
      const send = () => fetch(`http://localhost:${handle.routerPort}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'sonata-code-simple', messages: [] }),
      });
      expect((await send()).status).toBe(502);
      expect(configJson()).not.toContain('gpt-5.6-luna');
      expect(spawnEnvs).toHaveLength(0);

      mkdirSync(join(home, '.codex'), { recursive: true });
      writeFileSync(join(home, '.codex', 'auth.json'), JSON.stringify({ tokens: { access_token: 'x', refresh_token: 'r' } }));
      const res = await send();
      expect(configJson()).toContain('gpt-5.6-luna');
      expect(spawnEnvs).toHaveLength(1);
      expect(spawnEnvs[0].CHATGPT_TOKEN_DIR).toBeDefined();
      expect(res.status).toBe(200);
    } finally {
      errorSpy.mockRestore();
    }
  });

  describe('the ChatGPT token directory LiteLLM owns', () => {
    // LiteLLM re-reads CHATGPT_TOKEN_DIR/auth.json on every access token it
    // needs, refreshes it in place with open("w"), and ChatGPT rotates
    // refresh tokens — an old one is refused as `refresh_token_reused`. So
    // sonata writes a token only into a directory it has just created for a
    // spawn, and never into one a LiteLLM is using. A different login in the
    // store — another store, or another account — restarts LiteLLM into a
    // fresh directory; nothing else does.
    const claimJwt = (exp: number, account?: string) => `h.${Buffer.from(JSON.stringify({
      exp, client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
      ...(account === undefined ? {} : { 'https://api.openai.com/auth': { chatgpt_account_id: account } }),
    })).toString('base64url')}.s`;
    const machine = (extra = '', source?: string) => `
[models."luna"]
gateway = "codex"
id = "gpt-5.6-luna"
${extra}
[tiers.code]
simple = ["luna"]
complex = ["luna"]
[native.gateways."codex"]
auth = "codex-oauth"
${source === undefined ? '' : `credential_source = "${source}"`}
[native.ports]
router = 0
litellm = ${litellmPort}
`;
    const writeCodexStore = (tokens: Record<string, string>) => {
      mkdirSync(join(home, '.codex'), { recursive: true });
      writeFileSync(join(home, '.codex', 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens }));
    };
    const writeOpencodeStore = (access: string, refresh: string) => {
      mkdirSync(join(home, '.local', 'share', 'opencode'), { recursive: true });
      writeFileSync(join(home, '.local', 'share', 'opencode', 'auth.json'), JSON.stringify({
        openai: { type: 'oauth', access, refresh, expires: 1_900_000_000_000 },
      }));
    };
    const ocDbPath = () => join(home, '.local', 'share', 'opencode', 'opencode.db');
    const start = async (o: { onExitSupported?: boolean; upstream?: () => Response } = {}) => {
      const envs: NodeJS.ProcessEnv[] = [];
      const exits: ((code: number | null, signal: NodeJS.Signals | null) => void)[][] = [];
      const outputs: ((line: string) => void)[][] = [];
      const upstreamCalls: string[] = [];
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        upstreamCalls.push(String(url));
        return o.upstream?.() ?? new Response('{}', { status: 200 });
      }));
      const handle = await cmdServe({
        cwd, home, tempDir: tempDirFor(), waitForLitellm: async () => {}, respawnDelayMs: 0,
        spawnLitellm: (_config, env) => {
          envs.push({ ...env });
          const listeners: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
          exits.push(listeners);
          const lines: ((line: string) => void)[] = [];
          outputs.push(lines);
          return {
            pid: envs.length,
            kill: () => { setImmediate(() => listeners.forEach((cb) => cb(null, 'SIGTERM'))); },
            ...(o.onExitSupported === false ? {} : { onExit: (cb: (code: number | null, signal: NodeJS.Signals | null) => void) => { listeners.push(cb); } }),
            onOutputLine: (cb: (line: string) => void) => { lines.push(cb); },
          };
        },
      });
      handles.push(handle);
      vi.unstubAllGlobals();
      const send = () => fetch(`http://localhost:${handle.routerPort}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'sonata-code-simple', messages: [] }),
      }).then(async (res) => { await res.text(); return res.status; });
      const dir = () => envs.at(-1)?.CHATGPT_TOKEN_DIR ?? '';
      const tokenFile = () => join(dir(), 'auth.json');
      const held = () => JSON.parse(readFileSync(tokenFile(), 'utf8')) as { refresh_token?: string };
      const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
      /** The latest child exiting on its own. */
      const crash = () => exits.at(-1)!.forEach((cb) => cb(1, null));
      /** The latest child writing `text`, one line at a time, to its stdout or stderr. */
      const emit = (text: string) => { for (const line of text.split('\n')) outputs.at(-1)!.forEach((cb) => cb(line)); };
      const sendFull = () => fetch(`http://localhost:${handle.routerPort}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'sonata-code-simple', messages: [] }),
      }).then(async (res) => ({ status: res.status, text: await res.text() }));
      return { send, sendFull, envs, dir, tokenFile, held, settle, crash, emit, upstreamCalls };
    };
    let errors: string[];
    let errorSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      errors = [];
      errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.join(' ')); });
    });
    afterEach(() => { errorSpy.mockRestore(); });

    it('seeds a fresh directory for the first spawn and points LiteLLM at it', async () => {
      writeMachineConfig(machine());
      writeCodexStore({ access_token: claimJwt(2_000_000_000, 'acct-a'), refresh_token: 'FROM-CODEX' });
      const { envs, held, tokenFile } = await start();
      expect(envs).toHaveLength(1);
      expect(held().refresh_token).toBe('FROM-CODEX');
      expect(statSync(tokenFile()).mode & 0o777).toBe(0o600);
      expect(readdirSync(tempDirFor()).filter((name) => name.startsWith('chatgpt'))).toEqual(['chatgpt']);
    });

    it('leaves a token LiteLLM has refreshed alone, through requests, config edits, re-merges and a registry restart', async () => {
      writeMachineConfig(machine());
      writeCodexStore({ access_token: claimJwt(1000, 'acct-a'), refresh_token: 'FROM-CODEX' });
      const { send, envs, dir, tokenFile, settle } = await start();
      const refreshed = JSON.stringify({
        access_token: claimJwt(2000, 'acct-a'), refresh_token: 'REFRESHED', expires_at: 2000, account_id: 'acct-a',
      });
      writeFileSync(tokenFile(), refreshed);
      const first = dir();
      for (let i = 0; i < 5; i += 1) await send();
      writeMachineConfig(`# edited\n${machine()}`);
      await send();
      writeSonataKey(home, 'unrelated', 'k');
      await send();
      // A store that is re-read (its file rewritten, same login) re-merges too.
      writeCodexStore({ access_token: claimJwt(1000, 'acct-a'), refresh_token: 'FROM-CODEX' });
      await send();
      expect(envs).toHaveLength(1);
      expect(readFileSync(tokenFile(), 'utf8')).toBe(refreshed);
      // A registry change restarts LiteLLM into the SAME directory, untouched.
      writeMachineConfig(machine('context_window = 64000'));
      await send();
      await settle();
      expect(envs).toHaveLength(2);
      expect(dir()).toBe(first);
      expect(readFileSync(tokenFile(), 'utf8')).toBe(refreshed);
    });

    it.runIf(sqliteAvailable())('leaves LiteLLM\'s rotated token alone for an opencode v2 login that carries no account id', async () => {
      // The v2 credential row has no `accountId`. Read as "a different
      // account", it overwrote LiteLLM's rotated token on every re-merge.
      writeMachineConfig(machine('', 'opencode'));
      writeOpencodeCredDb(ocDbPath(), [{
        id: 'c1', integration: 'openai', timeCreated: 1,
        value: JSON.stringify({ type: 'oauth', access: claimJwt(1_900_000_000, 'acct-1'), refresh: 'STORE', expires: 1_900_000_000_000 }),
      }]);
      const { send, envs, tokenFile } = await start();
      const rotated = JSON.stringify({
        access_token: claimJwt(1_900_864_000, 'acct-1'), refresh_token: 'LITELLM-ROTATED',
        id_token: null, expires_at: 1_900_864_000, account_id: 'acct-1',
      });
      writeFileSync(tokenFile(), rotated);
      writeSonataKey(home, 'unrelated', 'k');
      await send();
      writeMachineConfig(`# edited\n${machine('', 'opencode')}`);
      await send();
      expect(envs).toHaveLength(1);
      expect(readFileSync(tokenFile(), 'utf8')).toBe(rotated);
    });

    it('never touches a half-written file in LiteLLM\'s directory', async () => {
      writeMachineConfig(machine());
      writeCodexStore({ access_token: claimJwt(1000, 'acct-a'), refresh_token: 'FROM-CODEX' });
      const { send, envs, tokenFile } = await start();
      // LiteLLM is mid-write (open("w") has truncated it) when a re-merge lands.
      writeFileSync(tokenFile(), '{"access_token":"h.eyJ');
      writeMachineConfig(`# edited\n${machine()}`);
      await send();
      writeSonataKey(home, 'unrelated', 'k');
      await send();
      expect(readFileSync(tokenFile(), 'utf8')).toBe('{"access_token":"h.eyJ');
      expect(envs).toHaveLength(1);
    });

    it('restarts LiteLLM once, into a fresh directory holding the new account\'s token, when the account changes', async () => {
      writeMachineConfig(machine());
      writeCodexStore({ access_token: claimJwt(2_000_000_000, 'acct-a'), refresh_token: 'ACCOUNT-A' });
      const { send, envs, dir, held, settle } = await start();
      const first = dir();
      expect(held().refresh_token).toBe('ACCOUNT-A');
      writeCodexStore({ access_token: claimJwt(1_900_000_000, 'acct-b'), refresh_token: 'ACCOUNT-B' });
      await send();
      await waitFor(() => envs.length === 2, 'the restart for the new account');
      expect(dir()).not.toBe(first);
      expect(held().refresh_token).toBe('ACCOUNT-B');
      expect(existsSync(first)).toBe(false);
      expect(errors.some((line) => line.includes('gateway "codex": account changed — restarting litellm'))).toBe(true);
      for (let i = 0; i < 4; i += 1) { await send(); await settle(); }
      expect(envs).toHaveLength(2);
    });

    it('restarts LiteLLM into a fresh directory when credential_source moves to another store', async () => {
      writeMachineConfig(machine('', 'codex'));
      writeCodexStore({ access_token: claimJwt(2_000_000_000), refresh_token: 'CODEX-A' });
      writeOpencodeStore(claimJwt(1_900_000_000), 'OPENCODE-B');
      const { send, envs, dir, held } = await start();
      const first = dir();
      expect(held().refresh_token).toBe('CODEX-A');
      writeMachineConfig(machine('', 'opencode'));
      await send();
      await waitFor(() => envs.length === 2, 'the restart for the new source');
      expect(dir()).not.toBe(first);
      expect(held().refresh_token).toBe('OPENCODE-B');
      expect(errors.some((line) => line.includes('credential source changed (codex store → opencode store)'))).toBe(true);
    });

    it('does not restart for a same-account re-login, or for codex refreshing its own store', async () => {
      writeMachineConfig(machine());
      writeCodexStore({ access_token: claimJwt(1000, 'acct-a'), refresh_token: 'SEEDED' });
      const { send, envs, tokenFile, settle } = await start();
      const seeded = readFileSync(tokenFile(), 'utf8');
      writeCodexStore({ access_token: claimJwt(9_999_999_999, 'acct-a'), refresh_token: 'RELOGGED' });
      await send(); await settle();
      writeCodexStore({ access_token: claimJwt(9_999_999_999, 'acct-a'), refresh_token: 'CODEX-REFRESHED', account_id: 'acct-a' });
      await send(); await settle();
      // An account learned only now (the seed had none) is not a switch either.
      expect(envs).toHaveLength(1);
      expect(readFileSync(tokenFile(), 'utf8')).toBe(seeded);
    });

    it('does not restart while one account\'s store alternates between records with and without account_id or an id token', async () => {
      // LiteLLM reads the record's `account_id` first, then the JWT claim;
      // `chatgptAccountId` now follows that order. Every shape one login's
      // record takes must still name one account, or the seed generation
      // would move and restart LiteLLM on every rewrite.
      writeMachineConfig(machine());
      writeCodexStore({ access_token: claimJwt(2_000_000_000, 'acct-a'), refresh_token: 'SEEDED', account_id: 'acct-a' });
      const { send, envs, tokenFile, settle } = await start();
      const seeded = readFileSync(tokenFile(), 'utf8');
      const shapes: Record<string, string>[] = [
        { access_token: claimJwt(2_000_000_001, 'acct-a'), refresh_token: 'R1' },
        { access_token: claimJwt(2_000_000_002), refresh_token: 'R2', account_id: 'acct-a' },
        { access_token: claimJwt(2_000_000_003), id_token: claimJwt(2_000_000_003, 'acct-a'), refresh_token: 'R3' },
        { access_token: claimJwt(2_000_000_004, 'acct-a'), id_token: claimJwt(2_000_000_004, 'acct-a'), refresh_token: 'R4', account_id: 'acct-a' },
        { access_token: claimJwt(2_000_000_005), refresh_token: 'R5' },
      ];
      for (let round = 0; round < 2; round += 1) {
        for (const tokens of shapes) { writeCodexStore(tokens); await send(); await settle(); }
      }
      expect(envs).toHaveLength(1);
      expect(readFileSync(tokenFile(), 'utf8')).toBe(seeded);
      expect(errors.some((line) => line.includes('restarting litellm'))).toBe(false);
    });

    it('restarts when `codex logout` makes the default fall through to opencode\'s other account', async () => {
      writeMachineConfig(machine());
      writeCodexStore({ access_token: claimJwt(2_000_000_000, 'acct-a'), refresh_token: 'CODEX-A' });
      writeOpencodeStore(claimJwt(1_900_000_000, 'acct-b'), 'OPENCODE-B');
      const { send, envs, dir, held } = await start();
      const first = dir();
      rmSync(join(home, '.codex', 'auth.json'));
      await send();
      await waitFor(() => envs.length === 2, 'the restart for the fallback login');
      expect(dir()).not.toBe(first);
      expect(held().refresh_token).toBe('OPENCODE-B');
    });

    it('seeds a fresh directory when a login returns after positively going away', async () => {
      writeMachineConfig(machine('', 'codex'));
      writeCodexStore({ access_token: claimJwt(2_000_000_000, 'acct-a'), refresh_token: 'FIRST' });
      const { send, envs, dir, held, settle } = await start();
      const first = dir();
      rmSync(join(home, '.codex', 'auth.json'));
      expect(await send()).toBe(502);
      await settle();
      writeCodexStore({ access_token: claimJwt(2_000_000_000, 'acct-a'), refresh_token: 'SECOND' });
      await send();
      await waitFor(() => envs.at(-1)?.CHATGPT_TOKEN_DIR !== undefined && envs.at(-1)?.CHATGPT_TOKEN_DIR !== first,
        'a spawn into a new directory');
      expect(held().refresh_token).toBe('SECOND');
    });

    it('detects a logout and re-login by the login\'s identity, not by the gateway\'s name', async () => {
      // Renaming the gateway keeps the login it reads. Keyed on the name, the
      // logout under the new name was never seen, and a same-account re-login
      // left LiteLLM on the spent token.
      writeMachineConfig(machine('', 'codex'));
      writeCodexStore({ access_token: claimJwt(2_000_000_000, 'acct-a'), refresh_token: 'FIRST' });
      const { send, envs, dir, held, settle } = await start();
      const first = dir();
      writeMachineConfig(machine('', 'codex').replaceAll('"codex"', '"chatgpt"').replace('credential_source = "chatgpt"', 'credential_source = "codex"'));
      await send(); await settle();
      expect(held().refresh_token).toBe('FIRST');
      rmSync(join(home, '.codex', 'auth.json'));
      expect(await send()).toBe(502);
      await settle();
      writeCodexStore({ access_token: claimJwt(2_000_000_000, 'acct-a'), refresh_token: 'SECOND' });
      await send();
      await waitFor(() => envs.at(-1)?.CHATGPT_TOKEN_DIR !== first && held().refresh_token === 'SECOND',
        'a spawn into a new directory with the returning login');
      expect(errors.some((line) => line.includes('logged in again'))).toBe(true);
    });

    for (const source of ['codex', undefined] as const) {
      it(`keeps a resolved gateway's login through a store skipped for staying unreadable, and restarts nothing when it reads again (source ${source ?? 'default'})`, async () => {
        // Past the torn window an unreadable store reads as absent with
        // \`skipped\` set. Counted as a logout, that dropped the gateway and
        // ended its lineage, so the file reading again re-seeded LiteLLM from
        // the store — a refresh token LiteLLM had already spent — and deleted
        // the directory it was running in.
        writeMachineConfig(machine('', source));
        const codexPath = join(home, '.codex', 'auth.json');
        const old = (Date.now() - 3_600_000) / 1000;
        writeCodexStore({ access_token: claimJwt(2_000_000_000, 'acct-a'), refresh_token: 'RT-1', account_id: 'acct-a' });
        const body = readFileSync(codexPath, 'utf8');
        utimesSync(codexPath, old, old);
        // A different login elsewhere the default could fall through to.
        writeOpencodeStore(claimJwt(1_900_000_000, 'acct-b'), 'OPENCODE-B');
        const { send, envs, dir, tokenFile, settle } = await start();
        expect(await send()).toBe(200);
        const first = dir();
        const rotated = JSON.stringify({ access_token: claimJwt(2_000_000_001, 'acct-a'), refresh_token: 'RT-2-ROTATED', account_id: 'acct-a' });
        writeFileSync(tokenFile(), rotated);
        writeFileSync(codexPath, '{"auth_mode":"chat');
        utimesSync(codexPath, old, old);
        expect(await send()).toBe(200);
        await settle();
        writeFileSync(codexPath, body);
        utimesSync(codexPath, old, old);
        expect(await send()).toBe(200);
        await settle();
        expect(await send()).toBe(200);
        await settle();
        expect(envs).toHaveLength(1);
        expect(dir()).toBe(first);
        expect(existsSync(first)).toBe(true);
        expect(readFileSync(tokenFile(), 'utf8')).toBe(rotated);
        expect(errors.some((line) => line.includes('logged in again') || line.includes('restarting litellm'))).toBe(false);
      });
    }

    it.runIf(sqliteAvailable())('refuses through one empty read of opencode.db, and restarts nothing when the row returns', async () => {
      // "Empty twice" is how opencodeDbRead reads a logout, and a request
      // landing there is refused — but one such read may be a gap. Marking
      // the lineage ended on it re-seeded LiteLLM from the store when the row
      // came back, putting back a refresh token LiteLLM may already have spent.
      writeMachineConfig(machine('', 'opencode'));
      const row = [{
        id: 'c1', integration: 'openai', timeCreated: 1,
        value: JSON.stringify({ type: 'oauth', access: claimJwt(1_900_000_000, 'acct-1'), refresh: 'STORE', expires: 1_900_000_000_000 }),
      }];
      writeOpencodeCredDb(ocDbPath(), row);
      const { send, envs, dir, tokenFile, settle } = await start();
      const first = dir();
      const rotated = JSON.stringify({ access_token: claimJwt(1_900_864_000, 'acct-1'), refresh_token: 'LITELLM-ROTATED' });
      writeFileSync(tokenFile(), rotated);
      rmSync(ocDbPath());
      writeOpencodeCredDb(ocDbPath(), []);
      expect(await send()).toBe(502);
      await settle();
      rmSync(ocDbPath());
      writeOpencodeCredDb(ocDbPath(), row);
      expect(await send()).toBe(200);
      await settle();
      expect(await send()).toBe(200);
      await settle();
      expect(envs).toHaveLength(1);
      expect(dir()).toBe(first);
      expect(readFileSync(tokenFile(), 'utf8')).toBe(rotated);
    });

    it.runIf(sqliteAvailable())('treats opencode.db still empty on a later read as a logout, and re-seeds when a login returns', async () => {
      writeMachineConfig(machine('', 'opencode'));
      const row = (refresh: string) => [{
        id: 'c1', integration: 'openai', timeCreated: 1,
        value: JSON.stringify({ type: 'oauth', access: claimJwt(1_900_000_000, 'acct-1'), refresh, expires: 1_900_000_000_000 }),
      }];
      writeOpencodeCredDb(ocDbPath(), row('FIRST'));
      const { send, envs, dir, held, settle } = await start();
      const first = dir();
      rmSync(ocDbPath());
      writeOpencodeCredDb(ocDbPath(), []);
      expect(await send()).toBe(502);
      expect(await send()).toBe(502);
      await settle();
      rmSync(ocDbPath());
      writeOpencodeCredDb(ocDbPath(), row('SECOND'));
      await send();
      await waitFor(() => envs.at(-1)?.CHATGPT_TOKEN_DIR !== first && held().refresh_token === 'SECOND',
        'a spawn into a new directory with the returning login');
      expect(envs.length).toBeGreaterThanOrEqual(2);
    });

    it('ends a crash racing a login change with one live LiteLLM, in the new directory, and no child in a deleted one', async () => {
      // The child crashes and, inside the respawn delay, a request sees a new
      // account. The deliberate restart waited on an exit that had already
      // fired, the crash respawn spawned a second child into the old
      // directory meanwhile, and the restart then spawned a third — deleting
      // the directory the second was still running in and orphaning it.
      writeMachineConfig(machine('', 'codex'));
      writeCodexStore({ access_token: claimJwt(2_000_000_000, 'acct-a'), refresh_token: 'ACCOUNT-A', account_id: 'acct-a' });
      type Kid = { dir: string; alive: boolean; exits: ((code: number | null, signal: NodeJS.Signals | null) => void)[]; ranInDeletedDir: boolean };
      const kids: Kid[] = [];
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
      const handle = await cmdServe({
        cwd, home, tempDir: tempDirFor(), waitForLitellm: async () => {}, respawnDelayMs: 100, litellmExitTimeoutMs: 200,
        spawnLitellm: (_config, env) => {
          const kid: Kid = { dir: env.CHATGPT_TOKEN_DIR ?? '', alive: true, exits: [], ranInDeletedDir: false };
          kids.push(kid);
          return {
            pid: 100 + kids.length,
            kill: () => {
              if (!kid.alive) return;
              kid.alive = false;
              setTimeout(() => kid.exits.forEach((cb) => cb(null, 'SIGTERM')), 5);
            },
            onExit: (cb) => { kid.exits.push(cb); },
          };
        },
      });
      handles.push(handle);
      vi.unstubAllGlobals();
      const watch = setInterval(() => {
        for (const kid of kids) if (kid.alive && !existsSync(kid.dir)) kid.ranInDeletedDir = true;
      }, 2);
      try {
        const send = () => fetch(`http://localhost:${handle.routerPort}/v1/messages`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'sonata-code-simple', messages: [] }),
        }).then(async (res) => { await res.text(); return res.status; });
        expect(await send()).toBe(200);
        writeCodexStore({ access_token: claimJwt(1_900_000_000, 'acct-b'), refresh_token: 'ACCOUNT-B', account_id: 'acct-b' });
        const first = kids[0];
        first.alive = false;
        first.exits.forEach((cb) => cb(1, null));
        await send();
        await new Promise((resolve) => setTimeout(resolve, 1000));
        await send();
        await new Promise((resolve) => setTimeout(resolve, 300));
      } finally {
        clearInterval(watch);
      }
      const alive = kids.filter((kid) => kid.alive);
      expect(alive).toHaveLength(1);
      const held = JSON.parse(readFileSync(join(alive[0].dir, 'auth.json'), 'utf8')) as { refresh_token?: string };
      expect(held.refresh_token).toBe('ACCOUNT-B');
      expect(kids.some((kid) => kid.ranInDeletedDir)).toBe(false);
      expect(errors.some((line) => line.includes('did not exit within'))).toBe(false);
    });

    it('keeps a retired token directory until the child spawned into it is seen to exit', async () => {
      // A LiteLLM that outlives its SIGTERM and SIGKILL is still running in
      // its directory; removing it then leaves that process with no login.
      writeMachineConfig(machine('', 'codex'));
      writeCodexStore({ access_token: claimJwt(2_000_000_000, 'acct-a'), refresh_token: 'ACCOUNT-A', account_id: 'acct-a' });
      const exits: ((code: number | null, signal: NodeJS.Signals | null) => void)[][] = [];
      const dirs: string[] = [];
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
      const handle = await cmdServe({
        cwd, home, tempDir: tempDirFor(), waitForLitellm: async () => {}, litellmExitTimeoutMs: 20,
        spawnLitellm: (_config, env) => {
          const listeners: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
          exits.push(listeners);
          dirs.push(env.CHATGPT_TOKEN_DIR ?? '');
          // Deaf to every signal: exits only when the test says so.
          return { pid: dirs.length, kill: () => {}, forceKill: () => {}, onExit: (cb) => { listeners.push(cb); } };
        },
      });
      handles.push(handle);
      vi.unstubAllGlobals();
      writeCodexStore({ access_token: claimJwt(1_900_000_000, 'acct-b'), refresh_token: 'ACCOUNT-B', account_id: 'acct-b' });
      await fetch(`http://localhost:${handle.routerPort}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'sonata-code-simple', messages: [] }),
      }).then((res) => res.text());
      await waitFor(() => dirs.length === 2, 'the restart for the new account');
      expect(dirs[1]).not.toBe(dirs[0]);
      expect(existsSync(dirs[0])).toBe(true);
      exits[0].forEach((cb) => cb(null, 'SIGKILL'));
      expect(existsSync(dirs[0])).toBe(false);
      expect(existsSync(dirs[1])).toBe(true);
    });

    describe('a ChatGPT login LiteLLM has been refused', () => {
      // LiteLLM 1.98.0 catches a refused refresh inside get_access_token,
      // logs "re-login required" and falls into a device-code login that
      // holds each request for up to fifteen minutes. Its own output — read
      // from the captured fixtures below — is the only early sign.
      const fixture = (name: string) => readFileSync(join(import.meta.dirname, '..', 'fixtures', 'litellm', name), 'utf8');

      it('answers every ChatGPT request with a named 502 once LiteLLM logs the refusal, logging the remedy once', async () => {
        writeMachineConfig(machine());
        writeCodexStore({ access_token: claimJwt(2_000_000_000, 'acct-a'), refresh_token: 'SEEDED' });
        const { send, sendFull, emit, upstreamCalls } = await start();
        expect(await send()).toBe(200);
        const forwardedBefore = upstreamCalls.length;
        emit(fixture('chatgpt-refresh-refused.txt'));
        emit(fixture('chatgpt-device-code.txt'));
        const refused = await sendFull();
        expect(refused.status).toBe(502);
        expect(refused.text).toContain('codex login');
        expect(refused.text).toContain('sonata restart');
        expect(await send()).toBe(502);
        expect(upstreamCalls.length).toBe(forwardedBefore);
        const remedies = errors.filter((line) => line.includes('ChatGPT login was refused by OpenAI'));
        expect(remedies).toHaveLength(1);
        expect(remedies[0]).toContain('"codex"');
      });

      it('reads a real LiteLLM process\'s output: forwards it, masks the device code, and marks the gateways', async () => {
        // The default spawn, with the managed binary replaced by a script that
        // writes the captured output and then stays up like LiteLLM would.
        const stderrFixture = join(import.meta.dirname, '..', 'fixtures', 'litellm', 'chatgpt-refresh-refused.txt');
        const stdoutFixture = join(import.meta.dirname, '..', 'fixtures', 'litellm', 'chatgpt-device-code.txt');
        writeFileSync(managedLitellmPath(home),
          `#!/bin/sh\ncat '${stderrFixture}' >&2\ncat '${stdoutFixture}'\nprintf 'partial line at exit'\nexec sleep 30\n`, { mode: 0o755 });
        writeMachineConfig(machine());
        writeCodexStore({ access_token: claimJwt(2_000_000_000, 'acct-a'), refresh_token: 'SEEDED' });
        const out: string[] = [];
        const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
          out.push(String(chunk)); return true;
        }) as typeof process.stdout.write);
        const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
          out.push(String(chunk)); return true;
        }) as typeof process.stderr.write);
        try {
          vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
          const handle = await cmdServe({ cwd, home, tempDir: tempDirFor(), waitForLitellm: async () => {} });
          handles.push(handle);
          vi.unstubAllGlobals();
          await waitFor(() => out.join('').includes('Enter code:'), 'the device-code prompt forwarded');
          const status = await fetch(`http://localhost:${handle.routerPort}/v1/messages`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'sonata-code-simple', messages: [] }),
          }).then(async (res) => { await res.text(); return res.status; });
          expect(status).toBe(502);
        } finally {
          outSpy.mockRestore();
          errSpy.mockRestore();
        }
        const forwarded = out.join('');
        expect(forwarded).toContain('ChatGPT refresh token failed, re-login required');
        expect(forwarded).toContain('2) Enter code: ****\n');
        expect(forwarded).not.toContain('Enter code: U');
        expect(errors.filter((line) => line.includes('ChatGPT login was refused by OpenAI'))).toHaveLength(1);
      });

      it('clears on the next deliberate spawn — a login change restarts LiteLLM and serves again', async () => {
        writeMachineConfig(machine());
        writeCodexStore({ access_token: claimJwt(2_000_000_000, 'acct-a'), refresh_token: 'ACCOUNT-A' });
        const { send, envs, emit, settle } = await start();
        emit(fixture('chatgpt-refresh-refused.txt'));
        expect(await send()).toBe(502);
        writeCodexStore({ access_token: claimJwt(2_000_000_000, 'acct-b'), refresh_token: 'ACCOUNT-B' });
        await send();
        await waitFor(() => envs.length === 2, 'the restart for the new account');
        await settle();
        expect(await send()).toBe(200);
      });

      it('keeps the mark through a restart for anything else, which spawns LiteLLM on the same refused token', async () => {
        // An unrelated model-list edit is a deliberate spawn, but it reuses
        // the refused directory. Clearing the mark on every deliberate spawn
        // served the next request into a fifteen-minute device-code login.
        writeMachineConfig(machine());
        writeCodexStore({ access_token: claimJwt(2_000_000_000, 'acct-a'), refresh_token: 'SEEDED' });
        const { send, sendFull, envs, emit, settle, upstreamCalls } = await start();
        expect(await send()).toBe(200);
        emit(fixture('chatgpt-refresh-refused.txt'));
        expect(await send()).toBe(502);
        const forwarded = upstreamCalls.length;
        writeMachineConfig(machine('[models."terra"]\ngateway = "codex"\nid = "gpt-5.6-terra"'));
        await send();
        await waitFor(() => envs.length === 2, 'the restart for the new model list');
        await settle();
        expect(envs[1].CHATGPT_TOKEN_DIR).toBe(envs[0].CHATGPT_TOKEN_DIR);
        const refused = await sendFull();
        expect(refused.status).toBe(502);
        expect(refused.text).toContain('ChatGPT login was refused by OpenAI');
        expect(upstreamCalls.length).toBe(forwarded);
      });

      it('keeps the mark when the refused token could not be read at mark time — LiteLLM was mid-write', async () => {
        // LiteLLM truncates auth.json and rewrites it as it records the
        // device-code request. A mark taken then held no token, and the first
        // readable one — the same refused token — cleared it on the next
        // unrelated restart.
        writeMachineConfig(machine());
        writeCodexStore({ access_token: claimJwt(2_000_000_000, 'acct-a'), refresh_token: 'SEEDED' });
        const { send, envs, emit, settle, upstreamCalls } = await start();
        expect(await send()).toBe(200);
        const file = join(envs[0].CHATGPT_TOKEN_DIR!, 'auth.json');
        const saved = readFileSync(file, 'utf8');
        writeFileSync(file, saved.slice(0, 10));
        emit(fixture('chatgpt-refresh-refused.txt'));
        writeFileSync(file, JSON.stringify({ ...JSON.parse(saved), device_code_requested_at: Date.now() / 1000 }));
        expect(await send()).toBe(502);
        const forwarded = upstreamCalls.length;
        writeMachineConfig(machine('[models."terra"]\ngateway = "codex"\nid = "gpt-5.6-terra"'));
        await send();
        await waitFor(() => envs.length === 2, 'the restart for the new model list');
        await settle();
        expect(await send()).toBe(502);
        expect(await send()).toBe(502);
        expect(upstreamCalls.length).toBe(forwarded);
      });

      it('clears for a sonata-owned login once `sonata auth login` rewrites it and LiteLLM is restarted', async () => {
        writeMachineConfig(machine('', 'sonata'));
        const dir = credentialDir(home, 'codex');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'auth.json'), JSON.stringify({ access_token: claimJwt(2_000_000_000, 'acct-a'), refresh_token: 'OLD' }));
        const { send, envs, emit, settle } = await start();
        emit(fixture('chatgpt-refresh-refused.txt'));
        expect(await send()).toBe(502);
        // An unrelated restart first: the refused file is still there.
        writeMachineConfig(machine('[models."terra"]\ngateway = "codex"\nid = "gpt-5.6-terra"', 'sonata'));
        await send();
        await waitFor(() => envs.length === 2, 'the restart for the new model list');
        await settle();
        expect(await send()).toBe(502);
        // The re-login rewrites auth.json; the next restart holds a new token.
        await new Promise((resolve) => setTimeout(resolve, 20));
        writeFileSync(join(dir, 'auth.json'), JSON.stringify({ access_token: claimJwt(2_000_000_001, 'acct-a'), refresh_token: 'NEW-LOGIN' }));
        writeMachineConfig(machine('', 'sonata'));
        await send();
        await waitFor(() => envs.length === 3, 'the restart after the re-login');
        await settle();
        expect(await send()).toBe(200);
      });

      it('keeps the mark through a crash respawn, which reuses the refused token', async () => {
        writeMachineConfig(machine());
        writeCodexStore({ access_token: claimJwt(2_000_000_000, 'acct-a'), refresh_token: 'SEEDED' });
        const { send, envs, emit, crash } = await start();
        emit(fixture('chatgpt-refresh-refused.txt'));
        crash();
        await waitFor(() => envs.length === 2, 'the crash respawn');
        expect(await send()).toBe(502);
      });

      it('keeps the mark through a spawn with no ChatGPT gateway at all, and when the gateway returns on the same token', async () => {
        // A restart while no project names a ChatGPT gateway starts LiteLLM
        // with no token directory. That is no evidence of a new login, but
        // "not the refused directory" cleared the mark on it, and putting the
        // gateway back served the refused token into a device-code login.
        const withByok = (chat: boolean) => `
[models."byok"]
gateway = "or"
id = "some/model"
${chat ? '[models."luna"]\ngateway = "codex"\nid = "gpt-5.6-luna"\n[native.gateways."codex"]\nauth = "codex-oauth"\ncredential_source = "codex"' : ''}
[tiers.code]
simple = ["${chat ? 'luna' : 'byok'}"]
complex = ["${chat ? 'luna' : 'byok'}"]
[native.gateways."or"]
base_url = "https://or.example/v1"
[native.ports]
router = 0
litellm = ${litellmPort}
`;
        writeSonataKey(home, 'or', 'sk-or');
        writeMachineConfig(withByok(true));
        writeCodexStore({ access_token: claimJwt(2_000_000_000, 'acct-a'), refresh_token: 'SEEDED', account_id: 'acct-a' });
        const { send, envs, emit, settle } = await start();
        expect(await send()).toBe(200);
        emit(fixture('chatgpt-refresh-refused.txt'));
        expect(await send()).toBe(502);
        writeMachineConfig(withByok(false));
        await send();
        await waitFor(() => envs.length === 2, 'the restart without the ChatGPT gateway');
        await settle();
        expect(envs[1].CHATGPT_TOKEN_DIR).toBeUndefined();
        writeMachineConfig(withByok(true));
        await send();
        await waitFor(() => envs.length === 3, 'the restart with it back');
        await settle();
        expect(await send()).toBe(502);
      });

      it('keeps the mark for a sonata-owned login through LiteLLM\'s own rewrite of auth.json', async () => {
        // After the refusal LiteLLM records `device_code_requested_at` in the
        // same auth.json. Keyed on the file's stat, that write cleared the
        // mark on the next unrelated restart, serving a device-code hang.
        writeMachineConfig(machine('', 'sonata'));
        const dir = credentialDir(home, 'codex');
        mkdirSync(dir, { recursive: true });
        const record = { access_token: claimJwt(2_000_000_000, 'acct-a'), refresh_token: 'REFUSED' };
        writeFileSync(join(dir, 'auth.json'), JSON.stringify(record));
        const { send, envs, emit, settle, upstreamCalls } = await start();
        emit(fixture('chatgpt-refresh-refused.txt'));
        await new Promise((resolve) => setTimeout(resolve, 20));
        writeFileSync(join(dir, 'auth.json'), JSON.stringify({ ...record, device_code_requested_at: Date.now() / 1000 }));
        expect(await send()).toBe(502);
        const forwarded = upstreamCalls.length;
        writeMachineConfig(machine('[models."terra"]\ngateway = "codex"\nid = "gpt-5.6-terra"', 'sonata'));
        await send();
        await waitFor(() => envs.length === 2, 'the restart for the new model list');
        await settle();
        expect(await send()).toBe(502);
        expect(upstreamCalls.length).toBe(forwarded);
      });

      it('marks it from a response too, when LiteLLM answers a request with how its device-code login ended', async () => {
        // As LiteLLM's proxy renders it, measured: a 400.
        const captured = JSON.parse(fixture('chatgpt-refresh-refused-proxy.json')) as { case: string; status: number; body: string }[];
        const polling = captured.find((entry) => entry.case === 'polling failed')!;
        writeMachineConfig(machine());
        writeCodexStore({ access_token: claimJwt(2_000_000_000, 'acct-a'), refresh_token: 'SEEDED' });
        const { send, upstreamCalls } = await start({
          upstream: () => new Response(polling.body, { status: polling.status }),
        });
        await send();
        const forwarded = upstreamCalls.length;
        expect(await send()).toBe(502);
        expect(upstreamCalls.length).toBe(forwarded);
        expect(errors.filter((line) => line.includes('ChatGPT login was refused by OpenAI'))).toHaveLength(1);
      });
    });

    it('respawns a crashed LiteLLM into the directory it was using, with LiteLLM\'s token as it left it', async () => {
      writeMachineConfig(machine());
      writeCodexStore({ access_token: claimJwt(1000, 'acct-a'), refresh_token: 'SEEDED' });
      const { send, envs, dir, tokenFile, crash, settle } = await start();
      const first = dir();
      const refreshed = JSON.stringify({ access_token: claimJwt(3000, 'acct-a'), refresh_token: 'REFRESHED', expires_at: 3000 });
      writeFileSync(tokenFile(), refreshed);
      // codex refreshes its own copy meanwhile: newer than LiteLLM's, same account.
      writeCodexStore({ access_token: claimJwt(9000, 'acct-a'), refresh_token: 'CODEX-OWN' });
      await send(); await settle();
      crash();
      await waitFor(() => envs.length === 2, 'the crash respawn');
      expect(dir()).toBe(first);
      expect(readFileSync(tokenFile(), 'utf8')).toBe(refreshed);
    });
  });

  describe('a credential store that reads wrong before anything has resolved', () => {
    let errors: string[];
    let errorSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      errors = [];
      errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.join(' ')); });
    });
    afterEach(() => { errorSpy.mockRestore(); });
    const claimJwt = (exp: number) => `h.${Buffer.from(JSON.stringify({ exp, client_id: 'app_EMoamEEZ73f0CkXaXp7hrann' })).toString('base64url')}.s`;
    const codexRecord = (refresh: string) =>
      JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: claimJwt(2_000_000_000), refresh_token: refresh } });

    it('refuses a default ChatGPT gateway whose codex file is torn, rather than serve opencode\'s account', async () => {
      writeMachineConfig(`
[models."luna"]
gateway = "codex"
id = "gpt-5.6-luna"
[tiers.code]
simple = ["luna"]
complex = ["luna"]
[native.gateways."codex"]
auth = "codex-oauth"
[native.ports]
router = 0
litellm = ${litellmPort}
`);
      mkdirSync(join(home, '.codex'), { recursive: true });
      writeFileSync(join(home, '.codex', 'auth.json'), codexRecord('CODEX-A').slice(0, 30));
      mkdirSync(join(home, '.local', 'share', 'opencode'), { recursive: true });
      writeFileSync(join(home, '.local', 'share', 'opencode', 'auth.json'), JSON.stringify({
        openai: { type: 'oauth', access: claimJwt(1_900_000_000), refresh: 'OPENCODE-B', expires: 1_900_000_000_000 },
      }));
      const envs: NodeJS.ProcessEnv[] = [];
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
      const handle = await cmdServe({
        cwd, home, tempDir: tempDirFor(), waitForLitellm: async () => {},
        spawnLitellm: (_config, env) => { envs.push({ ...env }); return { pid: 1, kill: () => {} }; },
      });
      handles.push(handle);
      vi.unstubAllGlobals();
      const send = async () => {
        const res = await fetch(`http://localhost:${handle.routerPort}/v1/messages`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'sonata-code-simple', messages: [] }),
        });
        return { status: res.status, text: await res.text() };
      };
      const refused = await send();
      expect(refused.status).toBe(502);
      expect(refused.text).toContain('could not be read');
      const seededWith = () => envs.map((env) =>
        (JSON.parse(readFileSync(join(env.CHATGPT_TOKEN_DIR!, 'auth.json'), 'utf8')) as { refresh_token: string }).refresh_token);
      expect(seededWith()).not.toContain('OPENCODE-B');
      writeFileSync(join(home, '.codex', 'auth.json'), codexRecord('CODEX-A'));
      expect((await send()).status).toBe(200);
      expect(seededWith()).toEqual(['CODEX-A']);
    });

    it('does not drop a served gateway for a conflict it cannot establish while codex\'s file is torn', async () => {
      // "cx" reads codex and has resolved. A project arrives with a default
      // ChatGPT gateway while codex's file is half-written: its identity
      // cannot be told, and guessing "opencode" dropped every gateway of the
      // kind — "cx" included — for the length of one write.
      writeMachineConfig(`
[models."luna"]
gateway = "cx"
id = "gpt-5.6-luna"
[tiers.code]
simple = ["luna"]
complex = ["luna"]
[native.gateways."cx"]
auth = "codex-oauth"
credential_source = "codex"
[native.ports]
router = 0
litellm = ${litellmPort}
`);
      mkdirSync(join(home, '.codex'), { recursive: true });
      writeFileSync(join(home, '.codex', 'auth.json'), codexRecord('CODEX-A'));
      const project = mkdtempSync(join(tmpdir(), 'serve-torn-identity-'));
      writeFileSync(join(project, 'sonata.toml'), `
[models."other"]
gateway = "dflt"
id = "gpt-5.6-luna"
[tiers.code]
simple = ["other"]
complex = ["other"]
[native.gateways."dflt"]
auth = "codex-oauth"
`);
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
      const handle = await cmdServe({
        cwd, home, tempDir: tempDirFor(), waitForLitellm: async () => {},
        spawnLitellm: () => ({ pid: 1, kill: () => {} }),
      });
      handles.push(handle);
      vi.unstubAllGlobals();
      const send = async (headers: Record<string, string> = {}) => {
        const res = await fetch(`http://localhost:${handle.routerPort}/v1/messages`, {
          method: 'POST', headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify({ model: 'sonata-code-simple', messages: [] }),
        });
        return { status: res.status, text: await res.text() };
      };
      expect((await send()).status).toBe(200);
      writeFileSync(join(home, '.codex', 'auth.json'), codexRecord('CODEX-A').slice(0, 30));
      const fromProject = await send(projectHeaders(project));
      expect(fromProject.status).toBe(502);
      expect(fromProject.text).toContain('could not be read');
      expect((await send()).status).toBe(200);
      expect(errors.some((line) => line.includes('read different credentials'))).toBe(false);
      rmSync(project, { recursive: true, force: true });
    });

    describe('a store that stays unreadable', () => {
      // Torn is bounded: a file whose unparseable bytes have not moved for
      // TORN_REPEAT_MS, or a read error lasting UNREADABLE_STORE_WINDOW_MS, is
      // steadily unreadable — corrupt, zero bytes, EACCES — and is skipped as
      // absent, as base did. Read as torn
      // forever, a default ChatGPT gateway opencode could serve answered 502
      // for good, promising a retry that never changed anything.
      const DEFAULT_CHATGPT = () => `
[models."luna"]
gateway = "codex"
id = "gpt-5.6-luna"
[tiers.code]
simple = ["luna"]
complex = ["luna"]
[native.gateways."codex"]
auth = "codex-oauth"
[native.ports]
router = 0
litellm = ${litellmPort}
`;
      const codexPath = () => join(home, '.codex', 'auth.json');
      const writeOpencodeLogin = () => {
        mkdirSync(join(home, '.local', 'share', 'opencode'), { recursive: true });
        writeFileSync(join(home, '.local', 'share', 'opencode', 'auth.json'), JSON.stringify({
          openai: { type: 'oauth', access: claimJwt(1_900_000_000), refresh: 'OPENCODE-B', expires: 1_900_000_000_000 },
        }));
      };
      const backdate = (path: string) => {
        const old = (Date.now() - 60_000) / 1000;
        utimesSync(path, old, old);
      };
      const start = async (now?: () => number) => {
        const envs: NodeJS.ProcessEnv[] = [];
        vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
        const handle = await cmdServe({
          cwd, home, tempDir: tempDirFor(), waitForLitellm: async () => {}, ...(now === undefined ? {} : { now }),
          spawnLitellm: (_config, env) => { envs.push({ ...env }); return { pid: 1, kill: () => {} }; },
        });
        handles.push(handle);
        vi.unstubAllGlobals();
        const send = async () => {
          const res = await fetch(`http://localhost:${handle.routerPort}/v1/messages`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'sonata-code-simple', messages: [] }),
          });
          return { status: res.status, text: await res.text() };
        };
        const seededWith = () => envs.map((env) =>
          (JSON.parse(readFileSync(join(env.CHATGPT_TOKEN_DIR!, 'auth.json'), 'utf8')) as { refresh_token: string }).refresh_token);
        return { send, seededWith };
      };

      it('serves a default ChatGPT gateway from opencode once codex\'s auth.json has held the same empty content for a second', async () => {
        // Torn on its first read, however old its mtime: only its bytes
        // staying put says it is not mid-write.
        writeMachineConfig(DEFAULT_CHATGPT());
        mkdirSync(join(home, '.codex'), { recursive: true });
        writeFileSync(codexPath(), '');
        backdate(codexPath());
        writeOpencodeLogin();
        let offset = 0;
        const { send, seededWith } = await start(() => Date.now() + offset);
        expect((await send()).status).toBe(502);
        offset = TORN_REPEAT_MS;
        expect((await send()).status).toBe(200);
        expect(seededWith()).toEqual(['OPENCODE-B']);
        expect(errors.filter((line) => line.includes(codexPath()) && line.includes('skipped as if absent'))).toHaveLength(1);
        await send();
        expect(errors.filter((line) => line.includes('skipped as if absent'))).toHaveLength(1);
      });

      it('serves it from opencode when codex\'s auth.json cannot be opened at all (EACCES)', async () => {
        writeMachineConfig(DEFAULT_CHATGPT());
        mkdirSync(join(home, '.codex'), { recursive: true });
        writeFileSync(codexPath(), codexRecord('CODEX-A'), { mode: 0o000 });
        backdate(codexPath());
        writeOpencodeLogin();
        try {
          // No bytes to compare: torn for the 10 s cap from its first failure.
          let offset = 0;
          const { send, seededWith } = await start(() => Date.now() + offset);
          expect((await send()).status).toBe(502);
          offset = UNREADABLE_STORE_WINDOW_MS;
          expect((await send()).status).toBe(200);
          expect(seededWith()).toEqual(['OPENCODE-B']);
          expect(errors.some((line) => line.includes(codexPath()) && line.includes('EACCES'))).toBe(true);
        } finally {
          chmodSync(codexPath(), 0o600);
        }
      });

      it('notices a chmod on the next request, though chmod moves no mtime', async () => {
        // The plan fingerprint was ino:mtime:size, which chmod leaves alone,
        // so a store made unreadable (or readable again) was never re-read.
        // Sourced from codex alone: a default source's identity check reads
        // codex's file on every merge anyway, which would hide the gap.
        writeMachineConfig(DEFAULT_CHATGPT().replace('auth = "codex-oauth"', 'auth = "codex-oauth"\ncredential_source = "codex"'));
        mkdirSync(join(home, '.codex'), { recursive: true });
        writeFileSync(codexPath(), codexRecord('CODEX-A'));
        backdate(codexPath());
        const { send, seededWith } = await start();
        expect((await send()).status).toBe(200);
        chmodSync(codexPath(), 0o000);
        try {
          expect((await send()).status).toBe(200);
          expect(errors.some((line) => line.includes(codexPath()) && line.includes('EACCES'))).toBe(true);
        } finally {
          chmodSync(codexPath(), 0o600);
        }
        expect((await send()).status).toBe(200);
        // Kept through it: the gateway had resolved, so nothing re-seeded.
        expect(seededWith()).toEqual(['CODEX-A']);
      });

      // An ACL entry moves neither the mode nor the stat the rows are keyed
      // on — only ctime — so a signal carrying the mode missed it. macOS's
      // `chmod +a` is the one portable-enough way to make one.
      const accessChanges = [
        { name: 'a chmod', runs: true, lock: (db: string) => chmodSync(db, 0o000), unlock: (db: string) => chmodSync(db, 0o600) },
        {
          name: 'an ACL change', runs: process.platform === 'darwin' && process.getuid?.() !== 0,
          lock: (db: string) => execFileSync('/bin/chmod', ['+a', 'everyone deny read', db]),
          unlock: (db: string) => execFileSync('/bin/chmod', ['-a#', '0', db]),
        },
      ];
      for (const change of accessChanges) it.runIf(sqliteAvailable() && change.runs)(`notices ${change.name} on opencode.db on the next request, though its rows do not change`, async () => {
        // opencode.db's signal was its credential rows' hash, re-read when its
        // stat moved: a chmod moved the stat, the rows read the same (or not
        // at all), and the signal stood still, so nothing was re-read.
        writeMachineConfig(`
[models."pdm"]
gateway = "pd"
id = "pd-1"
[native.gateways."pd"]
base_url = "https://pd.example"
provider = "anthropic"
credential_source = "opencode"
[native.ports]
router = 0
litellm = ${litellmPort}
`);
        const db = join(home, '.local', 'share', 'opencode', 'opencode.db');
        mkdirSync(dirname(db), { recursive: true });
        writeOpencodeCredDb(db, [{ id: 'c1', integration: 'pd', timeCreated: 1, value: JSON.stringify({ type: 'key', key: 'FROM-DB' }) }]);
        vi.stubGlobal('fetch', vi.fn(async () => new Response(
          '{"id":"x","type":"message","role":"assistant","content":[],"usage":{"input_tokens":1,"output_tokens":1}}',
          { status: 200, headers: { 'content-type': 'application/json' } })));
        const handle = await cmdServe({
          cwd, home, tempDir: tempDirFor(), waitForLitellm: async () => {},
          spawnLitellm: () => ({ pid: 1, kill: () => {} }),
        });
        handles.push(handle);
        vi.unstubAllGlobals();
        const send = async () => {
          const res = await fetch(`http://localhost:${handle.routerPort}/v1/messages`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'pdm', max_tokens: 1, messages: [] }),
          });
          await res.text();
          return res.status;
        };
        expect(await send()).toBe(200);
        change.lock(db);
        try {
          await send();
          expect(errors.some((line) => line.includes('opencode.db') && line.includes('could not be'))).toBe(true);
        } finally {
          change.unlock(db);
        }
      });

      it('refuses within the window, and serves from opencode once it lapses with nothing on disk changing', async () => {
        writeMachineConfig(DEFAULT_CHATGPT());
        mkdirSync(join(home, '.codex'), { recursive: true });
        writeFileSync(codexPath(), '');
        writeOpencodeLogin();
        let offset = 0;
        const { send, seededWith } = await start(() => Date.now() + offset);
        const refused = await send();
        expect(refused.status).toBe(502);
        expect(refused.text).toContain('retried on the next request');
        expect((await send()).status).toBe(502);
        offset = 15_000;
        expect((await send()).status).toBe(200);
        expect(seededWith()).toEqual(['OPENCODE-B']);
      });

      it('refuses within the window and recovers when codex\'s write completes', async () => {
        writeMachineConfig(DEFAULT_CHATGPT());
        mkdirSync(join(home, '.codex'), { recursive: true });
        writeFileSync(codexPath(), codexRecord('CODEX-A').slice(0, 30));
        writeOpencodeLogin();
        const { send, seededWith } = await start();
        expect((await send()).status).toBe(502);
        writeFileSync(codexPath(), codexRecord('CODEX-A'));
        expect((await send()).status).toBe(200);
        expect(seededWith()).toEqual(['CODEX-A']);
      });

      it.runIf(sqliteAvailable())('skips an opencode.db that keeps failing, once the window lapses, for opencode\'s auth.json', async () => {
        writeMachineConfig(`
[models."pdm"]
gateway = "pd"
id = "pd-1"
[native.gateways."pd"]
base_url = "https://pd.example"
provider = "anthropic"
credential_source = "opencode"
[native.ports]
router = 0
litellm = ${litellmPort}
`);
        const dir = join(home, '.local', 'share', 'opencode');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'opencode.db'), 'this is not a sqlite database, and never will be');
        writeFileSync(join(dir, 'auth.json'), JSON.stringify({ pd: { type: 'api', key: 'FROM-AUTH-JSON' } }));
        const forwarded: string[] = [];
        const upstream = vi.fn(async (_url: string, init: RequestInit) => {
          const headers = new Headers(init.headers);
          forwarded.push(headers.get('x-api-key') ?? headers.get('authorization') ?? '(none)');
          return new Response('{"id":"x","type":"message","role":"assistant","content":[],"usage":{"input_tokens":1,"output_tokens":1}}',
            { status: 200, headers: { 'content-type': 'application/json' } });
        });
        vi.stubGlobal('fetch', upstream);
        let offset = 0;
        const handle = await cmdServe({
          cwd, home, tempDir: tempDirFor(), waitForLitellm: async () => {}, now: () => Date.now() + offset,
          spawnLitellm: () => ({ pid: 1, kill: () => {} }),
        });
        handles.push(handle);
        vi.unstubAllGlobals();
        const send = async () => {
          const res = await fetch(`http://localhost:${handle.routerPort}/v1/messages`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'pdm', max_tokens: 1, messages: [] }),
          });
          await res.text();
          return res.status;
        };
        expect(await send()).toBe(502);
        offset = 15_000;
        expect(await send()).toBe(200);
        expect(forwarded).toHaveLength(1);
        expect(forwarded[0]).toContain('FROM-AUTH-JSON');
        expect(errors.some((line) => line.includes('opencode.db') && line.includes('skipped as if absent'))).toBe(true);
      });

      it('picks up a key rotated, then removed, in opencode while sonata\'s own keys.json is skipped', async () => {
        // The skipped store is not the one the key came from, so it says
        // nothing about that key. Kept through it, the rotated key never
        // reached the gateway and the removed one was sent indefinitely.
        writeMachineConfig(`
[models."pdm"]
gateway = "pd"
id = "pd-1"
[native.gateways."pd"]
base_url = "https://pd.example"
provider = "anthropic"
[native.ports]
router = 0
litellm = ${litellmPort}
`);
        const keys = join(home, '.config', 'sonata', 'keys.json');
        writeFileSync(keys, '{"pd": "sk-');
        backdate(keys);
        const ocAuth = join(home, '.local', 'share', 'opencode', 'auth.json');
        mkdirSync(dirname(ocAuth), { recursive: true });
        writeFileSync(ocAuth, JSON.stringify({ pd: { type: 'api', key: 'KEY-OLD' } }));
        const forwarded: string[] = [];
        vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
          const headers = new Headers(init.headers);
          forwarded.push(headers.get('x-api-key') ?? headers.get('authorization') ?? '(none)');
          return new Response('{"id":"x","type":"message","role":"assistant","content":[],"usage":{"input_tokens":1,"output_tokens":1}}',
            { status: 200, headers: { 'content-type': 'application/json' } });
        }));
        let offset = 0;
        const handle = await cmdServe({
          cwd, home, tempDir: tempDirFor(), waitForLitellm: async () => {}, now: () => Date.now() + offset,
          spawnLitellm: () => ({ pid: 1, kill: () => {} }),
        });
        handles.push(handle);
        vi.unstubAllGlobals();
        const send = async () => {
          const res = await fetch(`http://localhost:${handle.routerPort}/v1/messages`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'pdm', max_tokens: 1, messages: [] }),
          });
          await res.text();
          return res.status;
        };
        // keys.json is torn on its first read; the same bytes a second later are skipped.
        expect(await send()).toBe(502);
        offset = TORN_REPEAT_MS;
        expect(await send()).toBe(200);
        expect(forwarded.at(-1)).toContain('KEY-OLD');
        writeFileSync(ocAuth, JSON.stringify({ pd: { type: 'api', key: 'KEY-ROTATED' } }));
        expect(await send()).toBe(200);
        expect(forwarded.at(-1)).toContain('KEY-ROTATED');
        writeFileSync(ocAuth, JSON.stringify({}));
        await send();
        expect(forwarded.at(-1)).not.toContain('KEY-');
      });

      it('ends a default ChatGPT gateway read from opencode when opencode logs out while codex\'s file is skipped', async () => {
        // codex's skipped file never held the login served, so it cannot
        // vouch for it: kept, opencode's logout left LiteLLM on account B.
        writeMachineConfig(DEFAULT_CHATGPT());
        mkdirSync(join(home, '.codex'), { recursive: true });
        writeFileSync(codexPath(), '');
        backdate(codexPath());
        writeOpencodeLogin();
        let offset = 0;
        const { send, seededWith } = await start(() => Date.now() + offset);
        expect((await send()).status).toBe(502);
        offset = TORN_REPEAT_MS;
        expect((await send()).status).toBe(200);
        expect(seededWith()).toEqual(['OPENCODE-B']);
        writeFileSync(join(home, '.local', 'share', 'opencode', 'auth.json'), JSON.stringify({}));
        expect((await send()).status).toBe(502);
        expect((await send()).status).toBe(502);
      });
    });

    it.runIf(sqliteAvailable())('refuses the first request after the last opencode.db credential row is removed', async () => {
      writeMachineConfig(`
[models."pdm"]
gateway = "pd"
id = "pd-1"
[native.gateways."pd"]
base_url = "https://pd.example"
provider = "anthropic"
credential_source = "opencode"
[native.ports]
router = 0
litellm = ${litellmPort}
`);
      const db = join(home, '.local', 'share', 'opencode', 'opencode.db');
      writeOpencodeCredDb(db, [{ id: 'c1', integration: 'pd', value: JSON.stringify({ type: 'key', key: 'REVOKED-KEY' }), timeCreated: 1 }]);
      const forwarded: string[] = [];
      const upstream = vi.fn(async (_url: string, init: RequestInit) => {
        const headers = new Headers(init.headers);
        forwarded.push(headers.get('x-api-key') ?? headers.get('authorization') ?? '(none)');
        return new Response('{"id":"x","type":"message","role":"assistant","content":[],"usage":{"input_tokens":1,"output_tokens":1}}',
          { status: 200, headers: { 'content-type': 'application/json' } });
      });
      vi.stubGlobal('fetch', upstream);
      const handle = await cmdServe({
        cwd, home, tempDir: tempDirFor(), waitForLitellm: async () => {},
        spawnLitellm: () => ({ pid: 1, kill: () => {} }),
      });
      handles.push(handle);
      vi.unstubAllGlobals();
      const send = async () => {
        const res = await fetch(`http://localhost:${handle.routerPort}/v1/messages`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'pdm', max_tokens: 1, messages: [] }),
        });
        await res.text();
        return res.status;
      };
      expect(await send()).toBe(200);
      expect(forwarded).toHaveLength(1);
      // The last row goes (`opencode auth logout`): the table now reads empty.
      rmSync(db);
      writeOpencodeCredDb(db, []);
      expect(await send()).toBe(502);
      expect(forwarded).toHaveLength(1);
    });
  });

  describe('a credential store that cannot be read for a moment', () => {
    // codex rewrites auth.json by truncating and writing, so a request can
    // land on half a file. Read as "no credential", that dropped the gateway
    // from LiteLLM and restarted it, then restarted it again when the write
    // completed — and an intermittent failure restarted it without bound. A
    // gateway that has resolved keeps its last credential through a read that
    // fails for any reason but a store positively saying it holds none.
    const config = (cxSource: string, extraGateway = '') => `
[models."luna"]
gateway = "cx"
id = "gpt-5.6-luna"
[models."flash"]
gateway = "acme"
id = "flash-1"
[tiers.code]
simple = ["luna"]
complex = ["flash"]
[native.gateways."cx"]
auth = "codex-oauth"
${cxSource}
[native.gateways."acme"]
base_url = "https://acme.example/v1"
${extraGateway}
[native.ports]
router = 0
litellm = ${litellmPort}
`;
    const codexFile = () => join(home, '.codex', 'auth.json');
    const goodCodex = (refresh = 'CODEX-A') =>
      JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: jwt(2_000_000_000), refresh_token: refresh } });
    const writeCodex = (text: string) => {
      mkdirSync(join(home, '.codex'), { recursive: true });
      writeFileSync(codexFile(), text);
    };
    const start = async () => {
      writeSonataKey(home, 'acme', 'acme-key');
      const tempDir = tempDirFor();
      let spawns = 0;
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
      const handle = await cmdServe({
        cwd, home, tempDir, waitForLitellm: async () => {},
        spawnLitellm: () => {
          spawns += 1;
          const exits: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
          return {
            pid: spawns,
            kill: () => { setImmediate(() => exits.forEach((cb) => cb(null, 'SIGTERM'))); },
            onExit: (cb) => { exits.push(cb); },
          };
        },
      });
      handles.push(handle);
      vi.unstubAllGlobals();
      const send = async (model: string, headers: Record<string, string> = {}) => {
        const res = await fetch(`http://localhost:${handle.routerPort}/v1/messages`, {
          method: 'POST', headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify({ model, messages: [] }),
        });
        return { status: res.status, text: await res.text() };
      };
      const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
      const configJson = () => readFileSync(join(tempDir, 'config.json'), 'utf8');
      const heldRefresh = () =>
        (JSON.parse(readFileSync(join(tempDir, 'chatgpt', 'auth.json'), 'utf8')) as { refresh_token: string }).refresh_token;
      return { send, settle, spawns: () => spawns, configJson, heldRefresh };
    };
    let errors: string[];
    let errorSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      errors = [];
      errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.join(' ')); });
    });
    afterEach(() => { errorSpy.mockRestore(); });

    it('keeps serving the gateway through one torn read, with no LiteLLM restart', async () => {
      writeMachineConfig(config('credential_source = "codex"'));
      writeCodex(goodCodex());
      const { send, settle, spawns, configJson } = await start();
      expect((await send('sonata-code-simple')).status).toBe(200);
      writeCodex(goodCodex().slice(0, 20));
      expect((await send('sonata-code-simple')).status).toBe(200);
      await settle();
      writeCodex(goodCodex());
      expect((await send('sonata-code-simple')).status).toBe(200);
      await settle();
      expect(spawns()).toBe(1);
      expect(configJson()).toContain('gpt-5.6-luna');
      // Logged, once, as a read failure — never as a missing login.
      expect(errors.filter((line) => line.includes('no ChatGPT credential was found'))).toHaveLength(0);
      expect(errors.filter((line) => line.includes('could not be read'))).toHaveLength(1);
    });

    it('restarts nothing through six intermittent failures', async () => {
      writeMachineConfig(config('credential_source = "codex"'));
      writeCodex(goodCodex());
      const { send, settle, spawns } = await start();
      for (let i = 0; i < 6; i += 1) {
        writeCodex(goodCodex().slice(0, 20));
        expect((await send('sonata-code-simple')).status).toBe(200);
        await settle();
        writeCodex(goodCodex());
        expect((await send('sonata-code-simple')).status).toBe(200);
        await settle();
      }
      expect(spawns()).toBe(1);
    });

    it('does not let a torn codex file switch the default to opencode\'s account', async () => {
      writeMachineConfig(config(''));
      writeCodex(goodCodex('CODEX-A'));
      mkdirSync(join(home, '.local', 'share', 'opencode'), { recursive: true });
      const ocJwt = `h.${Buffer.from(JSON.stringify({ exp: 2_100_000_000, client_id: 'app_EMoamEEZ73f0CkXaXp7hrann' })).toString('base64url')}.s`;
      writeFileSync(join(home, '.local', 'share', 'opencode', 'auth.json'), JSON.stringify({
        openai: { type: 'oauth', access: ocJwt, refresh: 'OPENCODE-B', expires: 2_100_000_000_000 },
      }));
      const { send, settle, spawns, heldRefresh } = await start();
      expect(heldRefresh()).toBe('CODEX-A');
      writeCodex(goodCodex('CODEX-A').slice(0, 20));
      expect((await send('sonata-code-simple')).status).toBe(200);
      await settle();
      expect(heldRefresh()).toBe('CODEX-A');
      expect(spawns()).toBe(1);
    });

    it('still removes and names the gateway once its store positively holds no login', async () => {
      writeMachineConfig(config('credential_source = "codex"'));
      writeCodex(goodCodex());
      const { send, spawns, configJson } = await start();
      rmSync(codexFile());
      const res = await send('sonata-code-simple');
      expect(res.status).toBe(502);
      const message = (JSON.parse(res.text) as { error: { message: string } }).error.message;
      expect(message).toContain('gateway "cx"');
      expect(message).toContain('codex login');
      await waitFor(() => spawns() === 2, 'the restart that drops the gateway');
      expect(configJson()).not.toContain('gpt-5.6-luna');
      expect((await send('sonata-code-complex')).status).toBe(200);
    });

    it('names a gateway whose store has never been readable', async () => {
      writeMachineConfig(`
[models."flash"]
gateway = "acme"
id = "flash-1"
[native.gateways."acme"]
base_url = "https://acme.example/v1"
[native.ports]
router = 0
litellm = ${litellmPort}
`);
      writeCodex(goodCodex().slice(0, 20));
      const project = mkdtempSync(join(tmpdir(), 'serve-never-readable-'));
      writeFileSync(join(project, 'sonata.toml'), config('credential_source = "codex"').replace(/\[native\.ports\][\s\S]*$/, ''));
      const { send } = await start();
      const res = await send('sonata-code-simple', projectHeaders(project));
      expect(res.status).toBe(502);
      expect((JSON.parse(res.text) as { error: { message: string } }).error.message).toContain('gateway "cx"');
    });

    it('does not restart LiteLLM for a gateway that fails but serves no model', async () => {
      writeMachineConfig(config('credential_source = "codex"', `
[native.gateways."spare"]
auth = "codex-oauth"
credential_source = "codex"
`).replace('[models."luna"]\ngateway = "cx"', '[models."luna"]\ngateway = "acme"').replace(
        /\[native\.gateways\."cx"\][^[]*/, '',
      ));
      writeCodex(goodCodex());
      const { send, settle, spawns } = await start();
      rmSync(codexFile());
      expect((await send('sonata-code-simple')).status).toBe(200);
      await settle();
      expect(spawns()).toBe(1);
    });
  });

  it('loads the v0.13.1 BYOK pair in one config, drops both gateways, and keeps the rest serving', async () => {
    writeMachineConfig(`
[models."luna"]
gateway = "codex"
id = "gpt-5.6-luna"
[models."byok"]
gateway = "openai"
id = "gpt-5.6-luna"
[models."flash"]
gateway = "acme"
id = "flash-1"
[tiers.code]
simple = ["luna", "byok"]
complex = ["flash"]
[native.gateways."codex"]
auth = "codex-oauth"
credential_source = "codex"
[native.gateways."openai"]
auth = "codex-oauth"
credential_source = "sonata"
[native.gateways."acme"]
base_url = "https://gateway.example/v1"
[native.ports]
router = 0
litellm = ${litellmPort}
`);
    writeSonataKey(home, 'acme', 'k');
    const configs: string[] = [];
    const forwarded: string[] = [];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        forwarded.push((JSON.parse(init.body as string) as { model: string }).model);
        return new Response('{}', { status: 200 });
      }));
      const handle = await cmdServe({
        cwd, home, tempDir: tempDirFor(), waitForLitellm: async () => {},
        spawnLitellm: (configPath) => { configs.push(readFileSync(configPath, 'utf8')); return { pid: 1, kill: () => {} }; },
      });
      handles.push(handle);
      vi.unstubAllGlobals();
      expect(configs.at(-1)).not.toContain('/luna');
      expect(configs.at(-1)).not.toContain('/byok');
      const send = (model: string) => fetch(`http://localhost:${handle.routerPort}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages: [] }),
      });
      const simple = await send('sonata-code-simple');
      expect(simple.status).toBe(502);
      const message = (await simple.json() as { error: { message: string } }).error.message;
      expect(message).toMatch(/"codex".*"openai"/s);
      expect((await send('sonata-code-complex')).status).toBe(200);
      expect(forwarded.every((model) => model.endsWith('/flash'))).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('leaves models on a dropped OAuth gateway out of LiteLLM, and answers them 502 naming the conflict', async () => {
    // The machine's `codex` reads the default store; a project's `codex-work`
    // has its own sonata login. One LiteLLM child cannot hold both, so both
    // gateways are dropped — and their models must not be served from
    // LiteLLM's default token dir either, which is another account.
    writeMachineConfig(`
[models."luna"]
gateway = "codex"
id = "gpt-5.6-luna"
[tiers.code]
simple = ["luna"]
complex = ["luna"]
[native.gateways."codex"]
auth = "codex-oauth"
[native.gateways."acme"]
base_url = "https://gateway.example/v1"
[models."flash"]
gateway = "acme"
id = "flash-1"
[native.ports]
router = 0
litellm = ${litellmPort}
`);
    writeSonataKey(home, 'acme', 'k');
    const project = mkdtempSync(join(tmpdir(), 'serve-tenant-oauth-conflict-'));
    writeFileSync(join(project, 'sonata.toml'), `
[models."work"]
gateway = "codex-work"
id = "gpt-5.6-luna"
[tiers.code]
simple = ["work"]
complex = ["work"]
[native.gateways."codex-work"]
auth = "codex-oauth"
credential_source = "sonata"
`);
    // Register the project before startup, so the union sees the conflict.
    await recordSession(home, { session: 'conflict-session', cwd: project, started: new Date().toISOString() });
    const configs: string[] = [];
    const forwarded: string[] = [];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        forwarded.push((JSON.parse(init.body as string) as { model: string }).model);
        return new Response('{}', { status: 200 });
      }));
      const handle = await cmdServe({
        cwd, home, tempDir: tempDirFor(), waitForLitellm: async () => {},
        spawnLitellm: (configPath) => { configs.push(readFileSync(configPath, 'utf8')); return { pid: 1, kill: () => {} }; },
      });
      handles.push(handle);
      vi.unstubAllGlobals();
      expect(configs.length).toBeGreaterThan(0);
      const last = configs.at(-1)!;
      expect(last).not.toContain('/luna');
      expect(last).not.toContain('/work');
      expect(last).toContain('/flash');
      for (const [headers, model] of [[{}, 'sonata-code-simple'], [projectHeaders(project), 'sonata-code-simple'], [{}, 'luna']] as const) {
        const res = await fetch(`http://localhost:${handle.routerPort}/v1/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify({ model, messages: [] }),
        });
        expect(res.status).toBe(502);
        const body = await res.json() as { type: string; error: { type: string; message: string } };
        expect(body.type).toBe('error');
        expect(body.error.message).toContain('codex-oauth');
        expect(body.error.message).toContain('"codex"');
        expect(body.error.message).toContain('"codex-work"');
      }
      expect(forwarded).toEqual([]);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('serialises the model-change check, so two concurrent first requests spawn one child and a later crash still respawns', async () => {
    // Without an in-flight guard, request 2 saw request 1's not-yet-ready child
    // and took the *restart* branch: an extra kill/respawn, and a deliberate-
    // restart marker consumed by the abandoned child's exit — after which the
    // next genuine crash was swallowed and the router served a dead upstream.
    writeMachineConfig(`
[models."sonnet-like"]
gateway = "anth"
id = "some-model"
[tiers.code]
simple = ["sonnet-like"]
complex = ["sonnet-like"]
[native.gateways."anth"]
base_url = "https://anth.example"
provider = "anthropic"
[native.ports]
router = 0
litellm = ${litellmPort}
`);
    writeSonataKey(home, 'anth', 'k');
    const project = mkdtempSync(join(tmpdir(), 'serve-tenant-race-'));
    writeFileSync(join(project, 'sonata.toml'), TENANT('needs-litellm'));
    const kills: number[] = [];
    const exitCbs: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
    let spawns = 0;
    let releaseReady: () => void = () => {};
    const firstReady = new Promise<void>((r) => { releaseReady = r; });
    let waits = 0;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(),
      litellmExitTimeoutMs: 20, // its fake children never exit on SIGTERM; stop() would wait out the default
      respawnDelayMs: 0,
      waitForLitellm: async () => { waits += 1; if (waits === 1) await firstReady; },
      spawnLitellm: () => {
        spawns += 1;
        const pid = spawns;
        return { pid, kill: () => kills.push(pid), onExit: (cb) => { exitCbs.push(cb); } };
      },
    });
    handles.push(handle);
    vi.unstubAllGlobals();
    // Raw sockets, not `fetch`: undici pools by origin and dispatches two
    // requests to one server one after the other, which would defeat the whole
    // point of this test.
    const call = () => new Promise<void>((resolve, reject) => {
      const request = httpRequest({
        host: 'localhost', port: handle.routerPort, path: '/v1/messages', method: 'POST',
        headers: { 'content-type': 'application/json', ...projectHeaders(project) },
      }, (res) => { res.resume(); res.on('end', () => resolve()); });
      request.on('error', reject);
      request.end(JSON.stringify({ model: 'sonata-code-simple', messages: [] }));
    });
    // Request 1 first, held at its readiness probe with the child spawned but
    // not yet ready — the exact window request 2 used to walk into.
    const first = call();
    for (let i = 0; i < 200 && spawns === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
    expect(spawns).toBe(1);
    const second = call();
    await new Promise((r) => setTimeout(r, 30));
    // Without the guard, request 2 took the restart branch and killed a child
    // that was still coming up.
    expect(kills).toEqual([]);
    expect(spawns).toBe(1);
    releaseReady();
    await Promise.all([first, second]);
    await new Promise((r) => setTimeout(r, 10));
    expect(spawns).toBe(1);

    // The live child now crashes on its own. The marker must not have leaked,
    // so this is seen as a crash and respawned.
    for (const cb of exitCbs.slice()) cb(1, null);
    await waitFor(() => spawns === 2, 'the respawned litellm child');
    expect(spawns).toBe(2);
  });

  it('answers 502 naming the install when a tenant needs litellm and the venv is missing', async () => {
    rmSync(venvDir(home), { recursive: true, force: true });
    writeMachineConfig(`
[models."m"]
gateway = "anth"
id = "some-model"
[native.gateways."anth"]
base_url = "https://anth.example"
provider = "anthropic"
[native.ports]
router = 0
litellm = ${litellmPort}
`);
    writeSonataKey(home, 'anth', 'k');
    const project = mkdtempSync(join(tmpdir(), 'serve-tenant-noinstall-'));
    writeFileSync(join(project, 'sonata.toml'), TENANT('needs-litellm'));
    const handle = await cmdServe({ cwd, home, tempDir: tempDirFor(), waitForLitellm: async () => {}, spawnLitellm: () => { throw new Error('must not spawn'); } });
    handles.push(handle);
    const res = await fetch(`http://localhost:${handle.routerPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...projectHeaders(project) },
      body: JSON.stringify({ model: 'sonata-code-simple', messages: [] }),
    });
    const text = await res.text();
    expect(res.status).toBe(502);
    expect(text).toContain('sonata litellm install');
  });

  it('starts the lazy child after LiteLLM is installed following an unavailable response', async () => {
    rmSync(venvDir(home), { recursive: true, force: true });
    writeMachineConfig(`
[models."m"]
gateway = "anth"
id = "some-model"
[native.gateways."anth"]
base_url = "https://anth.example"
provider = "anthropic"
[native.ports]
router = 0
litellm = ${litellmPort}
`);
    writeSonataKey(home, 'anth', 'k');
    const project = mkdtempSync(join(tmpdir(), 'serve-tenant-install-recovery-'));
    writeFileSync(join(project, 'sonata.toml'), TENANT('needs-litellm'));
    let spawns = 0;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(), waitForLitellm: async () => {},
      spawnLitellm: () => { spawns += 1; return { pid: spawns, kill: () => {} }; },
    });
    handles.push(handle);
    vi.unstubAllGlobals();
    const request = () => fetch(`http://localhost:${handle.routerPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...projectHeaders(project) },
      body: JSON.stringify({ model: 'sonata-code-simple', messages: [] }),
    });
    const unavailable = await request();
    expect(unavailable.status).toBe(502);
    expect(await unavailable.text()).toContain('sonata litellm install');
    installFakeVenv(home);
    const served = await request();
    expect(served.status).toBe(200);
    expect(spawns).toBe(1);
  });

  it('retries lazy LiteLLM startup when its first health check fails', async () => {
    writeMachineConfig(`
[models."m"]
gateway = "anth"
id = "some-model"
[native.gateways."anth"]
base_url = "https://anth.example"
provider = "anthropic"
[native.ports]
router = 0
litellm = ${litellmPort}
`);
    writeSonataKey(home, 'anth', 'k');
    const project = mkdtempSync(join(tmpdir(), 'serve-tenant-wait-recovery-'));
    writeFileSync(join(project, 'sonata.toml'), TENANT('needs-litellm'));
    let spawns = 0;
    let waits = 0;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(),
      spawnLitellm: () => { spawns += 1; return { pid: spawns, kill: () => {} }; },
      waitForLitellm: async () => {
        waits += 1;
        if (waits === 1) throw new Error('not ready');
      },
    });
    handles.push(handle);
    vi.unstubAllGlobals();
    const request = () => fetch(`http://localhost:${handle.routerPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...projectHeaders(project) },
      body: JSON.stringify({ model: 'sonata-code-simple', messages: [] }),
    });
    await request();
    expect(spawns).toBe(1);
    const served = await request();
    expect(served.status).toBe(200);
    expect(spawns).toBe(2);
  });

  it('keeps a lazy child abandoned when it exits before its readiness check fails', async () => {
    writeMachineConfig(`
[models."m"]
gateway = "anth"
id = "some-model"
[native.gateways."anth"]
base_url = "https://anth.example"
provider = "anthropic"
[native.ports]
router = 0
litellm = ${litellmPort}
`);
    writeSonataKey(home, 'anth', 'k');
    const project = mkdtempSync(join(tmpdir(), 'serve-tenant-exit-recovery-'));
    writeFileSync(join(project, 'sonata.toml'), TENANT('needs-litellm'));
    let spawns = 0;
    let waits = 0;
    let firstExit: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(),
      litellmExitTimeoutMs: 20, // its fake children never exit on SIGTERM; stop() would wait out the default
      spawnLitellm: () => {
        spawns += 1;
        return {
          pid: spawns,
          kill: () => {},
          onExit: (cb) => { if (spawns === 1) firstExit = cb; },
        };
      },
      waitForLitellm: async () => {
        waits += 1;
        if (waits === 1) {
          firstExit?.(1, null);
          throw new Error('not ready');
        }
      },
      respawnDelayMs: 0,
    });
    handles.push(handle);
    vi.unstubAllGlobals();
    const request = () => fetch(`http://localhost:${handle.routerPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...projectHeaders(project) },
      body: JSON.stringify({ model: 'sonata-code-simple', messages: [] }),
    });
    await request();
    await waitFor(() => spawns === 1, 'the first lazy spawn');
    expect(spawns).toBe(1);
    const served = await request();
    expect(served.status).toBe(200);
    expect(spawns).toBe(2);
  });

  it('leaves a tenant that will not parse out of the union and still serves the others', async () => {
    writeMachineConfig(TENANT('machine-model'));
    const broken = mkdtempSync(join(tmpdir(), 'serve-tenant-broken-'));
    writeFileSync(join(broken, 'sonata.toml'), '[native.gateways\n');
    const configs: string[] = [];
    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(), waitForLitellm: async () => {},
      spawnLitellm: (configPath) => { configs.push(readFileSync(configPath, 'utf8')); return { pid: 1, kill: () => {} }; },
    });
    handles.push(handle);
    const res = await fetch(`http://localhost:${handle.routerPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...projectHeaders(broken) },
      body: JSON.stringify({ model: 'sonata-code-simple', messages: [] }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(join(broken, 'sonata.toml'));
    expect(configs.at(-1)).toContain('machine-model');
  });

  it('ignores a project [native.ports]: the router binds the machine ports', async () => {
    writeMachineConfig(TENANT('machine-model'));
    const project = mkdtempSync(join(tmpdir(), 'serve-tenant-ports-'));
    const projectPort = await freePort();
    writeFileSync(join(project, 'sonata.toml'), TENANT('a-model', projectPort).replace('router = 0', `router = ${projectPort}`));
    const handle = await cmdServe({ cwd: project, home, tempDir: tempDirFor(), waitForLitellm: async () => {}, spawnLitellm: () => ({ pid: 1, kill: () => {} }) });
    handles.push(handle);
    expect(handle.routerPort).not.toBe(projectPort);
    expect(handle.litellmPort).toBe(litellmPort);
  });
});

describe('sonataRouterMultiTenant', () => {
  it('is true for a multi-tenant router, false for an older one, null for a non-router', async () => {
    const payload = (body: unknown, ok = true) => (async () => new Response(JSON.stringify(body), { status: ok ? 200 : 500 })) as unknown as typeof fetch;
    expect(await sonataRouterMultiTenant(1, payload({ sonata: true, multiTenant: true }))).toBe(true);
    expect(await sonataRouterMultiTenant(1, payload({ sonata: true, configPath: '/x' }))).toBe(false);
    expect(await sonataRouterMultiTenant(1, payload({ other: true }))).toBe(null);
    expect(await sonataRouterMultiTenant(1, payload({}, false))).toBe(null);
  });
});

describe('cmdServe — a project-scoped install with no machine config', () => {
  it('starts and serves that project, because the guard asks whether any tenant has [native]', async () => {
    // `sonata init` defaults to project scope, so a fresh install writes no
    // machine config at all. The router must still come up.
    rmSync(machineConfigPath(), { force: true });
    const project = mkdtempSync(join(tmpdir(), 'serve-project-only-'));
    writeFileSync(join(project, 'sonata.toml'), `
[models."flash"]
gateway = "acme"
id = "a-model"
[tiers.code]
simple = ["flash"]
complex = ["flash"]
[native.gateways."acme"]
base_url = "https://gateway.example/v1"
[native.ports]
router = 0
litellm = ${litellmPort}
`);
    const forwarded: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      forwarded.push((JSON.parse(init.body as string) as { model: string }).model);
      return new Response('{}', { status: 200 });
    }));
    const handle = await cmdServe({
      cwd: project, home, tempDir: tempDirFor(), waitForLitellm: async () => {},
      // `routerPorts` reads the machine config, which this test deliberately
      // does not have, so the port comes from the seam rather than 4100.
      ports: { router: 0, litellm: litellmPort },
      spawnLitellm: () => ({ pid: 1, kill: () => {} }),
    });
    handles.push(handle);
    vi.unstubAllGlobals();
    const res = await fetch(`http://localhost:${handle.routerPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...projectHeaders(project) },
      body: JSON.stringify({ model: 'sonata-code-simple', messages: [] }),
    });
    expect(res.status).toBe(200);
    expect(forwarded).toEqual([`${tenantId(realpathSync(join(project, 'sonata.toml')))}/flash`]);
  });

  it('still refuses when no tenant has a [native] table at all', async () => {
    rmSync(machineConfigPath(), { force: true });
    await expect(cmdServe({ cwd, home, tempDir: tempDirFor(), ports: { router: 0, litellm: litellmPort } }))
      .rejects.toThrow(/no \[native\] table/);
  });
});

describe('cmdServe — a machine config that will not load', () => {
  // The machine cap bounds everything the router forwards, so a machine
  // config that fails to load must not silently remove it: `machineConfig()`
  // swallows the load error, `machineDailyUsd` is undefined, and the
  // machine-wide [budget] vanishes while every request keeps spending. A
  // broken file that never had a [budget] table had no cap to lose and must
  // not start refusing everything.
  const PROJECT = () => `
[models."flash"]
gateway = "acme"
id = "a-model"
[tiers.code]
simple = ["flash"]
complex = ["flash"]
[native.gateways."acme"]
base_url = "https://gateway.example/v1"
[native.ports]
router = 0
litellm = ${litellmPort}
`;

  async function serveWithBrokenMachine(withBudget: boolean) {
    writeMachineConfig(withBudget ? '[budget]\ndaily_usd = 5\n[native.gateways\n' : '[native.gateways\n');
    const project = mkdtempSync(join(tmpdir(), 'serve-broken-machine-'));
    writeFileSync(join(project, 'sonata.toml'), PROJECT());
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const handle = await cmdServe({
      cwd: project, home, tempDir: tempDirFor(), waitForLitellm: async () => {},
      // `routerPorts` reads the machine config, which is deliberately broken
      // here, so the port comes from the seam rather than 4100.
      ports: { router: 0, litellm: litellmPort },
      spawnLitellm: () => ({ pid: 1, kill: () => {} }),
    });
    handles.push(handle);
    vi.unstubAllGlobals();
    return { project, handle };
  }

  const request = (project: string, handle: ServeHandle) =>
    fetch(`http://localhost:${handle.routerPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...projectHeaders(project) },
      body: JSON.stringify({ model: 'sonata-code-simple', messages: [] }),
    });

  it('refuses a project request when the broken machine config had a [budget] table', async () => {
    const { project, handle } = await serveWithBrokenMachine(true);
    const res = await request(project, handle);
    expect(res.status).toBe(429);
    const body = await res.text();
    expect(body).toContain('sets [budget] but will not load');
    expect(body).toContain(machineConfigPath());
  });

  it('refuses nothing extra when the broken machine config had no [budget] table', async () => {
    const { project, handle } = await serveWithBrokenMachine(false);
    const res = await request(project, handle);
    expect(res.status).toBe(200);
  });
});

describe('cmdServe — the machine config is the machine, canonically', () => {
  it('names the canonical machine config in a budget refusal', async () => {
    // `TenantRegistry` realpaths every config path; `join(home, ...)` did not,
    // and on a home that traverses a symlink the two spellings differ — the
    // machine config was then treated as a project tenant and its machine-wide
    // cap applied per project directory. The refusal's `configPath` is where
    // that comparison is visible from outside.
    writeMachineConfig(`
[models."flash"]
gateway = "acme"
id = "a-model"
[tiers.code]
simple = ["flash"]
complex = ["flash"]
[native.gateways."acme"]
base_url = "https://gateway.example/v1"
[native.ports]
router = 0
litellm = ${litellmPort}
[budget]
daily_usd = 0.5
`);
    appendRow(home, {
      ts: new Date().toISOString(), ms: 1, alias: 'sonata-code-simple', upstream: 'litellm',
      status: 200, complete: true, tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
      price: { source: 'model', totalUsd: 9 }, attempts: [],
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(), waitForLitellm: async () => {},
      spawnLitellm: () => ({ pid: 1, kill: () => {} }),
    });
    handles.push(handle);
    vi.unstubAllGlobals();
    const res = await fetch(`http://localhost:${handle.routerPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'sonata-code-simple', messages: [] }),
    });
    expect(res.status).toBe(429);
    expect(await res.text()).toContain(realpathSync(machineConfigPath()));
  });
});

describe('budgetStatusesFor', () => {
  const tenant = (over: Partial<RouterTenant>): RouterTenant =>
    ({ id: 't', configPath: '/canonical/sonata.toml', ...over } as RouterTenant);

  it('treats the machine config as the machine, even spelled non-canonically', () => {
    // `TenantRegistry` realpaths every config path; `join(home, ...)` does not.
    // Comparing them raw made the machine config look like a project tenant,
    // and its machine-wide cap was then applied per project directory.
    const statuses = budgetStatusesFor({
      tenant: tenant({
        configPath: '/canonical/machine/sonata.toml',
        project: '/some/project',
        config: { budget: { dailyUsd: 5 } } as never,
      }),
      machineConfigPath: '/canonical/machine/sonata.toml',
      machineDailyUsd: 5,
      projectSpend: () => 99,
      machineSpend: () => 1,
    });
    expect(statuses).toEqual([{ dailyUsd: 5, spentUsd: 1, configPath: '/canonical/machine/sonata.toml' }]);
  });

  it('applies a project cap alongside the machine one for a real project tenant', () => {
    const statuses = budgetStatusesFor({
      tenant: tenant({ config: { budget: { dailyUsd: 2 } } as never, project: '/p' }),
      machineConfigPath: '/canonical/machine/sonata.toml',
      machineDailyUsd: 5,
      projectSpend: () => 3,
      machineSpend: () => 1,
    });
    expect(statuses).toEqual([
      { dailyUsd: 2, spentUsd: 3, configPath: '/canonical/sonata.toml' },
      { dailyUsd: 5, spentUsd: 1, configPath: '/canonical/machine/sonata.toml' },
    ]);
  });
});

describe('mergeTenantGateways', () => {
  const gw = (over: Record<string, unknown>) => ({ baseUrl: 'https://a.example/v1', auth: 'api-key', ...over } as never);

  it('keeps one definition per name, and a differing base_url is not a conflict', () => {
    // Deliberate and tested elsewhere: two projects may name one gateway and
    // reach different endpoints, sharing the machine-wide credential.
    const lines: string[] = [];
    const merged = mergeTenantGateways([
      { id: 'a', gateways: { acme: gw({ baseUrl: 'https://a.example/v1' }) } },
      { id: 'b', gateways: { acme: gw({ baseUrl: 'https://b.example/v1' }) } },
    ], (l) => lines.push(l));
    expect(Object.keys(merged)).toEqual(['acme']);
    expect(lines).toEqual([]);
  });

  it('drops two differently named gateways from two projects that share one key variable', () => {
    // parseConfig refuses the pair inside one file, but the router merges
    // every project's gateways into ONE child env keyed by envVarForGateway,
    // so `foo-bar` in one project and `foo_bar` in another would still write
    // the same SONATA_KEY_FOO_BAR and one would send the other's key.
    const lines: string[] = [];
    const merged = mergeTenantGateways([
      { id: 'a', gateways: { 'foo-bar': gw({}), keep: gw({}) } },
      { id: 'b', gateways: { foo_bar: gw({}) } },
    ], (l) => lines.push(l));
    expect(merged['foo-bar']).toBeUndefined();
    expect(merged.foo_bar).toBeUndefined();
    expect(Object.keys(merged)).toEqual(['keep']);
    expect(lines.join('\n')).toContain('SONATA_KEY_FOO_BAR');
  });

  it('drops two differently named gateways of one OAuth kind from two projects', () => {
    // One LiteLLM child holds ONE ChatGPT credential (CHATGPT_TOKEN_DIR), so
    // two projects' codex-oauth gateways would both be served whichever
    // account buildChildEnv found first.
    const lines: string[] = [];
    const merged = mergeTenantGateways([
      { id: 'a', gateways: { codex: gw({ auth: 'codex-oauth', baseUrl: undefined }), keep: gw({}) } },
      { id: 'b', gateways: { 'codex-work': gw({ auth: 'codex-oauth', baseUrl: undefined, credentialSource: 'sonata' }) } },
    ], (l) => lines.push(l));
    expect(merged.codex).toBeUndefined();
    expect(merged['codex-work']).toBeUndefined();
    expect(Object.keys(merged)).toEqual(['keep']);
    expect(lines.join('\n')).toMatch(/auth = "codex-oauth".*"codex" \(a, default\).*"codex-work" \(b, sonata:codex-work\)/s);
  });

  it('keeps two differently named OAuth gateways of one kind that read the same credential', () => {
    // Same source (the default included) means one account: nothing can reach
    // the wrong endpoint, so dropping them would only break both projects.
    const lines: string[] = [];
    const merged = mergeTenantGateways([
      { id: 'a', gateways: { codex: gw({ auth: 'codex-oauth', baseUrl: undefined }) } },
      { id: 'b', gateways: { openai: gw({ auth: 'codex-oauth', baseUrl: undefined }) } },
    ], (l) => lines.push(l));
    expect(Object.keys(merged).sort()).toEqual(['codex', 'openai']);
    expect(lines).toEqual([]);
  });

  it('drops two sonata-sourced gateways of one kind from two projects: two logins', () => {
    const lines: string[] = [];
    const merged = mergeTenantGateways([
      { id: 'a', gateways: { codex: gw({ auth: 'codex-oauth', baseUrl: undefined, credentialSource: 'sonata' }) } },
      { id: 'b', gateways: { 'codex-work': gw({ auth: 'codex-oauth', baseUrl: undefined, credentialSource: 'sonata' }) } },
    ], (l) => lines.push(l));
    expect(merged).toEqual({});
    expect(lines.join('\n')).toContain('sonata:codex-work');
  });

  it('drops ALL gateways of a kind once any two of them read different credentials', () => {
    // A and B share the default store, C has its own sonata login. Keeping A
    // and B while dropping C (or any pair-wise rule) still leaves one child
    // env deciding between two accounts; every one of them goes.
    const lines: string[] = [];
    const merged = mergeTenantGateways([
      { id: 'a', gateways: { codex: gw({ auth: 'codex-oauth', baseUrl: undefined }), keep: gw({}) } },
      { id: 'b', gateways: { openai: gw({ auth: 'codex-oauth', baseUrl: undefined }) } },
      { id: 'c', gateways: { chatgpt: gw({ auth: 'codex-oauth', baseUrl: undefined, credentialSource: 'sonata' }) } },
    ], (l) => lines.push(l));
    expect(Object.keys(merged)).toEqual(['keep']);
    const text = lines.join('\n');
    expect(text).toContain('"codex" (a, default)');
    expect(text).toContain('"openai" (b, default)');
    expect(text).toContain('"chatgpt" (c, sonata:chatgpt)');
  });

  describe('by the credential store serve would actually read', () => {
    let storeHome: string;
    beforeEach(() => { storeHome = mkdtempSync(join(tmpdir(), 'sonata-oauth-store-')); });
    afterEach(() => { rmSync(storeHome, { recursive: true, force: true }); });
    const withCodexStore = () => {
      mkdirSync(join(storeHome, '.codex'), { recursive: true });
      writeFileSync(join(storeHome, '.codex', 'auth.json'), JSON.stringify({ tokens: { access_token: 'x' } }));
    };
    const codexPair = (): Parameters<typeof mergeTenantGateways>[0] => [
      { id: 'a', gateways: { codex: gw({ auth: 'codex-oauth', baseUrl: undefined, credentialSource: 'codex' }) } },
      { id: 'b', gateways: { openai: gw({ auth: 'codex-oauth', baseUrl: undefined }) } },
    ];

    it('keeps codex `codex` beside the default when the default reads the codex store', () => {
      withCodexStore();
      const lines: string[] = [];
      const merged = mergeTenantGateways(codexPair(), (l) => lines.push(l), (name, g) => resolvedOauthIdentity(storeHome, name, g));
      expect(Object.keys(merged).sort()).toEqual(['codex', 'openai']);
      expect(lines).toEqual([]);
    });

    it('drops them when the default falls through to the opencode store', () => {
      const lines: string[] = [];
      const merged = mergeTenantGateways(codexPair(), (l) => lines.push(l), (name, g) => resolvedOauthIdentity(storeHome, name, g));
      expect(merged).toEqual({});
      expect(lines.join('\n')).toMatch(/"codex" \(a, codex store\).*"openai" \(b, opencode store\)/s);
    });

    it('treats copilot on opencode and on the default as one login', () => {
      expect(resolvedOauthIdentity(storeHome, 'x', { auth: 'copilot-oauth', credentialSource: 'opencode' }))
        .toBe(resolvedOauthIdentity(storeHome, 'y', { auth: 'copilot-oauth' }));
    });

    it('never treats two sonata logins, or one beside a machine store, as one', () => {
      expect(resolvedOauthIdentity(storeHome, 'a', { auth: 'codex-oauth', credentialSource: 'sonata' }))
        .not.toBe(resolvedOauthIdentity(storeHome, 'b', { auth: 'codex-oauth', credentialSource: 'sonata' }));
      withCodexStore();
      expect(resolvedOauthIdentity(storeHome, 'a', { auth: 'codex-oauth', credentialSource: 'sonata' }))
        .not.toBe(resolvedOauthIdentity(storeHome, 'b', { auth: 'codex-oauth' }));
    });
  });

  it('keeps one OAuth gateway that two projects name identically', () => {
    const lines: string[] = [];
    const merged = mergeTenantGateways([
      { id: 'a', gateways: { codex: gw({ auth: 'codex-oauth', baseUrl: undefined }) } },
      { id: 'b', gateways: { codex: gw({ auth: 'codex-oauth', baseUrl: undefined }) } },
    ], (l) => lines.push(l));
    expect(Object.keys(merged)).toEqual(['codex']);
    expect(lines).toEqual([]);
  });

  it('drops a gateway whose tenants disagree about how it authenticates', () => {
    // `buildChildEnv` resolves one credential per gateway NAME, so a name two
    // projects define with different credential sources would send one
    // project's credential to the other's endpoint. Neither gets a key: a
    // visible failure beats a silent cross-project credential.
    const lines: string[] = [];
    const merged = mergeTenantGateways([
      { id: 'a', gateways: { acme: gw({ credentialSource: 'sonata' }) } },
      { id: 'b', gateways: { acme: gw({ credentialSource: 'opencode' }) } },
    ], (l) => lines.push(l));
    expect(merged.acme).toBeUndefined();
    expect(lines.join('\n')).toContain('acme');
    expect(lines.join('\n')).toContain('credential');
  });

  it('drops a gateway whose tenants disagree about its auth kind', () => {
    const merged = mergeTenantGateways([
      { id: 'a', gateways: { g: gw({ auth: 'api-key' }) } },
      { id: 'b', gateways: { g: gw({ auth: 'codex-oauth' }) } },
    ], () => {});
    expect(merged.g).toBeUndefined();
  });

  it('logs a conflict once, not once per merge', () => {
    const lines: string[] = [];
    const tenants = [
      { id: 'a', gateways: { acme: gw({ credentialSource: 'sonata' }) } },
      { id: 'b', gateways: { acme: gw({ credentialSource: 'opencode' }) } },
    ];
    const log = (l: string) => lines.push(l);
    mergeTenantGateways(tenants, log);
    mergeTenantGateways(tenants, log);
    expect(lines).toHaveLength(2);
  });
});

describe('cmdServe — the models.dev price refresh', () => {
  it('runs the injected refresh against its own home instead of fetching', async () => {
    const calls: string[] = [];
    const handle = await realCmdServe({
      cwd, home, tempDir: tempDirFor(),
      waitForLitellm: async () => {}, spawnLitellm: () => ({ pid: 1, kill() {} }),
      refreshPrices: async (at) => { calls.push(at); },
    });
    handles.push(handle);
    expect(calls).toEqual([home]);
  });
});

describe('defaultWaitForLitellm — a listener that never answers', () => {
  it('bounds each probe with an abort signal, so the deadline is reached', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    // Accepts the connection and never answers — unless the signal aborts it.
    const doFetch = ((_url: string, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }) as unknown as typeof fetch;
    let clock = 0;
    const waited = defaultWaitForLitellm(4010, 'sk', {
      doFetch,
      now: () => clock,
      sleep: async () => { clock += 1_000; },
      timeoutMs: 1_500,
    });
    await expect(waited).rejects.toThrow(/did not come up/);
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal !== undefined)).toBe(true);
  }, 15_000);
});

describe('cmdServe — the router listens on both loopback families', () => {
  // `localhost` resolves to ::1 and 127.0.0.1 here, in that order. The router
  // bound `localhost` — ::1 only — while every client (Claude Code's
  // ANTHROPIC_BASE_URL, the hooks, doctor) connects to `localhost` with
  // Node's happy-eyeballs: when the ::1 attempt has not been *seen* to
  // complete within 250ms, it is abandoned for 127.0.0.1, where nothing
  // listened, and the request fails `fetch failed` / ETIMEDOUT.
  const health = (url: string) => fetch(url, { headers: { connection: 'close' } }).then((res) => res.status);

  it('accepts a client that stalls while connecting over localhost', async () => {
    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(),
      waitForLitellm: async () => {}, spawnLitellm: () => ({ pid: 1, kill() {} }),
    });
    handles.push(handle);
    const net = await import('node:net');
    // The same connect undici makes for `fetch('http://localhost:…')`:
    // happy-eyeballs across both families, 250ms per attempt. Blocking the
    // thread for 300ms as the first attempt starts — a loaded worker, or a busy
    // client — lets that timer expire before the completed connect is seen,
    // so the attempt is abandoned for the next family.
    const outcome = await new Promise<string>((resolve) => {
      const stall = new Int32Array(new SharedArrayBuffer(4));
      const socket = net.connect({ host: 'localhost', port: handle.routerPort, autoSelectFamily: true });
      // Blocking from a setImmediate puts the stall in the loop's check phase,
      // so the next turn runs its timers — the expired attempt timer — before
      // it polls for the connect that has meanwhile completed.
      socket.once('connectionAttempt', () => { setImmediate(() => { Atomics.wait(stall, 0, 0, 300); }); });
      socket.once('connect', () => { socket.destroy(); resolve('connected'); });
      socket.once('error', (error: NodeJS.ErrnoException) => resolve(`${error.code ?? error.message}`));
    });
    expect(outcome).toBe('connected');
  });

  it('answers on both http://127.0.0.1 and http://[::1]', async () => {
    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(),
      waitForLitellm: async () => {}, spawnLitellm: () => ({ pid: 1, kill() {} }),
    });
    handles.push(handle);
    expect(await health(`http://127.0.0.1:${handle.routerPort}/__sonata_health`)).toBe(200);
    expect(await health(`http://[::1]:${handle.routerPort}/__sonata_health`)).toBe(200);
  });

  it('releases both families on stop', async () => {
    const port = await freePort();
    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(), ports: { router: port, litellm: litellmPort },
      waitForLitellm: async () => {}, spawnLitellm: () => ({ pid: 1, kill() {} }),
    });
    await handle.stop();
    const net = await import('node:net');
    for (const host of ['127.0.0.1', '::1']) {
      const again = net.createServer();
      await new Promise<void>((resolve, reject) => { again.once('error', reject); again.listen(port, host, () => resolve()); });
      await new Promise<void>((resolve) => again.close(() => resolve()));
    }
  });

  for (const missing of ['::1', '127.0.0.1'] as const) {
    for (const code of ['EADDRNOTAVAIL', 'EAFNOSUPPORT']) {
      it(`serves on the other family when ${missing} cannot be bound (${code})`, async () => {
        const handle = await cmdServe({
          cwd, home, tempDir: tempDirFor(),
          waitForLitellm: async () => {}, spawnLitellm: () => ({ pid: 1, kill() {} }),
          listenOn: (server, port, host) => host === missing
            ? Promise.reject(Object.assign(new Error(`listen ${code} ${host}`), { code }))
            : listenOn(server, port, host),
        });
        handles.push(handle);
        const present = missing === '::1' ? `127.0.0.1` : `[::1]`;
        expect(await health(`http://${present}:${handle.routerPort}/__sonata_health`)).toBe(200);
      });
    }
  }

  it('fails when neither family can be bound', async () => {
    await expect(cmdServe({
      cwd, home, tempDir: tempDirFor(),
      waitForLitellm: async () => {}, spawnLitellm: () => ({ pid: 1, kill() {} }),
      listenOn: (_server, _port, host) => Promise.reject(Object.assign(new Error(`listen EADDRNOTAVAIL ${host}`), { code: 'EADDRNOTAVAIL' })),
    })).rejects.toThrow(/EADDRNOTAVAIL/);
  });

  it('still refuses, naming the holder, when either family of a fixed port is taken', async () => {
    // A router predating this binds ::1 alone; its successor must not come up
    // beside it on 127.0.0.1 and split `localhost` between two daemons.
    const net = await import('node:net');
    for (const held of ['::1', '127.0.0.1']) {
      const port = await freePort();
      const holder = net.createServer();
      await new Promise<void>((resolve) => holder.listen(port, held, () => resolve()));
      try {
        await expect(cmdServe({
          cwd, home, tempDir: tempDirFor(), ports: { router: port, litellm: litellmPort },
          waitForLitellm: async () => {}, spawnLitellm: () => ({ pid: 1, kill() {} }),
          probeHealth: (async () => { throw new Error('not a router'); }) as unknown as typeof fetch,
        })).rejects.toThrow(/non-sonata/);
        // Nothing half-bound is left behind on the other family.
        const other = held === '::1' ? '127.0.0.1' : '::1';
        const again = net.createServer();
        await new Promise<void>((resolve, reject) => { again.once('error', reject); again.listen(port, other, () => resolve()); });
        await new Promise<void>((resolve) => again.close(() => resolve()));
      } finally {
        await new Promise<void>((resolve) => holder.close(() => resolve()));
      }
    }
  });

  it('retries an ephemeral port whose other family is already taken', async () => {
    // Port 0 lets the kernel pick for the first family only; the same number
    // can be held on the second. That is a collision to route around, not a
    // configured port to refuse.
    let collisions = 1;
    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(),
      waitForLitellm: async () => {}, spawnLitellm: () => ({ pid: 1, kill() {} }),
      listenOn: (server, port, host) => {
        if (host === '::1' && collisions > 0) {
          collisions -= 1;
          return Promise.reject(Object.assign(new Error(`listen EADDRINUSE ${host}:${port}`), { code: 'EADDRINUSE' }));
        }
        return listenOn(server, port, host);
      },
    });
    handles.push(handle);
    expect(collisions).toBe(0);
    expect(await health(`http://127.0.0.1:${handle.routerPort}/__sonata_health`)).toBe(200);
    expect(await health(`http://[::1]:${handle.routerPort}/__sonata_health`)).toBe(200);
  });
});

describe('cmdServe — the managed LiteLLM is bound and reached on one family', () => {
  // LiteLLM's own default host is 0.0.0.0 — every IPv4 interface, and
  // overridable by a stray HOST in the environment — while the router reached
  // it as `localhost`, which tries ::1 first. The router must reach exactly
  // the address the child binds, or a foreign ::1 listener on that port
  // answers in its place.
  it('starts the child on 127.0.0.1 alone', async () => {
    const argsFile = join(cwd, 'litellm-args');
    writeFileSync(managedLitellmPath(home), `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\n`, { mode: 0o755 });
    const handle = await cmdServe({ cwd, home, tempDir: tempDirFor(), waitForLitellm: async () => {} });
    handles.push(handle);
    await waitFor(() => existsSync(argsFile) && readFileSync(argsFile, 'utf8').includes('--port'), 'the child to record its arguments');
    const args = readFileSync(argsFile, 'utf8').trim().split('\n');
    expect(args[args.indexOf('--host') + 1]).toBe('127.0.0.1');
    expect(args[args.indexOf('--port') + 1]).toBe(String(litellmPort));
  });

  it('forwards to the child at 127.0.0.1', async () => {
    const seen: string[] = [];
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string) => { seen.push(String(url)); return new Response('{}', { status: 200 }); });
    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(),
      waitForLitellm: async () => {}, spawnLitellm: () => ({ pid: 1, kill() {} }),
    });
    handles.push(handle);
    await realFetch(`http://127.0.0.1:${handle.routerPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [] }),
    });
    expect(seen.some((url) => url.startsWith(`http://127.0.0.1:${litellmPort}/`))).toBe(true);
    expect(seen.some((url) => url.includes('localhost'))).toBe(false);
  });
});

describe('killRecordedOrphan — escalates and forgets only a dead pid', () => {
  let orphanHome: string;
  beforeEach(() => { orphanHome = mkdtempSync(join(tmpdir(), 'sonata-orphan-')); });
  afterEach(() => { rmSync(orphanHome, { recursive: true, force: true }); });
  const record = (state: Record<string, unknown>) => {
    mkdirSync(dirname(serveStatePath(orphanHome, 4100)), { recursive: true });
    writeFileSync(serveStatePath(orphanHome, 4100), JSON.stringify(state));
  };
  const stateOf = () => JSON.parse(readFileSync(serveStatePath(orphanHome, 4100), 'utf8')) as { routerPid?: number; litellmPid?: number };

  it('sends SIGKILL when SIGTERM is ignored, then drops the pid once it is gone', async () => {
    record({ routerPid: 11, litellmPid: 222 });
    const signals: string[] = [];
    let alive = true;
    await killRecordedOrphan(orphanHome, 4100, {
      processCommand: () => '/opt/venv/bin/python /opt/venv/bin/litellm --config x',
      kill: (pid) => signals.push(`TERM ${pid}`),
      forceKill: (pid) => { signals.push(`KILL ${pid}`); alive = false; },
      isAlive: () => alive,
      sleep: async () => {},
      timeoutMs: 50,
    });
    expect(signals).toEqual(['TERM 222', 'KILL 222']);
    expect(stateOf()).toMatchObject({ routerPid: 11 });
    expect(stateOf().litellmPid).toBeUndefined();
  });

  it('does not escalate a process that exits on SIGTERM', async () => {
    record({ litellmPid: 222 });
    const signals: string[] = [];
    let alive = true;
    await killRecordedOrphan(orphanHome, 4100, {
      processCommand: () => 'litellm --config x',
      kill: (pid) => { signals.push(`TERM ${pid}`); alive = false; },
      forceKill: (pid) => signals.push(`KILL ${pid}`),
      isAlive: () => alive,
      sleep: async () => {},
      timeoutMs: 50,
    });
    expect(signals).toEqual(['TERM 222']);
    expect(stateOf().litellmPid).toBeUndefined();
  });

  it('logs a recorded pid that has simply exited as already gone', async () => {
    record({ litellmPid: 222 });
    const notes: string[] = [];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { notes.push(args.map(String).join(' ')); });
    try {
      await killRecordedOrphan(orphanHome, 4100, {
        processCommand: () => undefined,
        kill: () => {}, forceKill: () => {}, isAlive: () => false, sleep: async () => {}, timeoutMs: 50,
      });
    } finally {
      errorSpy.mockRestore();
    }
    expect(notes.join('\n')).toMatch(/222 .*already gone/);
    expect(notes.join('\n')).not.toMatch(/could not be verified/);
    expect(stateOf().litellmPid).toBeUndefined();
  });

  it('sends nothing and forgets the record when ps cannot say what the pid is', async () => {
    record({ routerPid: 11, litellmPid: 222 });
    const signals: string[] = [];
    const result = await killRecordedOrphan(orphanHome, 4100, {
      processCommand: () => undefined,
      kill: (pid) => signals.push(`TERM ${pid}`), forceKill: (pid) => signals.push(`KILL ${pid}`),
      isAlive: () => true, sleep: async () => {}, timeoutMs: 50,
    });
    expect(signals).toEqual([]);
    expect(result.survivor).toBeUndefined();
    expect(stateOf()).toMatchObject({ routerPid: 11 });
    expect(stateOf().litellmPid).toBeUndefined();
  });

  it('keeps the pid on record when it survives SIGKILL too', async () => {
    record({ routerPid: 11, litellmPid: 222 });
    await killRecordedOrphan(orphanHome, 4100, {
      processCommand: () => 'litellm --config x',
      kill: () => {}, forceKill: () => {}, isAlive: () => true,
      sleep: async () => {}, timeoutMs: 50,
    });
    expect(stateOf()).toMatchObject({ routerPid: 11, litellmPid: 222 });
  });

  it('never signals a pid whose command line is no longer LiteLLM', async () => {
    record({ litellmPid: 222 });
    const signals: string[] = [];
    await killRecordedOrphan(orphanHome, 4100, {
      processCommand: () => '/usr/bin/vim notes.txt',
      kill: (pid) => signals.push(`TERM ${pid}`), forceKill: (pid) => signals.push(`KILL ${pid}`),
      isAlive: () => true, sleep: async () => {}, timeoutMs: 50,
    });
    expect(signals).toEqual([]);
    // Not ours: forgetting it is right, since it will never be our child again.
    expect(stateOf().litellmPid).toBeUndefined();
  });
});
