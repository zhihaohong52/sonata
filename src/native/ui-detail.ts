/**
 * Opening a row.
 *
 * A routed session's log is its request stream; a dispatch run's log is its
 * real terminal transcript. Both are read through the functions the CLI
 * already uses (`recentRoutes`, `readEvents`, `readReport`).
 */
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

import { readRows } from '../ledger.js';
import { recentRoutes, type RouteLine } from '../commands/status.js';
import { readEvents, readReport, runDir } from '../store.js';
import { parseFilters } from './ui-usage.js';
import { projectDirs } from './ui-runs.js';
import type { UiDeps } from './ui.js';

/** `events.jsonl` has no size bound; a response must. */
export const MAX_TRANSCRIPT_BYTES = 262_144;
export const MAX_ROUTE_LINES = 500;

export function sessionDetail(
  deps: UiDeps,
  id: string,
  query: URLSearchParams,
): { id: string; routes: RouteLine[] } {
  const now = (deps.now ?? Date.now)();
  const filters = parseFilters(query, now);
  const rows = readRows(deps.home, filters.sinceMs, now).filter((row) => row.session === id);
  return { id, routes: recentRoutes(rows, MAX_ROUTE_LINES) };
}

export function runDetail(
  deps: UiDeps,
  id: string,
  cwdParam: string | undefined,
): { id: string; cwd: string; transcript: string; truncated: boolean; report: string | null } | undefined {
  // The cwd is a query parameter, so it is caller-controlled. It is only ever
  // honoured when it names a project discovery already found -- otherwise the
  // parameter would be a way to read a run directory anywhere on the machine.
  const allowed = projectDirs(deps);
  const candidates = cwdParam === undefined ? allowed : allowed.filter((dir) => sameDir(dir, cwdParam));

  for (const cwd of candidates) {
    if (!existsSync(join(runDir(cwd, id), 'meta.json'))) continue;
    const whole = readEvents(cwd, id).join('\n');
    const truncated = Buffer.byteLength(whole, 'utf8') > MAX_TRANSCRIPT_BYTES;
    return {
      id,
      cwd,
      // Tail-first: the end of a run is what says how it finished.
      transcript: truncated ? whole.slice(-MAX_TRANSCRIPT_BYTES) : whole,
      truncated,
      report: readReport(cwd, id),
    };
  }
  return undefined;
}

function sameDir(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}
