/**
 * Bridges a `codex login` credential into the shape LiteLLM's `chatgpt`
 * provider reads.
 *
 * Codex stores its ChatGPT OAuth tokens nested under `tokens`; LiteLLM expects
 * them flat, alongside an `expires_at` it would otherwise have to derive. The
 * two formats are otherwise the same credential, so this is a re-shaping, not a
 * copy of a secret into a new trust domain — the file is written 0600 into
 * serve's own temp directory and removed when serve stops.
 *
 * Nothing here logs a token. Callers that report health use `codexAuthReport`,
 * which carries no secret material.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The flat record LiteLLM's chatgpt Authenticator reads. */
export interface ChatGptAuthRecord {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_at?: number;
  account_id?: string;
}

export interface CodexAuthReport {
  present: boolean;
  /** Which harness's login supplied it. */
  source?: 'codex' | 'opencode';
  /** `chatgpt` for a subscription login, `apikey` when codex holds a real key. */
  mode?: string;
  expiresAt?: number;
  expired?: boolean;
  /** Set when the credential cannot be used, with the reason. */
  problem?: string;
}

export function codexAuthPath(home: string): string {
  return join(home, '.codex', 'auth.json');
}

export function opencodeAuthPath(home: string): string {
  return join(home, '.local', 'share', 'opencode', 'auth.json');
}

/**
 * The OAuth app both codex and opencode use for a ChatGPT login.
 *
 * Checked before treating an opencode `openai` entry as a ChatGPT credential:
 * that key could in principle hold some other OpenAI OAuth grant, and handing a
 * non-subscription token to the chatgpt provider would fail in the confusing
 * way this whole module exists to avoid.
 */
export const CHATGPT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

/** The `exp` claim of a JWT, without verifying the signature. */
export function jwtExpiry(token: string): number | undefined {
  const payload = token.split('.')[1];
  if (payload === undefined) return undefined;
  try {
    const padded = payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), '=');
    const claims: unknown = JSON.parse(Buffer.from(padded, 'base64url').toString('utf8'));
    if (claims === null || typeof claims !== 'object') return undefined;
    const exp = (claims as Record<string, unknown>).exp;
    return typeof exp === 'number' ? exp : undefined;
  } catch {
    return undefined;
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * The flattened credential, or null when codex is not logged in with a
 * subscription. A refresh token alone is enough for LiteLLM to mint a new
 * access token, so an expired access token is not fatal here.
 */
export function readCodexOAuth(home: string): ChatGptAuthRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(codexAuthPath(home), 'utf8'));
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object') return null;
  const tokens = (raw as Record<string, unknown>).tokens;
  if (tokens === null || typeof tokens !== 'object') return null;
  const t = tokens as Record<string, unknown>;

  const accessToken = str(t.access_token);
  if (accessToken === undefined) return null;

  return {
    access_token: accessToken,
    refresh_token: str(t.refresh_token),
    id_token: str(t.id_token),
    expires_at: jwtExpiry(accessToken),
    account_id: str(t.account_id),
  };
}

/** The `client_id` claim of a JWT, used to identify which OAuth app issued it. */
function jwtClientId(token: string): string | undefined {
  const payload = token.split('.')[1];
  if (payload === undefined) return undefined;
  try {
    const padded = payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), '=');
    const claims: unknown = JSON.parse(Buffer.from(padded, 'base64url').toString('utf8'));
    if (claims === null || typeof claims !== 'object') return undefined;
    const id = (claims as Record<string, unknown>).client_id;
    return typeof id === 'string' ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The ChatGPT credential opencode stores under `openai`.
 *
 * opencode writes `{type: "oauth", access, refresh, expires, accountId}` — the
 * same subscription credential codex holds, under different field names. It is
 * NOT an API key: `opencodeKeys` is right to skip it, because handing it to a
 * gateway as a bearer produces a 429 from the metered API after the token has
 * already authenticated.
 */
export function readOpencodeChatGptOAuth(home: string): ChatGptAuthRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(opencodeAuthPath(home), 'utf8'));
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object') return null;
  const entry = (raw as Record<string, unknown>).openai;
  if (entry === null || typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;
  if (e.type !== 'oauth') return null;

  const accessToken = str(e.access);
  if (accessToken === undefined) return null;
  if (jwtClientId(accessToken) !== CHATGPT_CLIENT_ID) return null;

  // opencode records `expires` in milliseconds; the JWT is authoritative.
  const expires = typeof e.expires === 'number' ? Math.floor(e.expires / 1000) : undefined;

  return {
    access_token: accessToken,
    refresh_token: str(e.refresh),
    expires_at: jwtExpiry(accessToken) ?? expires,
    account_id: str(e.accountId),
  };
}

/**
 * A ChatGPT credential from whichever harness has one.
 *
 * codex is preferred only because it is the harness the gateway is usually
 * named after; either file yields the same subscription.
 */
export function readChatGptOAuth(home: string): ChatGptAuthRecord | null {
  return readCodexOAuth(home) ?? readOpencodeChatGptOAuth(home);
}

/** Health information about the codex credential, carrying no secret material. */
export function codexAuthReport(home: string, now: number = Date.now()): CodexAuthReport {
  const fromCodex = readCodexOAuth(home);
  const record = fromCodex ?? readOpencodeChatGptOAuth(home);
  if (record === null) {
    return {
      present: false,
      problem: 'no ChatGPT login found in codex or opencode — run `codex login`',
    };
  }
  const source: 'codex' | 'opencode' = fromCodex === null ? 'opencode' : 'codex';

  let mode: string | undefined;
  if (source === 'codex') {
    try {
      const raw: unknown = JSON.parse(readFileSync(codexAuthPath(home), 'utf8'));
      mode = str((raw as Record<string, unknown>)?.auth_mode);
    } catch { /* the record parsed, so this is only the label */ }
  }

  const expired = record.expires_at !== undefined && now / 1000 >= record.expires_at;
  // LiteLLM refreshes on demand, so an expired access token with a refresh
  // token is healthy; without one it needs a fresh login.
  const problem = expired && record.refresh_token === undefined
    ? `token expired and no refresh token — run \`${source === 'codex' ? 'codex login' : 'opencode auth login'}\``
    : undefined;

  return { present: true, source, mode, expiresAt: record.expires_at, expired, problem };
}
