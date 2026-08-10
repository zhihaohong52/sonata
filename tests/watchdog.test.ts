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

  it('guards the exit write with an existence check', () => {
    expect(script).toContain("if [ ! -f '/tmp/sonata/exit' ]; then");
    expect(script).toContain("echo $STATUS > '/tmp/sonata/exit'");
  });
});
