/**
 * Bridges opencode's GitHub Copilot login into LiteLLM's `github_copilot`
 * provider.
 *
 * opencode stores `{type: "oauth", access: "gho_…", refresh, expires}` under
 * `github-copilot`. That `gho_` value is a GitHub OAuth token, **not** a
 * Copilot API key: it has to be exchanged at
 * `api.github.com/copilot_internal/v2/token` for a short-lived key. LiteLLM's
 * provider performs that exchange and caches the result, reading the GitHub
 * token from a plain-text `access-token` file in `GITHUB_COPILOT_TOKEN_DIR`.
 *
 * So `opencodeKeys` is right to skip this entry — handing a `gho_` token to a
 * gateway as a bearer would fail. It just must not be invisible, which is what
 * this module fixes.
 *
 * Nothing here logs a token.
 */
import { readFileSync } from 'node:fs';

import { opencodeAuthPath } from './codex-auth.js';

export interface CopilotAuthReport {
  present: boolean;
  expiresAt?: number;
  expired?: boolean;
  problem?: string;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function copilotEntry(home: string): Record<string, unknown> | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(opencodeAuthPath(home), 'utf8'));
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object') return null;
  const entry = (raw as Record<string, unknown>)['github-copilot'];
  if (entry === null || typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;
  return e.type === 'oauth' ? e : null;
}

/**
 * The GitHub OAuth token opencode holds for Copilot, or null.
 *
 * This is the value LiteLLM writes into its `access-token` file; it is not
 * usable directly against any model endpoint.
 */
export function readCopilotToken(home: string): string | null {
  const entry = copilotEntry(home);
  if (entry === null) return null;
  return str(entry.access) ?? null;
}

/** The scope GitHub requires before it will mint a Copilot key. */
export const COPILOT_SCOPE = 'copilot';

/**
 * Whether the stored GitHub token may be exchanged for a Copilot key.
 *
 * It usually may not. opencode requests only `read:user`, so GitHub answers the
 * exchange with 403 and LiteLLM silently drops the deployment — the request
 * then fails as "no healthy deployments", naming neither the token nor the
 * scope. Checking first is what keeps a credential that cannot work from being
 * offered as if it could.
 *
 * Scopes are not in the token (it is opaque), so this asks GitHub, which
 * returns them in `x-oauth-scopes`. **Fails closed**: any error, timeout or
 * offline machine yields false, because "unknown" must not be treated as usable.
 */
export async function copilotTokenCanExchange(
  token: string,
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<boolean> {
  const doFetch = opts.fetch ?? fetch;
  try {
    const response = await doFetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
    });
    if (!response.ok) return false;
    const scopes = (response.headers.get('x-oauth-scopes') ?? '')
      .split(',')
      .map((scope) => scope.trim());
    return scopes.includes(COPILOT_SCOPE);
  } catch {
    return false;
  }
}

/** Health information, carrying no secret material. */
export function copilotAuthReport(home: string, now: number = Date.now()): CopilotAuthReport {
  const entry = copilotEntry(home);
  if (entry === null || str(entry.access) === undefined) {
    return {
      present: false,
      problem: 'no Copilot login in opencode — run `opencode auth login` and choose github-copilot',
    };
  }
  // opencode records `expires` in milliseconds, and writes 0 for the Copilot
  // entry to mean "does not expire" — reading that literally reported a live
  // token as expired since 1970.
  const expiresAt = typeof entry.expires === 'number' && entry.expires > 0
    ? Math.floor(entry.expires / 1000)
    : undefined;
  const expired = expiresAt !== undefined && now / 1000 >= expiresAt;

  // LiteLLM re-exchanges the GitHub token for a Copilot key on demand, and the
  // GitHub token itself is long-lived; an expired *Copilot* key is not a problem
  // the user has to act on. Only a missing token is.
  return { present: true, expiresAt, expired };
}
