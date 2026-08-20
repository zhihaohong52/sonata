import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cmdServe, serveHealthUrl, type ServeHandle } from '../../src/commands/serve.js';
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
gateway = "anexto"
id = "deepseek-v4-flash-0731"
context_window = 128000

[native.gateways."anexto"]
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

describe('cmdServe', () => {
  it('resolves keys into the LiteLLM child environment under the gateway variable', async () => {
    writeSonataKey(home, 'anexto', 'the-key');
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

    expect(captured.SONATA_KEY_ANEXTO).toBe('the-key');
    expect(captured).not.toHaveProperty('ANTHROPIC_API_KEY');
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
