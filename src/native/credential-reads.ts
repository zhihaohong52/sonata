/**
 * Whether a credential store answered this read, as distinct from what it
 * answered.
 *
 * Every credential reader in sonata folds "the file is not there", "the file
 * holds no login" and "the file could not be read just now" into one null,
 * which is right for a command run once and wrong for a daemon reading on every
 * re-merge: codex rewrites `auth.json` by truncating and writing, so a request
 * can land on half a file, and reading that as "logged out" dropped the gateway
 * and restarted LiteLLM twice per write. `sonata serve` asks this module which
 * of the stores a gateway consulted gave a real answer, so that only a store
 * positively holding nothing takes a gateway away.
 *
 * Reads only; nothing here logs a value, and a detail names a path and an
 * error code, never content.
 */
import { readFileSync, statSync } from 'node:fs';

import { opencodeDbPath } from './opencode-store.js';
import { openReadOnlySync, sqliteAvailable } from '../sqlite.js';

/**
 * `ok` — read and parsed. `absent` — positively nothing there (ENOENT, or a
 * store sonata steadily cannot read at all). `unreadable` — anything else: a
 * parse error (a write in progress), EACCES, EMFILE, a locked database.
 */
export type StoreReadState = 'ok' | 'absent' | 'unreadable';

export interface StoreRead {
  state: StoreReadState;
  /** For `unreadable`: which store, and why, with no content. */
  detail?: string;
}

function errnoCode(error: unknown): string {
  return (error as NodeJS.ErrnoException)?.code ?? (error instanceof Error ? error.message : String(error));
}

const ABSENT_CODES = new Set(['ENOENT', 'ENOTDIR']);

/** A JSON credential file: codex's or opencode's `auth.json`, sonata's `keys.json`. */
export function jsonStoreRead(path: string): StoreRead {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const code = errnoCode(error);
    return ABSENT_CODES.has(code) ? { state: 'absent' } : { state: 'unreadable', detail: `${path}: ${code}` };
  }
  try {
    JSON.parse(text);
  } catch {
    return { state: 'unreadable', detail: `${path}: not valid JSON (a write in progress?)` };
  }
  return { state: 'ok' };
}

/** A file whose presence is the credential: sonata's own OAuth logins. */
export function fileStoreRead(path: string): StoreRead {
  try {
    statSync(path);
    return { state: 'ok' };
  } catch (error) {
    const code = errnoCode(error);
    return ABSENT_CODES.has(code) ? { state: 'absent' } : { state: 'unreadable', detail: `${path}: ${code}` };
  }
}

/**
 * opencode.db's `credential` table.
 *
 * A database that is not there, or one `node:sqlite` cannot load on this Node,
 * answers the same "no rows" every time, and one with no `credential` table is
 * a v1 database that holds none — all steady answers. One that exists and
 * cannot be opened or queried (locked, mid-checkpoint) is unreadable.
 *
 * An EMPTY table when the previous read in this process found rows is read a
 * second time, on a fresh connection, before anything is concluded: a login
 * vanishing between two reads is what a torn read looks like, but deferring
 * the verdict to the next request — as this once did — served that request
 * on the credential just logged out. Empty twice is a logout and is `ok`;
 * rows on the second read make the first one `unreadable`. `memory.rows`
 * carries the previous count; pass the same object each call.
 */
export function opencodeDbRead(
  home: string,
  memory: { rows?: number } = {},
  env: NodeJS.ProcessEnv = process.env,
): StoreRead {
  const path = opencodeDbPath(home, env);
  const present = fileStoreRead(path);
  if (present.state !== 'ok') return present;
  if (!sqliteAvailable()) return { state: 'absent' };
  const first = countCredentialRows(path);
  if (first.rows === undefined) {
    if (!first.missingTable) return { state: 'unreadable', detail: first.detail };
    memory.rows = 0;
    return { state: 'ok' };
  }
  const previous = memory.rows;
  if (first.rows === 0 && previous !== undefined && previous > 0) {
    const again = countCredentialRows(path);
    if (again.rows === undefined && !again.missingTable) return { state: 'unreadable', detail: again.detail };
    const rows = again.rows ?? 0;
    memory.rows = rows;
    return rows === 0 ? { state: 'ok' } : { state: 'unreadable', detail: `${path}: the credential table read empty` };
  }
  memory.rows = first.rows;
  return { state: 'ok' };
}

/** One count of opencode.db's credential rows, on its own read-only connection. */
function countCredentialRows(path: string): { rows?: number; missingTable?: true; detail?: string } {
  const db = openReadOnlySync(path);
  if (db === undefined) return { detail: `${path}: could not be opened` };
  try {
    return { rows: Number(db.all('SELECT COUNT(*) AS n FROM credential')[0]?.n ?? 0) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no such table/i.test(message)) return { missingTable: true };
    return { detail: `${path}: ${message}` };
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}
