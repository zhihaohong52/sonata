import { existsSync, readFileSync } from 'node:fs';
import { readEvents, runDir } from '../store.js';
import { transcriptPath } from '../transcript.js';
import { cmdVerify } from './verify.js';

export interface LogOptions { cwd: string; id: string }

/**
 * Prints everything a run ever put on its pane: the transcript captured when
 * it finished, else the event log recorded while it ran.
 *
 * `sonata tail` returns only what is new since the last call, so a caller that
 * polled sees the conversation in fragments and a caller that arrived late
 * sees none of it. This is the reader for the whole record.
 *
 * The live equivalent is `tmux attach -r -t sonata-<id>`, which works only
 * while the session is up. This works afterwards, and outlives the session.
 */
export function cmdLog(opts: LogOptions): { ok: boolean; text: string } {
  const verified = cmdVerify({ cwd: opts.cwd, id: opts.id });
  if (!verified.ok) return { ok: false, text: verified.detail };

  // A finished run's transcript is tmux's whole history, captured once; the
  // event log is one screen per poll and can miss a burst between polls. The
  // event log remains for a live run, or one whose session died before the
  // transcript was captured.
  const transcript = transcriptPath(runDir(opts.cwd, opts.id));
  if (existsSync(transcript)) {
    return { ok: true, text: `${readFileSync(transcript, 'utf8').replace(/\n+$/, '')}\n\n— sonata ${verified.detail}` };
  }

  const lines = readEvents(opts.cwd, opts.id);
  if (lines.length === 0) {
    return { ok: true, text: `${opts.id}: no output was recorded\n\n— sonata ${verified.detail}` };
  }
  return { ok: true, text: `${lines.join('\n')}\n\n— sonata ${verified.detail}` };
}
