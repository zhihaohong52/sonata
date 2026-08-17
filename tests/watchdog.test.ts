import { describe, it, expect } from 'vitest';
import { wrapWithTimeout } from '../src/watchdog.js';

const script = wrapWithTimeout({
  harnessScriptPath: '/tmp/sonata/harness.sh',
  runDir: '/tmp/sonata',
  timeoutSeconds: 42,
});

describe('wrapWithTimeout process-group killing', () => {
  const script = wrapWithTimeout({
    harnessScriptPath: '/r/.sonata/runs/a1/harness.sh',
    runDir: '/r/.sonata/runs/a1',
    timeoutSeconds: 30,
  });

  it('enables job control so the harness gets its own process group', () => {
    expect(script).toContain('set -m');
  });

  it('kills the whole process group, not just the leader', () => {
    // A harness spawns a CLI which spawns further children; killing only the
    // direct children leaves grandchildren running.
    expect(script).toContain('kill -TERM -$HARNESS_PID');
    expect(script).toContain('kill -KILL -$HARNESS_PID');
  });

  it('falls back to a plain pid kill if the group kill fails', () => {
    expect(script).toContain('|| kill -TERM $HARNESS_PID');
    expect(script).toContain('|| kill -KILL $HARNESS_PID');
  });
});

/**
 * `set -m` is what makes the group killable, and it is also what takes the
 * terminal away from the harness — its own process group is not the
 * terminal's foreground group, so anything that reads the terminal gets
 * SIGTTIN and stops. Reproduced with a harness that reads a single key: the
 * pane freezes and the process sits in state T until the run timeout.
 */
describe('wrapWithTimeout hands the terminal to the harness', () => {
  it('foregrounds the harness so an interactive TUI can read the terminal', () => {
    expect(script).toContain('fg %1');
  });

  /**
   * `fg %1 >/dev/null 2>&1` runs, reports success, and leaves the job stopped
   * anyway — the handover does not happen. Verified both ways against the same
   * wrapper, so the noisier form is the working one.
   */
  it('does not redirect fg, which silently defeats the handover', () => {
    // Anchored: the comment above the call names the broken form on purpose.
    expect(script).not.toMatch(/^\s*fg %1\s*>/m);
  });

  it('still falls back to wait where there is no terminal to hand over', () => {
    expect(script).toContain('if [ -t 0 ]; then');
    expect(script).toContain('wait $HARNESS_PID');
  });

  it('takes the harness status from whichever branch ran', () => {
    // Both branches must set STATUS, or a run's exit code becomes the shell's.
    expect(script.match(/STATUS=\$\?/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe('wrapWithTimeout', () => {
  it('is a bash script that runs the harness in the background', () => {
    expect(script.startsWith('#!/bin/bash')).toBe(true);
    expect(script).toContain("bash '/tmp/sonata/harness.sh' &");
    expect(script).toContain('HARNESS_PID=$!');
  });

  it('embeds the timeout value and its log line', () => {
    expect(script).toContain('sleep 42');
    expect(script).toContain("sonata: run timeout after 42s");
    expect(script).toContain(">> '/tmp/sonata/harness.log'");
    expect(script).toContain("> '/tmp/sonata/timeout'");
  });

  it('checks liveness before killing', () => {
    expect(script).toContain('kill -0 $HARNESS_PID');
  });

  it('kills the harness tree and escalates TERM to KILL', () => {
    expect(script).toContain('pkill -P $HARNESS_PID');
    expect(script).toContain('kill -TERM $HARNESS_PID');
    expect(script).toContain('kill -KILL $HARNESS_PID');
  });

  it('waits for the harness and kills the watchdog on completion', () => {
    expect(script).toContain('wait $HARNESS_PID');
    expect(script).toContain('kill $WATCHDOG_PID');
  });

  it('disowns the watchdog so its kill is not reported into the pane', () => {
    // The watchdog is killed on every normal run, and job control would print
    // "Terminated: 15" to the terminal — which then becomes the tail of any
    // degraded report. Disown must come before the wait, or the report races.
    expect(script).toContain('disown $WATCHDOG_PID');
    expect(script.indexOf('disown $WATCHDOG_PID'))
      .toBeLessThan(script.indexOf('wait $HARNESS_PID'));
  });

  it('guards the exit write with an existence check', () => {
    expect(script).toContain("if [ ! -f '/tmp/sonata/exit' ]; then");
    expect(script).toContain("echo $STATUS > '/tmp/sonata/exit'");
  });
});
