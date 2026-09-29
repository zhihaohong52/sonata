import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRun, runDir, writeMeta } from '../../src/store.js';
import { summarizeRuns } from '../../src/commands/runs.js';

let cwd: string;
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'sonata-runs-')); });
afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

describe('summarizeRuns', () => {
  it('lists a run with its role and model', () => {
    const meta = createRun(cwd, { role: 'code', model: 'kimi-k3' } as never);
    const runs = summarizeRuns(cwd);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: meta.id, role: 'code', model: 'kimi-k3', report: false });
  });

  it('marks a run with a report', () => {
    const meta = createRun(cwd, { role: 'code', model: 'kimi-k3' } as never);
    writeFileSync(join(runDir(cwd, meta.id), 'report.md'), 'done');
    expect(summarizeRuns(cwd)[0].report).toBe(true);
  });

  it('takes the verdict tail recorded rather than re-deriving it', () => {
    // A read-only run reports through its terminal output and writes no
    // report.md; tail records it un-degraded. The old re-derivation badged it
    // degraded — and trusted a timed-out run that happened to have a report.
    const readOnly = createRun(cwd, { role: 'review', model: 'm' } as never);
    writeFileSync(join(runDir(cwd, readOnly.id), 'exit'), '0\n');
    writeMeta(cwd, { ...readOnly, exitCode: 0, degraded: false });

    const timedOut = createRun(cwd, { role: 'code', model: 'm' } as never);
    writeFileSync(join(runDir(cwd, timedOut.id), 'exit'), '0\n');
    writeFileSync(join(runDir(cwd, timedOut.id), 'report.md'), 'partial');
    writeMeta(cwd, { ...timedOut, exitCode: 0, degraded: true });

    const byId = Object.fromEntries(summarizeRuns(cwd).map((r) => [r.id, r]));
    expect(byId[readOnly.id].degraded).toBe(false);
    expect(byId[timedOut.id].degraded).toBe(true);
  });

  it('keeps the old rule for a finished run tail never recorded a verdict for', () => {
    const meta = createRun(cwd, { role: 'code', model: 'm' } as never);
    writeFileSync(join(runDir(cwd, meta.id), 'exit'), '1\n');
    expect(summarizeRuns(cwd)[0].degraded).toBe(true);
  });

  it('returns nothing when no runs exist', () => {
    expect(summarizeRuns(cwd)).toEqual([]);
  });

  it('skips a run directory with no readable meta rather than throwing', () => {
    const meta = createRun(cwd, { role: 'code', model: 'kimi-k3' } as never);
    writeFileSync(join(runDir(cwd, meta.id), 'meta.json'), '{not json');
    expect(summarizeRuns(cwd)).toEqual([]);
  });
});