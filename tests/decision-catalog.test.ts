import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseJevBench, loadDecisionCatalog, updateDecisionCatalog, decisionCatalogPath, JEVBENCH_URL,
} from '../src/decision-catalog.js';

const fixture = JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/jevbench/v1.5.4-sample.json'), 'utf8'));

describe('parseJevBench', () => {
  it('keeps systems with both axes, capability = mean(intelligence, calibration)', () => {
    const c = parseJevBench(fixture, '2026-10-01T00:00:00.000Z');
    expect(c.revision).toBe('v1.5.4');
    expect(c.sourceSha256).toBe('abc123');
    expect(c.systems.map((s) => s.key)).toEqual(['jev-1.13.0', 'kev-4b', 'winnow-12b']);
    expect(c.systems[0]).toEqual({ key: 'jev-1.13.0', display: 'Jev 1.13.0 (TypeSafe AI)', repo: 'https://docs.typesafe.ai', capability: 80, usdPer1000: 0.032 });
    expect(c.systems[2].usdPer1000).toBeUndefined();
  });
  it('throws without a systems array', () => {
    expect(() => parseJevBench({ revision: 'x' }, 'now')).toThrow();
  });
});

describe('update and load', () => {
  it('fetches the pinned URL, writes the cache, and loads it back', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dc-'));
    const urls: string[] = [];
    const r = await updateDecisionCatalog(home, (async (url: string) => { urls.push(url); return new Response(JSON.stringify(fixture)); }) as any, { now: () => new Date('2026-10-01T00:00:00Z') });
    expect(urls).toEqual([JEVBENCH_URL]);
    expect(r).toMatchObject({ systems: 3, revision: 'v1.5.4', path: decisionCatalogPath(home) });
    expect(loadDecisionCatalog(home)?.systems).toHaveLength(3);
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
