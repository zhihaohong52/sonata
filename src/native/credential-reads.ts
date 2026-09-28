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
 * How long a store that exists but cannot be read counts as mid-write.
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

/** What `boundUnreadable` remembers between reads; one per process, shared by every caller. */
export interface UnreadableMemory {
  /**
   * A file store's stat at its last unreadable read, when that last changed,
   * when its current run of failed reads began, and when the last of them was.
   */
  files: Map<string, { sig: string; since: number; last: number; changedAt?: number; warned?: true }>;
  /** When opencode.db's current run of failed reads began. */
  db: Map<string, { since: number; warned?: true }>;
  /** Unreadable reads answered as mid-write since this memory was made; a caller compares counts. */
  torn: number;
}

export function newUnreadableMemory(): UnreadableMemory {
  return { files: new Map(), db: new Map(), torn: 0 };
}

function statSig(path: string): { sig: string; mtimeMs?: number } {
  try {
    const { mtimeMs, size } = statSync(path);
    return { sig: `${mtimeMs}:${size}`, mtimeMs };
  } catch (error) {
    return { sig: `error:${errnoCode(error)}` };
  }
}

/**
 * A file store's read, with "cannot be read" bounded in time.
 *
 * An unreadable file counts as torn — answered `unreadable`, so the caller
 * keeps its last resolution or refuses for now — only while it is plausibly
 * mid-write, which takes both: its mtime is within `windowMs` of `now` (or
 * its mtime or size changed since the previous unreadable read less than
 * `windowMs` ago), AND its current run of failed reads began less than
 * `windowMs` ago. A write takes a moment; a file that something keeps
 * touching while it never once parses is not mid-write, and without the
 * second bound it read as torn forever. Past either it is steadily
 * unreadable and answered `absent`, with `skipped` naming the path and the
 * error; `warn` is called once per such stretch. A run is continuous only
 * while each failed read follows the previous one within `windowMs`: any
 * read that is not unreadable forgets the file, and so does a gap — a torn
 * read at startup and another after a quiet minute are two writes, not one
 * run that has gone on for a minute. A file that stays broken is still
 * skipped across gaps, since it is torn only while recently written.
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
  const { sig, mtimeMs } = statSig(path);
  const recorded = memory.files.get(path);
  const previous = recorded !== undefined && now - recorded.last < windowMs ? recorded : undefined;
  const changedAt = previous !== undefined && previous.sig !== sig ? now : previous?.changedAt;
  const since = previous?.since ?? now;
  const record: { sig: string; since: number; last: number; changedAt?: number; warned?: true } =
    { sig, since, last: now, ...(changedAt === undefined ? {} : { changedAt }) };
  // Warned once per unchanged file, across gaps: a file that stays broken
  // and is read once a minute starts a new run each time, and is still one
  // stretch to report.
  if (recorded?.warned === true && recorded.sig === sig) record.warned = true;
  memory.files.set(path, record);
  const recentlyWritten = mtimeMs !== undefined && Math.abs(now - mtimeMs) < windowMs;
  const recentlyChanged = changedAt !== undefined && now - changedAt < windowMs;
  const runIsYoung = now - since < windowMs;
  if ((recentlyWritten || recentlyChanged) && runIsYoung) {
    memory.torn += 1;
    return read;
  }
  const detail = read.detail ?? `${path}: unreadable`;
  if (record.warned !== true) {
    record.warned = true;
    warn(`${detail} — it has not read cleanly for ${Math.round(windowMs / 1000)}s, so it is skipped as if absent ` +
      'until it does');
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
