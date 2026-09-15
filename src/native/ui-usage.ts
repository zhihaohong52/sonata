/**
 * `/__sonata/api/usage` — the CLI's report, with a selector on it.
 *
 * Parameter parsing and nothing else: every figure comes back from
 * `aggregate`, so the page and `sonata usage` cannot disagree about money.
 */
import { readRowsAsync } from '../ledger.js';
import { loadSessions } from '../sessions.js';
import {
  aggregate, labelOf, parseDuration, projectResolver,
  type UsageDimension, type UsageReport,
} from '../commands/usage.js';
import type { UiDeps } from './ui.js';

/** The one definition of what `?by=` accepts; the HTTP layer validates against it. */
export const USAGE_DIMENSIONS: UsageDimension[] = ['model', 'role', 'tier', 'effort', 'gateway', 'session', 'project'];
const DEFAULT_WINDOW_MS = 86_400_000;

export interface UiFilters {
  sinceMs: number;
  project?: string;
  session?: string;
}

function nonEmpty(value: string | null): string | undefined {
  return value === null || value === '' ? undefined : value;
}

export function parseFilters(query: URLSearchParams, now: number): UiFilters {
  const since = nonEmpty(query.get('since'));
  let window = DEFAULT_WINDOW_MS;
  if (since !== undefined) {
    // A bad duration in a URL is a typo, not a reason to show an error page
    // where a default window would do. `by` is different: silently reporting a
    // dimension the user did not ask for is a wrong answer, not a lenient one.
    try { window = parseDuration(since); } catch { window = DEFAULT_WINDOW_MS; }
  }
  return {
    sinceMs: now - window,
    project: nonEmpty(query.get('project')),
    session: nonEmpty(query.get('session')),
  };
}

export async function usagePayload(
  deps: UiDeps,
  query: URLSearchParams,
): Promise<{ report: UsageReport; by: UsageDimension; filters: UiFilters }> {
  const by = (nonEmpty(query.get('by')) ?? 'model') as UsageDimension;
  if (!USAGE_DIMENSIONS.includes(by)) {
    throw new Error(`sonata UI: unknown dimension "${by}" — use one of ${USAGE_DIMENSIONS.join(', ')}`);
  }
  const now = (deps.now ?? Date.now)();
  const filters = parseFilters(query, now);
  const sessions = loadSessions(deps.home);
  const resolve = projectResolver(deps.home);

  let rows = await readRowsAsync(deps.home, filters.sinceMs, now);
  if (filters.session !== undefined) rows = rows.filter((row) => row.session === filters.session);
  if (filters.project !== undefined) {
    // Resolved labels, never raw cwds — the same pooling `[budget] daily_usd`
    // applies, so the page cannot disagree with the cap that refuses requests.
    const wanted = resolve(filters.project);
    rows = rows.filter((row) => labelOf(row, 'project', sessions, resolve) === wanted);
  }
  return { report: aggregate(rows, by, sessions, resolve), by, filters };
}
