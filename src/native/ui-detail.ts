/**
 * Opening a row.
 *
 * A routed session's log is its request stream; a dispatch run's log is its
 * real terminal transcript. Both are read through the functions the CLI
 * already uses (`recentRoutes`, `readEvents`, `readReport`).
 */
import { realpathSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { join } from 'node:path';

import { readRowsAsync } from '../ledger.js';
import { recentRoutes, type RouteLine } from '../commands/status.js';
import { runDir } from '../store.js';
import { reportPathFor } from '../report-contract.js';
import { parseFilters } from './ui-usage.js';
import { projectDiscovery } from './ui-runs.js';
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

/**
 * A bounded window of one file, read without loading the rest of it.
 *
 * `events.jsonl` and `report.md` have no size bound, so reading them whole and
 * then applying the cap put the entire file on the router's heap to return at
 * most `maxBytes` of it. Open, stat, seek, read the window, close.
 *
 * The boundary correction is the byte-domain one `truncateBytes` performs and
 * for the same reason: a window edge can land mid-sequence, and a lone
 * continuation byte decodes to U+FFFD.
 */
async function readWindow(
  path: string,
  maxBytes: number,
  keep: 'head' | 'tail',
): Promise<{ text: string; truncated: boolean } | null> {
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(path, 'r');
  } catch {
    return null; // absent, or unreadable — indistinguishable from the caller's side
  }
  try {
    const size = (await handle.stat()).size;
    if (size <= maxBytes) {
      const whole = Buffer.alloc(size);
      if (size > 0) await handle.read(whole, 0, size, 0);
      return { text: whole.toString('utf8'), truncated: false };
    }
    // One byte past the cap on the head path: the boundary test asks what the
    // FIRST excluded byte is, and without it a sequence cut by the cap decodes
    // to U+FFFD -- three bytes where one was trimmed, pushing the result back
    // OVER the cap it was meant to respect.
    const want = keep === 'tail' ? maxBytes : maxBytes + 1;
    const position = keep === 'tail' ? size - maxBytes : 0;
    const window = Buffer.alloc(want);
    const { bytesRead } = await handle.read(window, 0, want, position);
    const bytes = window.subarray(0, bytesRead);
    const isContinuation = (i: number): boolean => i < bytes.byteLength && (bytes[i] & 0xc0) === 0x80;
    if (keep === 'tail') {
      let start = 0;
      while (isContinuation(start)) start += 1;
      return { text: bytes.subarray(start).toString('utf8'), truncated: true };
    }
    let end = Math.min(maxBytes, bytes.byteLength);
    while (end > 0 && isContinuation(end)) end -= 1;
    return { text: bytes.subarray(0, end).toString('utf8'), truncated: true };
  } finally {
    await handle.close();
  }
}

export async function sessionDetail(
  deps: UiDeps,
  id: string,
  query: URLSearchParams,
): Promise<{ id: string; routes: RouteLine[] }> {
  const now = (deps.now ?? Date.now)();
  const filters = parseFilters(query, now);
  const rows = (await readRowsAsync(deps.home, filters.sinceMs, now)).filter((row) => row.session === id);
  return { id, routes: recentRoutes(rows, MAX_ROUTE_LINES) };
}

export async function runDetail(
  deps: UiDeps,
  id: string,
  cwdParam: string | undefined,
): Promise<{
  id: string; cwd: string;
  transcript: string; truncated: boolean;
  report: string | null; reportTruncated: boolean;
} | undefined> {
  // Run ids are six lowercase hex characters from newRunId(). Validate before
  // constructing any path so a caller cannot use traversal or an absolute id.
  if (!/^[0-9a-f]{6}$/.test(id)) return undefined;

  // The cwd is a query parameter, so it is caller-controlled. It is only ever
  // honoured when it names a project discovery already found -- otherwise the
  // parameter would be a way to read a run directory anywhere on the machine.
  const allowed = projectDiscovery(deps).dirs;
  const candidates = cwdParam === undefined ? allowed : allowed.filter((dir) => sameDir(dir, cwdParam));

  for (const cwd of candidates) {
    const dir = runDir(cwd, id);
    try {
      await fsp.access(join(dir, 'meta.json'));
    } catch {
      continue;
    }
    // Tail-first: the end of a run is what says how it finished. Only the tail
    // is read — the rest of the file is never loaded to be thrown away.
    const window = await readWindow(join(dir, 'events.jsonl'), MAX_TRANSCRIPT_BYTES, 'tail');
    // `readEvents` drops blank lines; the same shaping applied to the window.
    const tail = {
      text: window === null ? '' : window.text.split('\n').filter(Boolean).join('\n'),
      truncated: window?.truncated ?? false,
    };
    const head = await readWindow(reportPathFor(dir), MAX_REPORT_BYTES, 'head');
    // A report capped nowhere would defeat the cap it is returned beside.
    // Head, not tail -- deliberately the opposite of the transcript, and NOT an
    // oversight to be tidied up later. Sonata's own annotations are prefixes
    // (`[timed out: …]`, `[no worktree change: …]`, `[effort … not honoured:
    // …]`), and they are exactly what tells a reader whether the rest of the
    // report can be believed. Truncating them away would hide the notice that
    // says the content is untrustworthy.
    const report = head;
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
