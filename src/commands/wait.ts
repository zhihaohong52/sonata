import { loadConfig } from '../config.js';
import { cmdTail } from './tail.js';
import type { TailResult } from './tail.js';
import type { TailState } from '../types.js';

/**
 * `RUNNING` is not a run state — it means "this call gave up its window, the
 * run is untouched". The caller resumes with another `cmdWait` on the same id.
 */
export type WaitState = TailState | 'RUNNING';

export interface WaitResult extends Omit<TailResult, 'state'> {
  state: WaitState;
  /** Always present, so a caller resuming after RUNNING or PAUSED has the id. */
  id: string;
}

export interface WaitOptions {
  cwd: string;
  id: string;
  windowSeconds?: number;
  pollMs?: number;
  now?: () => number;
  /** Seam for tests; production always uses the real cmdTail. */
  tail?: typeof cmdTail;
}

/**
 * Blocks until a run reaches a state worth returning to the caller.
 *
 * This exists so a dispatch costs one tool call instead of one per model turn.
 * Every intermediate PROGRESS result used to be returned to the wrapper agent,
 * which re-sent its whole context each time — so the cost grew with the length
 * of the run rather than the size of its result. Nothing read those lines.
 *
 * The loop reuses cmdTail rather than growing a second state machine, so pane
 * diffing, events.jsonl and the cursor keep advancing exactly as before and
 * `sonata log` is unaffected.
 */
export async function cmdWait(opts: WaitOptions): Promise<WaitResult> {
  const now = opts.now ?? (() => Date.now());
  const tail = opts.tail ?? cmdTail;
  const pollMs = opts.pollMs ?? 500;
  const windowSeconds = opts.windowSeconds
    ?? loadConfig(opts.cwd).run.dispatchWindowSeconds;
  const deadline = now() + windowSeconds * 1000;

  for (;;) {
    const result = await tail({
      cwd: opts.cwd,
      id: opts.id,
      // One tail call must not outlast the window it is spending.
      waitSeconds: Math.max(0, Math.ceil((deadline - now()) / 1000)),
      pollMs,
    });
    if (result.state !== 'PROGRESS') return { ...result, id: opts.id };
    if (now() >= deadline) return { ...result, state: 'RUNNING', id: opts.id };
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
