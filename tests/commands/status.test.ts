import { describe, expect, it } from 'vitest';
import { recentRoutes } from '../../src/commands/status.js';
import type { LedgerRow } from '../../src/ledger.js';

function row(over: Partial<LedgerRow> = {}): LedgerRow {
  return {
    ts: '2026-08-27T12:00:00.000Z', ms: 5, alias: 'sonata-code-simple',
    key: 'flash', gateway: 'acme', upstream: 'litellm', status: 200, complete: true,
    tokens: { input: 100, output: 10, cacheRead: 0, cacheCreation: 0 },
    price: { source: 'none' }, attempts: [], ...over,
  };
}

describe('recentRoutes', () => {
  it('summarises a row into alias, attempts, and who served it', () => {
    const [line] = recentRoutes([row({ attempts: [{ key: 'first', status: 403 }] })], 10);
    expect(line).toMatchObject({
      alias: 'sonata-code-simple', served: 'flash', status: 200, input: 100, output: 10,
      attempts: [{ key: 'first', status: 403 }],
    });
  });

  it('returns the most recent rows last-first, capped at the limit', () => {
    const rows = [row({ ts: '2026-08-27T10:00:00.000Z', key: 'a' }), row({ ts: '2026-08-27T11:00:00.000Z', key: 'b' }), row({ ts: '2026-08-27T12:00:00.000Z', key: 'c' })];
    expect(recentRoutes(rows, 2).map((l) => l.served)).toEqual(['c', 'b']);
  });

  it('reports an exhausted tier with no server', () => {
    const [line] = recentRoutes([row({ status: 529, key: undefined, attempts: [{ key: 'only', status: 500 }] })], 10);
    expect(line.served).toBeUndefined();
    expect(line.status).toBe(529);
  });

  it('returns nothing for an empty ledger', () => {
    expect(recentRoutes([], 10)).toEqual([]);
  });
});