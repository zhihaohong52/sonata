import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ledgerDir, ledgerPathFor, appendRow, readRows, readRowsAsync, pruneLedger,
  LEDGER_RETENTION_DAYS, type LedgerRow,
} from '../src/ledger.js';
import { aggregate } from '../src/commands/usage.js';
import { recentRoutes } from '../src/commands/status.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'sonata-ledger-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

/**
 * A row as a ledger file can actually hold it: arbitrary JSON.
 *
 * `readRows` parses lines off disk, so its real input is not `LedgerRow` — it
 * is whatever JSON is in the file, including shapes no writer would produce.
 * A `Partial<LedgerRow>` cannot express those, and narrowing to it silently
 * turns a malformed-input test into a well-formed one: a `price: null` becomes
 * `undefined` (which `JSON.stringify` drops entirely) and a price missing
 * `totalUsd` becomes a valid one, so the reader keeps both and the test fails
 * for the wrong reason.
 *
 * Every field the reader defends against is evidence its input is wider than
 * the writer's type.
 */
function persistedRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...row(), ...over };
}

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
    writeFileSync(path, `${readFileSync(path, 'utf8')}${JSON.stringify(persistedRow({ ts: '2026-08-27T05:55:00.000Z', alias: 'null-price', price: null }))}\n`);
    writeFileSync(path, `${readFileSync(path, 'utf8')}${JSON.stringify(persistedRow({ ts: '2026-08-27T05:56:00.000Z', alias: 'bad-price', price: { source: 'model' } }))}\n`);
    const back = readRows(home, 0, Date.parse('2026-08-27T06:00:00Z'));
    expect(back).toHaveLength(1);
    expect(back[0].alias).toBe('sonata-code-simple');
  });

  it('keeps rows whose price is a valid billed source', () => {
    appendRow(home, row({ alias: 'ai', price: { source: 'models-dev', totalUsd: 0.0012 } }));
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

// Ledger files written before the models.dev switch carry `ai-pricing`.
// Rejecting them would drop that spend from `sonata usage` *and* from
// `spentTodayUsd`, silently lowering a budget cap's view of a day it should
// still count. Reported by CodeRabbit on PR #15.
describe('legacy ai-pricing rows stay readable', () => {
  it('keeps a row whose source is the retired ai-pricing', () => {
    const home = mkdtempSync(join(tmpdir(), 'ledger-legacy-'));
    const row = {
      ts: '2026-09-03T01:00:00.000Z', ms: 5, alias: 'sonata-code-simple',
      key: 'flash', gateway: 'acme', upstream: 'litellm',
      status: 200, complete: true,
      tokens: { input: 10, output: 2, cacheRead: 0, cacheCreation: 0 },
      price: { source: 'ai-pricing', totalUsd: 1.25 }, attempts: [],
    };
    appendRow(home, row as never);
    const rows = readRows(home, Date.parse('2026-09-03T00:00:00Z'), Date.parse('2026-09-03T23:59:59Z'));
    expect(rows).toHaveLength(1);
    expect(rows[0].price).toEqual({ source: 'ai-pricing', totalUsd: 1.25 });
  });
});


describe('day-file selection', () => {
  /**
   * The filename IS the UTC date, so a file whose whole day falls outside the
   * window cannot contribute. Measured before this existed: a 24-hour query
   * opened 14 files / 15 MB / 36,797 lines to answer from one, on the router's
   * own event loop, every 5 seconds a UI page was open.
   */
  function seedDays(days: string[]): void {
    mkdirSync(ledgerDir(home), { recursive: true });
    for (const day of days) {
      writeFileSync(
        join(ledgerDir(home), `${day}.jsonl`),
        `${JSON.stringify(row({ ts: `${day}T12:00:00.000Z`, key: day }))}\n`,
      );
    }
  }

  const days = ['2026-08-01', '2026-08-20', '2026-08-21', '2026-08-22', '2026-08-23'];

  it('does not open a day file that is entirely before the window', () => {
    seedDays(days);
    // A far-off file holding a row that IS inside the window: if the file were
    // opened, its row would come back. Its absence is the proof it was skipped.
    writeFileSync(
      join(ledgerDir(home), '2026-01-01.jsonl'),
      `${JSON.stringify(row({ ts: '2026-08-22T12:00:00.000Z', key: 'would-have-matched' }))}\n`,
    );
    const keys = readRows(
      home,
      Date.parse('2026-08-22T00:00:00.000Z'),
      Date.parse('2026-08-22T23:00:00.000Z'),
    ).map((r) => r.key);
    expect(keys).toEqual(['2026-08-22']);
  });

  it('keeps a one-day margin on both sides, so a row whose ts disagrees with its filename is still found', () => {
    mkdirSync(ledgerDir(home), { recursive: true });
    // A hand-edited / clock-skewed file: filed under the 21st, timestamped the 22nd.
    writeFileSync(
      join(ledgerDir(home), '2026-08-21.jsonl'),
      `${JSON.stringify(row({ ts: '2026-08-22T01:00:00.000Z', key: 'skewed' }))}\n`,
    );
    const rows = readRows(
      home,
      Date.parse('2026-08-22T00:00:00.000Z'),
      Date.parse('2026-08-22T23:00:00.000Z'),
    );
    expect(rows.map((r) => r.key)).toEqual(['skewed']);
  });

  it('still drops an in-file row outside the window: the per-row ts stays the source of truth', () => {
    mkdirSync(ledgerDir(home), { recursive: true });
    writeFileSync(join(ledgerDir(home), '2026-08-22.jsonl'), [
      JSON.stringify(row({ ts: '2026-08-22T01:00:00.000Z', key: 'in' })),
      JSON.stringify(row({ ts: '2026-08-22T23:30:00.000Z', key: 'after-now' })),
    ].join('\n') + '\n');
    const rows = readRows(
      home,
      Date.parse('2026-08-22T00:00:00.000Z'),
      Date.parse('2026-08-22T12:00:00.000Z'),
    );
    expect(rows.map((r) => r.key)).toEqual(['in']);
  });

  it('readRowsAsync returns exactly what readRows does', async () => {
    seedDays(days);
    for (const [since, now] of [
      [0, Date.now()],
      [Date.parse('2026-08-21T00:00:00.000Z'), Date.parse('2026-08-23T00:00:00.000Z')],
      [Date.parse('2030-01-01T00:00:00.000Z'), Date.parse('2030-01-02T00:00:00.000Z')],
    ] as [number, number][]) {
      expect(await readRowsAsync(home, since, now)).toEqual(readRows(home, since, now));
    }
  });

  it('readRowsAsync answers an absent ledger directory with no rows, like readRows', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'sonata-ledger-empty-'));
    try {
      expect(await readRowsAsync(empty, 0)).toEqual([]);
      expect(readRows(empty, 0)).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('recentRoutes carries what the status board needs', () => {
  it('surfaces the gateway, the effort level and the timestamp', () => {
    // All three were already recorded per request and none reached the view,
    // so a reader could see WHAT ran but not when, through which provider, or
    // at which level — the three questions asked of a routing log.
    const [line] = recentRoutes([row({ effort: 'max', gateway: 'acme' })], 10);
    expect(line).toMatchObject({
      gateway: 'acme',
      effort: 'max',
      ts: '2026-08-27T04:12:07.881Z',
    });
  });

  it('leaves them absent rather than inventing them', () => {
    // A candidate that pinned no level, and a row from before the ledger
    // recorded a gateway. Absent must stay absent: `@undefined` beside a
    // model name is worse than no suffix.
    const [line] = recentRoutes([row({ effort: undefined, gateway: undefined })], 10);
    expect(line!.effort).toBeUndefined();
    expect(line!.gateway).toBeUndefined();
  });

  it('keeps newest first, so the timestamp column reads downward', () => {
    const lines = recentRoutes([
      row({ ts: '2026-08-27T04:00:00.000Z', alias: 'older' }),
      row({ ts: '2026-08-27T04:12:07.881Z', alias: 'newer' }),
    ], 10);
    expect(lines.map((l) => l.alias)).toEqual(['newer', 'older']);
  });
});
