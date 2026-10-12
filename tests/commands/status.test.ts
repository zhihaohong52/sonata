import { describe, expect, it } from 'vitest';
import { recentRoutes, routeCostLabel, routeTotals, type RouteLine } from '../../src/commands/status.js';
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

  it('surfaces a successful keyless request under its alias, not as a total failure', () => {
    // An anthropic-path row has no `key` (no tier resolution happened) and no
    // failed candidates — it succeeded. Rendering `served` as undefined would
    // present that success as "every candidate failed".
    const [line] = recentRoutes([row({ key: undefined, attempts: [], upstream: 'anthropic' })], 10);
    expect(line.served).toBe('sonata-code-simple');
  });

  it('returns nothing for an empty ledger', () => {
    expect(recentRoutes([], 10)).toEqual([]);
  });
});
describe('recentRoutes for the loop panel', () => {
  const row = (over: Record<string, unknown>) => ({
    ts: '2026-10-09T03:00:00.000Z', ms: 10, alias: 'sonata-code-auto', upstream: 'litellm',
    status: 200, complete: true, tokens: { input: 1, output: 2 }, attempts: [], key: 'flash',
    role: 'code', tier: 'normal', price: { source: 'model', totalUsd: 0.0123 }, ...over,
  }) as never;

  it('carries role, tier and a priced row\'s cost', () => {
    const [line] = recentRoutes([row({})], 10);
    expect(line).toMatchObject({ role: 'code', tier: 'normal', priceUsd: 0.0123 });
  });

  it('tolerates a ledger row with no price at all', () => {
    const [line] = recentRoutes([row({ price: undefined })], 10);
    expect(line.priceUsd).toBeUndefined();
  });

  it('leaves priceUsd absent for an unpriced row rather than 0', () => {
    const [line] = recentRoutes([row({ price: { source: 'none' } })], 10);
    expect(line.priceUsd).toBeUndefined();
  });
});

describe('route cost', () => {
  const line = (over: Partial<RouteLine>): RouteLine => ({ alias: 'a', attempts: [], served: 'k', status: 200, input: 1, output: 1, ts: '2026-10-12T00:00:00Z', ...over });

  it('marks covered rows and carries the flag through recentRoutes', () => {
    const rows = [
      { ...row(), price: { source: 'covered', totalUsd: 0.42 } },
      { ...row(), price: { source: 'models-dev', totalUsd: 1.1 } },
    ] as LedgerRow[];
    const lines = recentRoutes(rows, 10);
    expect(lines.filter((l) => l.isCovered === true)).toHaveLength(1);
    expect(lines.some((l) => 'isCovered' in l && l.isCovered !== true)).toBe(false);
  });

  it('labels each route and totals billed apart from subscription', () => {
    expect(routeCostLabel(line({ priceUsd: 0.0123 }))).toBe('$0.0123');
    expect(routeCostLabel(line({ priceUsd: 0.42, isCovered: true }))).toBe('$0.4200 sub');
    expect(routeCostLabel(line({}))).toBe('—');
    expect(routeTotals([line({ priceUsd: 1.1 }), line({ priceUsd: 0.42, isCovered: true }), line({})])).toBe('$1.1000 billed · $0.4200 sub');
    expect(routeTotals([line({ priceUsd: 0.42, isCovered: true })])).toBe('$0.4200 sub');
    expect(routeTotals([line({})])).toBeUndefined();
  });
});
