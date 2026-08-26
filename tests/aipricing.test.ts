import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aiPricingPath, loadAiPricing, normalizeAiPricingRows } from '../src/aipricing.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'aipricing', 'prices.json');

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'sonata-aip-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('normalizeAiPricingRows', () => {
  const rows = JSON.parse(readFileSync(FIXTURE, 'utf8')).data as unknown[];

  it('groups rates by normalized model then provider', () => {
    const models = normalizeAiPricingRows(rows);
    expect(models['deepseek-v4-flash'].deepseek).toEqual({ input: 0.44, output: 1.32, cachedInput: 0.014 });
  });

  it('keeps providers distinct rather than collapsing them', () => {
    const models = normalizeAiPricingRows(rows);
    expect(models['deepseek-v4-flash'].fireworks.input).toBe(0.9);
  });

  it('folds a dated slug onto its normalized name', () => {
    expect(Object.keys(normalizeAiPricingRows(rows))).not.toContain('deepseek-v4-flash-0731');
  });

  it('ignores batch, non-USD and non-per-million rows', () => {
    expect(normalizeAiPricingRows(rows)['gpt-5.6-luna']).toBeUndefined();
  });

  it('ignores malformed rows', () => {
    expect(normalizeAiPricingRows([null, 42, {}, { canonical_slug: 'x' }])).toEqual({});
  });
});

describe('loadAiPricing', () => {
  it('returns undefined when absent', () => {
    expect(loadAiPricing(home)).toBeUndefined();
  });

  it('round-trips a written cache', () => {
    mkdirSync(dirname(aiPricingPath(home)), { recursive: true });
    writeFileSync(aiPricingPath(home), JSON.stringify({
      fetchedAt: '2026-08-26T15:31:30.637Z',
      models: { 'deepseek-v4-flash': { deepseek: { input: 0.44 } } },
    }));
    expect(loadAiPricing(home)!.models['deepseek-v4-flash'].deepseek.input).toBe(0.44);
  });

  it('returns undefined for a corrupt cache rather than throwing', () => {
    mkdirSync(dirname(aiPricingPath(home)), { recursive: true });
    writeFileSync(aiPricingPath(home), '{not json');
    expect(loadAiPricing(home)).toBeUndefined();
  });

  it('returns undefined when the shape is wrong', () => {
    mkdirSync(dirname(aiPricingPath(home)), { recursive: true });
    writeFileSync(aiPricingPath(home), JSON.stringify({ models: 'nope' }));
    expect(loadAiPricing(home)).toBeUndefined();
  });
});
