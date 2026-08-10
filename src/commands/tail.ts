import { statSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../config.js';
import { getAdapter } from '../adapters/index.js';
import { tryCapturePane } from '../tmux.js';
import { cleanPane, newLines } from '../normalize.js';
import {
  readMeta, readExit, readReport, readCursor, writeCursor,
  appendEvents, readEvents, writeMeta, runDir,
} from '../store.js';
import type { TailState } from '../types.js';

export interface DecideInput {
  newLines: string[];
  exitCode: number | null;
  report: string | null;
  promptText: string | null;
  msSinceLastChange: number;
  stallTimeoutMs: number;
  paneTail: string[];
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
    const degraded = input.report === null;
    return {
      state: 'DONE',
      lines: input.newLines,
      exitCode: input.exitCode,
      degraded,
      report: degraded
        ? `[degraded: harness exited ${input.exitCode} without writing a report]\n\n${input.paneTail.join('\n')}`
        : input.report!,
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
          fresh = [...fresh, ...extra];
        }
        writePaneSnapshot(opts.cwd, opts.id, settledPane);
        pane = settledPane;
      }
      exitCode = readExit(opts.cwd, opts.id);
    }


    // Prefer the model's own report; fall back to a final message the harness
    // wrote itself (codex `-o`) before giving up and returning pane text.
    const fallbackPath = adapter.fallbackReportFile
      ? join(runDir(opts.cwd, opts.id), adapter.fallbackReportFile)
      : null;
    const fallback = fallbackPath && existsSync(fallbackPath)
      ? readFileSync(fallbackPath, 'utf8').trim() || null
      : null;

    const result = decide({
      newLines: fresh,
      exitCode,
      report: readReport(opts.cwd, opts.id) ?? fallback,
      promptText: meta.interactive ? adapter.describePrompt(pane) : null,
      msSinceLastChange: now() - lastChange,
      stallTimeoutMs: config.run.stallTimeoutSeconds * 1000,
      paneTail: pane.slice(-20),
    });

    if (result.state === 'DONE') {
      writeMeta(opts.cwd, {
        ...meta,
        endedAt: new Date().toISOString(),
        exitCode: result.exitCode,
        degraded: result.degraded,
      });
      return result;
    }

    if (result.state !== 'PROGRESS' || result.lines.length > 0) return result;
    if (now() >= deadline) return result;

    await new Promise((r) => setTimeout(r, pollMs));
  }
}
