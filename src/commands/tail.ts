import { loadConfig } from '../config.js';
import { getAdapter } from '../adapters/index.js';
import { capturePane } from '../tmux.js';
import { cleanPane, newLines } from '../normalize.js';
import {
  readMeta, readExit, readReport, readCursor, writeCursor,
  appendEvents, readEvents, writeMeta,
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
  now?: () => number;
}

export async function cmdTail(opts: TailOptions): Promise<TailResult> {
  const now = opts.now ?? (() => Date.now());
  const pollMs = opts.pollMs ?? 500;
  const config = loadConfig(opts.cwd);
  const meta = readMeta(opts.cwd, opts.id);
  const adapter = getAdapter(meta.harness);

  const deadline = now() + opts.waitSeconds * 1000;
  let lastChange = now();

  for (;;) {
    const pane = cleanPane(await capturePane(meta.session));
    const cursor = readCursor(opts.cwd, opts.id);
    const seen = readEvents(opts.cwd, opts.id);
    const fresh = newLines(seen.slice(Math.max(0, seen.length - 200)), pane);

    if (fresh.length > 0) {
      appendEvents(opts.cwd, opts.id, fresh);
      writeCursor(opts.cwd, opts.id, cursor + fresh.length);
      lastChange = now();
    }

    const exitCode = readExit(opts.cwd, opts.id);
    const result = decide({
      newLines: fresh,
      exitCode,
      report: readReport(opts.cwd, opts.id),
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
