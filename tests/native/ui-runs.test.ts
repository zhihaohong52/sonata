import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectDirs, runRows, clearUiRunCache, RUN_USAGE_REASON, MAX_PROJECT_DIRS, MAX_RUN_ROWS, PROJECT_CACHE_MS } from '../../src/native/ui-runs.js';

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
  clearUiRunCache();
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

  it('deduplicates a directory reached both ways through realpath', () => {
    const link = join(home, 'projB-link');
    try {
      symlinkSync(projB, link, 'dir');
    } catch {
      return; // Symlinks may be unavailable in a restricted test environment.
    }
    try {
      const dirs = projectDirs({
        ...deps(),
        tenants: () => [{ id: 't1', configPath: join(link, 'sonata.toml') }],
      });
      expect(dirs).toHaveLength(1);
      expect(realpathSync(dirs[0])).toBe(realpathSync(projB));
    } finally {
      rmSync(link, { recursive: true, force: true });
    }
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

  it('caps the union when the remaining directories come from sessions', () => {
    const dirs: string[] = [];
    const sessionHome = mkdtempSync(join(tmpdir(), 'sonata-uir-cap-home-'));
    try {
      for (let i = 0; i < MAX_PROJECT_DIRS - 2 + 5; i += 1) {
        dirs.push(mkdtempSync(join(tmpdir(), 'sonata-uir-cap-session-')));
      }
      mkdirSync(join(sessionHome, '.config', 'sonata'), { recursive: true });
      writeFileSync(join(sessionHome, '.config', 'sonata', 'sessions.json'), JSON.stringify(
        Object.fromEntries(dirs.slice(MAX_PROJECT_DIRS - 2).map((cwd, i) => [`s${i}`, { session: `s${i}`, cwd, started: '' }])),
      ));
      const tenantDirs = dirs.slice(0, MAX_PROJECT_DIRS - 2);
      const many = tenantDirs.map((dir, i) => ({ id: `t${i}`, configPath: join(dir, 'sonata.toml') }));
      expect(projectDirs({ ...deps(), home: sessionHome, tenants: () => many })).toHaveLength(MAX_PROJECT_DIRS);
    } finally {
      rmSync(sessionHome, { recursive: true, force: true });
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reuses a matching cache entry during the TTL', () => {
    let now = 1000;
    let tenants = [{ id: 't1', configPath: join(projA, 'sonata.toml') }];
    const cachedDeps = { ...deps(), now: () => now, tenants: () => tenants };
    expect(projectDirs(cachedDeps)).toEqual([projA, projB]);
    // The tenant object changes, but its config-path key stays the same. Change
    // the session source so a fresh enumeration would produce a different list.
    tenants = [{ id: 't2', configPath: join(projA, 'sonata.toml') }];
    writeFileSync(join(home, '.config', 'sonata', 'sessions.json'), JSON.stringify({
      s1: { session: 's1', cwd: projA, started: '2026-09-15T00:00:00.000Z' },
    }));
    now += PROJECT_CACHE_MS - 1;
    expect(projectDirs(cachedDeps)).toEqual([projA, projB]);
  });

  it('re-enumerates after the cache TTL', () => {
    let now = 1000;
    const cachedDeps = { ...deps(), now: () => now };
    expect(projectDirs(cachedDeps)).toEqual([projA, projB]);
    writeFileSync(join(home, '.config', 'sonata', 'sessions.json'), JSON.stringify({
      s1: { session: 's1', cwd: projA, started: '2026-09-15T00:00:00.000Z' },
    }));
    now += PROJECT_CACHE_MS;
    expect(projectDirs(cachedDeps)).toEqual([projA]);
  });

  it('clearUiRunCache forces immediate re-enumeration', () => {
    let tenantDirs = [projA];
    const cachedDeps = { ...deps(), now: () => 1000, tenants: () => tenantDirs.map((dir, i) => ({ id: `t${i}`, configPath: join(dir, 'sonata.toml') })) };
    expect(projectDirs(cachedDeps)).toEqual([projA, projB]);
    tenantDirs = [projB];
    clearUiRunCache();
    expect(projectDirs(cachedDeps)).toEqual([projB]);
  });

  it('does not reuse a cache entry for a different home or tenant set', () => {
    const otherHome = mkdtempSync(join(tmpdir(), 'sonata-uir-other-home-'));
    const otherProject = mkdtempSync(join(tmpdir(), 'sonata-uir-other-project-'));
    try {
      const first = { ...deps(), tenants: () => [{ id: 't1', configPath: join(projA, 'sonata.toml') }] };
      expect(projectDirs(first)).toEqual([projA, projB]);
      expect(projectDirs({ ...first, home: otherHome })).toEqual([projA]);
      expect(projectDirs({ ...first, tenants: () => [{ id: 't2', configPath: join(otherProject, 'sonata.toml') }] })).toEqual([otherProject, projB]);
    } finally {
      rmSync(otherHome, { recursive: true, force: true });
      rmSync(otherProject, { recursive: true, force: true });
    }
  });
});

describe('runRows', () => {
  it('finds runs across every discovered project', () => {
    expect(runRows(deps(), all).rows.map((r) => r.id).sort()).toEqual(['aaa111', 'bbb222', 'ccc333']);
  });

  it('never reports usage as zero', () => {
    for (const row of runRows(deps(), all).rows) {
      expect(row.usage).toBeNull();
      expect(row.usageReason).toBe(RUN_USAGE_REASON);
    }
  });

  it('carries state and the degraded verdict from summarizeRuns', () => {
    const rows = runRows(deps(), all).rows;
    expect(rows.find((r) => r.id === 'aaa111')!.state).toBe('DONE');
    expect(rows.find((r) => r.id === 'aaa111')!.degraded).toBe(false);
    expect(rows.find((r) => r.id === 'bbb222')!.state).toBe('RUNNING');
    expect(rows.find((r) => r.id === 'ccc333')!.degraded).toBe(true);
  });

  it('filters by project', () => {
    expect(runRows(deps(), { ...all, project: projB }).rows.map((r) => r.id)).toEqual(['ccc333']);
  });

  it('returns nothing when a session filter is set, since a run has no session id', () => {
    expect(runRows(deps(), { ...all, session: 's1' })).toEqual({ rows: [], truncated: false });
  });

  it('sorts newest first', () => {
    expect(runRows(deps(), all).rows.map((r) => r.id)).toEqual(['ccc333', 'bbb222', 'aaa111']);
  });

  it('survives a project with no .sonata directory at all', () => {
    const empty = mkdtempSync(join(tmpdir(), 'empty-'));
    try {
      const rows = runRows({ ...deps(), tenants: () => [{ id: 't1', configPath: join(empty, 'sonata.toml') }] }, all).rows;
      expect(rows.map((r) => r.id)).toEqual(['ccc333']);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

import { handleUiRequest } from '../../src/native/ui.js';

describe('GET /__sonata/api/sessions', () => {
  beforeEach(() => {
    const usage = join(home, '.config', 'sonata', 'usage');
    const day = new Date().toISOString().slice(0, 10);
    mkdirSync(usage, { recursive: true });
    writeFileSync(join(usage, `${day}.jsonl`), JSON.stringify({
      ts: new Date().toISOString(), ms: 10, alias: 'sonata-code-simple', upstream: 'litellm',
      status: 200, complete: true, tokens: { input: 100, output: 20 },
      price: { source: 'models-dev', totalUsd: 0.25 }, attempts: [], key: 'flash', session: 's1', project: projB,
    }) + '\n');
  });
  it('returns both row kinds in one list', () => {
    const res = handleUiRequest(
      { method: 'GET', url: '/__sonata/api/sessions?since=30d', headers: { host: 'localhost:4100' } },
      deps(),
    );
    expect(res?.status).toBe(200);
    const rows = JSON.parse((res!.body as Buffer).toString()).rows;
    const kinds = new Set(rows.map((r: any) => r.kind));
    expect(kinds).toEqual(new Set(['session', 'run']));
    expect(rows.find((r: any) => r.kind === 'session').requests).toBe(1);
    expect(rows.find((r: any) => r.kind === 'run').usageReason).toBe(RUN_USAGE_REASON);
    // The payload says whether the run cap hid anything, rather than letting a
    // short list read as "this is all of them".
    expect(JSON.parse((res!.body as Buffer).toString()).runsTruncated).toBe(false);
  });
});

describe('run row caching and cap', () => {
  it('serves the rows from cache rather than re-reading every run per request', () => {
    const cachedDeps = { ...deps(), now: () => 1000 };
    expect(runRows(cachedDeps, all).rows.map((r) => r.id)).toEqual(['ccc333', 'bbb222', 'aaa111']);
    // A new run on disk must NOT appear until the TTL expires: that is the
    // proof the rows themselves are cached, not merely the directory list.
    makeRun(projA, 'ddd444', { role: 'code', startedAt: '2026-09-15T06:00:00.000Z' });
    expect(runRows(cachedDeps, all).rows.map((r) => r.id)).toEqual(['ccc333', 'bbb222', 'aaa111']);
    expect(runRows({ ...cachedDeps, now: () => 1000 + PROJECT_CACHE_MS }, all).rows.map((r) => r.id))
      .toEqual(['ddd444', 'ccc333', 'bbb222', 'aaa111']);
  });

  it('keeps the NEWEST rows when the cap is reached, not the first project\'s', () => {
    // projB's run is the newest of the three seeded ones; bury it behind more
    // runs than the cap allows in projA, which is enumerated first.
    for (let i = 0; i < MAX_RUN_ROWS + 10; i += 1) {
      const id = i.toString(16).padStart(6, '0');
      // All older than projB's 05:00 run.
      makeRun(projA, id, { role: 'code', startedAt: `2026-09-14T00:00:00.00${i % 10}Z` });
    }
    const { rows, truncated } = runRows(deps(), all);
    expect(rows).toHaveLength(MAX_RUN_ROWS);
    expect(truncated).toBe(true);
    expect(rows[0].id).toBe('ccc333');
    expect(rows.map((r) => r.id)).toContain('bbb222');
  });

  it("caps AFTER filtering, so a filter never shows a project's share of a global cap", () => {
    // Bury projB's single run behind far more than the cap in projA. Capping
    // before filtering would return nothing for projB while it has a run.
    for (let i = 0; i < MAX_RUN_ROWS + 10; i += 1) {
      const id = i.toString(16).padStart(6, '0');
      makeRun(projA, id, { role: 'code', startedAt: `2026-09-16T00:00:00.00${i % 10}Z` });
    }
    const filtered = runRows(deps(), { ...all, project: projB });
    expect(filtered.rows.map((r) => r.id)).toEqual(['ccc333']);
    expect(filtered.truncated).toBe(false);
    // ...and the unfiltered view is still capped and still says so.
    expect(runRows(deps(), all).truncated).toBe(true);
  });

  it('serves two different project filters correctly from ONE warm cache', () => {
    const cachedDeps = { ...deps(), now: () => 1000 };
    // Warm the cache with one filter, then query the other inside the TTL.
    expect(runRows(cachedDeps, { ...all, project: projA }).rows.map((r) => r.id))
      .toEqual(['bbb222', 'aaa111']);
    expect(runRows(cachedDeps, { ...all, project: projB }).rows.map((r) => r.id))
      .toEqual(['ccc333']);
    // The unfiltered view is unaffected by either: the filter lives on the
    // read side of the cache, never baked into the cached value.
    expect(runRows(cachedDeps, all).rows.map((r) => r.id))
      .toEqual(['ccc333', 'bbb222', 'aaa111']);
    expect(runRows(cachedDeps, { ...all, project: projA }).rows.map((r) => r.id))
      .toEqual(['bbb222', 'aaa111']);
  });
});
