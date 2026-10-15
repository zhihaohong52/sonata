/**
 * `sonata runs` — the list `listRuns()` could always produce.
 *
 * Until now its only consumer was the garbage collector: sonata could
 * enumerate every run it had ever launched and exposed that only to `gc`,
 * while `sonata log <id>` required an id the user had no way to find.
 */
import { listRuns, readMeta, readExit, readReport, runDir } from '../store.js';
import { worktreeFingerprintAtExit } from '../worktree.js';

export interface RunSummary {
  id: string;
  state: string;
  degraded: boolean;
  role?: string;
  model?: string;
  started?: string;
  report: boolean;
  /**
   * The run finished with the worktree exactly as it found it — the
   * `[no worktree change: …]` the report carries, visible in the list too.
   * Only from the fingerprint the launch wrapper captured at exit, never a
   * fresh sample: the tree has been free to move since. Absent when either
   * side was not captured (a read-only role, outside git, a run still going).
   */
  worktreeUnchanged?: true;
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
        // The store's rule, not file presence: an empty or whitespace-only
        // report.md is no report.
        report: report !== null,
        ...(exit !== null && meta.worktreeAtLaunch !== undefined
          && worktreeFingerprintAtExit(runDir(cwd, id)) === meta.worktreeAtLaunch
          ? { worktreeUnchanged: true as const } : {}),
      });
    } catch {
      // A half-written or hand-edited run directory is skipped, not fatal.
      continue;
    }
  }
  return out;
}