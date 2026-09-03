/**
 * The report contract: the one definition of how a dispatched run reports back.
 *
 * A sonata run's result is a **file**, never terminal output. The prompt asks
 * the model to write it, the harness watcher waits for it to appear, the store
 * reads it, `sonata runs` checks whether it exists, and `tail` decides whether
 * a run without one is degraded. Before this module those five places each
 * carried the bare string `report.md`, so nothing forced them to agree — and
 * the failure mode of disagreement is silent in the worst direction: a model
 * writes its report where it was told, nothing reads it there, and the run is
 * reported degraded despite having succeeded.
 *
 * The contract in full:
 *
 * 1. The model writes `report.md` in the run directory, as its final action.
 * 2. Some configurations physically cannot — a read-only sandbox, or a tool
 *    allowlist with no write tool (`LaunchPlan.canWriteReport === false`).
 *    Those runs are told not to try, their terminal output is taken as the
 *    report, and lacking the file does **not** make them degraded — but only
 *    when the run also exited cleanly, was not timed out, and actually printed
 *    something. A read-only run that crashed, or that said nothing at all, is
 *    still a failure worth flagging.
 * 3. A harness may write a final message of its own (codex/claude `-o`), named
 *    per adapter by `fallbackReportFile`. It is used only when the model's own
 *    report is absent — it is the harness's account, not the model's.
 * 4. A run that could have written a report and did not is degraded, and so is
 *    a run killed at its timeout, report or no report.
 *
 * **What this module owns is the file, not the verdict.** Rules 2 and 4 are
 * decided by `decide()` in `src/commands/tail.ts`, and stay there: that
 * predicate is a state machine over exit code, timeout and pane output, and
 * every clause of it was written against an observed failure. Re-expressing it
 * here as a one-line helper would have to drop those clauses to fit, which is
 * a behaviour change disguised as a refactor — the simplified version treats a
 * *crashed* read-only run as "report impossible", exactly the silent success
 * the clauses exist to catch. Rule 3 stays per-adapter for the same reason in
 * the other direction: which file a harness writes is harness knowledge and
 * belongs behind the adapter boundary.
 *
 * So: one definition of *where the report lives*, referenced everywhere, and
 * the rules written down beside it.
 */
import { join } from 'node:path';

/** The file the model is asked to write, and the only result that is returned. */
export const REPORT_FILENAME = 'report.md';

/** The model's report inside a run directory. */
export function reportPathFor(runDir: string): string {
  return join(runDir, REPORT_FILENAME);
}

/**
 * A harness's own final-message file, when it writes one.
 *
 * Declared per adapter (`HarnessAdapter.fallbackReportFile`); this names the
 * concept so the manifest can state where it sits in the contract — consulted
 * only when the model's own report is absent.
 */
export type FallbackReportFile = string | undefined;
