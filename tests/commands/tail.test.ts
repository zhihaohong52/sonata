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
  timedOut: false,
};

describe('tail decide — runs that cannot write a report', () => {
  const readOnly = { ...base, canWriteReport: false };

  it('does not call a clean read-only run degraded for lacking a report', () => {
    // pi's read-only allowlist removes the write tool, so the model cannot
    // write report.md. Nothing went wrong; the terminal output is the report.
    const r = decide({ ...readOnly, exitCode: 0 });
    expect(r.state).toBe('DONE');
    expect(r.degraded).toBe(false);
    expect(r.report).toContain('cannot write a report file');
    expect(r.report).toContain('last\nlines');
  });

  it('still flags a read-only run that crashed', () => {
    // Only a clean exit is expected to lack a report. A non-zero exit is a
    // real failure and must not be excused by the same rule.
    const r = decide({ ...readOnly, exitCode: 139 });
    expect(r.degraded).toBe(true);
    expect(r.report).toContain('degraded');
  });

  it('still flags a read-only run that timed out', () => {
    const r = decide({ ...readOnly, exitCode: 143, timedOut: true });
    expect(r.degraded).toBe(true);
    expect(r.report).toMatch(/^\[timed out:/);
  });

  it('prefers a real report when one exists anyway', () => {
    const r = decide({ ...readOnly, exitCode: 0, report: 'written after all' });
    expect(r.degraded).toBe(false);
    expect(r.report).toBe('written after all');
  });

  it('leaves write-capable runs degraded when they write nothing', () => {
    const r = decide({ ...base, canWriteReport: true, exitCode: 0 });
    expect(r.degraded).toBe(true);
  });
});

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

  it('marks a timed-out finished run DONE degraded with the timeout line', () => {
    const r = decide({ ...base, exitCode: 0, timedOut: true });
    expect(r.state).toBe('DONE');
    expect(r.degraded).toBe(true);
    expect(r.report).toMatch(/^\[timed out: sonata killed the run after the configured run_timeout_seconds\]\n\n/);
  });

  it('still degrades a timed-out run that has a report file', () => {
    const r = decide({ ...base, exitCode: 0, report: 'a complete report', timedOut: true });
    expect(r.state).toBe('DONE');
    expect(r.degraded).toBe(true);
    expect(r.report).toMatch(/^\[timed out: sonata killed the run after the configured run_timeout_seconds\]/);
    expect(r.report).toContain('last');
  });
});
