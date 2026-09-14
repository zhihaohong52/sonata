import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionRows } from '../../src/native/ui-sessions.js';

let home: string;
const all = { sinceMs: 0 };

function row(over: Record<string, unknown>): string {
  return JSON.stringify({
    ts: new Date().toISOString(), ms: 10, alias: 'sonata-code-simple', upstream: 'litellm',
    status: 200, complete: true, tokens: { input: 100, output: 20 },
    price: { source: 'models-dev', totalUsd: 0.25 }, attempts: [], ...over,
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sonata-uis-'));
  const usage = join(home, '.config', 'sonata', 'usage');
  mkdirSync(usage, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  writeFileSync(join(usage, `${day}.jsonl`), [
    row({ key: 'flash', session: 's1', project: '/proj/a' }),
    row({ key: 'flash', session: 's1', project: '/proj/a' }),
    row({ key: 'terra', session: 's1', project: '/proj/a', price: { source: 'none' } }),
    row({ key: 'terra', session: 's2', project: '/proj/b', price: { source: 'covered', totalUsd: 3 } }),
  ].join('\n') + '\n');
  writeFileSync(join(home, '.config', 'sonata', 'sessions.json'), JSON.stringify({
    s1: { session: 's1', cwd: '/proj/a', started: '2026-09-15T00:00:00.000Z' },
    s2: { session: 's2', cwd: '/proj/b', started: '2026-09-15T01:00:00.000Z' },
    s3: { session: 's3', cwd: '/proj/c', started: '2026-09-15T02:00:00.000Z' },
  }));
});

afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('sessionRows', () => {
  const deps = () => ({ home, port: 4100 });

  it('produces one row per session that has ledger rows', () => {
    const rows = sessionRows(deps(), all);
    expect(rows.map((r) => r.id).sort()).toEqual(['s1', 's2']);
    expect(rows.every((r) => r.kind === 'session')).toBe(true);
  });

  it('omits a registered session with no requests rather than showing an empty row', () => {
    expect(sessionRows(deps(), all).find((r) => r.id === 's3')).toBeUndefined();
  });

  it('counts requests and tokens', () => {
    const s1 = sessionRows(deps(), all).find((r) => r.id === 's1')!;
    expect(s1.requests).toBe(3);
    expect(s1.input).toBe(300);
    expect(s1.output).toBe(60);
  });

  it('keeps unpriced and covered out of costUsd', () => {
    const rows = sessionRows(deps(), all);
    const s1 = rows.find((r) => r.id === 's1')!;
    expect(s1.costUsd).toBe(0.5);
    expect(s1.unpricedRequests).toBe(1);
    const s2 = rows.find((r) => r.id === 's2')!;
    expect(s2.costUsd).toBe(0);
    expect(s2.coveredUsd).toBe(3);
  });

  it('lists the distinct candidates that served it', () => {
    const s1 = sessionRows(deps(), all).find((r) => r.id === 's1')!;
    expect(s1.models.sort()).toEqual(['flash', 'terra']);
  });

  it('carries the start time from the session map', () => {
    const s1 = sessionRows(deps(), all).find((r) => r.id === 's1')!;
    expect(s1.started).toBe('2026-09-15T00:00:00.000Z');
  });

  it('filters by session', () => {
    expect(sessionRows(deps(), { ...all, session: 's2' }).map((r) => r.id)).toEqual(['s2']);
  });

  it('filters by project', () => {
    expect(sessionRows(deps(), { ...all, project: '/proj/b' }).map((r) => r.id)).toEqual(['s2']);
  });

  it('sorts newest first', () => {
    expect(sessionRows(deps(), all).map((r) => r.id)).toEqual(['s2', 's1']);
  });
});
