import { statSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../config.js';
import { getAdapter } from '../adapters/index.js';
import { tryCapturePane } from '../tmux.js';
import { cleanPane, newLines } from '../normalize.js';
import {
  readMeta, readExit, readReport, readCursor, writeCursor,
  appendEvents, readEvents, writeMeta, runDir, readAnsweredPrompt, clearAnsweredPrompt,
} from '../store.js';
import { cmdVerify } from './verify.js';
import type { TailState } from '../types.js';

/**
 * The provenance line appended to every finished report.
 *
 * Built from the run's own meta.json, so it cannot be produced by a wrapper
 * that skipped the dispatch and answered from memory — the failure `sonata
 * verify` was written to catch, but which only helped when someone remembered
 * to run it.
 */
function provenance(cwd: string, id: string): string {
  const v = cmdVerify({ cwd, id });
  return v.ok ? `— sonata ${v.detail}` : `— sonata could NOT verify this run: ${v.detail}`;
}

export interface DecideInput {
  newLines: string[];
  exitCode: number | null;
  report: string | null;
  promptText: string | null;
  msSinceLastChange: number;
  stallTimeoutMs: number;
  paneTail: string[];
  timedOut: boolean;
  /**
   * False when the harness configuration cannot write a report file at all
   * (pi's read-only tool allowlist removes the write tool). A clean exit with
   * no report is then the expected outcome, not a failure.
   */
  canWriteReport?: boolean;
  /**
   * The launch line sonata itself put in the pane (the `cmd.sh` path). Used to
   * tell the harness's own output apart from the echo of the command that
   * started it — an exact string sonata wrote, not a guessed prompt pattern.
   */
  launchMarker?: string;
}

/**
 * The harness's own output: everything in the pane that sonata did not put
 * there. tmux echoes the launch command, and the shell prints a prompt around
 * it, so a pane that "has content" is not evidence a model ever spoke.
 */
export function harnessOutput(paneTail: string[], launchMarker?: string): string[] {
  return paneTail.filter((line) => {
    const t = line.trim();
    if (t.length === 0) return false;
    if (launchMarker !== undefined && t.includes(launchMarker)) return false;
    // The watchdog foregrounds the harness job with `fg`, which echoes the
    // job's command line — `bash '<runDir>/harness.sh'`. That is sonata's own
    // plumbing, not the model speaking. Left in, it streamed to the user as if
    // the harness had said it, and worse, it counted towards `spoke`, so a run
    // that produced nothing at all could look like it had answered. Anchored to
    // `bash '` so a model quoting its own harness path is not swallowed.
    if (/^bash '.*\/harness\.sh'$/.test(t)) return false;
    return true;
  });
}

export interface TailResult {
  state: TailState;
  lines: string[];
  prompt?: string;
  report?: string;
  exitCode?: number;
  degraded?: boolean;
}

/** Pure state machine. Order matters: completion beats a stale prompt match. */
export function decide(input: DecideInput): TailResult {
  if (input.exitCode !== null) {
    // A run that could never write a report is not degraded for lacking one —
    // its terminal output IS the report. Only a clean exit qualifies: a
    // read-only run that crashed is still a failure worth flagging.
    //
    // The output must also be non-empty. Without that check, ANY clean exit
    // was accepted as success for a read-only role, so a harness that died
    // before saying anything — a locked database, an expired token, a bad
    // model id — was reported DONE and not degraded, with the launch command
    // echo standing in for a report. That is the silent success this whole
    // design exists to prevent: nothing else downstream can tell the
    // difference between "answered" and "never ran".
    const spoke = harnessOutput(input.paneTail, input.launchMarker).length > 0;
    const reportImpossible = input.canWriteReport === false
      && input.report === null
      && input.exitCode === 0
      && !input.timedOut
      && spoke;

    // A timed-out run is degraded even if a report file happens to exist: the
    // work was cut short, so the report cannot be trusted as complete.
    const degraded = input.timedOut || (input.report === null && !reportImpossible);
    const report = input.timedOut
      ? `[timed out: sonata killed the run after the configured run_timeout_seconds]\n\n${input.paneTail.join('\n')}`
      : reportImpossible
        ? `[read-only run: the harness cannot write a report file, so this is its terminal output]\n\n${input.paneTail.join('\n')}`
        : degraded && !spoke
          ? `[degraded: the harness exited ${input.exitCode} without producing any output — nothing ran]\n\n${input.paneTail.join('\n')}`
          : degraded
            ? `[degraded: harness exited ${input.exitCode} without writing a report]\n\n${input.paneTail.join('\n')}`
            : input.report!;
    return {
      state: 'DONE',
      lines: input.newLines,
      exitCode: input.exitCode,
      degraded,
      report,
    };
  }

  if (input.promptText !== null) {
    return { state: 'PAUSED', lines: input.newLines, prompt: input.promptText };
  }

  if (input.newLines.length > 0) {
    return { state: 'PROGRESS', lines: input.newLines };
  }

  if (input.msSinceLastChange >= input.stallTimeoutMs) {
    return { state: 'STALLED', lines: input.paneTail };
  }

  return { state: 'PROGRESS', lines: [] };
}

export interface TailOptions {
  cwd: string;
  id: string;
  waitSeconds: number;
  /** Best-effort observer for newly persisted harness output. */
  onLines?: (lines: string[]) => void;
  pollMs?: number;
  /** Grace period after the exit sentinel for the pane to flush. */
  settleMs?: number;
  now?: () => number;
}

function lastChangeMs(cwd: string, id: string, now: () => number): number {
  try {
    const lastWrite = statSync(join(runDir(cwd, id), 'events.jsonl')).mtimeMs;
    return lastWrite <= now() ? lastWrite : now();
  } catch {
    return now();
  }
}

function paneSnapshotPath(cwd: string, id: string): string {
  return join(runDir(cwd, id), 'pane.snapshot');
}

function readPaneSnapshot(cwd: string, id: string): string[] {
  const p = paneSnapshotPath(cwd, id);
  if (!existsSync(p)) return [];
  const raw = readFileSync(p, 'utf8');
  return raw.length === 0 ? [] : raw.split('\n');
}

function writePaneSnapshot(cwd: string, id: string, lines: string[]): void {
  writeFileSync(paneSnapshotPath(cwd, id), lines.join('\n'));
}

export async function cmdTail(opts: TailOptions): Promise<TailResult> {
  const now = opts.now ?? (() => Date.now());
  const pollMs = opts.pollMs ?? 500;
  const settleMs = opts.settleMs ?? 500;
  const config = loadConfig(opts.cwd);
  const meta = readMeta(opts.cwd, opts.id);
  const adapter = getAdapter(meta.harness);

  const deadline = now() + opts.waitSeconds * 1000;
  let lastChange = lastChangeMs(opts.cwd, opts.id, now);
  // The exact path tmux echoes when the run starts, so pane lines sonata
  // caused can be told from output the harness produced.
  const scriptPath = join(runDir(opts.cwd, opts.id), 'cmd.sh');

  for (;;) {
    const cursor = readCursor(opts.cwd, opts.id);
    const prevPane = readPaneSnapshot(opts.cwd, opts.id);

    // Diff against the PREVIOUS PANE, not the accumulated event log. The event
    // log contains older, already-scrolled content, so suffix-overlap against
    // it fails and re-emits the whole pane on every poll — which makes every
    // call return PROGRESS immediately and starves the caller's poll budget.
    //
    // A failed capture (null, common when tmux is busy) must not be mistaken
    // for an emptied pane: writing an empty snapshot would make the next poll
    // re-emit everything, producing the same starvation.
    const captured = await tryCapturePane(meta.session);
    const paneNow = captured === null ? prevPane : cleanPane(captured);
    const freshNow = captured === null ? [] : newLines(prevPane, paneNow);
    if (captured !== null) writePaneSnapshot(opts.cwd, opts.id, paneNow);

    if (freshNow.length > 0) {
      appendEvents(opts.cwd, opts.id, freshNow);
      writeCursor(opts.cwd, opts.id, cursor + freshNow.length);
      // A real repeat prompt has output between asks. Forget the old answer as
      // soon as the pane advances so we do not hide that new request forever.
      clearAnsweredPrompt(opts.cwd, opts.id);
      lastChange = now();
    }

    let exitCode = readExit(opts.cwd, opts.id);
    let pane = paneNow;
    let fresh = freshNow;

    // The exit sentinel is a file write; the harness's last output reaches the
    // pane via a terminal flush. Under load the sentinel wins the race, which
    // would truncate a degraded report of exactly the crash we need to see.
    // Take one settling capture before declaring the run finished.
    if (exitCode !== null) {
      await new Promise((r) => setTimeout(r, settleMs));
      const settled = await tryCapturePane(meta.session);
      if (settled !== null) {
        const settledPane = cleanPane(settled);
        const extra = newLines(pane, settledPane);
        if (extra.length > 0) {
          appendEvents(opts.cwd, opts.id, extra);
          writeCursor(opts.cwd, opts.id, readCursor(opts.cwd, opts.id) + extra.length);
          clearAnsweredPrompt(opts.cwd, opts.id);
          fresh = [...fresh, ...extra];
        }
        writePaneSnapshot(opts.cwd, opts.id, settledPane);
        pane = settledPane;
      }
      exitCode = readExit(opts.cwd, opts.id);
    }

    const output = harnessOutput(fresh, scriptPath);
    if (output.length > 0) {
      try {
        opts.onLines?.(output);
      } catch {
        // Progress notifications are cosmetic; never let their transport stop a run.
      }
    }

    // Prefer the model's own report; fall back to a final message the harness
    // wrote itself (codex `-o`) before giving up and returning pane text.
    const fallbackPath = adapter.fallbackReportFile
      ? join(runDir(opts.cwd, opts.id), adapter.fallbackReportFile)
      : null;
    const fallback = fallbackPath && existsSync(fallbackPath)
      ? readFileSync(fallbackPath, 'utf8').trim() || null
      : null;

    const detectedPrompt = meta.interactive ? adapter.describePrompt(pane) : null;
    const answeredPrompt = readAnsweredPrompt(opts.cwd, opts.id);
    const result = decide({
      newLines: fresh,
      exitCode,
      report: readReport(opts.cwd, opts.id) ?? fallback,
      promptText: detectedPrompt === answeredPrompt ? null : detectedPrompt,
      msSinceLastChange: now() - lastChange,
      stallTimeoutMs: config.run.stallTimeoutSeconds * 1000,
      paneTail: pane.slice(-20),
      timedOut: existsSync(join(runDir(opts.cwd, opts.id), 'timeout')),
      canWriteReport: meta.canWriteReport,
      launchMarker: scriptPath,
    });

    if (result.state === 'DONE') {
      writeMeta(opts.cwd, {
        ...meta,
        endedAt: new Date().toISOString(),
        exitCode: result.exitCode,
        degraded: result.degraded,
      });
      // Every finished report carries its own provenance, so verification is
      // not a step someone has to remember. A wrapper that answers from its
      // own head instead of dispatching cannot produce this line: it is built
      // from the run's meta.json, which only a real run writes.
      return { ...result, report: `${result.report ?? ''}\n\n${provenance(opts.cwd, opts.id)}` };
    }

    if (result.state !== 'PROGRESS' || result.lines.length > 0) return result;
    if (now() >= deadline) return result;

    await new Promise((r) => setTimeout(r, pollMs));
  }
}
