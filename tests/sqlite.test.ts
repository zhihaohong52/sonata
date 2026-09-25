import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { openReadOnlySync } from '../src/sqlite.js';

/** `node:sqlite` is still flagged experimental on some Node versions. */
function sqliteAvailable(): boolean {
  try {
    createRequire(import.meta.url)('node:sqlite');
    return true;
  } catch {
    return false;
  }
}

const skip = !sqliteAvailable();

/** A tiny db with one `t` table holding `n`. */
function makeDb(path: string): void {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
    DatabaseSync: new (path: string) => {
      exec(sql: string): void;
      prepare(sql: string): { run(...params: unknown[]): unknown };
      close(): void;
    };
  };
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE t (n INTEGER NOT NULL)');
  db.prepare('INSERT INTO t (n) VALUES (?)').run(7);
  db.close();
}

describe('openReadOnlySync', () => {
  it.skipIf(skip)('returns undefined when the file does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sonata-sqlite-'));
    expect(openReadOnlySync(join(dir, 'nope.db'))).toBeUndefined();
  });

  it.skipIf(skip)('returns undefined for a file that is not a database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sonata-sqlite-'));
    const path = join(dir, 'garbage.db');
    writeFileSync(path, 'this is not a database');
    expect(openReadOnlySync(path)).toBeUndefined();
  });

  it.skipIf(skip)('queries a real database and closes it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sonata-sqlite-'));
    const path = join(dir, 'ok.db');
    makeDb(path);

    const db = openReadOnlySync(path);
    expect(db).toBeDefined();
    expect(db!.all('SELECT n FROM t')).toEqual([{ n: 7 }]);
    expect(db!.all('SELECT n FROM t WHERE n = ?', 7)).toEqual([{ n: 7 }]);
    expect(db!.all('SELECT n FROM t WHERE n = ?', 8)).toEqual([]);
    db!.close();
  });

  it.skipIf(skip)('opens read-only — a write is refused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sonata-sqlite-'));
    const path = join(dir, 'ro.db');
    makeDb(path);

    const db = openReadOnlySync(path)!;
    expect(() => db.all('INSERT INTO t (n) VALUES (9)')).toThrow();
    db.close();
  });
});
