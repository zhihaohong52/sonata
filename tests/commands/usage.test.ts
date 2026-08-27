import { describe, expect, it } from 'vitest';
import { aggregate, parseDuration } from '../../src/commands/usage.js';
import type { LedgerRow } from '../../src/ledger.js';

function row(over: Partial<LedgerRow> = {}): LedgerRow {
  return {
    ts: '2026-08-27T12:00:00.000Z', ms: 5,
    alias: 'sonata-code-simple', role: 'code', tier: 'simple',
    key: 'flash', gateway: 'acme', upstream: 'litellm',
    status: 200, complete: true, session: 's1',
    tokens: { input: 100, output: 10, cacheRead: 0, cacheCreation: 0 },
    price: { source: 'model', totalUsd: 0.5 }, attempts: [],
    ...over,
  };
}

describe('parseDuration', () => {
  it('parses days, hours and minutes', () => {
    expect(parseDuration('7d')).toBe(7 * 24 * 3600 * 1000);
    expect(parseDuration('12h')).toBe(12 * 3600 * 1000);
    expect(parseDuration('30m')).toBe(30 * 60 * 1000);
  });
  it('rejects nonsense', () => {
    expect(() => parseDuration('soon')).toThrow(/duration/i);
  });
});

describe('aggregate', () => {
  it('groups by model and sums tokens and cost', () => {
    const report = aggregate([row(), row()], 'model', {});
    expect(report.buckets).toHaveLength(1);
    expect(report.buckets[0]).toMatchObject({ label: 'flash', requests: 2, input: 200, output: 20, costUsd: 1 });
    expect(report.pricedTotalUsd).toBe(1);
  });

  it('keeps unpriced volume out of the total and counts it separately', () => {
    const report = aggregate([row(), row({ price: { source: 'none' } })], 'model', {});
    expect(report.pricedTotalUsd).toBe(0.5);
    expect(report.unpriced).toMatchObject({ requests: 1, input: 100, output: 10 });
    expect(report.buckets[0].unpricedRequests).toBe(1);
  });

  it('counts a known-zero rate as priced, not unpriced', () => {
    const report = aggregate([row({ price: { source: 'gateway', totalUsd: 0 } })], 'model', {});
    expect(report.unpriced.requests).toBe(0);
    expect(report.pricedTotalUsd).toBe(0);
  });

  it('groups by role, tier and gateway', () => {
    expect(aggregate([row()], 'role', {}).buckets[0].label).toBe('code');
    expect(aggregate([row()], 'tier', {}).buckets[0].label).toBe('simple');
    expect(aggregate([row()], 'gateway', {}).buckets[0].label).toBe('acme');
  });

  it('groups by project using the session map', () => {
    const sessions = { s1: { session: 's1', cwd: '/repo/a', started: '2026-08-27T10:00:00.000Z' } };
    expect(aggregate([row()], 'project', sessions).buckets[0].label).toBe('/repo/a');
  });

  it('labels a session with no map entry as unknown rather than dropping it', () => {
    const report = aggregate([row({ session: 'ghost' })], 'project', {});
    expect(report.buckets[0].label).toBe('unknown');
    expect(report.buckets[0].requests).toBe(1);
  });

  it('groups anthropic rows by their model, so the baseline is comparable', () => {
    const report = aggregate(
      [row(), row({ upstream: 'anthropic', key: undefined, alias: 'claude-sonnet-5', role: undefined, tier: undefined })],
      'model',
      {},
    );
    expect(report.buckets.map((b) => b.label).sort()).toEqual(['claude-sonnet-5', 'flash']);
  });

  it('sorts buckets by cost descending', () => {
    const report = aggregate(
      [row({ key: 'cheap', price: { source: 'model', totalUsd: 0.1 } }), row({ key: 'dear', price: { source: 'model', totalUsd: 9 } })],
      'model',
      {},
    );
    expect(report.buckets.map((b) => b.label)).toEqual(['dear', 'cheap']);
  });

  it('returns an empty report for no rows', () => {
    expect(aggregate([], 'model', {})).toMatchObject({ buckets: [], pricedTotalUsd: 0 });
  });
});