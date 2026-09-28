/**
 * Which file is a run's log, and how it is read: the one rule `sonata log`
 * and the web UI's run detail share, so the two cannot disagree.
 *
 * A **non-interactive** run's harness tees everything it prints to
 * `<runDir>/harness.log` (opencode `run`, pi, reasonix `run`, codex `exec`).
 * That file is written by the harness itself, so it holds the complete
 * output: nothing scrolls off it, it is not trimmed at a history limit, a
 * resize does not reflow it, and no poll has to be watching. Those are
 * exactly the runs whose bursts the live event log loses, since that log is a
 * diff of the visible screen, one screen per poll.
 *
 * An **interactive** run is a full-screen TUI; its output is screen redraws,
 * not lines, and it keeps the event log — the screen-diff record it has
 * always had, lossy for bursts. So does a run whose harness.log is absent or
 * holds nothing but escapes and whitespace.
 *
 * This replaced two attempts to reconstruct a complete record from tmux —
 * live from scrollback, then from a capture once the run finished — both of
 * which broke on how tmux actually behaves (history trimmed in blocks at the
 * limit, rows reflowed or pulled back by a resize, an alternate-screen TUI
 * writing no history at all). The harness's own log has none of those
 * problems because tmux is not involved.
 */
import { closeSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { stripAnsi } from './normalize.js';

export const HARNESS_LOG_FILE = 'harness.log';
export const EVENTS_FILE = 'events.jsonl';

export interface RunLogFile {
  path: string;
  source: 'harness' | 'events';
}

/** A partial escape sequence can straddle two reads; keep this much back. */
const ESCAPE_CARRY = 32;

/**
 * Whether a file holds anything once escapes and whitespace are gone. Reads
 * only as far as the first such character, so a real log costs one read.
 */
function hasContent(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return false;
  }
  try {
    const decoder = new StringDecoder('utf8');
    const buf = Buffer.alloc(64 * 1024);
    let carry = '';
    for (;;) {
      const bytes = readSync(fd, buf, 0, buf.length, null);
      const text = carry + (bytes === 0 ? decoder.end() : decoder.write(buf.subarray(0, bytes)));
      if (bytes === 0) return /\S/.test(stripAnsi(text));
      // Test all but the tail, which may be the start of an escape sequence
      // the next read completes.
      const settled = text.slice(0, Math.max(0, text.length - ESCAPE_CARRY));
      if (/\S/.test(stripAnsi(settled))) return true;
      carry = text.slice(settled.length);
    }
  } finally {
    closeSync(fd);
  }
}

/** The file that is this run's log. */
export function runLogFile(runDir: string, meta: { interactive?: boolean }): RunLogFile {
  const harnessLog = join(runDir, HARNESS_LOG_FILE);
  if (meta.interactive !== true && hasContent(harnessLog)) return { path: harnessLog, source: 'harness' };
  return { path: join(runDir, EVENTS_FILE), source: 'events' };
}

/**
 * A harness log as the pane would have shown it: escapes stripped, CRLF read
 * as a line break, a bare CR as the terminal reads it — the text after the
 * last one, which is what a redrawn progress line leaves on screen — trailing
 * space trimmed, blank lines dropped as the event log drops them. Every line
 * of content is kept.
 */
export function cleanRunLog(raw: string): string {
  return stripAnsi(raw)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.slice(line.lastIndexOf('\r') + 1).replace(/\s+$/, ''))
    .filter((line) => line.length > 0)
    .join('\n');
}
