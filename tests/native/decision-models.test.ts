import { describe, it, expect, vi } from 'vitest';
import {
  parseModelListing, normalizeDecisionId, scoreFor, chooseDecisionModel, defaultDecisionModel, ModelListCache,
} from '../../src/native/decision-models.js';
import type { DecisionCatalog } from '../../src/decision-catalog.js';

const catalog: DecisionCatalog = {
  fetchedAt: '2026-10-01T00:00:00Z', revision: 'v1.5.4',
  systems: [
    { key: 'jev-1.13.0', display: 'Jev 1.13.0', repo: 'https://docs.typesafe.ai', capability: 80 },
    { key: 'kev-4b', display: 'kev 4B', repo: 'https://github.com/jaredpalmer/kev', capability: 55 },
    { key: 'winnow-12b', display: 'Winnow', repo: 'https://huggingface.co/EldanRing/Winnow-12B', capability: 79 },
    { key: 'free-a', display: 'Free A', capability: 60 },
    { key: 'paid-a', display: 'Paid A', capability: 60 },
  ],
};

describe('parseModelListing', () => {
  it('reads TypeSafe {models}', () => {
    expect(parseModelListing({ models: [{ id: 'jev-1.13' }, { name: 'jev-1.12' }] })).toEqual([{ id: 'jev-1.13' }, { id: 'jev-1.12' }]);
  });
  it('reads OpenRouter {data}, keeping only decision models with their price', () => {
    expect(parseModelListing({ data: [
      { id: 'typesafe/jev-1.13', architecture: { output_modalities: ['decisions'] }, pricing: { prompt: '0.000000042' } },
      { id: 'openai/gpt-x', architecture: { output_modalities: ['text'] }, pricing: { prompt: '0.000001' } },
      { id: 'respan/span-01-lite:free', architecture: { output_modalities: ['decisions'] }, pricing: { prompt: '0' } },
    ] })).toEqual([{ id: 'typesafe/jev-1.13', pricePerToken: 0.000000042 }, { id: 'respan/span-01-lite:free', pricePerToken: 0 }]);
  });
  it('treats a chat-only list as no decision models, and junk as no list', () => {
    expect(parseModelListing({ data: [{ id: 'llama', architecture: { output_modalities: ['text'] } }] })).toEqual([]);
    expect(parseModelListing({ object: 'list', data: [{ id: 'llama' }] })).toEqual([]);
    expect(parseModelListing('nope')).toBeUndefined();
    expect(parseModelListing({ something: 1 })).toBeUndefined();
  });
});

describe('normalizeDecisionId / scoreFor', () => {
  it('drops vendor, ~, :variant and a trailing .0', () => {
    expect(normalizeDecisionId('typesafe/jev-1.13')).toBe('jev-1.13');
    expect(normalizeDecisionId('jev-1.13.0')).toBe('jev-1.13');
    expect(normalizeDecisionId('respan/span-01-lite:free')).toBe('span-01-lite');
    expect(normalizeDecisionId('~typesafe/jev-latest')).toBe('jev-latest');
  });
  it('matches by key, then by the repo path tail, exactly', () => {
    expect(scoreFor('typesafe/jev-1.13', catalog)?.key).toBe('jev-1.13.0');
    expect(scoreFor('jaredpalmer/kev-4b', catalog)?.key).toBe('kev-4b');
    expect(scoreFor('EldanRing/Winnow-12B', catalog)?.key).toBe('winnow-12b');
    expect(scoreFor('~typesafe/jev-latest', catalog)).toBeUndefined();
    expect(scoreFor('kev-4', catalog)).toBeUndefined();
    expect(scoreFor('typesafe/jev-1.13', undefined)).toBeUndefined();
  });
});

describe('chooseDecisionModel', () => {
  const or = 'https://openrouter.ai/api';
  it('uses a pinned model without ranking', () => {
    expect(chooseDecisionModel({ baseUrl: or, pinned: 'x/y', listed: [{ id: 'typesafe/jev-1.13' }], catalog }))
      .toMatchObject({ model: 'x/y', reason: 'pinned' });
  });
  it('picks the highest capability, never an alias or an unscored model', () => {
    const c = chooseDecisionModel({ baseUrl: or, listed: [
      { id: '~typesafe/jev-latest' }, { id: 'inception/mercury-decide:free', pricePerToken: 0 },
      { id: 'jaredpalmer/kev-4b' }, { id: 'typesafe/jev-1.13' },
    ], catalog });
    expect(c.model).toBe('typesafe/jev-1.13');
    expect(c.ranked.map((r) => r.id)).toEqual(['typesafe/jev-1.13', 'jaredpalmer/kev-4b', '~typesafe/jev-latest', 'inception/mercury-decide:free']);
  });
  it('breaks an exact tie on price: free, then cheaper, then unlisted', () => {
    const c = chooseDecisionModel({ baseUrl: or, listed: [
      { id: 'v/paid-a', pricePerToken: 0.0000001 }, { id: 'v/free-a', pricePerToken: 0 },
    ], catalog });
    expect(c.model).toBe('v/free-a');
  });
  it('falls back to the URL default when nothing is listed or scored', () => {
    expect(chooseDecisionModel({ baseUrl: or, listed: undefined, catalog }).model).toBe('~typesafe/jev-latest');
    expect(chooseDecisionModel({ baseUrl: or, listed: [{ id: 'x/unknown' }], catalog }).model).toBe('~typesafe/jev-latest');
    expect(chooseDecisionModel({ baseUrl: 'http://localhost:8000', listed: undefined, catalog: undefined }).model).toBeUndefined();
    expect(chooseDecisionModel({ baseUrl: 'https://api.typesafe.ai', listed: [{ id: 'jev-1.13' }], catalog: undefined }).model).toBe('jev-latest');
  });
  it('asks TypeSafe for jev-latest when its listing has only unscored aliases (it 422s without a model)', () => {
    const c = chooseDecisionModel({ baseUrl: 'https://api.typesafe.ai', listed: [{ id: 'jev-latest' }, { id: 'jev-preview' }], catalog });
    expect(c.model).toBe('jev-latest');
  });
  it('knows the default per host', () => {
    expect(defaultDecisionModel('https://openrouter.ai/api')).toBe('~typesafe/jev-latest');
    expect(defaultDecisionModel('https://api.typesafe.ai')).toBe('jev-latest');
  });
});

describe('ModelListCache', () => {
  const listing = { data: [{ id: 'typesafe/jev-1.13', architecture: { output_modalities: ['decisions'] } }] };
  it('fetches <base>/v1/models once per hour per URL, with the key', async () => {
    let t = 0;
    const calls: Array<{ url: string; auth?: string }> = [];
    const cache = new ModelListCache((async (url: string, init: RequestInit) => {
      calls.push({ url, auth: (init.headers as Record<string, string>)?.authorization });
      return new Response(JSON.stringify(listing));
    }) as any, { now: () => t });
    expect(await cache.list('https://openrouter.ai/api', 'k')).toEqual([{ id: 'typesafe/jev-1.13' }]);
    t = 30 * 60_000; await cache.list('https://openrouter.ai/api', 'k');
    expect(calls).toEqual([{ url: 'https://openrouter.ai/api/v1/models', auth: 'Bearer k' }]);
    t = 61 * 60_000; await cache.list('https://openrouter.ai/api', 'k');
    expect(calls).toHaveLength(2);
  });
  it('remembers a failure for 5 minutes and sends no auth header without a key', async () => {
    let t = 0;
    const f = vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>)?.authorization).toBeUndefined();
      return new Response('nope', { status: 404 });
    });
    const cache = new ModelListCache(f as any, { now: () => t });
    expect(await cache.list('http://localhost:8000', undefined)).toBeUndefined();
    t = 4 * 60_000; await cache.list('http://localhost:8000', undefined);
    expect(f).toHaveBeenCalledTimes(1);
    t = 6 * 60_000; await cache.list('http://localhost:8000', undefined);
    expect(f).toHaveBeenCalledTimes(2);
  });
});
