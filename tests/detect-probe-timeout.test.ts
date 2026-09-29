import { describe, it, expect, vi, beforeEach } from 'vitest';

// Every `--version` probe must be bounded: pi, codex and reasonix passed no
// timeout, and neither did `tmux -V`, so a binary that hangs on `--version`
// hung `sonata init` and `sonata doctor` outright.
const calls: Array<{ cmd: string; timeout?: number }> = [];
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return {
    ...real,
    execFile: (cmd: string, _args: string[], opts: { timeout?: number }, cb: (e: unknown, v: unknown) => void) => {
      calls.push({ cmd, timeout: opts?.timeout });
      cb(null, { stdout: `${cmd} 1.0.0`, stderr: '' });
    },
  };
});

const { probeVersion, detectTmux, VERSION_PROBE_TIMEOUT_MS } = await import('../src/detect.js');

beforeEach(() => { calls.length = 0; });

describe('version probes are bounded', () => {
  it('bounds a probe whose caller names no timeout', async () => {
    await probeVersion('codex', process.env);
    expect(calls).toEqual([{ cmd: 'codex', timeout: VERSION_PROBE_TIMEOUT_MS }]);
    expect(VERSION_PROBE_TIMEOUT_MS).toBe(10_000);
  });

  it('bounds tmux -V', async () => {
    await detectTmux();
    expect(calls).toEqual([{ cmd: 'tmux', timeout: VERSION_PROBE_TIMEOUT_MS }]);
  });
});
