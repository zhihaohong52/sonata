import { describe, it, expect } from 'vitest';
import { normalizeModelsDevNames, displayNameFor, catalogSpellingsFor } from '../src/modelsdev.js';

// A vendor's own API publishes a versionless alias beside the versioned id:
// DeepSeek serves V4.1 Flash as `deepseek-flash`. models.dev keys each
// provider by that provider's slug, and the one field every provider agrees
// on for the same weights is the display `name`.
const doc = {
  deepseek: { models: {
    'deepseek-flash': { name: 'DeepSeek V4.1 Flash', cost: { input: 1, output: 2 } },
    'deepseek-v4-flash': { name: 'DeepSeek V4 Flash', cost: { input: 1, output: 2 } },
    // Uncosted: the rate normalizer drops it, but the name is still a fact.
    'deepseek-preview': { name: 'DeepSeek Preview' },
  } },
  openrouter: { models: {
    'deepseek/deepseek-v4.1-flash': { name: 'DeepSeek V4.1 Flash' },
  } },
  // Another reseller spells the *older* model with the slug DeepSeek uses for
  // the newer one — a slug is only meaningful under its own provider.
  nan: { models: { 'deepseek-v4-flash': { name: 'DeepSeek V4.1 Flash' } } },
  broken: { models: { 'no-name': { cost: { input: 1 } }, 'bad-name': { name: 7 }, 'empty-name': { name: '' } } },
};

describe('normalizeModelsDevNames', () => {
  it('reads name per provider and model, costed or not', () => {
    const n = normalizeModelsDevNames(doc);
    expect(n.deepseek['deepseek-flash']).toBe('DeepSeek V4.1 Flash');
    expect(n.deepseek['deepseek-preview']).toBe('DeepSeek Preview');
  });

  it('skips absent, non-string and empty names', () => {
    expect(normalizeModelsDevNames(doc).broken).toBeUndefined();
  });

  it('survives a malformed document', () => {
    expect(normalizeModelsDevNames(null)).toEqual({});
    expect(normalizeModelsDevNames({ p: { models: 'nope' } })).toEqual({});
  });
});

describe('displayNameFor', () => {
  const names = normalizeModelsDevNames(doc);

  it('resolves a slug under the named provider', () => {
    expect(displayNameFor(names, ['deepseek'], 'deepseek-flash')).toBe('DeepSeek V4.1 Flash');
  });

  it('never reads a slug under a provider the gateway did not name', () => {
    // `nan` files `deepseek-v4-flash` as V4.1; under `deepseek` it is V4.
    expect(displayNameFor(names, ['deepseek'], 'deepseek-v4-flash')).toBe('DeepSeek V4 Flash');
    expect(displayNameFor(names, ['openrouter'], 'deepseek-flash')).toBeUndefined();
  });

  it('matches a bare id against a vendor-qualified key, as pricing does', () => {
    expect(displayNameFor(names, ['openrouter'], 'deepseek-v4.1-flash')).toBe('DeepSeek V4.1 Flash');
  });

  it('answers nothing without a cache, providers, or an id', () => {
    expect(displayNameFor(undefined, ['deepseek'], 'deepseek-flash')).toBeUndefined();
    expect(displayNameFor(names, [], 'deepseek-flash')).toBeUndefined();
    expect(displayNameFor(names, ['deepseek'], '')).toBeUndefined();
  });
});

describe('catalogSpellingsFor', () => {
  const names = normalizeModelsDevNames(doc);

  it('offers the id, then the display name as a catalog spelling', () => {
    expect(catalogSpellingsFor(names, ['deepseek'], 'deepseek-flash'))
      .toEqual(['deepseek-flash', 'deepseek-v4.1-flash']);
  });

  it('offers only the id when the name adds nothing', () => {
    // Unknown to the cache, or a name that spells the same as the id.
    expect(catalogSpellingsFor(names, ['deepseek'], 'mystery-9')).toEqual(['mystery-9']);
    expect(catalogSpellingsFor(undefined, ['deepseek'], 'deepseek-flash')).toEqual(['deepseek-flash']);
    expect(catalogSpellingsFor({ p: { 'glm-5.2': 'GLM 5.2' } }, ['p'], 'glm-5.2')).toEqual(['glm-5.2']);
  });
});
