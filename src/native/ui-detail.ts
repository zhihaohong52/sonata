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
/** `report.md` has no size bound either, and it rides the same response. */
export const MAX_REPORT_BYTES = 262_144;
export const MAX_ROUTE_LINES = 500;

/**
 * Cap a string in the **byte** domain, never the character one.
 *
 * Slicing bytes can land mid-sequence, so the kept range is advanced (or
 * retreated) to a UTF-8 character boundary: a lone continuation byte decodes
 * to U+FFFD and a split surrogate pair is worse still.
 *
 * `keep` is not cosmetic. A transcript keeps its **tail**, because the end of a
 * run is what says how it finished. A report keeps its **head**, because
 * sonata's own annotations — `[timed out: …]`, `[no worktree change: …]`,
 * `[effort … not honoured: …]` — are prefixes, and they are precisely the part
 * that says whether the rest can be believed.
 */
export function truncateBytes(
  value: string,
  maxBytes: number,
  keep: 'head' | 'tail',
): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= maxBytes) return { text: value, truncated: false };
  const isContinuation = (i: number): boolean => i < bytes.byteLength && (bytes[i] & 0xc0) === 0x80;
  if (keep === 'tail') {
    let start = bytes.byteLength - maxBytes;
    while (isContinuation(start)) start += 1;
    return { text: bytes.subarray(start).toString('utf8'), truncated: true };
  }
  let end = maxBytes;
  while (end > 0 && isContinuation(end)) end -= 1;
  return { text: bytes.subarray(0, end).toString('utf8'), truncated: true };
}

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
): {
  id: string; cwd: string;
  transcript: string; truncated: boolean;
  report: string | null; reportTruncated: boolean;
} | undefined {
  // Run ids are six lowercase hex characters from newRunId(). Validate before
  // constructing any path so a caller cannot use traversal or an absolute id.
  if (!/^[0-9a-f]{6}$/.test(id)) return undefined;

  // The cwd is a query parameter, so it is caller-controlled. It is only ever
  // honoured when it names a project discovery already found -- otherwise the
  // parameter would be a way to read a run directory anywhere on the machine.
  const allowed = projectDirs(deps);
  const candidates = cwdParam === undefined ? allowed : allowed.filter((dir) => sameDir(dir, cwdParam));

  for (const cwd of candidates) {
    if (!existsSync(join(runDir(cwd, id), 'meta.json'))) continue;
    // Tail-first: the end of a run is what says how it finished.
    const tail = truncateBytes(readEvents(cwd, id).join('\n'), MAX_TRANSCRIPT_BYTES, 'tail');
    const whole = readReport(cwd, id);
    // A report capped nowhere would defeat the cap it is returned beside.
    // Head, not tail -- deliberately the opposite of the transcript, and NOT an
    // oversight to be tidied up later. Sonata's own annotations are prefixes
    // (`[timed out: …]`, `[no worktree change: …]`, `[effort … not honoured:
    // …]`), and they are exactly what tells a reader whether the rest of the
    // report can be believed. Truncating them away would hide the notice that
    // says the content is untrustworthy.
    const report = whole === null ? null : truncateBytes(whole, MAX_REPORT_BYTES, 'head');
    return {
      id,
      cwd,
      transcript: tail.text,
      truncated: tail.truncated,
      report: report === null ? null : report.text,
      reportTruncated: report !== null && report.truncated,
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
