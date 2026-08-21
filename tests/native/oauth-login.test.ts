import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { credentialDir, loginGateway } from '../../src/native/oauth-login.js';

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

  it('fails with install guidance when litellm is absent', async () => {
    const result = await loginGateway({
      home, gateway: 'codex', auth: 'codex-oauth', progress, interpreter: '/nonexistent/python',
    });
    expect(result.ok).toBe(false);
    expect(result.problem).toMatch(/litellm/i);
  });
});
