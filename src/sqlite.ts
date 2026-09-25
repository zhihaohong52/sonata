/**
 * A tiny read-only window onto someone else's SQLite database.
 *
 * `node:sqlite` is the only SQLite sonata needs and ships none: opencode keeps
 * its v2 credential store (and later its usage) in one, and sonata only ever
 * *reads* it. Opened `readOnly: true`, always, so a bug here cannot write into
 * a harness's own data — the one property this module exists to guarantee.
 *
 * Synchronous on purpose. The callers (`resolveKeys` and friends) are sync all
 * the way up through `serve`'s per-request credential resolution and `init`'s
 * plan, and `DatabaseSync` is synchronous anyway; only loading the module is
 * not, which `createRequire` solves without a promise rippling through every
 * caller.
 *
 * Every failure mode answers `undefined` — module absent (Node < 22.13), no
 * file, not a database, unreadable. A database sonata cannot open must degrade
 * to "no rows", never break the command that was reading credentials beside
 * it. Nothing here logs; rows may hold secrets.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

export interface ReadOnlyDb {
  /** Runs a statement, returning its rows. Intended for SELECTs. */
  all(sql: string, ...params: unknown[]): Record<string, unknown>[];
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => {
    prepare(sql: string): { all(...params: unknown[]): unknown[] };
    close(): void;
  };
}

let cached: SqliteModule | null | undefined;

function sqliteModule(): SqliteModule | null {
  if (cached !== undefined) return cached;
  // Node 22 prints "SQLite is an experimental feature" to stderr the first
  // time the module loads — into `sonata init`'s Ink screen and every hook's
  // output. Only that one warning is dropped, and only for this load.
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const message = typeof warning === 'string' ? warning : warning.message;
    if (message.includes('SQLite is an experimental feature')) return;
    (emit as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    cached = createRequire(import.meta.url)('node:sqlite') as SqliteModule;
  } catch {
    cached = null;
  } finally {
    process.emitWarning = emit;
  }
  return cached;
}

/**
 * The database at `path`, opened read-only, or `undefined` when it cannot be
 * opened — never throws.
 */
export function openReadOnlySync(path: string): ReadOnlyDb | undefined {
  // Existence first: most machines have no opencode.db, and those must not
  // load `node:sqlite` at all.
  if (!existsSync(path)) return undefined;
  const sqlite = sqliteModule();
  if (sqlite === null) return undefined;
  let opened: InstanceType<SqliteModule['DatabaseSync']> | undefined;
  try {
    opened = new sqlite.DatabaseSync(path, { readOnly: true });
    const handle: ReadOnlyDb = {
      all: (sql, ...params) => opened!.prepare(sql).all(...params) as Record<string, unknown>[],
      close: () => opened!.close(),
    };
    // SQLite opens a non-database file lazily and only fails at the first
    // statement — probe here so "a usable database or undefined" is what the
    // caller gets, rather than a handle that throws on first use.
    handle.all('SELECT 1');
    return handle;
  } catch {
    try {
      opened?.close();
    } catch {
      // Already closed, or never really opened — either way nothing to do.
    }
    return undefined;
  }
}
