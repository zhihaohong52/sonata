import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectDirs, runRows, clearProjectDirCache, RUN_USAGE_REASON, MAX_PROJECT_DIRS } from '../../src/native/ui-runs.js';

let home: string;
let projA: string;
let projB: string;
const all = { sinceMs: 0 };

function makeRun(cwd: string, id: string, meta: Record<string, unknown>, opts: { exit?: number; report?: string } = {}): void {
  const dir = join(cwd, '.sonata', 'runs', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ id, session: `sonata-${id}`, cwd, ...meta }));
  if (opts.exit !== undefined) writeFileSync(join(dir, 'exit'), String(opts.exit));
  if (opts.report !== undefined) writeFileSync(join(dir, 'report.md'), opts.report);
}

beforeEach(() => {
  clearProjectDirCache();
  home = mkdtempSync(join(tmpdir(), 'sonata-uir-'));
  projA = mkdtempSync(join(tmpdir(), 'projA-'));
  projB = mkdtempSync(join(tmpdir(), 'projB-'));
  mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
  writeFileSync(join(home, '.config', 'sonata', 'sessions.json'), JSON.stringify({
    s1: { session: 's1', cwd: projB, started: '2026-09-15T00:00:00.000Z' },
  }));
  makeRun(projA, 'aaa111', { role: 'code', model: 'flash', startedAt: '2026-09-15T03:00:00.000Z' }, { exit: 0, report: 'done' });
  makeRun(projA, 'bbb222', { role: 'review', model: 'terra', startedAt: '2026-09-15T04:00:00.000Z' });
  makeRun(projB, 'ccc333', { role: 'code', model: 'flash', startedAt: '2026-09-15T05:00:00.000Z' }, { exit: 1 });
});

afterEach(() => {
  for (const d of [home, projA, projB]) rmSync(d, { recursive: true, force: true });
});

const deps = () => ({
  home, port: 4100,
  tenants: () => [{ id: 't1', configPath: join(projA, 'sonata.toml') }],
});

describe('projectDirs', () => {
  it('unions tenant config directories with session cwds', () => {
    expect(projectDirs(deps()).sort()).toEqual([projA, projB].sort());
  });

  it('skips a tenant with no config path', () => {
    const dirs = projectDirs({ ...deps(), tenants: () => [{ id: 't1', configPath: null }] });
    expect(dirs).toEqual([projB]);
  });

  it('deduplicates a directory reached both ways', () => {
    const dirs = projectDirs({ ...deps(), tenants: () => [{ id: 't1', configPath: join(projB, 'sonata.toml') }] });
    expect(dirs).toEqual([projB]);
  });

  it('skips a directory that no longer exists rather than throwing', () => {
    const dirs = projectDirs({ ...deps(), tenants: () => [{ id: 't1', configPath: '/nope/sonata.toml' }] });
    expect(dirs).toEqual([projB]);
  });

  it('caps enumeration so a long-lived daemon cannot stat without bound', () => {
    const dirs: string[] = [];
    try {
      for (let i = 0; i < MAX_PROJECT_DIRS + 5; i += 1) {
        dirs.push(mkdtempSync(join(tmpdir(), 'sonata-uir-cap-')));
      }
      const many = dirs.map((dir, i) => ({ id: `t${i}`, configPath: join(dir, 'sonata.toml') }));
      expect(projectDirs({ ...deps(), tenants: () => many })).toHaveLength(MAX_PROJECT_DIRS);
    } finally {
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runRows', () => {
  it('finds runs across every discovered project', () => {
    expect(runRows(deps(), all).map((r) => r.id).sort()).toEqual(['aaa111', 'bbb222', 'ccc333']);
  });

  it('never reports usage as zero', () => {
    for (const row of runRows(deps(), all)) {
      expect(row.usage).toBeNull();
      expect(row.usageReason).toBe(RUN_USAGE_REASON);
    }
  });

  it('carries state and the degraded verdict from summarizeRuns', () => {
    const rows = runRows(deps(), all);
    expect(rows.find((r) => r.id === 'aaa111')!.state).toBe('DONE');
    expect(rows.find((r) => r.id === 'aaa111')!.degraded).toBe(false);
    expect(rows.find((r) => r.id === 'bbb222')!.state).toBe('RUNNING');
    expect(rows.find((r) => r.id === 'ccc333')!.degraded).toBe(true);
  });

  it('filters by project', () => {
    expect(runRows(deps(), { ...all, project: projB }).map((r) => r.id)).toEqual(['ccc333']);
  });

  it('returns nothing when a session filter is set, since a run has no session id', () => {
    expect(runRows(deps(), { ...all, session: 's1' })).toEqual([]);
  });

  it('sorts newest first', () => {
    expect(runRows(deps(), all).map((r) => r.id)).toEqual(['ccc333', 'bbb222', 'aaa111']);
  });

  it('survives a project with no .sonata directory at all', () => {
    const empty = mkdtempSync(join(tmpdir(), 'empty-'));
    try {
      const rows = runRows({ ...deps(), tenants: () => [{ id: 't1', configPath: join(empty, 'sonata.toml') }] }, all);
      expect(rows.map((r) => r.id)).toEqual(['ccc333']);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

import { handleUiRequest } from '../../src/native/ui.js';

describe('GET /__sonata/api/sessions', () => {
  it('returns both row kinds in one list', () => {
    const res = handleUiRequest(
      { method: 'GET', url: '/__sonata/api/sessions?since=30d', headers: { host: 'localhost:4100' } },
      deps(),
    );
    expect(res?.status).toBe(200);
    const kinds = new Set(JSON.parse((res!.body as Buffer).toString()).rows.map((r: any) => r.kind));
    expect(kinds.has('run')).toBe(true);
  });
});
