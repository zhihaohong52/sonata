import { describe, it, expect, vi, beforeEach } from 'vitest';

// `sonata doctor` probes harness versions and tmux itself, and neither probe
// was bounded — a binary hanging on `--version` (or `tmux -V`) hung doctor.
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

const { VERSION_PROBE_TIMEOUT_MS } = await import('../src/detect.js');
const { tmuxVersion } = await import('../src/tmux.js');
const { defaultHarnessVersion } = await import('../src/commands/doctor.js');

beforeEach(() => { calls.length = 0; });

describe('doctor version probes are bounded', () => {
  it('bounds tmux -V', async () => {
    await tmuxVersion();
    expect(calls).toEqual([{ cmd: 'tmux', timeout: VERSION_PROBE_TIMEOUT_MS }]);
  });

  it('bounds a harness --version', async () => {
    await defaultHarnessVersion(['codex', '--version']);
    expect(calls).toEqual([{ cmd: 'codex', timeout: VERSION_PROBE_TIMEOUT_MS }]);
  });
});
