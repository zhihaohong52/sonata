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
 * cannot be opened or queried (locked, mid-checkpoint) is unreadable. So is an
 * EMPTY table when the previous read in this process found rows: a login
 * vanishing between two reads is what a torn read looks like, while a real
 * logout of the last row reads empty again next time and is then believed.
 * `memory.rows` carries that previous count; pass the same object each call.
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
  const db = openReadOnlySync(path);
  if (db === undefined) return { state: 'unreadable', detail: `${path}: could not be opened` };
  try {
    const rows = Number(db.all('SELECT COUNT(*) AS n FROM credential')[0]?.n ?? 0);
    const previous = memory.rows;
    memory.rows = rows;
    if (rows === 0 && previous !== undefined && previous > 0) {
      return { state: 'unreadable', detail: `${path}: the credential table read empty` };
    }
    return { state: 'ok' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no such table/i.test(message)) {
      memory.rows = 0;
      return { state: 'ok' };
    }
    return { state: 'unreadable', detail: `${path}: ${message}` };
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}
