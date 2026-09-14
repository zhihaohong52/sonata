import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFilters, usagePayload } from '../../src/native/ui-usage.js';

let home: string;

function row(over: Record<string, unknown>): string {
  return JSON.stringify({
    ts: new Date().toISOString(), ms: 10, alias: 'sonata-code-simple', upstream: 'litellm',
    status: 200, complete: true, tokens: { input: 100, output: 20 },
    price: { source: 'models-dev', totalUsd: 0.5 }, attempts: [], ...over,
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sonata-ui-'));
  const dir = join(home, '.config', 'sonata', 'usage');
  mkdirSync(dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  writeFileSync(join(dir, `${day}.jsonl`), [
    row({ key: 'flash', session: 's1', project: '/proj/a' }),
    row({ key: 'flash', session: 's1', project: '/proj/a' }),
    row({ key: 'terra', session: 's2', project: '/proj/b', price: { source: 'none' } }),
  ].join('\n') + '\n');
});

afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('parseFilters', () => {
  it('defaults to a 24h window', () => {
    const now = 1_000_000_000_000;
    expect(parseFilters(new URLSearchParams(), now).sinceMs).toBe(now - 86_400_000);
  });

  it('accepts the same duration grammar as sonata usage', () => {
    const now = 1_000_000_000_000;
    expect(parseFilters(new URLSearchParams('since=30m'), now).sinceMs).toBe(now - 1_800_000);
  });

  it('falls back to the default on an unparseable duration rather than throwing', () => {
    const now = 1_000_000_000_000;
    expect(parseFilters(new URLSearchParams('since=forever'), now).sinceMs).toBe(now - 86_400_000);
  });

  it('reads project and session, and treats empty as absent', () => {
    const f = parseFilters(new URLSearchParams('project=/proj/a&session='), Date.now());
    expect(f.project).toBe('/proj/a');
    expect(f.session).toBeUndefined();
  });
});

describe('usagePayload', () => {
  const deps = () => ({ home, port: 4100 });

  it('aggregates by model by default', () => {
    const { report, by } = usagePayload(deps(), new URLSearchParams());
    expect(by).toBe('model');
    expect(report.buckets.map((b) => b.label).sort()).toEqual(['flash', 'terra']);
    expect(report.buckets.find((b) => b.label === 'flash')!.requests).toBe(2);
  });

  it('keeps unpriced volume out of the priced total', () => {
    const { report } = usagePayload(deps(), new URLSearchParams());
    expect(report.pricedTotalUsd).toBe(1);
    expect(report.unpriced.requests).toBe(1);
  });

  it('honours an explicit dimension', () => {
    const { report } = usagePayload(deps(), new URLSearchParams('by=session'));
    expect(report.buckets.map((b) => b.label).sort()).toEqual(['s1', 's2']);
  });

  it('rejects an unknown dimension instead of silently reporting by model', () => {
    expect(() => usagePayload(deps(), new URLSearchParams('by=wheelbarrow'))).toThrow(/dimension/);
  });

  it('filters to one session', () => {
    const { report } = usagePayload(deps(), new URLSearchParams('session=s1'));
    expect(report.buckets).toHaveLength(1);
    expect(report.buckets[0].requests).toBe(2);
  });

  it('filters to one project by resolved label', () => {
    const { report } = usagePayload(deps(), new URLSearchParams('project=/proj/a'));
    expect(report.buckets).toHaveLength(1);
    expect(report.buckets[0].label).toBe('flash');
  });
});
