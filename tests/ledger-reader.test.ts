import { appendFileSync, mkdirSync, mkdtempSync, rmSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLedgerReader, ledgerDir, readRows, type LedgerRow } from '../src/ledger.js';
import { aggregate } from '../src/commands/usage.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'sonata-ledger-reader-')); mkdirSync(ledgerDir(home), { recursive: true }); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const NOW = Date.parse('2026-08-27T12:00:00.000Z');
const DAY = 24 * 3600 * 1000;

function row(ts: number, n = 1): LedgerRow {
  return {
    ts: new Date(ts).toISOString(), ms: 10, alias: 'a', key: `k${n}`, gateway: 'g', upstream: 'litellm',
    status: 200, complete: true,
    tokens: { input: n, output: 1, cacheRead: 0, cacheCreation: 0 },
    price: { source: 'model', totalUsd: n / 100 }, attempts: [],
  };
}
const line = (r: LedgerRow): string => `${JSON.stringify(r)}\n`;
const file = (day: string): string => join(ledgerDir(home), `${day}.jsonl`);

describe('createLedgerReader', () => {
  it('matches a fresh full read at every step', () => {
    const reader = createLedgerReader(home);
    let now = NOW;
    const since = (): number => now - 3 * DAY;
    const check = (): void => {
      const got = reader.read(since(), now);
      const want = readRows(home, since(), now);
      expect(got).toEqual(want);
      expect(aggregate(got, 'model', {}, (c) => c)).toEqual(aggregate(want, 'model', {}, (c) => c));
    };
    check(); // no files
    appendFileSync(file('2026-08-27'), line(row(NOW - 1000, 1)) + line(row(NOW - 2000, 2)));
    check();
    // A partial line: not counted, not dropped, completed on a later poll.
    const full = line(row(NOW - 500, 3));
    appendFileSync(file('2026-08-27'), full.slice(0, 40));
    check();
    expect(reader.read(since(), now)).toHaveLength(2);
    appendFileSync(file('2026-08-27'), full.slice(40));
    check();
    expect(reader.read(since(), now)).toHaveLength(3);
    // A new day file.
    appendFileSync(file('2026-08-28'), line(row(NOW + 3600_000 * 2, 4)));
    now = NOW + 3 * 3600_000;
    check();
    // A row aging out of the window by time.
    writeFileSync(file('2026-08-24'), line(row(NOW - 3 * DAY + 60_000, 5)));
    now = NOW;
    check();
    now = NOW + 120_000;
    check();
    expect(reader.read(since(), now).some((r) => r.key === 'k5')).toBe(false);
    // Truncated, then replaced with different content of a different size.
    truncateSync(file('2026-08-27'), 0);
    check();
    writeFileSync(file('2026-08-27'), line(row(NOW - 100, 9)));
    check();
    // Deleted (retention).
    unlinkSync(file('2026-08-24'));
    check();
  });

  it('reuses the previous result while nothing changed', () => {
    appendFileSync(file('2026-08-27'), line(row(NOW - 1000)));
    const reader = createLedgerReader(home);
    const a = reader.read(NOW - DAY, NOW);
    expect(reader.read(NOW - DAY + 1000, NOW + 1000)).toBe(a);
    appendFileSync(file('2026-08-27'), line(row(NOW - 500, 2)));
    expect(reader.read(NOW - DAY, NOW + 1000)).not.toBe(a);
  });
});
