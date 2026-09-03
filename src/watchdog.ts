import { join } from 'node:path';

import { WORKTREE_HEAD_FILE, WORKTREE_STATUS_FILE } from './worktree.js';

export interface WatchdogInput {
  harnessScriptPath: string;
  runDir: string;
  timeoutSeconds: number;
  /** When false, skip `fg` and use `wait` — the harness does not read the
   *  terminal so SIGTTIN is not a risk, and `fg` can interfere with output
   *  redirection (measured: `claude -p` with redirected stdout hangs under
   *  `fg` in a tmux pane but completes fine under `wait`). */
  interactive?: boolean;
  /**
   * Working directory to fingerprint as the harness exits, or `undefined` to
   * capture nothing (a read-only role, which is not expected to leave a mark).
   *
   * The capture has to happen here rather than in `sonata tail` because the
   * exit sentinel this wrapper writes is what makes the run readable as
   * finished, and tail may not look for hours. Between those two moments the
   * tree belongs to whoever is using the repository.
   */
  worktreeCwd?: string;
}

/**
 * Wraps a harness script with a watchdog that kills it if it overruns.
 * Enforcement lives in the launched shell, not in `sonata tail`, so a run
 * with nobody watching is still bounded.
 */
export function wrapWithTimeout(input: WatchdogInput): string {
  const harnessLog = join(input.runDir, 'harness.log');
  const timeoutMark = join(input.runDir, 'timeout');
  const exitPath = join(input.runDir, 'exit');
  const headPath = join(input.runDir, WORKTREE_HEAD_FILE);
  const statusPath = join(input.runDir, WORKTREE_STATUS_FILE);

  return [
    '#!/bin/bash',
    '# Job control gives the background harness its own process group, so the',
    '# watchdog can kill the whole tree. A harness is typically a shell running',
    '# a Node CLI that spawns further children; killing only direct children',
    '# leaves those grandchildren running.',
    'set -m',
    `bash '${input.harnessScriptPath}' &`,
    'HARNESS_PID=$!',
    '',
    '(',
    `  sleep ${input.timeoutSeconds}`,
    '  if kill -0 $HARNESS_PID 2>/dev/null; then',
    `    echo 'sonata: run timeout after ${input.timeoutSeconds}s' >> '${harnessLog}'`,
    `    echo timeout > '${timeoutMark}'`,
    '    pkill -P $HARNESS_PID 2>/dev/null',
    '    kill -TERM -$HARNESS_PID 2>/dev/null || kill -TERM $HARNESS_PID 2>/dev/null',
    '    sleep 5',
    '    kill -KILL -$HARNESS_PID 2>/dev/null || kill -KILL $HARNESS_PID 2>/dev/null',
    '  fi',
    ') &',
    'WATCHDOG_PID=$!',
    '# Job control reports a killed background job to the terminal. On a normal',
    '# run the watchdog is always killed, so without this every completed run',
    '# ended with a "Terminated: 15" line in the pane — which then became the',
    '# tail of any degraded report. Disowning it silences the report only; the',
    '# watchdog still runs, and still kills the tree if it fires.',
    'disown $WATCHDOG_PID 2>/dev/null',
    '',
    '# `set -m` above put the harness in its own process group, which means it is',
    '# NOT the terminal\'s foreground group. Any harness that reads the terminal —',
    '# every interactive TUI, which is how sonata honours `default` mode — then',
    '# takes SIGTTIN and stops dead. Reproduced with a one-line harness that reads',
    '# a single key: the pane freezes and the process sits in state T forever,',
    '# until the run timeout kills something that never started.',
    '#',
    '# `fg` hands the terminal to that process group and waits for it exactly as',
    '# `wait` did, returning the same status.',
    '#',
    '# Its output is deliberately NOT redirected. `fg %1 >/dev/null 2>&1` runs and',
    '# reports success, but the job stays stopped — the handover simply does not',
    '# happen. Reproduced both ways against the same wrapper. The cost is one',
    '# extra pane line, the job command that fg echoes.',
    '#',
    '# With no terminal there is nothing to hand over and no job control to do it',
    '# with, so fall back to the plain wait.',
    ...(input.interactive !== false
      ? [
        'if [ -t 0 ]; then',
        '  fg %1',
        '  STATUS=$?',
        'else',
        '  wait $HARNESS_PID',
        '  STATUS=$?',
        'fi',
      ]
      : [
        '# Non-interactive harness: skip fg, use wait. fg interferes with',
        '# output redirection in some harnesses (claude -p hangs under fg).',
        'wait $HARNESS_PID',
        'STATUS=$?',
      ]),
    '',
    'kill $WATCHDOG_PID 2>/dev/null',
    'pkill -P $WATCHDOG_PID 2>/dev/null',
    'wait $WATCHDOG_PID 2>/dev/null',
    '',
    // Fingerprint the tree BEFORE the exit sentinel, because the sentinel is
    // what makes the run readable as finished. `sonata tail` compares against
    // this to say whether the run left a mark; sampling the tree when tail
    // happens to look measures whatever the repository holds by then, which
    // after a `sonata run` the user walked away from is their own subsequent
    // editing. Raw git output is written here and hashed in Node
    // (`worktreeFingerprintAtExit`) so the fingerprint formula is never
    // reimplemented in bash. Nothing here touches $STATUS.
    ...(input.worktreeCwd === undefined
      ? []
      : [
        `if ( cd '${input.worktreeCwd}' && git status --porcelain ) > '${statusPath}' 2>/dev/null; then`,
        `  ( cd '${input.worktreeCwd}' && git rev-parse HEAD ) > '${headPath}' 2>/dev/null || : > '${headPath}'`,
        'else',
        '  # Not a usable repository. Remove both files rather than leaving the',
        '  # empty one the redirection just created: an empty status reads as a',
        '  # clean tree, and "unknown" must never be reported as "unchanged".',
        `  rm -f '${statusPath}' '${headPath}'`,
        'fi',
        '',
      ]),
    `if [ ! -f '${exitPath}' ]; then`,
    `  echo $STATUS > '${exitPath}'`,
    'fi',
    '',
    'exit $STATUS',
  ].join('\n') + '\n';
}
