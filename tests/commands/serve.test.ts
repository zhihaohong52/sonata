import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cmdServe, serveHealthUrl, type ServeHandle } from '../../src/commands/serve.js';
import { writeSonataKey } from '../../src/native/credentials.js';

let cwd: string;
let home: string;
let handles: ServeHandle[];

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'sonata-serve-cwd-'));
  home = mkdtempSync(join(tmpdir(), 'sonata-serve-home-'));
  handles = [];
  writeFileSync(join(cwd, 'sonata.toml'), `
[native.models."deepseek-v4-flash"]
gateway = "vendorx"
id = "deepseek-v4-flash-0731"
context_window = 128000

[native.gateways."vendorx"]
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

describe('cmdServe', () => {
  it('resolves keys into the LiteLLM child environment under the gateway variable', async () => {
    writeSonataKey(home, 'vendorx', 'the-key');
    let captured: NodeJS.ProcessEnv = {};

    const handle = await cmdServe({
      cwd,
      home,
      waitForLitellm: async () => {}, spawnLitellm: (_configPath, env) => {
        captured = env;
        return { pid: 1, kill() {} };
      },
    });
    handles.push(handle);

    expect(captured.SONATA_KEY_VENDORX).toBe('the-key');
    expect(captured).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('serves a health endpoint on the router port', async () => {
    const handle = await cmdServe({ cwd, home, waitForLitellm: async () => {}, spawnLitellm: () => ({ pid: 1, kill() {} }) });
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
});
