import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdAuthAdd, cmdAuthList, cmdAuthLogin, cmdAuthRemove } from '../../src/commands/auth.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sonata-auth-'));
});

afterEach(() => {
  home = '';
});

describe('native auth commands', () => {
  it('adds a key and lists only its source', () => {
    const key = 'secret-key-value';
    cmdAuthAdd({ home, gateway: 'vendorx', key });

    const result = cmdAuthList({ home, gateways: ['vendorx'] });
    expect(result.text).toBe('vendorx: key from sonata');
    expect(result.text.includes(key)).toBe(false);
  });

  it('removes a key and lists no key', () => {
    cmdAuthAdd({ home, gateway: 'vendorx', key: 'secret-key-value' });
    cmdAuthRemove({ home, gateway: 'vendorx' });

    expect(cmdAuthList({ home, gateways: ['vendorx'] }).text).toBe('vendorx: no key');
  });

  it('never includes stored key values in list output', () => {
    const key = 'do-not-print-me';
    cmdAuthAdd({ home, gateway: 'gateway-a', key });

    const result = cmdAuthList({ home, gateways: ['gateway-a', 'gateway-b'] });
    expect(result.text.includes(key)).toBe(false);
    expect(result.text).toContain('gateway-a: key from sonata');
    expect(result.text).toContain('gateway-b: no key');
  });
});

describe('cmdAuthLogin', () => {
  it('refuses a gateway that is not in the config, by name', async () => {
    const home = mkdtempSync(join(tmpdir(), 'auth-login-'));
    const cwd = mkdtempSync(join(tmpdir(), 'auth-login-cwd-'));
    writeFileSync(join(cwd, 'sonata.toml'), `
[native]
[native.ports]
router = 4100
litellm = 4101
[native.gateways.codex]
auth = "codex-oauth"
`);
    await expect(cmdAuthLogin({ home, cwd, gateway: 'nope', out: () => {} }))
      .rejects.toThrow(/no native gateway "nope".*codex/s);
    rmSync(home, { force: true, recursive: true });
    rmSync(cwd, { force: true, recursive: true });
  });

  it('refuses an api-key gateway, naming `auth add` instead', async () => {
    const home = mkdtempSync(join(tmpdir(), 'auth-login-'));
    const cwd = mkdtempSync(join(tmpdir(), 'auth-login-cwd-'));
    writeFileSync(join(cwd, 'sonata.toml'), `
[native]
[native.ports]
router = 4100
litellm = 4101
[native.gateways.openrouter]
base_url = "https://openrouter.ai/api/v1"
`);
    await expect(cmdAuthLogin({ home, cwd, gateway: 'openrouter', out: () => {} }))
      .rejects.toThrow(/sonata auth add openrouter/);
    rmSync(home, { force: true, recursive: true });
    rmSync(cwd, { force: true, recursive: true });
  });

  it('streams the device block and reports success', async () => {
    const home = mkdtempSync(join(tmpdir(), 'auth-login-'));
    const cwd = mkdtempSync(join(tmpdir(), 'auth-login-cwd-'));
    writeFileSync(join(cwd, 'sonata.toml'), `
[native]
[native.ports]
router = 4100
litellm = 4101
[native.gateways.codex]
auth = "codex-oauth"
`);
    const lines: string[] = [];
    await cmdAuthLogin({
      home, cwd, gateway: 'codex', out: (l) => lines.push(l),
      interpreter: join(process.cwd(), 'tests/fixtures/litellm/fake-authenticator.mjs'),
    });
    expect(lines.join('\n')).toContain('Enter code: WDJB-MJHT');
    expect(lines.join('\n')).toMatch(/never share this code/i);
    expect(lines.join('\n')).toMatch(/credential_source = "sonata"/);
    rmSync(home, { force: true, recursive: true });
    rmSync(cwd, { force: true, recursive: true });
  });
});
