import { join } from 'node:path';

export interface WatchdogInput {
  harnessScriptPath: string;
  runDir: string;
  timeoutSeconds: number;
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
    'if [ -t 0 ]; then',
    '  fg %1',
    '  STATUS=$?',
    'else',
    '  wait $HARNESS_PID',
    '  STATUS=$?',
    'fi',
    '',
    'kill $WATCHDOG_PID 2>/dev/null',
    'pkill -P $WATCHDOG_PID 2>/dev/null',
    'wait $WATCHDOG_PID 2>/dev/null',
    '',
    `if [ ! -f '${exitPath}' ]; then`,
    `  echo $STATUS > '${exitPath}'`,
    'fi',
    '',
    'exit $STATUS',
  ].join('\n') + '\n';
}
