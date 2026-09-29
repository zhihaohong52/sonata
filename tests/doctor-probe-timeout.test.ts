import { describe, it, expect, vi, beforeEach } from 'vitest';

// Every version probe — the detector's, `tmux -V`, and doctor's own harness
// and `claude --version` — goes through the one bounded runner, with the
// shared bound. `claude --version` was the one doctor probe left unbounded.
const calls: Array<{ cmd: string; timeoutMs: number }> = [];
vi.mock('../src/version-probe.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/version-probe.js')>();
  return {
    ...real,
    runProbe: async (cmd: string, _args: string[], opts: { timeoutMs: number }) => {
      calls.push({ cmd, timeoutMs: opts.timeoutMs });
      return { stdout: `${cmd} 1.0.0`, stderr: '' };
    },
  };
});

const { VERSION_PROBE_TIMEOUT_MS } = await import('../src/version-probe.js');
const { tmuxVersion } = await import('../src/tmux.js');
const { defaultHarnessVersion, defaultClaudeVersion } = await import('../src/commands/doctor.js');
const { probeVersion, detectTmux } = await import('../src/detect.js');

beforeEach(() => { calls.length = 0; });

describe('version probes are bounded', () => {
  it('bounds tmux -V', async () => {
    await tmuxVersion();
    expect(calls).toEqual([{ cmd: 'tmux', timeoutMs: VERSION_PROBE_TIMEOUT_MS }]);
  });

  it('bounds a harness version', async () => {
    await defaultHarnessVersion(['codex', '--version']);
    expect(calls).toEqual([{ cmd: 'codex', timeoutMs: VERSION_PROBE_TIMEOUT_MS }]);
  });

  it('bounds claude --version', async () => {
    expect(await defaultClaudeVersion()).toBe('claude 1.0.0');
    expect(calls).toEqual([{ cmd: 'claude', timeoutMs: VERSION_PROBE_TIMEOUT_MS }]);
  });

  it('bounds the detector probes', async () => {
    await probeVersion('codex', process.env);
    await detectTmux();
    expect(calls).toEqual([
      { cmd: 'codex', timeoutMs: VERSION_PROBE_TIMEOUT_MS },
      { cmd: 'tmux', timeoutMs: VERSION_PROBE_TIMEOUT_MS },
    ]);
    expect(VERSION_PROBE_TIMEOUT_MS).toBe(10_000);
  });
});
