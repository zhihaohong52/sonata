import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { spawn as spawnType } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  cmdServe, serveHealthUrl, type ServeHandle, isSonataRouter, occupiedPortMessage, startServeDaemon,
  serveStatePath, stopServe, cmdRestart,
} from '../../src/commands/serve.js';
import { writeSonataKey } from '../../src/native/credentials.js';

let cwd: string;
let home: string;
let handles: ServeHandle[];

/** Every cmdServe call in this file writes here, never into the real tmpdir. */
const tempDirFor = () => join(cwd, 'litellm');

beforeEach(() => {
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
    await expect(response.json()).resolves.toEqual({ status: 'ok', sonata: true });
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
    // The occupant is usually sonata itself: an MCP dispatch to a native model
    // starts a router inside the `sonata mcp` process, and it lives until
    // Claude Code restarts. Calling that "a non-sonata listener" sent a user
    // looking for a foreign program that did not exist.
    const message = await occupiedPortMessage(4100, health({ status: 'ok', sonata: true }));
    expect(message).toMatch(/another sonata router/);
    expect(message).toMatch(/sonata mcp/);
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
    // The health probe answers sonata the first time, then reports gone —
    // stopServe polls until the port actually frees before returning.
    let calls = 0;
    const probe: typeof fetch = (async () => {
      calls += 1;
      return calls === 1 ? new Response(JSON.stringify({ sonata: true })) : new Response('', { status: 500 });
    }) as unknown as typeof fetch;

    const result = await stopServe({
      cwd, home, probeHealth: probe, kill: (pid) => killed.push(pid), sleep: async () => {},
    });

    expect(result.killed).toBe(true);
    expect(killed.sort()).toEqual([111, 222]);
    expect(existsSync(serveStatePath(home))).toBe(false);
  });

  it('refuses to kill when the port answers sonata but no pid was ever recorded', async () => {
    // Never guess a pid by scanning the OS — only a pid sonata itself
    // recorded is ever killed.
    await expect(stopServe({ cwd, home, probeHealth: sonataHealth }))
      .rejects.toThrow(/no recorded pid/);
  });

  it('throws if the port is still answering after the kill, rather than reporting success', async () => {
    mkdirSync(dirname(serveStatePath(home)), { recursive: true });
    writeFileSync(serveStatePath(home), JSON.stringify({ routerPid: 111 }));
    const result = await stopServe({
      cwd, home, probeHealth: sonataHealth, kill: () => {}, sleep: async () => {},
      now: (() => { let t = 0; return () => (t += 1000); })(), timeoutMs: 2000,
    }).catch((e) => e as Error);
    expect((result as Error).message).toMatch(/still answering/);
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
