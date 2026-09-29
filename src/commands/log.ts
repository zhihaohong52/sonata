import { readFileSync } from 'node:fs';
import { readEvents, readMeta, runDir } from '../store.js';
import { cleanRunLog, runLogFile } from '../run-log.js';
import { cmdVerify } from './verify.js';

export interface LogOptions { cwd: string; id: string }

/**
 * Prints what a run put on its pane.
 *
 * `sonata tail` returns only what is new since the last call, so a caller that
 * polled sees the conversation in fragments and a caller that arrived late
 * sees none of it. This is the reader for the record kept for the whole run:
 * a non-interactive run's own `harness.log`, complete, or else the event log,
 * one screen per poll (see `src/run-log.ts` for which and why).
 *
 * The live equivalent is `tmux attach -r -t sonata-<id>`, which works only
 * while the session is up. This works afterwards, and outlives the session.
 */
export function cmdLog(opts: LogOptions): { ok: boolean; text: string } {
  const verified = cmdVerify({ cwd: opts.cwd, id: opts.id });
  if (!verified.ok) return { ok: false, text: verified.detail };

  const file = runLogFile(runDir(opts.cwd, opts.id), readMeta(opts.cwd, opts.id));
  if (file.source === 'harness') {
    // hasContent looks for any visible character; a log that cleans down to
    // nothing (only carriage-return noise) falls through to the event log.
    const cleaned = cleanRunLog(readFileSync(file.path, 'utf8'));
    if (cleaned.length > 0) return { ok: true, text: `${cleaned}\n\n— sonata ${verified.detail}` };
  }

  const lines = readEvents(opts.cwd, opts.id);
  if (lines.length === 0) {
    return { ok: true, text: `${opts.id}: no output was recorded\n\n— sonata ${verified.detail}` };
  }
  return { ok: true, text: `${lines.join('\n')}\n\n— sonata ${verified.detail}` };
}
