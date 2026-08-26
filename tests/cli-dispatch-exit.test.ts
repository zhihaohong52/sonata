import { describe, it, expect, vi, beforeEach } from 'vitest';
import { main } from '../src/cli.js';
import { cmdDispatch } from '../src/commands/dispatch.js';

vi.mock('../src/commands/dispatch.js', () => ({
  cmdDispatch: vi.fn(),
}));

// `--task-stdin` reads the task synchronously from stdin (fd 0). Mock the fs
// read so that an fd-0 read returns a known string; every other fs read still
// delegates to the real node:fs.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: (path: unknown, options?: unknown) => {
      if (path === 0) return 'task text from stdin';
      return actual.readFileSync(path as string, options as never);
    },
  };
});

const cmdDispatchMock = vi.mocked(cmdDispatch);

/**
 * The dispatch CLI handler lives in `main`, which is only reachable through the
 * process exit code. Before the fix, a STALLED run fell through to `return 0`
 * — the run had not finished, but `sonata dispatch` reported success, so a
 * caller (or a tier fallback) could trust a report that never arrived. Exit
 * code 3 marks the outcome distinct from success (0) and failure (1).
 */
describe('dispatch exit codes', () => {
  beforeEach(() => {
    cmdDispatchMock.mockReset();
  });

  it('passes stdin as the task text when --task-stdin is given', async () => {
    cmdDispatchMock.mockResolvedValue({
      id: 'run-1',
      state: 'DONE',
      modelKey: 'flash',
      report: 'finished',
      attempts: [{ modelKey: 'flash', state: 'DONE', degraded: false }],
    });

    const code = await main(['dispatch', '--model', 'flash', '--task-stdin']);
    expect(code).toBe(0);
    expect(cmdDispatchMock).toHaveBeenCalledWith(
      expect.objectContaining({ task: 'task text from stdin' }),
    );
  });

  it('returns 3 when the run STALLED', async () => {
    cmdDispatchMock.mockResolvedValue({
      id: 'run-1',
      state: 'STALLED',
      modelKey: 'flash',
      attempts: [{ modelKey: 'flash', state: 'STALLED', degraded: false }],
    });

    const code = await main(['dispatch', '--model', 'flash', 'do the thing']);
    expect(code).toBe(3);
  });

  it('returns 0 when the run finishes DONE', async () => {
    cmdDispatchMock.mockResolvedValue({
      id: 'run-1',
      state: 'DONE',
      modelKey: 'flash',
      report: 'finished',
      attempts: [{ modelKey: 'flash', state: 'DONE', degraded: false }],
    });

    const code = await main(['dispatch', '--model', 'flash', 'do the thing']);
    expect(code).toBe(0);
  });
});