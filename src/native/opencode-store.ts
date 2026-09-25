/**
 * The one reader of opencode's provider credentials, in both of the places
 * opencode keeps them.
 *
 * v1 writes `auth.json`; v2 writes the `credential` table of `opencode.db` and
 * **does not migrate** — the two coexist, so a machine can hold a live login in
 * either or both. Precedence per integration: the table row wins, `auth.json`
 * is the fallback. What this module returns is normalized to ONE shape so no
 * caller cares which store answered.
 *
 * The db is opened read-only (`src/sqlite.ts`) and asked one query over a small
 * table; the real file is gigabytes and opencode holds it open, so nothing here
 * writes, migrates, or prunes. Malformed rows are skipped, never thrown.
 * Nothing here logs a value — the stores hold live secrets in plaintext.
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { openReadOnlySync } from '../sqlite.js';

export interface OpencodeCredential {
  /**
   * `api` for a bearer key, `oauth` for a login. The two stores disagree on the
   * spelling of the first — auth.json says `type: "api"`, the table says
   * `type: "key"` — and this is the one shape callers see.
   */
  type: 'api' | 'oauth';
  /** A bearer key (`type: 'api'`). */
  key?: string;
  /** An OAuth access token (`type: 'oauth'`). */
  access?: string;
  refresh?: string;
  /** Absolute epoch **milliseconds**; `0` means never expires. */
  expires?: number;
  accountId?: string;
  /** Which store the winning entry came from. */
  origin: 'auth.json' | 'opencode.db';
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Where opencode keeps its data, which is where `auth.json` lives and beside
 * which the db sits. This is deliberately the same path every other opencode
 * reader in sonata uses — one definition of "the opencode data dir", so the two
 * stores can never drift apart.
 */
export function opencodeDataDir(home: string): string {
  return join(home, '.local', 'share', 'opencode');
}

/**
 * The db to read: `OPENCODE_DB` when set (absolute as-is, relative under the
 * data dir), else `<data dir>/opencode.db`. Channel-specific
 * `opencode-<channel>.db` files are never consulted.
 */
export function opencodeDbPath(home: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPENCODE_DB;
  const dataDir = opencodeDataDir(home);
  if (override !== undefined && override.trim() !== '') {
    return isAbsolute(override) ? override : join(dataDir, override);
  }
  return join(dataDir, 'opencode.db');
}

type ParsedCredential = Omit<OpencodeCredential, 'origin'>;

/**
 * One `auth.json` entry. A usable key wins first, exactly as `opencodeKeys`
 * has always read these — an oauth entry carries `access`, not `key`, so the
 * shapes never collide.
 */
function parseAuthJsonEntry(raw: unknown): ParsedCredential | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const entry = raw as Record<string, unknown>;
  const key = str(entry.key) ?? str(entry.apiKey);
  if (key !== undefined) return { type: 'api', key };
  if (entry.type === 'oauth') {
    const access = str(entry.access);
    if (access === undefined) return undefined;
    return {
      type: 'oauth',
      access,
      refresh: str(entry.refresh),
      expires: num(entry.expires),
      accountId: str(entry.accountId),
    };
  }
  return undefined;
}

/** One `credential` table row's `value` column — plaintext JSON. */
function parseTableValue(raw: unknown): ParsedCredential | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const entry = raw as Record<string, unknown>;
  if (entry.type === 'key') {
    const key = str(entry.key);
    return key === undefined ? undefined : { type: 'api', key };
  }
  if (entry.type === 'oauth') {
    const access = str(entry.access);
    if (access === undefined) return undefined;
    return {
      type: 'oauth',
      access,
      refresh: str(entry.refresh),
      expires: num(entry.expires),
      // auth.json records the account on the entry itself; the table row's
      // `metadata` shape is opencode's private business, so only the same flat
      // field is read — a guess at a metadata spelling would invent data.
      accountId: str(entry.accountId),
    };
  }
  return undefined;
}

function readCredentialTable(dbPath: string): Map<string, ParsedCredential> {
  const rows = new Map<string, { timeCreated: number; credential: ParsedCredential }>();
  const db = openReadOnlySync(dbPath);
  if (db === undefined) return new Map();
  try {
    for (const row of db.all('SELECT integration_id, value, time_created FROM credential')) {
      const integration = str(row.integration_id);
      if (integration === undefined) continue;
      let value: unknown;
      try {
        value = JSON.parse(String(row.value));
      } catch {
        continue; // one malformed row must not cost the rest
      }
      const credential = parseTableValue(value);
      if (credential === undefined) continue;
      // At most one row per integration is normal; several mean a re-login,
      // and the newest is the live one. Ties keep the first row read.
      const timeCreated = num(row.time_created) ?? 0;
      const existing = rows.get(integration);
      if (existing !== undefined && existing.timeCreated >= timeCreated) continue;
      rows.set(integration, { timeCreated, credential });
    }
  } catch {
    // No `credential` table (a v1 db), a locked file, or a statement that
    // cannot run — all the same answer as "no rows", never a throw.
  } finally {
    db.close();
  }
  return new Map([...rows].map(([integration, row]) => [integration, row.credential]));
}

/**
 * Every provider credential opencode holds, keyed by the same integration ids
 * `auth.json` uses (`openai`, `github-copilot`, `anthropic`, …), with the
 * table row winning over `auth.json` per integration. Entries that carry no
 * usable credential are dropped rather than reported as logins.
 */
export function readOpencodeCredentials(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, OpencodeCredential> {
  const out: Record<string, OpencodeCredential> = {};

  try {
    const raw: unknown = JSON.parse(readFileSync(join(opencodeDataDir(home), 'auth.json'), 'utf8'));
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [integration, value] of Object.entries(raw)) {
        const parsed = parseAuthJsonEntry(value);
        if (parsed !== undefined) out[integration] = { ...parsed, origin: 'auth.json' };
      }
    }
  } catch {
    // Missing or malformed — the same as no credentials there.
  }

  for (const [integration, parsed] of readCredentialTable(opencodeDbPath(home, env))) {
    out[integration] = { ...parsed, origin: 'opencode.db' };
  }

  return out;
}

/** Which store won for one integration, or undefined when neither holds one. */
export function opencodeCredentialOrigin(
  home: string,
  integrationId: string,
  env: NodeJS.ProcessEnv = process.env,
): 'auth.json' | 'opencode.db' | undefined {
  return readOpencodeCredentials(home, env)[integrationId]?.origin;
}
