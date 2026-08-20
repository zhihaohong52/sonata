import { describe, expect, it, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { codexAuthPath, codexAuthReport, jwtExpiry, readCodexOAuth, readOpencodeChatGptOAuth, readChatGptOAuth } from '../../src/native/codex-auth.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'codex-auth-'));
});

/** A JWT whose payload carries `exp`; the signature is never verified. */
function jwt(exp: number): string {
  return `header.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.sig`;
}

function writeAuth(raw: unknown): void {
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(join(home, '.codex', 'auth.json'), JSON.stringify(raw));
}

describe('jwtExpiry', () => {
  it('reads the exp claim without verifying the signature', () => {
    expect(jwtExpiry(jwt(1787806005))).toBe(1787806005);
  });

  it('returns undefined for a malformed token rather than throwing', () => {
    expect(jwtExpiry('not-a-jwt')).toBeUndefined();
    expect(jwtExpiry('a.!!!!.c')).toBeUndefined();
    expect(jwtExpiry('')).toBeUndefined();
  });

  it('returns undefined when exp is absent or not a number', () => {
    const noExp = `h.${Buffer.from(JSON.stringify({ sub: 'x' })).toString('base64url')}.s`;
    expect(jwtExpiry(noExp)).toBeUndefined();
  });
});

describe('readCodexOAuth', () => {
  it('flattens codex nested tokens into the shape LiteLLM reads', () => {
    const exp = 1787806005;
    writeAuth({
      auth_mode: 'chatgpt',
      tokens: {
        access_token: jwt(exp), refresh_token: 'rt.1.abc',
        id_token: 'id.tok', account_id: 'acct-42',
      },
    });

    expect(readCodexOAuth(home)).toEqual({
      access_token: jwt(exp),
      refresh_token: 'rt.1.abc',
      id_token: 'id.tok',
      expires_at: exp,
      account_id: 'acct-42',
    });
  });

  it('returns null when codex is not logged in', () => {
    expect(readCodexOAuth(home)).toBeNull();
  });

  it('returns null for an api-key login, which carries no ChatGPT tokens', () => {
    // `codex login --api-key` leaves OPENAI_API_KEY set and `tokens` absent.
    writeAuth({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-real-key' });
    expect(readCodexOAuth(home)).toBeNull();
  });

  it('tolerates a malformed auth file', () => {
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex', 'auth.json'), 'not json at all');
    expect(readCodexOAuth(home)).toBeNull();
  });

  it('treats a blank access token as absent', () => {
    writeAuth({ tokens: { access_token: '   ' } });
    expect(readCodexOAuth(home)).toBeNull();
  });
});

describe('codexAuthReport', () => {
  const NOW = 1_700_000_000_000; // ms

  it('reports a healthy unexpired credential and never carries the token', () => {
    const exp = Math.floor(NOW / 1000) + 3600;
    writeAuth({ auth_mode: 'chatgpt', tokens: { access_token: jwt(exp), refresh_token: 'rt.1' } });

    const report = codexAuthReport(home, NOW);
    expect(report.present).toBe(true);
    expect(report.mode).toBe('chatgpt');
    expect(report.expired).toBe(false);
    expect(report.problem).toBeUndefined();
    expect(JSON.stringify(report)).not.toContain('rt.1');
  });

  it('is still healthy when expired but holding a refresh token', () => {
    // LiteLLM refreshes on demand, so this needs no user action.
    const exp = Math.floor(NOW / 1000) - 10;
    writeAuth({ auth_mode: 'chatgpt', tokens: { access_token: jwt(exp), refresh_token: 'rt.1' } });

    const report = codexAuthReport(home, NOW);
    expect(report.expired).toBe(true);
    expect(report.problem).toBeUndefined();
  });

  it('reports a problem when expired with no refresh token', () => {
    const exp = Math.floor(NOW / 1000) - 10;
    writeAuth({ auth_mode: 'chatgpt', tokens: { access_token: jwt(exp) } });

    expect(codexAuthReport(home, NOW).problem).toMatch(/codex login/);
  });

  it('reports not-logged-in with the fix when the file is missing', () => {
    const report = codexAuthReport(home, NOW);
    expect(report.present).toBe(false);
    expect(report.problem).toMatch(/codex login/);
  });

  it('names the auth file path it reads', () => {
    expect(codexAuthPath('/h')).toBe(join('/h', '.codex', 'auth.json'));
  });
});

/** A JWT carrying both exp and client_id, as the real ChatGPT tokens do. */
function chatgptJwt(exp: number, clientId = 'app_EMoamEEZ73f0CkXaXp7hrann'): string {
  const body = Buffer.from(JSON.stringify({ exp, client_id: clientId })).toString('base64url');
  return `header.${body}.sig`;
}

function writeOpencodeAuth(home: string, entries: Record<string, unknown>): void {
  mkdirSync(join(home, '.local', 'share', 'opencode'), { recursive: true });
  writeFileSync(join(home, '.local', 'share', 'opencode', 'auth.json'), JSON.stringify(entries));
}

describe('readOpencodeChatGptOAuth', () => {
  const exp = 1787806005;

  it('flattens opencode field names into the LiteLLM record', () => {
    // opencode calls them access/refresh/accountId; codex nests them under tokens.
    writeOpencodeAuth(home, {
      openai: {
        type: 'oauth', access: chatgptJwt(exp), refresh: 'rt-oc',
        expires: (exp + 60) * 1000, accountId: 'acct-oc',
      },
    });
    expect(readOpencodeChatGptOAuth(home)).toEqual({
      access_token: chatgptJwt(exp),
      refresh_token: 'rt-oc',
      expires_at: exp,
      account_id: 'acct-oc',
    });
  });

  it('ignores an api-key entry, which is not an oauth credential', () => {
    writeOpencodeAuth(home, { openai: { type: 'api', key: 'sk-real' } });
    expect(readOpencodeChatGptOAuth(home)).toBeNull();
  });

  it('refuses a token from a different OAuth app', () => {
    // Only the codex/opencode ChatGPT app's tokens work with LiteLLM's chatgpt
    // provider; another OpenAI grant would fail confusingly downstream.
    writeOpencodeAuth(home, {
      openai: { type: 'oauth', access: chatgptJwt(exp, 'app_somethingelse') },
    });
    expect(readOpencodeChatGptOAuth(home)).toBeNull();
  });

  it('returns null when opencode has no openai entry', () => {
    writeOpencodeAuth(home, { vendorx: { type: 'api', key: 'k' } });
    expect(readOpencodeChatGptOAuth(home)).toBeNull();
  });
});

describe('readChatGptOAuth', () => {
  const exp = 1787806005;

  it('prefers codex when both harnesses hold a login', () => {
    writeAuth({ auth_mode: 'chatgpt', tokens: { access_token: jwt(exp), refresh_token: 'rt-codex' } });
    writeOpencodeAuth(home, { openai: { type: 'oauth', access: chatgptJwt(exp), refresh: 'rt-oc' } });
    expect(readChatGptOAuth(home)?.refresh_token).toBe('rt-codex');
  });

  it('falls back to opencode when codex is not logged in', () => {
    writeOpencodeAuth(home, { openai: { type: 'oauth', access: chatgptJwt(exp), refresh: 'rt-oc' } });
    expect(readChatGptOAuth(home)?.refresh_token).toBe('rt-oc');
  });

  it('returns null when neither has one', () => {
    expect(readChatGptOAuth(home)).toBeNull();
  });
});

describe('codexAuthReport — source', () => {
  const NOW = 1_700_000_000_000;

  it('names opencode when that is where the login came from', () => {
    const exp = Math.floor(NOW / 1000) + 3600;
    writeOpencodeAuth(home, { openai: { type: 'oauth', access: chatgptJwt(exp), refresh: 'rt' } });
    const report = codexAuthReport(home, NOW);
    expect(report.present).toBe(true);
    expect(report.source).toBe('opencode');
    expect(report.problem).toBeUndefined();
  });

  it('mentions both harnesses when neither has a login', () => {
    expect(codexAuthReport(home, NOW).problem).toMatch(/codex or opencode/);
  });
});
