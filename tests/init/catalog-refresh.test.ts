import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { aaCatalogPath } from '../../src/catalog.js';
import {
  CATALOG_REFRESH_MIN_AGE_HOURS,
  refreshCatalogIfUncovered,
  uncoveredCandidates,
  type CatalogRefreshDeps,
} from '../../src/init/catalog-refresh.js';
import type { NativeCandidate } from '../../src/init/helpers.js';

const NOW = new Date('2026-10-04T00:00:00Z');

function candidate(gateway: string, id: string): NativeCandidate {
  return { key: `${gateway}-${id}`, gateway, id, contextWindow: 200_000, baseUrl: 'https://x.example/v1', auth: { type: 'api-key' } as never };
}

function homeWith(models: Record<string, unknown> | undefined, fetchedAt = '2026-09-20T00:00:00Z'): string {
  const home = mkdtempSync(join(tmpdir(), 'sonata-catalog-refresh-'));
  if (models !== undefined) {
    const path = aaCatalogPath(home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ fetchedAt, models }));
  }
  return home;
}

function deps(home: string, over: Partial<CatalogRefreshDeps> = {}): CatalogRefreshDeps & { calls: number } {
  const d = {
    home,
    calls: 0,
    hasKey: () => true,
    update: async () => { d.calls += 1; return { models: 7 }; },
    now: () => NOW,
    ...over,
  };
  return d;
}

const SOL = { intelligenceIndex: 47.6, blendedPriceUsd: 4, costPerTask: 1.04, family: 'gpt-6-sol', effort: 'max' };

describe('uncoveredCandidates', () => {
  it('matches a dotted harness id against AA\'s dashed slug', () => {
    const catalog = { fetchedAt: '2026-09-20T00:00:00Z', models: { 'gpt-6-1-sol': { ...SOL, family: 'gpt-6-1-sol' } } } as never;
    expect(uncoveredCandidates([candidate('codex', 'gpt-6.1-sol')], catalog, undefined)).toEqual([]);
    expect(uncoveredCandidates([candidate('codex', 'gpt-7-sol')], catalog, undefined)).toEqual(['codex-gpt-7-sol']);
  });
});

describe('refreshCatalogIfUncovered', () => {
  it('refreshes when a discovered model is missing from an older catalog', async () => {
    const lines: string[] = [];
    const d = deps(homeWith({ 'gpt-6-sol': SOL }));
    await refreshCatalogIfUncovered([candidate('codex', 'gpt-6-sol'), candidate('codex', 'gpt-6.1-sol')], d, (l) => lines.push(l));
    expect(d.calls).toBe(1);
    expect(lines.join('\n')).toContain('codex-gpt-6.1-sol');
    expect(lines.join('\n')).toContain('catalog refreshed: 7 models');
  });

  it('does nothing when the catalog covers every discovered model', async () => {
    const d = deps(homeWith({ 'gpt-6-sol': SOL }));
    await refreshCatalogIfUncovered([candidate('codex', 'gpt-6-sol')], d, () => {});
    expect(d.calls).toBe(0);
  });

  it('does not refetch a recent catalog for a model AA has not scored yet', async () => {
    const recent = new Date(NOW.getTime() - (CATALOG_REFRESH_MIN_AGE_HOURS - 1) * 3_600_000).toISOString();
    const d = deps(homeWith({ 'gpt-6-sol': SOL }, recent));
    await refreshCatalogIfUncovered([candidate('codex', 'gpt-6.1-sol')], d, () => {});
    expect(d.calls).toBe(0);
  });

  it('fetches a catalog when none is cached', async () => {
    const d = deps(homeWith(undefined));
    await refreshCatalogIfUncovered([candidate('codex', 'gpt-6-sol')], d, () => {});
    expect(d.calls).toBe(1);
  });

  it('skips without an AA key', async () => {
    const d = deps(homeWith(undefined), { hasKey: () => false });
    await refreshCatalogIfUncovered([candidate('codex', 'gpt-6-sol')], d, () => {});
    expect(d.calls).toBe(0);
  });

  it('reports a failed fetch and carries on', async () => {
    const lines: string[] = [];
    const d = deps(homeWith(undefined), { update: async () => ({ error: new Error('HTTP 503') }) });
    await expect(refreshCatalogIfUncovered([candidate('codex', 'gpt-6-sol')], d, (l) => lines.push(l))).resolves.toBeUndefined();
    expect(lines.join('\n')).toContain('catalog refresh failed: HTTP 503');
  });
});
