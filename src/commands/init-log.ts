/**
 * A file log for `sonata init`.
 *
 * The wizard owns the terminal — Ink repaints over itself and the list prompts
 * switch to the alternate screen buffer, which is discarded on exit. So the one
 * place a failure could be read from is the one place it does not survive: a
 * run that dies mid-wizard leaves a restored shell and no trace of why.
 *
 * Everything `init` prints is teed here, along with the choices it resolved and
 * any error that ended the run. Written line by line rather than at the end,
 * because the interesting case is the run that does not reach its end.
 *
 * No secret material is ever written: keys are recorded as the gateway they
 * belong to, never as their value.
 */
import { appendFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export interface InitLog {
  /** Where this run is being recorded. Printed when a run fails. */
  path: string;
  line(text: string): void;
  /** Records an error with its stack, then leaves the file closed-out. */
  fail(error: unknown): void;
}

export function initLogDir(home: string): string {
  return join(home, '.config', 'sonata', 'logs');
}

/** Keeps the most recent `keep` logs and deletes the rest. */
export function pruneInitLogs(dir: string, keep = 10): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((name) => /^init-.*\.log$/.test(name));
  } catch {
    return [];
  }
  // The names are timestamps, so lexical order is chronological order.
  const doomed = entries.sort().slice(0, Math.max(0, entries.length - keep));
  for (const name of doomed) {
    try { rmSync(join(dir, name)); } catch { /* another run got there first */ }
  }
  return doomed;
}

/** A log that writes nothing, for tests and for a home we cannot write to. */
export const nullInitLog: InitLog = { path: '', line: () => {}, fail: () => {} };

export function openInitLog(home: string, startedAt: Date = new Date()): InitLog {
  const dir = initLogDir(home);
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  const path = join(dir, `init-${stamp}.log`);

  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(path, `sonata init — ${startedAt.toISOString()}\n`);
  } catch {
    // A read-only or unwritable home must not stop the command it is logging.
    return nullInitLog;
  }
  pruneInitLogs(dir);

  const write = (text: string): void => {
    try { appendFileSync(path, text); } catch { /* logging never fails a run */ }
  };

  return {
    path,
    line(text: string) { write(`${text}\n`); },
    fail(error: unknown) {
      const detail = error instanceof Error
        ? `${error.name}: ${error.message}\n${error.stack ?? ''}`
        : String(error);
      write(`\n!! the run ended with an error\n${detail}\n`);
    },
  };
}
