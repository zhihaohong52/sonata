/**
 * `sonata usage` — what the native path actually consumed.
 *
 * Two honesty constraints shape this file. Unpriced volume is reported beside
 * the total and never folded into it: a total that treats "unknown" as zero is
 * worse than no total. And this measures the *native* path only — a `sonata
 * dispatch` run executes in the foreign CLI's own process and never transits
 * the router, so its tokens are unobservable and the output says so rather than
 * presenting a partial figure as complete.
 */
import { loadAiPricing } from '../aipricing.js';
import { readRows, type LedgerRow } from '../ledger.js';
import { loadSessions, type SessionRecord } from '../sessions.js';

export type UsageDimension = 'model' | 'role' | 'tier' | 'gateway' | 'session' | 'project';

export interface UsageBucket {
  label: string;
  requests: number;
  input: number;
  output: number;
  costUsd: number;
  unpricedRequests: number;
}

export interface UsageReport {
  buckets: UsageBucket[];
  pricedTotalUsd: number;
  unpriced: { requests: number; input: number; output: number };
  priceCacheAgeMs?: number;
}

const UNITS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseDuration(text: string): number {
  const match = /^(\d+)([mhd])$/.exec(text.trim());
  if (match === null) throw new Error(`sonata usage: invalid duration "${text}" — use 30m, 12h or 7d`);
  const duration = Number(match[1]) * UNITS[match[2]];
  // A long enough digit run parses as a Number but overflows the multiplication
  // to Infinity, which would silently select the entire ledger as the cutoff.
  if (!Number.isFinite(duration)) throw new Error(`sonata usage: invalid duration "${text}" — use 30m, 12h or 7d`);
  return duration;
}

function labelOf(row: LedgerRow, by: UsageDimension, sessions: Record<string, SessionRecord>): string {
  switch (by) {
    // An anthropic row has no sonata key; its alias is the model, which is
    // exactly the baseline the comparison needs on the same axis.
    // `??` alone let an empty-string alias through, and a router request that
    // never resolved a model writes exactly that — producing a nameless row in
    // a cost report, which is the one thing a cost report may not have.
    case 'model': return row.key || row.alias || '(unresolved)';
    case 'role': return row.role ?? '—';
    case 'tier': return row.tier ?? '—';
    case 'gateway': return row.gateway ?? row.upstream;
    case 'session': return row.session ?? 'unknown';
    case 'project': return row.session === undefined ? 'unknown' : (sessions[row.session]?.cwd ?? 'unknown');
  }
}

export function aggregate(
  rows: LedgerRow[],
  by: UsageDimension,
  sessions: Record<string, SessionRecord>,
): UsageReport {
  const buckets = new Map<string, UsageBucket>();
  const unpriced = { requests: 0, input: 0, output: 0 };
  let pricedTotalUsd = 0;

  for (const row of rows) {
    const label = labelOf(row, by, sessions);
    const bucket = buckets.get(label) ?? { label, requests: 0, input: 0, output: 0, costUsd: 0, unpricedRequests: 0 };
    bucket.requests += 1;
    bucket.input += row.tokens.input;
    bucket.output += row.tokens.output;
    // `totalUsd` of 0 is a real price (a free tier). Only `source: 'none'`
    // means unknown, and an unknown must never sum as zero.
    if (row.price.source === 'none' || row.price.totalUsd === undefined) {
      bucket.unpricedRequests += 1;
      unpriced.requests += 1;
      unpriced.input += row.tokens.input;
      unpriced.output += row.tokens.output;
    } else {
      bucket.costUsd += row.price.totalUsd;
      pricedTotalUsd += row.price.totalUsd;
    }
    buckets.set(label, bucket);
  }

  return {
    buckets: [...buckets.values()].sort((a, b) => b.costUsd - a.costUsd || b.requests - a.requests),
    pricedTotalUsd,
    unpriced,
  };
}

export async function cmdUsage(opts: {
  home: string;
  since: string;
  by: UsageDimension;
  session?: string;
  json: boolean;
}): Promise<UsageReport> {
  const now = Date.now();
  let rows = readRows(opts.home, now - parseDuration(opts.since), now);
  if (opts.session !== undefined) rows = rows.filter((row) => row.session === opts.session);
  const report = aggregate(rows, opts.by, loadSessions(opts.home));
  const cache = loadAiPricing(opts.home);
  if (cache !== undefined) {
    const fetched = Date.parse(cache.fetchedAt);
    if (Number.isFinite(fetched)) report.priceCacheAgeMs = now - fetched;
  }
  return report;
}