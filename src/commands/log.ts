import { readEvents } from '../store.js';
import { cmdVerify } from './verify.js';

export interface LogOptions { cwd: string; id: string }

/**
 * Prints everything a run ever put on its pane.
 *
 * `sonata tail` returns only what is new since the last call, so a caller that
 * polled sees the conversation in fragments and a caller that arrived late
 * sees none of it. The events file has held the whole transcript all along;
 * this is the reader for it.
 *
 * The live equivalent is `tmux attach -r -t sonata-<id>`, which works only
 * while the session is up. This works afterwards, and outlives the session.
 */
export function cmdLog(opts: LogOptions): { ok: boolean; text: string } {
  const verified = cmdVerify({ cwd: opts.cwd, id: opts.id });
  if (!verified.ok) return { ok: false, text: verified.detail };

  const lines = readEvents(opts.cwd, opts.id);
  if (lines.length === 0) {
    return { ok: true, text: `${opts.id}: no output was recorded\n\n— sonata ${verified.detail}` };
  }
  return { ok: true, text: `${lines.join('\n')}\n\n— sonata ${verified.detail}` };
}
