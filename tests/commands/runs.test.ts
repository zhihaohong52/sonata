import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRun, runDir } from '../../src/store.js';
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

  it('returns nothing when no runs exist', () => {
    expect(summarizeRuns(cwd)).toEqual([]);
  });

  it('skips a run directory with no readable meta rather than throwing', () => {
    const meta = createRun(cwd, { role: 'code', model: 'kimi-k3' } as never);
    writeFileSync(join(runDir(cwd, meta.id), 'meta.json'), '{not json');
    expect(summarizeRuns(cwd)).toEqual([]);
  });
});