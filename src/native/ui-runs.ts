/**
 * The `kind: 'run'` half of the merged list: `sonata dispatch` runs.
 *
 * A run executes in the foreign CLI's own process against that CLI's own
 * credentials and never transits the router, so there is no ledger row for it
 * and its usage is `null` with a reason -- never `0`. Reading those numbers
 * out of each harness's own session store is feasible and deferred; see the
 * spec's "Deliberately not done".
 */
import { existsSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';

import { summarizeRuns } from '../commands/runs.js';
import { loadSessions } from '../sessions.js';
import { projectResolver } from '../commands/usage.js';
import type { UiFilters } from './ui-usage.js';
import type { UiDeps } from './ui.js';

export const RUN_USAGE_REASON =
  'not observable: this run executed in the harness\'s own process and never transited the router';

/** A bound on how many directories one page load may stat. */
export const MAX_PROJECT_DIRS = 200;
/** Holding the page open must not re-enumerate the filesystem per render. */
export const PROJECT_CACHE_MS = 5000;
/**
 * A bound on how many run rows one **response** may carry.
 *
 * `MAX_PROJECT_DIRS` bounds how many directories are enumerated, not how many
 * runs live in them, so without this the response array is unbounded.
 */
export const MAX_RUN_ROWS = 500;

export interface RunRow {
  kind: 'run';
  id: string;
  project: string;
  cwd: string;
  role?: string;
  model?: string;
  state: string;
  degraded: boolean;
  started?: string;
  report: boolean;
  usage: null;
  usageReason: string;
}

/**
 * Directory discovery *and* the computed rows share one entry under one TTL.
 *
 * Caching discovery alone was not the fix it looked like: `summarizeRuns` was
 * still called per request for every project, reading every run's `meta.json`,
 * `exit` and whole `report.md` synchronously -- on the event loop the router
 * serves every native agent's request from.
 */
let cache: { at: number; key: string; dirs: string[]; rows?: RunRow[] } | undefined;

export function clearUiRunCache(): void {
  cache = undefined;
}

/**
 * Where run directories might be.
 *
 * Two sources only: projects that have routed (the tenant registry) and
 * projects a session was recorded in. A project that has done neither will not
 * appear -- accepted in the spec, because the alternative is walking the
 * user's home looking for `.sonata` directories, which the daemon does not get
 * to do.
 */
export function projectDirs(deps: UiDeps): string[] {
  const now = (deps.now ?? Date.now)();
  const tenantPaths = (deps.tenants?.() ?? []).map((tenant) => tenant.configPath);
  const cacheKey = JSON.stringify([deps.home, tenantPaths]);
  if (cache !== undefined && cache.key === cacheKey && now - cache.at < PROJECT_CACHE_MS) return cache.dirs;

  const seen = new Set<string>();
  const out: string[] = [];
  const add = (dir: string | undefined): void => {
    if (dir === undefined || dir === '' || out.length >= MAX_PROJECT_DIRS) return;
    let key: string;
    try {
      if (!existsSync(dir)) return;
      // Canonical, for the same reason the tenant id is: /var and /private/var
      // are one directory and must not enumerate as two.
      key = realpathSync(dir);
    } catch {
      return;
    }
    if (seen.has(key)) return;
    seen.add(key);
    // Keep the caller's spelling for project labels; use the real path only
    // for identity so symlinked spellings still collapse into one directory.
    out.push(dir);
  };

  for (const configPath of tenantPaths) {
    if (configPath !== null) add(dirname(configPath));
  }
  for (const record of Object.values(loadSessions(deps.home))) add(record?.cwd);

  cache = { at: now, key: cacheKey, dirs: out };
  return out;
}

/**
 * Every run row across every discovered project, newest first, **uncapped**.
 *
 * Cached unfiltered and uncapped deliberately: this value is shared by every
 * filter, so baking either a filter or a cap into it would let the first query
 * to warm the cache decide what every later one can see.
 */
function allRunRows(deps: UiDeps): RunRow[] {
  const dirs = projectDirs(deps); // also refreshes `cache` when it is stale
  const cached = cache?.rows;
  if (cached !== undefined) return cached;

  const resolve = projectResolver(deps.home);
  const out: RunRow[] = [];

  for (const cwd of dirs) {
    const project = resolve(cwd);
    let summaries: ReturnType<typeof summarizeRuns>;
    try {
      summaries = summarizeRuns(cwd);
    } catch {
      continue; // an unreadable project is skipped, never fatal to the page
    }
    for (const run of summaries) {
      out.push({
        kind: 'run', id: run.id, project, cwd,
        role: run.role, model: run.model, state: run.state,
        degraded: run.degraded, started: run.started, report: run.report,
        usage: null, usageReason: RUN_USAGE_REASON,
      });
    }
  }

  out.sort(
    (a, b) => (Date.parse(b.started ?? '') || 0) - (Date.parse(a.started ?? '') || 0) || a.id.localeCompare(b.id),
  );
  if (cache !== undefined) cache.rows = out;
  return out;
}

/**
 * The rows for one query, and whether the cap hid any of them.
 *
 * Order of operations is filter, then sort, then cap -- and each step is where
 * it is for a reason. **Filtering precedes the cap** because a cap exists to
 * bound a response, not to reinterpret the query: capping first would make a
 * project filter show that project's share of the newest N *globally*, so
 * filtering to a quiet project on a busy machine could return nothing while
 * that project has plenty of runs. **Sorting precedes the cap** because the
 * rows are gathered directory by directory, so capping during collection would
 * keep the first directory's rows and silently drop newer runs from every
 * later one. (The cached list is already sorted, and filtering preserves
 * order, so the sort is not redone per request.)
 *
 * `truncated` is reported rather than left implicit: a silently short list is
 * the same class of problem as a `0` that means unknown.
 */
export function runRows(
  deps: UiDeps,
  filters: UiFilters,
): { rows: RunRow[]; truncated: boolean } {
  // A run has no Claude Code session id, so it can never match a session
  // filter. Returning nothing is the honest answer; returning every run would
  // ignore the filter the user set.
  if (filters.session !== undefined) return { rows: [], truncated: false };

  // The filter is applied on the READ side of the cache, never baked into the
  // cached value -- otherwise the first filter to warm it would poison it for
  // every other filter.
  const all = allRunRows(deps);
  const matched = filters.project === undefined
    ? all
    : (() => {
        const wanted = projectResolver(deps.home)(filters.project);
        return all.filter((row) => row.project === wanted);
      })();

  if (matched.length <= MAX_RUN_ROWS) return { rows: matched, truncated: false };
  return { rows: matched.slice(0, MAX_RUN_ROWS), truncated: true };
}
