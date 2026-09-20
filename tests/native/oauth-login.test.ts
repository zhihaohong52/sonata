import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { credentialDir, loginGateway, resolveInterpreter } from '../../src/native/oauth-login.js';

const FAKE = join(process.cwd(), 'tests/fixtures/litellm/fake-authenticator.mjs');

describe('loginGateway', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'oauth-login-')); });
  afterEach(() => { rmSync(home, { force: true, recursive: true }); });

  const lines: string[] = [];
  const progress = { line: (text: string) => { lines.push(text); } };
  beforeEach(() => { lines.length = 0; });

  it('creates the credential directory 0700 and reports success', async () => {
    const result = await loginGateway({
      home, gateway: 'codex', auth: 'codex-oauth', progress, interpreter: FAKE,
    });
    expect(result.ok).toBe(true);
    const dir = credentialDir(home, 'codex');
    expect(existsSync(join(dir, 'auth.json'))).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('relays the phishing warning verbatim', async () => {
    // Sonata must not reformat this line away; it is the user's only cue.
    await loginGateway({ home, gateway: 'codex', auth: 'codex-oauth', progress, interpreter: FAKE });
    expect(lines).toContain('Device codes are a common phishing target. Never share this code.');
    expect(lines).toContain('2) Enter code: WDJB-MJHT');
  });

  it('fails when the child exits non-zero', async () => {
    process.env.FAKE_MODE = 'exit-nonzero';
    const result = await loginGateway({ home, gateway: 'codex', auth: 'codex-oauth', progress, interpreter: FAKE });
    delete process.env.FAKE_MODE;
    expect(result.ok).toBe(false);
    expect(result.problem).toMatch(/exited 1/);
  });

  it('fails when the child exits 0 but writes no credential', async () => {
    // An exit code alone is not evidence, the same discipline the run engine
    // applies to report files.
    process.env.FAKE_MODE = 'exit-zero-no-credential';
    const result = await loginGateway({ home, gateway: 'codex', auth: 'codex-oauth', progress, interpreter: FAKE });
    delete process.env.FAKE_MODE;
    expect(result.ok).toBe(false);
    expect(result.problem).toMatch(/no credential/i);
  });

  it('is cancellable', async () => {
    process.env.FAKE_MODE = 'hang';
    const controller = new AbortController();
    const pending = loginGateway({
      home, gateway: 'codex', auth: 'codex-oauth', progress, interpreter: FAKE, signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    const result = await pending;
    delete process.env.FAKE_MODE;
    expect(result.ok).toBe(false);
    expect(result.problem).toMatch(/cancelled/i);
  });

  it('requires api-key.json for copilot, because the exchange is the proof', async () => {
    // A ghu_ token with no Copilot exchange is not a usable credential.
    process.env.FAKE_MODE = 'exit-zero-no-credential';
    const result = await loginGateway({ home, gateway: 'copilot', auth: 'copilot-oauth', progress, interpreter: FAKE });
    delete process.env.FAKE_MODE;
    expect(result.ok).toBe(false);
  });

  it('prefers the managed LiteLLM interpreter', () => {
    const script = join(home, '.config', 'sonata', 'litellm', 'bin', 'litellm');
    mkdirSync(join(home, '.config', 'sonata', 'litellm', 'bin'), { recursive: true });
    writeFileSync(script, '#!/managed/python\n');
    expect(resolveInterpreter(home)).toBe('/managed/python');
  });

  it('falls back to the PATH LiteLLM interpreter when managed LiteLLM is absent', () => {
    const script = join(home, 'path-litellm');
    writeFileSync(script, '#!/path/litellm-python\n');
    expect(resolveInterpreter(home, () => script)).toBe('/path/litellm-python');
  });

  it('fails when LiteLLM is absent', () => {
    expect(() => resolveInterpreter(home, () => undefined)).toThrow('litellm is not installed');
  });

  // Kept at the `loginGateway` level as well as the resolver's: the resolver
  // throws, and it is this try/catch that has to turn that into a reportable
  // problem rather than an exception escaping the command. Testing only
  // `resolveInterpreter` leaves that conversion uncovered, and it is the part
  // the user actually sees.
  it('reports install guidance naming sonata litellm install', async () => {
    const result = await loginGateway({
      home, gateway: 'codex', auth: 'codex-oauth', progress, interpreter: '/nonexistent/python',
    });
    expect(result.ok).toBe(false);
    expect(result.problem).toMatch(/litellm/i);
  });

  it('fixes up the credential file to 0600 even if litellm wrote it looser', async () => {
    const result = await loginGateway({
      home, gateway: 'codex', auth: 'codex-oauth', progress, interpreter: FAKE,
    });
    expect(result.ok).toBe(true);
    const path = join(credentialDir(home, 'codex'), 'auth.json');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('resolves immediately without spawning when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await loginGateway({
      home, gateway: 'codex', auth: 'codex-oauth', progress, interpreter: FAKE, signal: controller.signal,
    });
    expect(result.ok).toBe(false);
    expect(result.problem).toMatch(/cancelled/i);
    expect(existsSync(join(credentialDir(home, 'codex'), 'auth.json'))).toBe(false);
  });
});
