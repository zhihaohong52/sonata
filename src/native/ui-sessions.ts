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
  /** Withdrawn turns on a subscription: list value, like `coveredUsd`, never billed. */
  withdrawnCoveredUsd: number;
  /** Withdrawn turns with no price: their cost is unknown, not zero, and in no USD figure above. */
  withdrawnUnpriced: number;
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
  const withdrawnBySession = new Map<string, { turns: number; usd: number; coveredUsd: number; unpriced: number }>();
  for (const row of rows) {
    const id = row.session;
    if (id === undefined) continue;
    if (row.withdrawn === true) {
      const w = withdrawnBySession.get(id) ?? { turns: 0, usd: 0, coveredUsd: 0, unpriced: 0 };
      w.turns += 1;
      if (row.price.source === 'covered') w.coveredUsd += row.price.totalUsd ?? 0;
      else if (row.price.source !== 'none' && row.price.totalUsd !== undefined) w.usd += row.price.totalUsd;
      else w.unpriced += 1;
      withdrawnBySession.set(id, w);
      continue;
    }
    const served = row.key ?? row.alias;
    if (served === '') continue;
    const models = servedBySession.get(id) ?? new Set<string>();
    models.add(served);
    servedBySession.set(id, models);
  }

  // A session whose only rows are withdrawn turns has no bucket, but it did
  // spend: it is listed with no requests and its withdrawn figures.
  const buckets = new Map(report.buckets.map((bucket) => [bucket.label, bucket]));
  const ids = new Set([...buckets.keys(), ...withdrawnBySession.keys()]);
  ids.delete('unknown');
  return [...ids]
    .map((id) => {
      const bucket = buckets.get(id);
      const withdrawn = withdrawnBySession.get(id);
      return {
        kind: 'session' as const,
        id,
        project: labelOf(
          // The id only exists because at least one filtered row has it.
          rows.find((row) => row.session === id)!,
          'project',
          sessions,
          resolve,
        ),
        started: sessions[id]?.started,
        requests: bucket?.requests ?? 0,
        input: bucket?.input ?? 0,
        output: bucket?.output ?? 0,
        costUsd: bucket?.costUsd ?? 0,
        coveredUsd: bucket?.coveredUsd ?? 0,
        unpricedRequests: bucket?.unpricedRequests ?? 0,
        withdrawnTurns: withdrawn?.turns ?? 0,
        withdrawnUsd: withdrawn?.usd ?? 0,
        withdrawnCoveredUsd: withdrawn?.coveredUsd ?? 0,
        withdrawnUnpriced: withdrawn?.unpriced ?? 0,
        models: [...(servedBySession.get(id) ?? new Set<string>())].sort(),
      };
    })
    .sort(
      (a, b) => (Date.parse(b.started ?? '') || 0) - (Date.parse(a.started ?? '') || 0)
        || a.id.localeCompare(b.id),
    );
}
