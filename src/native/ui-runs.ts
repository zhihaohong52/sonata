/**
 * The `kind: 'run'` half of the merged list: `sonata dispatch` runs.
 *
 * A run executes in the foreign CLI's own process against that CLI's own
 * credentials and never transits the router. Its usage is read from the
 * harness's own store once it finishes (`src/harness-usage.ts`) and written to
 * the ledger, where the usage views already count it; this row therefore
 * carries `usage: null` and says in `usageReason` what was recorded — never a
 * `0` standing in for "not read".
 */
import { existsSync, realpathSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { RunSummary } from '../commands/runs.js';
import { sonataDir, runDir } from '../store.js';
import { reportPathFor } from '../report-contract.js';
import { readRecordedUsage } from '../harness-usage.js';
import { loadSessions } from '../sessions.js';
import { projectResolver } from '../commands/usage.js';
import type { UiFilters } from './ui-usage.js';
import type { UiDeps } from './ui.js';

/** A run whose usage has not been read yet: it has not been tailed to completion. */
export const RUN_USAGE_REASON =
  'not read yet: a dispatch run\'s usage is recorded when it is tailed to completion';

/** What a run's `usage.json` says, in words for the run row. */
export function runUsageReason(cwd: string, id: string): string {
  const recorded = readRecordedUsage(cwd, id);
  if (recorded === undefined) return RUN_USAGE_REASON;
  if (recorded.kind === 'router') return 'counted by the router: this run\'s requests are in the ledger under its session';
  if (recorded.kind === 'unobservable') return `not observable: ${recorded.reason}`;
  const t = recorded.tokens;
  const tokens = t.input + t.output + t.cacheRead + t.cacheCreation;
  const cost = recorded.price.source === 'none' ? 'unpriced' : `$${recorded.price.totalUsd.toFixed(4)}`;
  return `recorded in the ledger: ${tokens} tokens, ${cost}`;
}

/** A bound on how many directories one page load may stat. */
export const MAX_PROJECT_DIRS = 200;
/**
 * A bound on how many candidates one page load may *consider*.
 *
 * `MAX_PROJECT_DIRS` bounds the accepted set, which is not the same thing: a
 * rejected candidate (gone, duplicate, unreadable) still costs an `existsSync`
 * plus a `realpathSync`, so a `sessions.json` full of stale entries drove
 * unbounded syscalls on the router's event loop however few directories came
 * out. Every candidate is counted against this before the filesystem is
 * touched at all.
 */
export const MAX_PROJECT_CANDIDATES = 1000;
/** Holding the page open must not re-enumerate the filesystem per render. */
export const PROJECT_CACHE_MS = 5000;
/**
 * A bound on how many run rows one **response** may carry.
 *
 * `MAX_PROJECT_DIRS` bounds how many directories are enumerated, not how many
 * runs live in them, so without this the response array is unbounded.
 */
export const MAX_RUN_ROWS = 500;

/**
 * The ceiling on one project's contribution to the cached list.
 *
 * `MAX_RUN_ROWS` bounds what a request returns; this bounds what the cache
 * holds, applied **per project** as the scan collects it. A single ceiling on
 * the combined list was tried and is wrong in the same way capping before
 * filtering is: one busy project's newest runs would evict a quiet project's
 * rows entirely, and a filter for the quiet project would then answer empty
 * with `truncated: false`. The cap is `MAX_RUN_ROWS` because no single
 * response can show more of one project than that anyway.
 */
export const MAX_CACHED_RUN_ROWS_PER_PROJECT = MAX_RUN_ROWS;

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
let cache: {
  at: number; key: string;
  dirs: string[];
  /** Whether discovery stopped short — see `projectDiscovery`. */
  dirsTruncated: boolean;
  rows?: RunRow[];
} | undefined;

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
export function projectDiscovery(deps: UiDeps): { dirs: string[]; truncated: boolean } {
  const now = (deps.now ?? Date.now)();
  const tenantPaths = (deps.tenants?.() ?? []).map((tenant) => tenant.configPath);
  const cacheKey = JSON.stringify([deps.home, tenantPaths]);
  if (cache !== undefined && cache.key === cacheKey && now - cache.at < PROJECT_CACHE_MS) {
    return { dirs: cache.dirs, truncated: cache.dirsTruncated };
  }

  const seen = new Set<string>();
  const out: string[] = [];
  let considered = 0;
  let truncated = false;
  const add = (dir: string | undefined): void => {
    if (dir === undefined || dir === '') return;
    if (out.length >= MAX_PROJECT_DIRS || considered >= MAX_PROJECT_CANDIDATES) {
      // Said out loud rather than left implicit: a short list must not read as
      // "these are all the projects".
      truncated = true;
      return;
    }
    considered += 1;
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

  cache = { at: now, key: cacheKey, dirs: out, dirsTruncated: truncated };
  return { dirs: out, truncated };
}

/** The discovered directories alone, for callers with no use for the flag. */
export function projectDirs(deps: UiDeps): string[] {
  return projectDiscovery(deps).dirs;
}

/**
 * `summarizeRuns` for the UI: the same fields, without reading report bodies.
 *
 * `src/commands/runs.ts` is shared with `sonata runs` and stays unchanged; it
 * calls `readReport` — loading a whole report into memory — purely to decide
 * `degraded`, which is a fine cost in a one-shot CLI process and not one the
 * router's event loop gets to pay per page load. Its definition of `degraded`
 * is `exit !== null && (exit !== 0 || report === null)`, and `readReport`
 * returns `null` exactly when the file is absent, so report **presence** is
 * that predicate's whole contribution. Everything else here is field-for-field
 * `summarizeRuns`, including skipping a half-written run directory rather than
 * failing the page.
 */
export async function uiRunSummaries(cwd: string): Promise<RunSummary[]> {
  let ids: string[];
  try {
    ids = (await fsp.readdir(join(sonataDir(cwd), 'runs'))).sort();
  } catch {
    return []; // no runs directory at all — the same answer `listRuns` gives
  }
  const out: RunSummary[] = [];
  for (const id of ids) {
    try {
      const dir = runDir(cwd, id);
      const meta = JSON.parse(await fsp.readFile(join(dir, 'meta.json'), 'utf8')) as {
        role?: string; model?: string; startedAt?: string;
      };
      const exit = await readExitAsync(join(dir, 'exit'));
      const report = await exists(reportPathFor(dir));
      out.push({
        id,
        state: exit === null ? 'RUNNING' : 'DONE',
        degraded: exit !== null && (exit !== 0 || !report),
        role: meta.role,
        model: meta.model,
        started: meta.startedAt,
        report,
      });
    } catch {
      // A half-written or hand-edited run directory is skipped, not fatal.
      continue;
    }
  }
  return out;
}

async function exists(path: string): Promise<boolean> {
  try {
    await fsp.access(path);
    return true;
  } catch {
    return false;
  }
}

/** `readExit`'s semantics: absent or unparseable reads as still running. */
async function readExitAsync(path: string): Promise<number | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(path, 'utf8');
  } catch {
    return null;
  }
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isNaN(n) ? null : n;
}

/**
 * Every run row across every discovered project, newest first, **uncapped**.
 *
 * Cached unfiltered and uncapped deliberately: this value is shared by every
 * filter, so baking either a filter or a cap into it would let the first query
 * to warm the cache decide what every later one can see.
 */
async function allRunRows(deps: UiDeps): Promise<RunRow[]> {
  const dirs = projectDiscovery(deps).dirs; // also refreshes `cache` when it is stale
  // Keep the entry selected for this scan. Another request may replace the
  // module cache while the filesystem awaits below; that result must not be
  // written into the replacement entry.
  const entry = cache;
  const cached = entry?.rows;
  if (cached !== undefined) return cached;

  const resolve = projectResolver(deps.home);
  const out: RunRow[] = [];

  for (const cwd of dirs) {
    const project = resolve(cwd);
    // Where this project's rows start, so the cap below applies to *it* rather
    // than to the combined list. A global trim is the same error as capping
    // before filtering: one busy project's newest runs would evict a quiet
    // project's runs entirely, and a filter for the quiet one would answer
    // empty with `truncated: false` — an answer that is both wrong and
    // confident.
    const startOfProject = out.length;
    let summaries: RunSummary[];
    try {
      summaries = await uiRunSummaries(cwd);
    } catch {
      continue; // an unreadable project is skipped, never fatal to the page
    }
    for (const run of summaries) {
      out.push({
        kind: 'run', id: run.id, project, cwd,
        role: run.role, model: run.model, state: run.state,
        degraded: run.degraded, started: run.started, report: run.report,
        usage: null, usageReason: runUsageReason(cwd, run.id),
      });
    }
    // Newest first within the project, then capped. `MAX_RUN_ROWS` is a
    // response cap, so a project holding more than that can never show all of
    // them in one answer anyway; what this protects is the *other* projects'
    // presence in the cache.
    if (out.length - startOfProject > MAX_CACHED_RUN_ROWS_PER_PROJECT) {
      const mine = out.splice(startOfProject, out.length - startOfProject);
      mine.sort(
        (a, b) => (Date.parse(b.started ?? '') || 0) - (Date.parse(a.started ?? '') || 0) || a.id.localeCompare(b.id),
      );
      out.push(...mine.slice(0, MAX_CACHED_RUN_ROWS_PER_PROJECT));
    }
  }

  out.sort(
    (a, b) => (Date.parse(b.started ?? '') || 0) - (Date.parse(a.started ?? '') || 0) || a.id.localeCompare(b.id),
  );
  // The cache is bounded per project, in the loop above, rather than here.
  // Trimming the combined list would let one busy project evict another's rows
  // entirely — the same failure as capping before filtering, which the
  // filter-then-cap order exists to prevent.
  if (cache === entry && entry !== undefined) entry.rows = out;
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
export async function runRows(
  deps: UiDeps,
  filters: UiFilters,
): Promise<{ rows: RunRow[]; truncated: boolean; discoveryTruncated: boolean }> {
  const discoveryTruncated = projectDiscovery(deps).truncated;
  // A run has no Claude Code session id, so it can never match a session
  // filter. Returning nothing is the honest answer; returning every run would
  // ignore the filter the user set.
  if (filters.session !== undefined) return { rows: [], truncated: false, discoveryTruncated };

  // The filter is applied on the READ side of the cache, never baked into the
  // cached value -- otherwise the first filter to warm it would poison it for
  // every other filter.
  // A copy. Nothing mutates this today — `route()` spreads it before it
  // reaches the response — but the safety then lives at the call site rather
  // than at the source, and a future caller that sorts or splices in place
  // would corrupt the shared cache for every later request. The symptom would
  // be one project's rows appearing under another's filter: the cross-key leak
  // #38's review caught twice, once in the keying and once in the async
  // write-back. A `slice()` on a bounded list is cheap beside the filesystem
  // scan that produced it.
  const all = (await allRunRows(deps)).slice();
  const matched = filters.project === undefined
    ? all
    : (() => {
        const wanted = projectResolver(deps.home)(filters.project);
        return all.filter((row) => row.project === wanted);
      })();

  if (matched.length <= MAX_RUN_ROWS) return { rows: matched, truncated: false, discoveryTruncated };
  return { rows: matched.slice(0, MAX_RUN_ROWS), truncated: true, discoveryTruncated };
}
