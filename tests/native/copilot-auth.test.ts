import { describe, expect, it, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { copilotAuthReport, readCopilotToken, copilotTokenCanExchange } from '../../src/native/copilot-auth.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'copilot-auth-'));
});

function writeOpencodeAuth(entries: Record<string, unknown>): void {
  mkdirSync(join(home, '.local', 'share', 'opencode'), { recursive: true });
  writeFileSync(join(home, '.local', 'share', 'opencode', 'auth.json'), JSON.stringify(entries));
}

describe('readCopilotToken', () => {
  it('returns the GitHub token opencode holds', () => {
    // This `gho_` value is a GitHub OAuth token, not a Copilot API key —
    // LiteLLM exchanges it at copilot_internal/v2/token.
    writeOpencodeAuth({ 'github-copilot': { type: 'oauth', access: 'gho_abc123', refresh: 'r' } });
    expect(readCopilotToken(home)).toBe('gho_abc123');
  });

  it('returns null when opencode has no copilot login', () => {
    writeOpencodeAuth({ anexto: { type: 'api', key: 'k' } });
    expect(readCopilotToken(home)).toBeNull();
  });

  it('ignores a non-oauth entry', () => {
    writeOpencodeAuth({ 'github-copilot': { type: 'api', key: 'sk-x' } });
    expect(readCopilotToken(home)).toBeNull();
  });

  it('tolerates a missing or malformed auth file', () => {
    expect(readCopilotToken(home)).toBeNull();
    mkdirSync(join(home, '.local', 'share', 'opencode'), { recursive: true });
    writeFileSync(join(home, '.local', 'share', 'opencode', 'auth.json'), 'nope');
    expect(readCopilotToken(home)).toBeNull();
  });
});

describe('copilotAuthReport', () => {
  const NOW = 1_700_000_000_000;

  it('reports a present login without carrying the token', () => {
    writeOpencodeAuth({
      'github-copilot': { type: 'oauth', access: 'gho_secret', expires: NOW + 3_600_000 },
    });
    const report = copilotAuthReport(home, NOW);
    expect(report.present).toBe(true);
    expect(report.problem).toBeUndefined();
    expect(JSON.stringify(report)).not.toContain('gho_secret');
  });

  it('does not flag an expired Copilot key as a problem', () => {
    // The GitHub token is long-lived and LiteLLM re-exchanges on demand, so
    // this needs no action from the user.
    writeOpencodeAuth({
      'github-copilot': { type: 'oauth', access: 'gho_x', expires: NOW - 1000 },
    });
    const report = copilotAuthReport(home, NOW);
    expect(report.expired).toBe(true);
    expect(report.problem).toBeUndefined();
  });

  it('names the fix when there is no login', () => {
    expect(copilotAuthReport(home, NOW).problem).toMatch(/opencode auth login/);
  });
});

describe('copilotAuthReport — opencode writes expires: 0', () => {
  const NOW = 1_700_000_000_000;

  it('treats expires: 0 as no expiry, not as expired since 1970', () => {
    // Observed in a real ~/.local/share/opencode/auth.json: the github-copilot
    // entry carries expires: 0. Reading it literally reported a working token
    // as expired.
    writeOpencodeAuth({ 'github-copilot': { type: 'oauth', access: 'gho_x', expires: 0 } });
    const report = copilotAuthReport(home, NOW);
    expect(report.expiresAt).toBeUndefined();
    expect(report.expired).toBe(false);
    expect(report.problem).toBeUndefined();
  });
});

describe('copilotTokenCanExchange', () => {
  const headers = (scopes: string) => new Headers({ 'x-oauth-scopes': scopes });

  it('accepts a token whose scopes include copilot', async () => {
    const fake = async () => new Response('{}', { status: 200, headers: headers('read:user, copilot') });
    expect(await copilotTokenCanExchange('gho_x', { fetch: fake })).toBe(true);
  });

  it('rejects the read:user-only token opencode actually stores', async () => {
    // Observed on a real machine. GitHub then answers the Copilot exchange with
    // 403 and LiteLLM drops the deployment, so the model must not be offered.
    const fake = async () => new Response('{}', { status: 200, headers: headers('read:user') });
    expect(await copilotTokenCanExchange('gho_x', { fetch: fake })).toBe(false);
  });

  it('fails closed on a network error, a timeout, or a non-200', async () => {
    const boom = async () => { throw new Error('offline'); };
    expect(await copilotTokenCanExchange('gho_x', { fetch: boom })).toBe(false);
    const unauthorized = async () => new Response('', { status: 401 });
    expect(await copilotTokenCanExchange('gho_x', { fetch: unauthorized })).toBe(false);
  });

  it('fails closed when the scope header is absent', async () => {
    const fake = async () => new Response('{}', { status: 200 });
    expect(await copilotTokenCanExchange('gho_x', { fetch: fake })).toBe(false);
  });

  it('does not mistake a scope that merely contains the word', async () => {
    const fake = async () => new Response('{}', { status: 200, headers: headers('copilot-editor') });
    expect(await copilotTokenCanExchange('gho_x', { fetch: fake })).toBe(false);
  });
});
