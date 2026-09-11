import { describe, it, expect } from 'vitest';
import { normalizeModelsDevContexts, contextWindowFor, enrichContextWindows, DEFAULT_CONTEXT_WINDOW } from '../src/modelsdev.js';

const doc = {
  deepseek: { models: {
    'deepseek-v4-pro': { cost: { input: 1, output: 2 }, limit: { context: 1_000_000, output: 384_000 } },
    'deepseek-v4-flash': { cost: { input: 1, output: 2 }, limit: { context: 128_000 } },
  } },
  openrouter: { models: {
    'deepseek/deepseek-v4-pro': { cost: { input: 1, output: 2 }, limit: { context: 1_000_000 } },
    // Deliberately uncosted: the rate normalizer drops this model, but its
    // context is still a fact about the model and must survive.
    'free/experimental-x': { limit: { context: 262_144 } },
  } },
  broken: { models: {
    'no-limit': { cost: { input: 1, output: 2 } },
    'bad-limit': { cost: { input: 1, output: 2 }, limit: { context: 'lots' } },
    'zero-limit': { cost: { input: 1, output: 2 }, limit: { context: 0 } },
  } },
};

describe('normalizeModelsDevContexts', () => {
  it('reads limit.context per provider and model', () => {
    const c = normalizeModelsDevContexts(doc);
    expect(c.deepseek['deepseek-v4-pro']).toBe(1_000_000);
    expect(c.deepseek['deepseek-v4-flash']).toBe(128_000);
  });

  // Rates and contexts are independent facts. A model models.dev has not
  // costed still has a real window, and dropping it would silently hand the
  // model the 128000 default it is meant to replace.
  it('keeps a model that has no cost at all', () => {
    expect(normalizeModelsDevContexts(doc).openrouter['free/experimental-x']).toBe(262_144);
  });

  it('skips absent, non-numeric and non-positive limits', () => {
    expect(normalizeModelsDevContexts(doc).broken).toBeUndefined();
  });

  it('survives a malformed document', () => {
    expect(normalizeModelsDevContexts(null)).toEqual({});
    expect(normalizeModelsDevContexts({ x: 7 })).toEqual({});
  });
});

describe('contextWindowFor', () => {
  const contexts = normalizeModelsDevContexts(doc);

  it('finds a bare id under its first-party provider', () => {
    expect(contextWindowFor(contexts, 'deepseek-v4-flash')).toBe(128_000);
  });

  // The same slash-suffix match pricing uses: a config carries the bare
  // upstream id while OpenRouter vendor-qualifies its keys.
  it('finds a bare id behind a vendor-qualified key', () => {
    expect(contextWindowFor(contexts, 'deepseek-v4-pro')).toBe(1_000_000);
  });

  // Measured on the real feed: `glm-5.2` is published by a dozen providers
  // between 202752 and 1048576, nearly all at ~1M, and taking the minimum let
  // one outlier understate it 5x — which then capped every tier containing it.
  it('takes the most commonly published window, not the smallest', () => {
    const mixed = normalizeModelsDevContexts({
      a: { models: { m: { limit: { context: 1_000_000 } } } },
      b: { models: { m: { limit: { context: 1_000_000 } } } },
      outlier: { models: { m: { limit: { context: 200_000 } } } },
    });
    expect(contextWindowFor(mixed, 'm')).toBe(1_000_000);
  });

  // A tie has no consensus to read, so it falls back to the safe direction:
  // an overstated window fails hard upstream, an understated one only wastes.
  it('breaks a tie toward the smaller window', () => {
    const tied = normalizeModelsDevContexts({
      a: { models: { m: { limit: { context: 1_000_000 } } } },
      b: { models: { m: { limit: { context: 200_000 } } } },
    });
    expect(contextWindowFor(tied, 'm')).toBe(200_000);
  });

  // A serving-variant suffix (`:free`, `:nitro`, `:floor`) picks a route for
  // the same weights, so it must not change the window. Measured on a real
  // config: `z-ai/glm-5.2:free` matched nothing while models.dev held that
  // exact row minus the suffix, and because the model sat in every tier it
  // capped all eight of them at the 128000 default.
  it('strips an OpenRouter serving-variant suffix', () => {
    const c = normalizeModelsDevContexts({ openrouter: { models: { 'z-ai/glm-5.2': { limit: { context: 1_048_576 } } } } });
    expect(contextWindowFor(c, 'z-ai/glm-5.2:free')).toBe(1_048_576);
    expect(contextWindowFor(c, 'glm-5.2:nitro')).toBe(1_048_576);
  });

  it('returns undefined for a model nobody lists', () => {
    expect(contextWindowFor(contexts, 'nobody-has-this')).toBeUndefined();
  });
});

describe('enrichContextWindows — replacing the 128000 guess', () => {
  const contexts = { deepseek: { 'deepseek-v4-pro': 1_000_000 }, or: { 'vendor/big-x': 262_144 } };
  const cand = (key: string, id: string, contextWindow: number) =>
    ({ key, gateway: 'g', id, contextWindow, baseUrl: 'https://g.example/v1', auth: 'api-key' as const });

  it('replaces the default with the window models.dev publishes', () => {
    const map = new Map([['a', cand('a', 'deepseek-v4-pro', 128_000)]]);
    enrichContextWindows(map, contexts);
    expect(map.get('a')!.contextWindow).toBe(1_000_000);
  });

  it('matches a vendor-qualified key from a bare id', () => {
    const map = new Map([['b', cand('b', 'big-x', 128_000)]]);
    enrichContextWindows(map, contexts);
    expect(map.get('b')!.contextWindow).toBe(262_144);
  });

  // A window that is not the default was chosen by someone. models.dev is a
  // better guess than sonata's, but it is not better than a decision.
  it('leaves a deliberately set window alone', () => {
    const map = new Map([['c', cand('c', 'deepseek-v4-pro', 64_000)]]);
    enrichContextWindows(map, contexts);
    expect(map.get('c')!.contextWindow).toBe(64_000);
  });

  it('leaves the default in place when models.dev has never heard of the model', () => {
    const map = new Map([['d', cand('d', 'private-model', 128_000)]]);
    enrichContextWindows(map, contexts);
    expect(map.get('d')!.contextWindow).toBe(128_000);
  });

  it('is a no-op with no cache at all', () => {
    const map = new Map([['e', cand('e', 'deepseek-v4-pro', 128_000)]]);
    enrichContextWindows(map, undefined);
    expect(map.get('e')!.contextWindow).toBe(128_000);
  });
});
