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
import { existsSync } from 'node:fs';
import { dirname, join, resolve as resolve0 } from 'node:path';

import { configPath, GLOBAL_CONFIG_RELATIVE } from '../config.js';
import { loadModelsDev } from '../modelsdev.js';
import { readRows, type LedgerRow } from '../ledger.js';
import { loadSessions, type SessionRecord } from '../sessions.js';

export type UsageDimension = 'model' | 'role' | 'tier' | 'gateway' | 'session' | 'project';

export interface UsageBucket {
  label: string;
  requests: number;
  input: number;
  output: number;
  /** Money spent. Never includes covered work — see `coveredUsd`. */
  costUsd: number;
  /**
   * Subscription-backed work, valued at list but never billed per token.
   *
   * Reported in its own column rather than added to `costUsd`, so a bucket's
   * spend figure agrees with the report's `priced total`.
   */
  coveredUsd: number;
  unpricedRequests: number;
  coveredRequests: number;
}

export interface UsageReport {
  buckets: UsageBucket[];
  pricedTotalUsd: number;
  unpriced: { requests: number; input: number; output: number };
  covered: { requests: number; totalUsd: number };
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

/**
 * Which project owns a working directory, for grouping and filtering.
 *
 * Resolves through `configPath`, so a linked git worktree lands on its main
 * checkout — the same borrow the router uses, and therefore the same pooling
 * `[budget] daily_usd` already enforces. Reporting a worktree's spend on its
 * own line while the cap counted it against the main checkout meant a refusal
 * could fire at a number appearing nowhere in the report.
 *
 * Grouping on the ledger's `tenant` id would be the obvious alternative and is
 * wrong here: only 2,871 of 24,774 rows on the development machine carry one
 * (the field postdates most of the history), so 88% would collapse into a
 * single "unknown" bucket. This is computed at report time and therefore works
 * on every row, however old.
 *
 * A cwd that resolves to the *machine* config keeps its own label rather than
 * merging: those requests really are served by that config, but collapsing
 * every configless directory into one bucket destroys more information than it
 * repairs. Only a project-config match pools.
 */
export type ProjectResolver = (cwd: string) => string;

export function projectResolver(home: string): ProjectResolver {
  const cache = new Map<string, string>();
  const machine = join(home, GLOBAL_CONFIG_RELATIVE);
  return (cwd) => {
    const hit = cache.get(cwd);
    if (hit !== undefined) return hit;
    let label = cwd;
    try {
      // A directory that no longer exists resolves to the machine config by
      // fallthrough, which would silently relabel a deleted project. Keep the
      // path it was recorded under instead.
      if (existsSync(cwd)) {
        const path = configPath(cwd, home);
        if (path !== null && path !== machine) label = dirname(path);
      }
    } catch {
      // Resolution is an improvement to grouping, never a new way to fail.
    }
    cache.set(cwd, label);
    return label;
  };
}

function labelOf(
  row: LedgerRow,
  by: UsageDimension,
  sessions: Record<string, SessionRecord>,
  resolve?: ProjectResolver,
): string {
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
    case 'project': {
      const cwd = row.project ?? (row.session === undefined ? undefined : sessions[row.session]?.cwd);
      if (cwd === undefined) return 'unknown';
      return resolve === undefined ? cwd : resolve(cwd);
    }
  }
}

export function aggregate(
  rows: LedgerRow[],
  by: UsageDimension,
  sessions: Record<string, SessionRecord>,
  resolve?: ProjectResolver,
): UsageReport {
  const buckets = new Map<string, UsageBucket>();
  const unpriced = { requests: 0, input: 0, output: 0 };
  const covered = { requests: 0, totalUsd: 0 };
  let pricedTotalUsd = 0;

  for (const row of rows) {
    const label = labelOf(row, by, sessions, resolve);
    const bucket = buckets.get(label) ?? {
      label, requests: 0, input: 0, output: 0, costUsd: 0, coveredUsd: 0, unpricedRequests: 0, coveredRequests: 0,
    };
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
    } else if (row.price.source === 'covered') {
      // Kept out of `costUsd`, which is spend. Folding it in made the cost
      // column disagree with its own `priced total`, and left a ` ~` flag as
      // the only hint — a flag that cannot say *how much*: measured on real
      // data, one project showed $167.10 of which $0.000000 was covered and
      // another showed $10.34 of which all of it was, marked identically.
      bucket.coveredUsd += row.price.totalUsd;
      bucket.coveredRequests += 1;
      covered.requests += 1;
      covered.totalUsd += row.price.totalUsd;
    } else {
      bucket.costUsd += row.price.totalUsd;
      pricedTotalUsd += row.price.totalUsd;
    }
    buckets.set(label, bucket);
  }

  return {
    // Ordered by total value (spend + covered), not spend alone: a bucket
    // that is entirely subscription work is still the largest thing in the
    // report and must not sink to the bottom now that its cost column is 0.
    buckets: [...buckets.values()].sort(
      (a, b) => (b.costUsd + b.coveredUsd) - (a.costUsd + a.coveredUsd) || b.requests - a.requests,
    ),
    pricedTotalUsd,
    unpriced,
    covered,
  };
}

export async function cmdUsage(opts: {
  home: string;
  since: string;
  by: UsageDimension;
  session?: string;
  /** Restrict to one project, named by any directory inside it. */
  project?: string;
  json: boolean;
}): Promise<UsageReport> {
  const now = Date.now();
  let rows = readRows(opts.home, now - parseDuration(opts.since), now);
  if (opts.session !== undefined) rows = rows.filter((row) => row.session === opts.session);

  const sessions = loadSessions(opts.home);
  const resolve = projectResolver(opts.home);
  if (opts.project !== undefined) {
    // Compare resolved labels, not raw paths: `--project .` from inside a
    // worktree must select the main checkout's rows too, exactly as the
    // budget pools them.
    const wanted = resolve(resolve0(opts.project));
    rows = rows.filter((row) => labelOf(row, 'project', sessions, resolve) === wanted);
  }

  const report = aggregate(rows, opts.by, sessions, resolve);
  const cache = loadModelsDev(opts.home);
  if (cache !== undefined) {
    const fetched = Date.parse(cache.fetchedAt);
    if (Number.isFinite(fetched)) report.priceCacheAgeMs = now - fetched;
  }
  return report;
}