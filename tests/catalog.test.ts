import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  normalizeModelName, lookupModel, proposeTiers, loadAaCatalog, aaCatalogPath,
  type AaCatalog,
} from '../src/catalog.js';

describe('normalizeModelName', () => {
  it('strips harness/provider prefixes and date suffixes', () => {
    expect(normalizeModelName('anexto-deepseek-v4-flash-0731')).toBe('deepseek-v4-flash');
    expect(normalizeModelName('opencode-anexto-deepseek-v4-pro-0813')).toBe('deepseek-v4-pro');
    expect(normalizeModelName('openai/gpt-5.6-terra')).toBe('gpt-5.6-terra');
    expect(normalizeModelName('gpt-5.6-luna')).toBe('gpt-5.6-luna');
  });

  it('is idempotent', () => {
    expect(normalizeModelName(normalizeModelName('anexto-deepseek-v4-flash-0731')))
      .toBe('deepseek-v4-flash');
  });

  it('remains idempotent on a full harness-provider-model key', () => {
    const once = normalizeModelName('opencode-anexto-deepseek-v4-pro-0813');
    expect(once).toBe('deepseek-v4-pro');
    expect(normalizeModelName(once)).toBe('deepseek-v4-pro');
  });

  it('bounds stripping to one harness then one provider, keeping a reserved-word model name', () => {
    // A model genuinely named "openai-something"/"pi-something": the unbounded
    // loop ate the model's own prefix past the provider segment. Two passes
    // strip the key's harness and provider, then stop.
    expect(normalizeModelName('opencode-openrouter-openai-something')).toBe('openai-something');
    expect(normalizeModelName('codex-openai-pi-something')).toBe('pi-something');
  });
});

describe('lookupModel', () => {
  it('classifies curated models without AA data', () => {
    expect(lookupModel('deepseek-v4-flash')).toMatchObject({ capable: true, cheap: true, source: 'curated' });
    expect(lookupModel('gpt-5.6-terra')).toMatchObject({ capable: true, cheap: false, source: 'curated' });
  });

  it('defaults unknown models to capable-not-cheap — never demote silently', () => {
    expect(lookupModel('mystery-model-9000')).toEqual({ capable: true, cheap: false, source: 'default' });
  });

  it('prefers AA data over the curated table when present', () => {
    const aa: AaCatalog = {
      fetchedAt: '2026-08-25T00:00:00Z',
      models: { 'deepseek-v4-flash': { codingIndex: 10, blendedPriceUsd: 0.2 } },
    };
    // AA says this model is below the capable threshold: not complex-eligible.
    expect(lookupModel('deepseek-v4-flash', aa)).toMatchObject({ capable: false, source: 'aa' });
  });
});

describe('proposeTiers', () => {
  it('splits keys into simple (cheap) and complex (capable), ranked', () => {
    const aa: AaCatalog = {
      fetchedAt: '2026-08-25T00:00:00Z',
      models: {
        'deepseek-v4-flash': { codingIndex: 45, blendedPriceUsd: 0.3 },
        'gpt-5.6-luna': { codingIndex: 42, blendedPriceUsd: 0.5 },
        'deepseek-v4-pro': { codingIndex: 60, blendedPriceUsd: 2.5 },
        'gpt-5.6-terra': { codingIndex: 70, blendedPriceUsd: 6.0 },
      },
    };
    const tiers = proposeTiers(
      ['deepseek-v4-flash', 'gpt-5.6-luna', 'deepseek-v4-pro', 'gpt-5.6-terra'], aa,
    );
    // simple = cheap AND capable, ranked by coding index desc
    expect(tiers.simple).toEqual(['deepseek-v4-flash', 'gpt-5.6-luna']);
    // complex = capable, ranked by index desc, price asc tie-break
    expect(tiers.complex[0]).toBe('gpt-5.6-terra');
    expect(tiers.complex).toContain('deepseek-v4-pro');
  });

  it('never returns an empty complex list when any model exists', () => {
    const tiers = proposeTiers(['mystery-model-9000']);
    expect(tiers.complex).toEqual(['mystery-model-9000']);
    // no cheap models: simple mirrors complex so the tier still resolves
    expect(tiers.simple).toEqual(['mystery-model-9000']);
  });

  it('breaks a coding-index tie by price, cheaper first', () => {
    const aa: AaCatalog = {
      fetchedAt: '2026-08-25T00:00:00Z',
      models: {
        'gpt-5.6-luna': { codingIndex: 50, blendedPriceUsd: 0.9 },
        'deepseek-v4-flash': { codingIndex: 50, blendedPriceUsd: 0.2 },
      },
    };
    const tiers = proposeTiers(['gpt-5.6-luna', 'deepseek-v4-flash'], aa);
    expect(tiers.complex).toEqual(['deepseek-v4-flash', 'gpt-5.6-luna']);
  });

  it('ranks the all-below-threshold fallback rather than raw input order', () => {
    const aa: AaCatalog = {
      fetchedAt: '2026-08-25T00:00:00Z',
      models: {
        'gpt-5.6-luna': { codingIndex: 30, blendedPriceUsd: 0.5 },
        'deepseek-v4-flash': { codingIndex: 20, blendedPriceUsd: 0.2 },
        'kimi-k3': { codingIndex: 35, blendedPriceUsd: 0.4 },
      },
    };
    // None clears the capable threshold, so the fallback takes every key —
    // and must still rank by index desc, not the order they were passed in.
    const tiers = proposeTiers(['gpt-5.6-luna', 'deepseek-v4-flash', 'kimi-k3'], aa);
    expect(tiers.complex).toEqual(['kimi-k3', 'gpt-5.6-luna', 'deepseek-v4-flash']);
  });
});

describe('loadAaCatalog', () => {
  it('reads the cache file and returns undefined when absent or corrupt', () => {
    const home = mkdtempSync(join(tmpdir(), 'sonata-catalog-'));
    expect(loadAaCatalog(home)).toBeUndefined();
    const path = aaCatalogPath(home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ fetchedAt: 'x', models: { m: { codingIndex: 1, blendedPriceUsd: 1 } } }));
    expect(loadAaCatalog(home)?.models.m.codingIndex).toBe(1);
    writeFileSync(path, '{ not json');
    expect(loadAaCatalog(home)).toBeUndefined();
  });

  it('drops entries with non-numeric scores while keeping their valid siblings', () => {
    const home = mkdtempSync(join(tmpdir(), 'sonata-catalog-'));
    const path = aaCatalogPath(home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      fetchedAt: 'x',
      models: {
        good: { codingIndex: 60, blendedPriceUsd: 1.2 },
        missing: { codingIndex: 60 },                  // blendedPriceUsd undefined
        nullPrice: { codingIndex: 60, blendedPriceUsd: null },
        stringIndex: { codingIndex: 'high', blendedPriceUsd: 0.5 },
        infinite: { codingIndex: Infinity, blendedPriceUsd: 0.5 },
      },
    }));
    const loaded = loadAaCatalog(home);
    expect(loaded).toBeDefined();
    expect(Object.keys(loaded!.models)).toEqual(['good']);
    expect(loaded!.models.good.codingIndex).toBe(60);
  });

  it('returns undefined when every entry is invalid', () => {
    const home = mkdtempSync(join(tmpdir(), 'sonata-catalog-'));
    const path = aaCatalogPath(home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      fetchedAt: 'x',
      models: {
        a: { codingIndex: 'nope', blendedPriceUsd: 0.5 },
        b: { codingIndex: 50 },
      },
    }));
    expect(loadAaCatalog(home)).toBeUndefined();
  });
});
