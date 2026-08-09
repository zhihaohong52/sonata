import { describe, it, expect } from 'vitest';
import { decide } from '../../src/commands/tail.js';

const base = {
  newLines: [] as string[],
  exitCode: null as number | null,
  report: null as string | null,
  promptText: null as string | null,
  msSinceLastChange: 0,
  stallTimeoutMs: 120_000,
  paneTail: ['last', 'lines'],
};

describe('tail decide', () => {
  it('reports DONE with the report when the exit sentinel exists', () => {
    const r = decide({ ...base, exitCode: 0, report: 'all good' });
    expect(r.state).toBe('DONE');
    expect(r.report).toBe('all good');
    expect(r.degraded).toBe(false);
    expect(r.exitCode).toBe(0);
  });

  it('marks DONE degraded when the process exited without a report', () => {
    const r = decide({ ...base, exitCode: 1, report: null });
    expect(r.state).toBe('DONE');
    expect(r.degraded).toBe(true);
    expect(r.report).toContain('last');
  });

  it('prefers DONE over a stale prompt match', () => {
    const r = decide({ ...base, exitCode: 0, report: 'x', promptText: 'Allow? (y/n)' });
    expect(r.state).toBe('DONE');
  });

  it('reports PAUSED when a prompt is pending', () => {
    const r = decide({ ...base, promptText: 'Allow bash rm -rf build? (y/n)' });
    expect(r.state).toBe('PAUSED');
    expect(r.prompt).toContain('rm -rf build');
  });

  it('reports PROGRESS when there are new lines', () => {
    const r = decide({ ...base, newLines: ['reading a.ts'] });
    expect(r.state).toBe('PROGRESS');
    expect(r.lines).toEqual(['reading a.ts']);
  });

  it('reports STALLED after the timeout with no change', () => {
    const r = decide({ ...base, msSinceLastChange: 130_000 });
    expect(r.state).toBe('STALLED');
    expect(r.lines).toEqual(['last', 'lines']);
  });

  it('stays PROGRESS while quiet but under the stall timeout', () => {
    const r = decide({ ...base, msSinceLastChange: 5_000 });
    expect(r.state).toBe('PROGRESS');
    expect(r.lines).toEqual([]);
  });
});
