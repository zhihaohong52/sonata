import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdAuthAdd, cmdAuthList, cmdAuthLogin, cmdAuthRemove, cmdAuthTrust, cmdAuthTrustList, cmdAuthUntrust, unboundConfigUrlNotice } from '../../src/commands/auth.js';
import { writeSonataKey } from '../../src/native/credentials.js';
import { readTrustBindings, unboundMessage } from '../../src/native/host-bindings.js';

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
    cmdAuthAdd({ home, gateway: 'acme', key });

    const result = cmdAuthList({ home, gateways: ['acme'] });
    expect(result.text).toBe('acme: key from sonata');
    expect(result.text.includes(key)).toBe(false);
  });

  it('removes a key and lists no key', () => {
    cmdAuthAdd({ home, gateway: 'acme', key: 'secret-key-value' });
    cmdAuthRemove({ home, gateway: 'acme' });

    expect(cmdAuthList({ home, gateways: ['acme'] }).text).toBe('acme: no key');
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

const yes = { interactive: true, ask: async () => 'y' } as const;
const trust = (gateway: string, host: string, extra: Partial<Parameters<typeof cmdAuthTrust>[0]> = {}) =>
  cmdAuthTrust({ home, gateway, host, ...yes, ...extra });

describe('auth trust', () => {
  it('trusts a host, lists it, and untrusts it again', async () => {
    expect((await trust('acme', 'proxy.example')).text).toContain('proxy.example');
    expect(readTrustBindings(home)).toEqual({ acme: ['proxy.example'] });
    expect(cmdAuthTrustList({ home, gateways: ['acme', 'other'] }).text).toBe(
      'acme: proxy.example\nother: no trusted hosts',
    );
    expect(cmdAuthUntrust({ home, gateway: 'acme', host: 'proxy.example' }).text).toContain('no longer');
    expect(readTrustBindings(home)).toEqual({});
  });

  it('trusting twice is idempotent, and names are lowercased', async () => {
    await trust('acme', 'Proxy.Example');
    await trust('acme', 'proxy.example');
    expect(readTrustBindings(home)).toEqual({ acme: ['proxy.example'] });
  });

  it('refuses a non-https host and an untrust with nothing stored', async () => {
    await expect(trust('acme', 'http://proxy.example/')).rejects.toThrow(/only https/);
    expect(() => cmdAuthUntrust({ home, gateway: 'acme', host: 'proxy.example' })).toThrow(/no trusted host/);
  });

  it('refuses without a terminal, and writes nothing', async () => {
    await expect(trust('acme', 'proxy.example', { interactive: false })).rejects.toThrow(/interactive terminal/);
    expect(readTrustBindings(home)).toEqual({});
  });

  it('shows gateway, host and where the key goes, and needs y or yes: anything else changes nothing', async () => {
    let question = '';
    await trust('acme', 'proxy.example', { ask: async (q) => { question = q; return 'yes'; } });
    expect(question).toContain('"acme"');
    expect(question).toContain('https://proxy.example');
    expect(readTrustBindings(home)).toEqual({ acme: ['proxy.example'] });
    for (const answer of ['', 'n', 'no', 'maybe']) {
      await expect(trust('acme', 'other.example', { ask: async () => answer })).rejects.toThrow(/not confirmed/);
    }
    expect(readTrustBindings(home)).toEqual({ acme: ['proxy.example'] });
  });

  it('refuses a host whose configured URL is plain http off loopback, and says https-only otherwise', async () => {
    await expect(trust('lan', '192.168.1.5:8000', { baseUrl: 'http://192.168.1.5:8000/v1' })).rejects.toThrow(/plain-http/);
    await expect(trust('ollama', 'ollama_server:11434', { baseUrl: 'http://ollama_server:11434/v1' })).rejects.toThrow(/https/);
    expect(readTrustBindings(home)).toEqual({});
    expect((await trust('acme', 'proxy.example', { baseUrl: 'https://proxy.example/v1' })).text).toContain('https only');
    expect((await trust('local', 'localhost:4000', { baseUrl: 'http://localhost:4000/v1' })).text).not.toContain('https only');
  });

  it('runs the upgrade seed first, so trusting one host first does not lose the others', async () => {
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(join(home, '.config', 'sonata', 'sonata.toml'), `
[native.gateways.old]
base_url = "https://old.example/v1"
`);
    writeSonataKey(home, 'old', 'sk-old');
    await trust('acme', 'proxy.example');
    expect(readTrustBindings(home)).toEqual({ acme: ['proxy.example'], old: ['old.example'] });
  });

  it('untrust also seeds first', () => {
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(join(home, '.config', 'sonata', 'sonata.toml'), `
[native.gateways.old]
base_url = "https://old.example/v1"
`);
    writeSonataKey(home, 'old', 'sk-old');
    expect(() => cmdAuthUntrust({ home, gateway: 'acme', host: 'proxy.example' })).toThrow(/no trusted host/);
    expect(readTrustBindings(home)).toEqual({ old: ['old.example'] });
  });

  it('auth add binds nothing, even with a project config naming a host', () => {
    // A cloned repo's config must never bind its host to the user's key.
    const cwd = mkdtempSync(join(tmpdir(), 'auth-add-repo-'));
    writeFileSync(join(cwd, 'sonata.toml'), `
[native.gateways.acme]
base_url = "https://proxy.example/v1"
`);
    cmdAuthAdd({ home, gateway: 'acme', key: 'k' });
    expect(readTrustBindings(home)).toEqual({});
    const notice = unboundConfigUrlNotice(home, cwd, 'acme');
    expect(notice).toBe(unboundMessage('acme', 'proxy.example', join(cwd, 'sonata.toml')));
    expect(notice).toContain('sonata auth trust acme proxy.example');
    expect(notice).toContain('do not trust it');
  });

  it('says nothing when the gateway URL is bound, or no config names it', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'auth-add-bound-'));
    writeFileSync(join(cwd, 'sonata.toml'), `
[native.gateways.openrouter]
base_url = "https://openrouter.ai/api/v1"
`);
    expect(unboundConfigUrlNotice(home, cwd, 'openrouter')).toBeUndefined();
    expect(unboundConfigUrlNotice(home, cwd, 'absent')).toBeUndefined();
    expect(unboundConfigUrlNotice(home, mkdtempSync(join(tmpdir(), 'auth-add-none-')), 'acme')).toBeUndefined();
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
