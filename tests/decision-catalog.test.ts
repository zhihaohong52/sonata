import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseDecisionIndex, loadDecisionCatalog, updateDecisionCatalog, decisionCatalogPath, DECISION_INDEX_URL,
} from '../src/decision-catalog.js';

const fixture = readFileSync(join(process.cwd(), 'tests/fixtures/decision-index/leaderboard-sample.html'), 'utf8');

describe('parseDecisionIndex', () => {
  it('keeps scored decision models only: capability = index score, cost per 1000 tasks, time per task', () => {
    const c = parseDecisionIndex(fixture, '2026-10-01T00:00:00.000Z');
    expect(c.revision).toBe('Decision Index v1.0');
    expect(c.systems.map((s) => s.key)).toEqual(['typesafe_jev-1-13', 'liquid-ai_d1']);
    expect(c.systems[0]).toEqual({ key: 'typesafe_jev-1-13', display: 'Jev 1.13', capability: 57.5, usdPer1000: 0.0415, msPerTask: 127 });
    expect(c.systems[1].display).toBe('d1 ultra');
  });
  it('throws when the page holds no decision models', () => {
    expect(() => parseDecisionIndex('<html></html>', 'now')).toThrow(/no decision models/);
  });
});

describe('update and load', () => {
  it('fetches the pinned URL, writes the cache, and loads it back', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dc-'));
    const urls: string[] = [];
    const r = await updateDecisionCatalog(home, (async (url: string) => { urls.push(url); return new Response(fixture); }) as any, { now: () => new Date('2026-10-01T00:00:00Z') });
    expect(urls).toEqual([DECISION_INDEX_URL]);
    expect(r).toMatchObject({ systems: 2, revision: 'Decision Index v1.0', path: decisionCatalogPath(home) });
    expect(loadDecisionCatalog(home)?.systems).toHaveLength(2);
  });
  it('rejects a non-2xx response', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dc-'));
    await expect(updateDecisionCatalog(home, (async () => new Response('x', { status: 503 })) as any, {})).rejects.toThrow(/HTTP 503/);
  });
  it('loads nothing from an absent or corrupt cache', () => {
    const home = mkdtempSync(join(tmpdir(), 'dc-'));
    expect(loadDecisionCatalog(home)).toBeUndefined();
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(decisionCatalogPath(home), '{not json');
    expect(loadDecisionCatalog(home)).toBeUndefined();
  });
});
