/**
 * `sonata runs` — the list `listRuns()` could always produce.
 *
 * Until now its only consumer was the garbage collector: sonata could
 * enumerate every run it had ever launched and exposed that only to `gc`,
 * while `sonata log <id>` required an id the user had no way to find.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { listRuns, readMeta, readExit, readReport, runDir } from '../store.js';
import { reportPathFor } from '../report-contract.js';

export interface RunSummary {
  id: string;
  state: string;
  degraded: boolean;
  role?: string;
  model?: string;
  started?: string;
  report: boolean;
}

export function summarizeRuns(cwd: string): RunSummary[] {
  const out: RunSummary[] = [];
  for (const id of listRuns(cwd)) {
    try {
      const meta = readMeta(cwd, id);
      const exit = readExit(cwd, id);
      const report = readReport(cwd, id);
      out.push({
        id,
        state: exit === null ? 'RUNNING' : 'DONE',
        // The verdict tail recorded when the run finished (`decide()`), which
        // weighs what this list cannot: a read-only run's terminal output, a
        // fallback report, a timeout. Re-deriving it from report.md alone badged
        // every read-only run and trusted a timed-out one. A run tail never
        // finalised keeps the old conservative rule.
        degraded: exit === null
          ? false
          : meta.degraded ?? (exit !== 0 || report === null),
        role: meta.role,
        model: meta.model,
        started: (meta as { startedAt?: string }).startedAt,
        report: existsSync(reportPathFor(runDir(cwd, id))),
      });
    } catch {
      // A half-written or hand-edited run directory is skipped, not fatal.
      continue;
    }
  }
  return out;
}