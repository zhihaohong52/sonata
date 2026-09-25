import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';

/** `node:sqlite` is still flagged experimental on some Node versions. */
export function sqliteAvailable(): boolean {
  try {
    createRequire(import.meta.url)('node:sqlite');
    return true;
  } catch {
    return false;
  }
}

export interface CredRow {
  id: string;
  integration: string | null;
  value: string;
  timeCreated: number;
}

/**
 * Builds a fixture `opencode.db` holding the real v2 `credential` schema.
 *
 * FAKE values only — these fixtures stand in for a store that holds live
 * secrets in plaintext, and no test may write anything real into one.
 */
export function writeOpencodeCredDb(path: string, rows: CredRow[]): void {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
    DatabaseSync: new (path: string) => {
      exec(sql: string): void;
      prepare(sql: string): { run(...params: unknown[]): unknown };
      close(): void;
    };
  };
  mkdirSync(dirname(path), { recursive: true }); // SQLite does not create parents
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE credential (
    id text PRIMARY KEY,
    integration_id text,
    label text NOT NULL,
    value text NOT NULL,
    connector_id text,
    method_id text,
    active integer,
    time_created integer NOT NULL,
    time_updated integer NOT NULL
  )`);
  const insert = db.prepare(
    'INSERT INTO credential (id, integration_id, label, value, connector_id, method_id, active, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const row of rows) {
    insert.run(row.id, row.integration, 'label', row.value, null, null, 1, row.timeCreated, row.timeCreated);
  }
  db.close();
}
