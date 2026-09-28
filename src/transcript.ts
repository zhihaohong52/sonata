/**
 * A finished run's transcript: everything tmux kept of its pane, captured
 * once, as `<runDir>/transcript.txt`.
 *
 * The event log (`events.jsonl`) is built while the run is live from a diff of
 * the visible screen, one screen per poll — bounded whatever the harness
 * redraws, and lossy for a burst larger than a screen between two polls.
 * Reconstructing the full history live was tried three times and each broke
 * on real tmux behaviour: scrollback trimmed in blocks at history-limit, rows
 * pulled back out of history by a taller client, rows reflowed by a wider one.
 * Once the run has finished, none of that matters: tmux's own scrollback is
 * the transcript, up to history-limit (10000 rows), and capturing it with
 * wrapped rows joined makes a resize irrelevant.
 *
 * Written through a temporary file and renamed into place, so a reader sees
 * it absent or whole; and never rewritten, so output typed into the pane after
 * the run (a later tail, a user attaching) does not become part of it.
 */
import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanPane } from './normalize.js';
import { tryCaptureHistory } from './tmux.js';

export const TRANSCRIPT_FILE = 'transcript.txt';

export function transcriptPath(runDir: string): string {
  return join(runDir, TRANSCRIPT_FILE);
}

/**
 * Writes the transcript if it is not there yet. True when it exists
 * afterwards; false when the pane could not be read (the session is gone).
 */
export async function captureTranscript(session: string, runDir: string): Promise<boolean> {
  const path = transcriptPath(runDir);
  if (existsSync(path)) return true;
  const raw = await tryCaptureHistory(session);
  if (raw === null) return false;
  const partial = `${path}.partial`;
  writeFileSync(partial, `${cleanPane(raw).join('\n')}\n`);
  renameSync(partial, path);
  return true;
}
