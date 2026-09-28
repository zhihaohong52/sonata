import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A write landing between two reads of one credential store inside ONE
 * child-env build: the `at`-th read of `path` sees the file truncated, every
 * other read sees it whole. Which read that is does not matter — whichever it
 * is, the build must not conclude the login is gone.
 */
const tear: { path?: string; at: number; n: number } = { at: -1, n: 0 };

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const readFileSync = ((path: unknown, ...rest: unknown[]) => {
    if (tear.path !== undefined && String(path) === tear.path && tear.n++ === tear.at) {
      const options = rest[0];
      const encoding = typeof options === 'string' ? options : (options as { encoding?: string } | undefined)?.encoding;
      return encoding ? '' : Buffer.alloc(0);
    }
    return (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof actual.readFileSync;
  return { ...actual, readFileSync, default: { ...actual, readFileSync } };
});

const { cmdServe } = await import('../../src/commands/serve.js');
const { managedLitellmPath, venvDir, LITELLM_VERSION } = await import('../../src/native/litellm-venv.js');

describe('one read per credential store per build', () => {
  let home: string;
  let cwd: string;
  let errors: string[];
  const realFetch = globalThis.fetch;
  const litellmPort = 47_000 + Math.floor(Math.random() * 900);

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'serve-read-once-home-'));
    cwd = mkdtempSync(join(tmpdir(), 'serve-read-once-cwd-'));
    mkdirSync(join(venvDir(home), 'bin'), { recursive: true });
    writeFileSync(managedLitellmPath(home), '#!/bin/sh\n', { mode: 0o755 });
    writeFileSync(join(venvDir(home), '.sonata-pin'), LITELLM_VERSION);
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    errors = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.join(' ')); });
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => String(url).includes(`:${litellmPort}`)
      ? new Response('{"id":"x","type":"message","role":"assistant","content":[],"usage":{"input_tokens":1,"output_tokens":1}}',
        { status: 200, headers: { 'content-type': 'application/json' } })
      : realFetch(url, init)) as typeof fetch;
    tear.path = undefined;
    tear.at = -1;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  const start = async (config: string) => {
    writeFileSync(join(home, '.config', 'sonata', 'sonata.toml'), `${config}
[native.ports]
router = 0
litellm = ${litellmPort}
`);
    let spawns = 0;
    let kills = 0;
    const handle = await cmdServe({
      cwd, home, tempDir: join(cwd, 'litellm'), waitForLitellm: async () => {}, litellmExitTimeoutMs: 100,
      refreshPrices: async () => {},
      spawnLitellm: () => {
        spawns += 1;
        const exits: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
        return {
          pid: spawns,
          kill: () => { kills += 1; setTimeout(() => exits.forEach((cb) => cb(0, 'SIGTERM')), 5); },
          onExit: (cb: (code: number | null, signal: NodeJS.Signals | null) => void) => { exits.push(cb); },
        };
      },
    });
    const send = async () => {
      const res = await realFetch(`http://localhost:${handle.routerPort}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'sonata-code-simple', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      });
      await res.text();
      return res.status;
    };
    return { handle, send, spawns: () => spawns, kills: () => kills };
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

  it.each([0, 1, 2, 3, 4, 5])('a codex login torn at read %i of a build is not read as a logout', async (at) => {
    const jwt = `h.${Buffer.from(JSON.stringify({ exp: 2_000_000_000, client_id: 'app_EMoamEEZ73f0CkXaXp7hrann' })).toString('base64url')}.s`;
    const codex = (refresh: string) => JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: jwt, refresh_token: refresh } });
    mkdirSync(join(home, '.codex'), { recursive: true });
    const file = join(home, '.codex', 'auth.json');
    writeFileSync(file, codex('CODEX-A1'));
    const { handle, send, spawns, kills } = await start(`
[models."luna"]
gateway = "codex"
id = "gpt-5.6-luna"
[tiers.code]
simple = ["luna"]
complex = ["luna"]
[native.gateways."codex"]
auth = "codex-oauth"
`);
    try {
      expect(await send()).toBe(200);
      // codex refreshes: the file moves to a new token, and one read of it
      // inside the next build lands mid-write.
      writeFileSync(file, codex('CODEX-A2'));
      tear.path = file;
      tear.n = 0;
      tear.at = at;
      await send();
      tear.path = undefined;
      await settle();
      expect(await send()).toBe(200);
      await settle();
      expect(kills()).toBe(0);
      expect(spawns()).toBe(1);
      expect(errors.filter((line) => line.includes('logged in again'))).toEqual([]);
      expect(errors.filter((line) => line.includes('no ChatGPT credential was found'))).toEqual([]);
    } finally {
      await handle.stop();
    }
  });

  it.each([0, 1, 2, 3])('a sonata key store torn at read %i of a build is not read as a missing key', async (at) => {
    const keys = join(home, '.config', 'sonata', 'keys.json');
    writeFileSync(keys, JSON.stringify({ acme: 'sk-SAME' }));
    const { handle, send } = await start(`
[models."a"]
gateway = "acme"
id = "a-1"
[tiers.code]
simple = ["a"]
complex = ["a"]
[native.gateways."acme"]
base_url = "https://acme.example/v1"
credential_source = "sonata"
`);
    try {
      expect(await send()).toBe(200);
      writeFileSync(keys, JSON.stringify({ acme: 'sk-SAME' }, null, 2));
      tear.path = keys;
      tear.n = 0;
      tear.at = at;
      await send();
      tear.path = undefined;
      await settle();
      expect(await send()).toBe(200);
      expect(errors.filter((line) => line.includes('none was found'))).toEqual([]);
    } finally {
      await handle.stop();
    }
  });
});
