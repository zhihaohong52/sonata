/**
 * The `kind: 'session'` half of the merged list: routed Claude Code sessions.
 *
 * A session's "log" is its request stream -- these rows are the summary of it.
 * Built by grouping the ledger on `session`, so a session that registered but
 * never issued a request has no row: an empty row would say "this session cost
 * nothing" where the truth is "nothing was routed for it".
 */
import { readRowsAsync } from '../ledger.js';
import { loadSessions } from '../sessions.js';
import { aggregate, labelOf, projectResolver } from '../commands/usage.js';
import type { UiFilters } from './ui-usage.js';
import type { UiDeps } from './ui.js';

export interface SessionRow {
  kind: 'session';
  id: string;
  project: string;
  started?: string;
  requests: number;
  input: number;
  output: number;
  /** Money spent. Covered and unpriced volume are deliberately not folded in. */
  costUsd: number;
  coveredUsd: number;
  unpricedRequests: number;
  /**
   * Turns withdrawn for an unrecoverable text tool call, and their priced
   * cost: billed, so spend, but not served, so in no figure above.
   */
  withdrawnTurns: number;
  withdrawnUsd: number;
  models: string[];
}

export async function sessionRows(deps: UiDeps, filters: UiFilters): Promise<SessionRow[]> {
  const now = (deps.now ?? Date.now)();
  const sessions = loadSessions(deps.home);
  const resolve = projectResolver(deps.home);
  const wanted = filters.project === undefined ? undefined : resolve(filters.project);

  let rows = await readRowsAsync(deps.home, filters.sinceMs, now);
  if (filters.session !== undefined) rows = rows.filter((row) => row.session === filters.session);
  if (filters.project !== undefined) {
    rows = rows.filter((row) => labelOf(row, 'project', sessions, resolve) === wanted);
  }

  const report = aggregate(rows, 'session', sessions, resolve);
  const servedBySession = new Map<string, Set<string>>();
  const withdrawnBySession = new Map<string, { turns: number; usd: number }>();
  for (const row of rows) {
    const id = row.session;
    if (id === undefined) continue;
    if (row.withdrawn === true) {
      const w = withdrawnBySession.get(id) ?? { turns: 0, usd: 0 };
      w.turns += 1;
      if (row.price.source !== 'none' && row.price.source !== 'covered' && row.price.totalUsd !== undefined) w.usd += row.price.totalUsd;
      withdrawnBySession.set(id, w);
      continue;
    }
    const served = row.key ?? row.alias;
    if (served === '') continue;
    const models = servedBySession.get(id) ?? new Set<string>();
    models.add(served);
    servedBySession.set(id, models);
  }

  return report.buckets
    .filter((bucket) => bucket.label !== 'unknown')
    .map((bucket) => ({
      kind: 'session' as const,
      id: bucket.label,
      project: labelOf(
        // The bucket only exists because at least one filtered row has this id.
        rows.find((row) => row.session === bucket.label)!,
        'project',
        sessions,
        resolve,
      ),
      started: sessions[bucket.label]?.started,
      requests: bucket.requests,
      input: bucket.input,
      output: bucket.output,
      costUsd: bucket.costUsd,
      coveredUsd: bucket.coveredUsd,
      unpricedRequests: bucket.unpricedRequests,
      withdrawnTurns: withdrawnBySession.get(bucket.label)?.turns ?? 0,
      withdrawnUsd: withdrawnBySession.get(bucket.label)?.usd ?? 0,
      models: [...(servedBySession.get(bucket.label) ?? new Set<string>())].sort(),
    }))
    .sort(
      (a, b) => (Date.parse(b.started ?? '') || 0) - (Date.parse(a.started ?? '') || 0)
        || a.id.localeCompare(b.id),
    );
}
