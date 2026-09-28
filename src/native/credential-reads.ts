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
import { createHash } from 'node:crypto';
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
  /**
   * For `absent`: set when the store exists but has stayed unreadable past
   * `UNREADABLE_STORE_WINDOW_MS` (`boundUnreadable`), so it is skipped as if
   * it were not there. Carries the same path-and-error detail.
   */
  skipped?: string;
  /**
   * For opencode.db, `ok`: the table read empty twice where the previous read
   * found rows. A logout — or a gap: callers refuse on it but do not yet treat
   * the login as gone for good.
   */
  emptied?: true;
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
 * on the credential just logged out. Empty twice is a logout and is `ok`
 * (flagged `emptied`, since one such read may still be a gap);
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
    return rows === 0 ? { state: 'ok', emptied: true } : { state: 'unreadable', detail: `${path}: the credential table read empty` };
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

/**
 * How long a store that exists but cannot be read counts as mid-write, when
 * there are no bytes to compare: a read error on a file (EACCES, EISDIR), or
 * a failed query on opencode.db. A file whose bytes were read but did not
 * parse is judged by whether those bytes move instead (`TORN_REPEAT_MS`).
 *
 * codex rewrites `auth.json` by truncating and writing, so a torn read is a
 * moment, and treating it as "no login" dropped gateways and restarted
 * LiteLLM. But a file that is corrupt, zero bytes or EACCES for good is not a
 * moment: read as torn forever, it refused a default-sourced ChatGPT gateway
 * that opencode could serve, with a 502 promising a retry that never
 * changed anything. Past this window a store is skipped as absent, which is
 * what every credential reader already does with it.
 */
export const UNREADABLE_STORE_WINDOW_MS = 10_000;

/**
 * How long a file may hold the same unparseable bytes and still count as
 * mid-write. A writer does not hold one partial state for a second.
 */
export const TORN_REPEAT_MS = 1_000;

/** When `boundUnreadable` stops treating a file as mid-write, in words, for the messages that promise it. */
export const UNREADABLE_SKIP_RULE = `once it stops changing (the same unparseable content ${TORN_REPEAT_MS / 1000}s ` +
  `apart), or once a read error has lasted ${UNREADABLE_STORE_WINDOW_MS / 1000}s`;

/** What `boundUnreadable` remembers between reads; one per process, shared by every caller. */
export interface UnreadableMemory {
  /**
   * A file store's last failed read: the hash of the bytes it returned (none
   * for a read error), when those bytes — or, with none, the run of read
   * errors — were first seen, and whether it has been reported.
   */
  files: Map<string, { hash?: string; since: number; warned?: true }>;
  /** When opencode.db's current run of failed reads began. */
  db: Map<string, { since: number; warned?: true }>;
  /** Unreadable reads answered as mid-write since this memory was made; a caller compares counts. */
  torn: number;
}

export function newUnreadableMemory(): UnreadableMemory {
  return { files: new Map(), db: new Map(), torn: 0 };
}

/** A sha256 of a file's bytes, or undefined when they cannot be read at all. Compared, never logged. */
function bytesHash(path: string): string | undefined {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return undefined;
  }
}

/** A file's mtime, or undefined when it cannot be stat'ed. */
function mtimeOf(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * A file store's read, with "cannot be read" bounded.
 *
 * A file whose bytes can be read (so what failed was their parse) counts as
 * torn — answered `unreadable`, so the caller keeps its last resolution or
 * refuses for now — only while those bytes, hashed here, are
 * still changing: they differ from the previous failed read's, or were first
 * seen less than `TORN_REPEAT_MS` ago. The same bytes a second apart are
 * stuck, not mid-write, however recently the file was touched and however
 * long ago it was last read; different bytes start again, however long the
 * file was quiet. A file rewritten with different unparseable bytes on every
 * read therefore stays torn for as long as that goes on — accepted: nothing
 * here can tell it from a writer mid-write.
 *
 * Bytes seen for the first time — no failed read on record — count from the
 * file's mtime when that is earlier than now: they have been there since the
 * last write. A file corrupt since before serve started is skipped on its
 * first read, rather than refusing every request for a second. After that
 * first sighting only the bytes count, as above.
 *
 * A file whose bytes cannot be read (EACCES, EISDIR) has nothing to compare, and
 * is torn only for `windowMs` from the first failure of its run — never
 * restarted by a gap; nothing rewrites a file into EACCES.
 *
 * Past either the store is steadily unreadable and answered `absent`, with
 * `skipped` naming the path and the error; `warn` is called once per
 * unchanged failure. Any read that is not unreadable forgets the file.
 */
export function boundUnreadable(
  path: string,
  read: StoreRead,
  memory: UnreadableMemory,
  now: number,
  warn: (line: string) => void = () => {},
  windowMs: number = UNREADABLE_STORE_WINDOW_MS,
): StoreRead {
  if (read.state !== 'unreadable') {
    memory.files.delete(path);
    return read;
  }
  const recorded = memory.files.get(path);
  const hash = bytesHash(path);
  const same = recorded !== undefined && recorded.hash === hash;
  const firstSeen = recorded === undefined && hash !== undefined ? Math.min(now, mtimeOf(path) ?? now) : now;
  const record: { hash?: string; since: number; warned?: true } =
    { ...(hash === undefined ? {} : { hash }), since: same ? recorded.since : firstSeen };
  if (same && recorded.warned === true) record.warned = true;
  memory.files.set(path, record);
  if (now - record.since < (hash === undefined ? windowMs : TORN_REPEAT_MS)) {
    memory.torn += 1;
    return read;
  }
  const detail = read.detail ?? `${path}: unreadable`;
  if (record.warned !== true) {
    record.warned = true;
    warn(`${detail} — ${hash === undefined
      ? `it has not read for ${Math.round(windowMs / 1000)}s`
      : `the same unparseable content for ${Math.max(1, Math.round((now - record.since) / 1000))}s, so not a write in progress`
    }, so it is skipped as if absent until it reads cleanly`);
  }
  return { state: 'absent', skipped: detail };
}

/**
 * opencode.db's read, with "cannot be read" bounded in time: a database that
 * has failed every read for `windowMs` — locked for good, corrupt — is
 * skipped as absent (logged once) rather than refusing its gateways forever.
 * The database is written constantly, so its mtime says nothing about a torn
 * read; the length of the run of failures does. Unlike a file's, the run is
 * not ended by a gap between failed reads: the run's length is the only
 * evidence here, and a database locked for good but read once a minute
 * would otherwise start a new run on every read and never be skipped.
 */
export function boundUnreadableDb(
  path: string,
  read: StoreRead,
  memory: UnreadableMemory,
  now: number,
  warn: (line: string) => void = () => {},
  windowMs: number = UNREADABLE_STORE_WINDOW_MS,
): StoreRead {
  if (read.state !== 'unreadable') {
    memory.db.delete(path);
    return read;
  }
  const run = memory.db.get(path) ?? { since: now };
  memory.db.set(path, run);
  if (now - run.since < windowMs) {
    memory.torn += 1;
    return read;
  }
  const detail = read.detail ?? `${path}: unreadable`;
  if (run.warned !== true) {
    run.warned = true;
    warn(`${detail} — it has not read cleanly for ${Math.round(windowMs / 1000)}s, so it is skipped as if absent ` +
      'until it does');
  }
  return { state: 'absent', skipped: detail };
}
