import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ledgerDir, ledgerPathFor, appendRow, readRows, pruneLedger,
  LEDGER_RETENTION_DAYS, type LedgerRow,
} from '../src/ledger.js';
import { aggregate } from '../src/commands/usage.js';
import { recentRoutes } from '../src/commands/status.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'sonata-ledger-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

function row(over: Partial<LedgerRow> = {}): LedgerRow {
  return {
    ts: '2026-08-27T04:12:07.881Z', ms: 100,
    alias: 'sonata-code-simple', role: 'code', tier: 'simple',
    key: 'flash', gateway: 'acme', upstream: 'litellm',
    status: 200, complete: true,
    tokens: { input: 10, output: 2, cacheRead: 0, cacheCreation: 0 },
    price: { source: 'none' },
    attempts: [],
    ...over,
  };
}

describe('ledger paths', () => {
  it('names a file by UTC date, not local date', () => {
    // 23:30 UTC-  a local timezone east of UTC would roll this to the next day.
    const previousTz = process.env.TZ;
    process.env.TZ = 'Pacific/Kiritimati';
    try {
      const at = new Date('2026-08-27T23:30:00.000Z');
      expect(ledgerPathFor(home, at)).toBe(join(ledgerDir(home), '2026-08-27.jsonl'));
    } finally {
      if (previousTz === undefined) delete process.env.TZ;
      else process.env.TZ = previousTz;
    }
  });
});

describe('appendRow / readRows', () => {
  it('round-trips a row', () => {
    appendRow(home, row());
    const back = readRows(home, 0, Date.parse('2026-08-27T05:00:00Z'));
    expect(back).toHaveLength(1);
    expect(back[0].alias).toBe('sonata-code-simple');
  });

  it('N appends produce N whole parseable lines and end with a newline', () => {
    appendRow(home, row());
    appendRow(home, row({ alias: 'sonata-review-simple' }));
    const raw = readFileSync(ledgerPathFor(home, new Date('2026-08-27T04:12:07.881Z')), 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line))).toHaveLength(2);
    expect(raw.endsWith('\n')).toBe(true);
  });

  it('skips a corrupt line rather than failing the whole read', () => {
    appendRow(home, row());
    const path = ledgerPathFor(home, new Date('2026-08-27T04:12:07.881Z'));
    writeFileSync(path, `${readFileSync(path, 'utf8')}{not json\nnull\n`);
    appendRow(home, row({ alias: 'later' }));
    const back = readRows(home, 0, Date.parse('2026-08-27T05:00:00Z'));
    expect(back.map((r) => r.alias)).toEqual(['sonata-code-simple', 'later']);
  });

  it('skips a literal null line', () => {
    appendRow(home, row());
    const path = ledgerPathFor(home, new Date('2026-08-27T04:12:07.881Z'));
    writeFileSync(path, `${readFileSync(path, 'utf8')}null\n`);
    expect(readRows(home, 0, Date.parse('2026-08-27T05:00:00Z'))).toHaveLength(1);
  });

  it('filters by since, across day files', () => {
    appendRow(home, row({ ts: '2026-08-25T10:00:00.000Z' }));
    appendRow(home, row({ ts: '2026-08-27T10:00:00.000Z', alias: 'recent' }));
    const now = Date.parse('2026-08-27T12:00:00Z');
    const back = readRows(home, now - 24 * 3600 * 1000, now);
    expect(back.map((r) => r.alias)).toEqual(['recent']);
  });

  it('returns nothing when the ledger has never been written', () => {
    expect(readRows(home, 0, Date.now())).toEqual([]);
  });

  it('skips a persisted row missing required fields', () => {
    appendRow(home, row());
    const path = ledgerPathFor(home, new Date('2026-08-27T04:12:07.881Z'));
    // A parseable line whose `tokens` and `attempts` are missing must not make
    // it through as a LedgerRow — aggregate/recentRoutes would crash on it.
    writeFileSync(path, `${readFileSync(path, 'utf8')}${JSON.stringify({ ts: '2026-08-27T05:50:00.000Z', alias: 'broken' })}\n`);
    const back = readRows(home, 0, Date.parse('2026-08-27T06:00:00Z'));
    expect(back).toHaveLength(1);
    expect(back[0].alias).toBe('sonata-code-simple');
  });

  it('skips a persisted row with a null or malformed price', () => {
    appendRow(home, row());
    const path = ledgerPathFor(home, new Date('2026-08-27T04:12:07.881Z'));
    // aggregate() dereferences price.source, so a null/malformed price must be
    // rejected here rather than throw downstream.
    writeFileSync(path, `${readFileSync(path, 'utf8')}${JSON.stringify(row({ ts: '2026-08-27T05:55:00.000Z', alias: 'null-price', price: null }))}\n`);
    writeFileSync(path, `${readFileSync(path, 'utf8')}${JSON.stringify(row({ ts: '2026-08-27T05:56:00.000Z', alias: 'bad-price', price: { source: 'model' } }))}\n`);
    const back = readRows(home, 0, Date.parse('2026-08-27T06:00:00Z'));
    expect(back).toHaveLength(1);
    expect(back[0].alias).toBe('sonata-code-simple');
  });

  it('keeps rows whose price is a valid billed source', () => {
    appendRow(home, row({ alias: 'ai', price: { source: 'ai-pricing', totalUsd: 0.0012 } }));
    appendRow(home, row({ alias: 'none', price: { source: 'none' } }));
    const back = readRows(home, 0, Date.parse('2026-08-27T06:00:00Z'));
    expect(back.map((r) => r.alias)).toEqual(['ai', 'none']);
  });

  it('readers survive a ledger containing an incomplete persisted row', () => {
    appendRow(home, row());
    appendRow(home, row({ alias: 'incomplete', tokens: undefined as never, attempts: undefined as never }));
    const back = readRows(home, 0, Date.parse('2026-08-27T06:00:00Z'));
    expect(back).toHaveLength(1);
    // Both readers reach into tokens/attempts; neither may throw.
    expect(() => aggregate(back, 'model', {})).not.toThrow();
    expect(() => recentRoutes(back, 10)).not.toThrow();
  });
});

describe('pruneLedger', () => {
  it('deletes files older than the retention window and keeps the rest', () => {
    appendRow(home, row({ ts: '2026-07-01T10:00:00.000Z' }));
    appendRow(home, row({ ts: '2026-07-28T10:00:00.000Z' }));
    appendRow(home, row({ ts: '2026-08-27T10:00:00.000Z' }));
    const removed = pruneLedger(home, LEDGER_RETENTION_DAYS, new Date('2026-08-27T12:00:00Z'));
    expect(removed).toBe(1);
    expect(existsSync(ledgerPathFor(home, new Date('2026-07-01T10:00:00Z')))).toBe(false);
    expect(existsSync(ledgerPathFor(home, new Date('2026-07-28T10:00:00Z')))).toBe(true);
    expect(existsSync(ledgerPathFor(home, new Date('2026-08-27T10:00:00Z')))).toBe(true);
  });

  it('ignores unrelated files in the directory', () => {
    mkdirSync(ledgerDir(home), { recursive: true });
    writeFileSync(join(ledgerDir(home), 'README.txt'), 'hi');
    expect(pruneLedger(home, 1, new Date('2026-08-27T12:00:00Z'))).toBe(0);
    expect(existsSync(join(ledgerDir(home), 'README.txt'))).toBe(true);
  });

  it('is a no-op on a missing directory', () => {
    expect(pruneLedger(home, 30, new Date())).toBe(0);
  });
});
