import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { cmdCatalogUpdate } from '../../src/commands/catalog.js';
import { aaCatalogPath, loadAaCatalog } from '../../src/catalog.js';
import { AI_PRICING_PAGE_SIZE, aiPricingPageUrl, aiPricingPath } from '../../src/aipricing.js';
import { cmdAuthAdd } from '../../src/commands/auth.js';

// Both response fixtures are synthetic and hand-written, never API redistributions.
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sonata-catalog-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const aaFixture = () => JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/aa/models.json'), 'utf8'));
const pricingFixture = () => JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/aipricing/prices.json'), 'utf8'));

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** The fixture is one short page, which is what ends the offset walk. */
const isPricing = (input: string | URL | Request) =>
  String(input).startsWith('https://ai-pricing.fyi/');

function bothFixtures(input: string | URL | Request, init?: RequestInit): Response {
  if (isPricing(input)) {
    expect(init).toBeUndefined();
    expect(String(input)).toBe(aiPricingPageUrl(0));
    return response(pricingFixture());
  }
  // Paginated: the page number is part of the request, and the fixture
  // declares has_more:false so one page ends the loop.
  expect(String(input)).toBe('https://artificialanalysis.ai/api/v2/language/models/free?page=1');
  expect(new Headers(init?.headers).get('x-api-key')).toBe('synthetic-key');
  return response(aaFixture());
}

describe('cmdCatalogUpdate', () => {
  it('fetches and caches AA scores and public ai-pricing rates', async () => {
    cmdAuthAdd({ home, gateway: 'artificialanalysis', key: 'synthetic-key' });
    const result = await cmdCatalogUpdate(home, {
      fetch: async (input, init) => bothFixtures(input, init),
      now: () => new Date('2026-08-25T12:00:00.000Z'),
    });

    expect(result.aa).toEqual({ models: 3, path: aaCatalogPath(home), fetchedAt: '2026-08-25T12:00:00.000Z' });
    expect(result.aiPricing).toEqual({ models: 1, path: aiPricingPath(home), fetchedAt: '2026-08-25T12:00:00.000Z' });
    expect(JSON.parse(readFileSync(aaCatalogPath(home), 'utf8'))).toEqual({
      fetchedAt: '2026-08-25T12:00:00.000Z',
      // Recorded, not merely checked mid-fetch: two index versions are not
      // comparable, and without this on disk a cache scored under one is
      // indistinguishable from one scored under the next.
      intelligenceIndexVersion: '4.1',
      models: {
        'gpt-5.6-luna': {
          codingIndex: 72.5, blendedPriceUsd: 0.42,
          intelligenceIndex: 52.3, agenticIndex: 46.9, costPerTask: 0.0487,
        },
        'deepseek-v4-flash': {
          codingIndex: 48, blendedPriceUsd: 0.18,
          intelligenceIndex: 51.8, agenticIndex: 48.4, costPerTask: 0.1122,
        },
        // No agentic score and no cost per task: still rankable on the coding
        // index and the blend computed from its per-token rates.
        'example-model': { codingIndex: 31, blendedPriceUsd: 2.75 },
      },
    });
    expect(JSON.parse(readFileSync(aiPricingPath(home), 'utf8'))).toMatchObject({
      fetchedAt: '2026-08-25T12:00:00.000Z',
      models: { 'deepseek-v4-flash': { deepseek: { input: 0.44, output: 1.32, cachedInput: 0.014 } } },
    });
  });

  it('writes AA when ai-pricing fails', async () => {
    cmdAuthAdd({ home, gateway: 'artificialanalysis', key: 'synthetic-key' });
    const result = await cmdCatalogUpdate(home, {
      fetch: async (input, init) => isPricing(input) ? response({}, 503) : bothFixtures(input, init),
    });

    expect(result.aa).not.toHaveProperty('error');
    expect(result.aiPricing).toHaveProperty('error');
    expect(readFileSync(aaCatalogPath(home), 'utf8')).toContain('gpt-5.6-luna');
  });

  it('writes ai-pricing without an AA key', async () => {
    const calls: string[] = [];
    const result = await cmdCatalogUpdate(home, {
      fetch: async (input, init) => {
        calls.push(String(input));
        expect(init).toBeUndefined();
        return response(pricingFixture());
      },
    });

    expect(calls).toEqual([aiPricingPageUrl(0)]);
    expect(result.aa).toHaveProperty('error');
    expect(result.aiPricing).not.toHaveProperty('error');
    expect(readFileSync(aiPricingPath(home), 'utf8')).toContain('deepseek-v4-flash');
  });

  it('reports a rejected AA key without preventing ai-pricing', async () => {
    cmdAuthAdd({ home, gateway: 'artificialanalysis', key: 'synthetic-key' });
    const result = await cmdCatalogUpdate(home, {
      fetch: async (input) => isPricing(input) ? response(pricingFixture()) : response({ error: 'nope' }, 403),
    });
    expect(result.aa).toMatchObject({ error: expect.objectContaining({ message: expect.stringMatching(/key rejected.*403/i) }) });
    expect(result.aiPricing).not.toHaveProperty('error');
  });

  it('keeps an existing AA cache when its response contains no usable entries', async () => {
    cmdAuthAdd({ home, gateway: 'artificialanalysis', key: 'synthetic-key' });
    await cmdCatalogUpdate(home, { fetch: async (input, init) => bothFixtures(input, init) });
    const before = readFileSync(aaCatalogPath(home), 'utf8');

    const result = await cmdCatalogUpdate(home, {
      fetch: async (input) => isPricing(input) ? response(pricingFixture()) : response({ data: [] }),
    });
    expect(result.aa).toMatchObject({ error: expect.objectContaining({ message: expect.stringMatching(/no usable model/i) }) });
    expect(readFileSync(aaCatalogPath(home), 'utf8')).toBe(before);
  });

  it('keeps existing prices when no response rows are usable while AA succeeds', async () => {
    cmdAuthAdd({ home, gateway: 'artificialanalysis', key: 'synthetic-key' });
    await cmdCatalogUpdate(home, { fetch: async (input, init) => bothFixtures(input, init) });
    const before = readFileSync(aiPricingPath(home), 'utf8');

    const result = await cmdCatalogUpdate(home, {
      fetch: async (input, init) => isPricing(input)
        ? response({ data: [{
          canonical_slug: 'deepseek-v4-flash',
          provider_slug: 'deepseek',
          metric: 'input_token',
          unit: 'per_1m_tokens',
          currency: 'USD',
          price_numeric: 0.44,
          tier_key: 'batch',
          batch_flag: 1,
        }] })
        : bothFixtures(input, init),
    });

    expect(result.aiPricing).toMatchObject({
      error: expect.objectContaining({ message: expect.stringMatching(/no usable price rows/i) }),
    });
    expect(readFileSync(aiPricingPath(home), 'utf8')).toBe(before);
    expect(result.aa).not.toHaveProperty('error');
    expect(readFileSync(aaCatalogPath(home), 'utf8')).toContain('gpt-5.6-luna');
  });

  it('reports malformed AA responses without blocking ai-pricing', async () => {
    cmdAuthAdd({ home, gateway: 'artificialanalysis', key: 'synthetic-key' });
    const result = await cmdCatalogUpdate(home, {
      fetch: async (input) => isPricing(input) ? response(pricingFixture()) : response({ models: [] }),
    });
    expect(result.aa).toMatchObject({ error: expect.objectContaining({ message: expect.stringMatching(/malformed/i) }) });
    expect(result.aiPricing).not.toHaveProperty('error');
  });
});

describe('the cached index version survives a round trip', () => {
  it('loadAaCatalog reads back the version cmdCatalogUpdate wrote', async () => {
    cmdAuthAdd({ home, gateway: 'artificialanalysis', key: 'synthetic-key' });
    await cmdCatalogUpdate(home, {
      fetch: async (input, init) => bothFixtures(input, init),
      now: () => new Date('2026-08-25T12:00:00.000Z'),
    });
    expect(loadAaCatalog(home)?.intelligenceIndexVersion).toBe('4.1');
  });

  it('a cache written before the version existed still loads', () => {
    mkdirSync(dirname(aaCatalogPath(home)), { recursive: true });
    writeFileSync(aaCatalogPath(home), JSON.stringify({
      fetchedAt: '2026-08-25T12:00:00.000Z',
      models: { m: { codingIndex: 50, blendedPriceUsd: 1 } },
    }));
    const loaded = loadAaCatalog(home);
    expect(loaded?.models.m.codingIndex).toBe(50);
    expect(loaded?.intelligenceIndexVersion).toBeUndefined();
  });

  // A version that is not a string would read as a known scale while naming
  // none, which is worse than admitting the cache does not record one.
  it('drops a non-string version rather than trusting it', () => {
    mkdirSync(dirname(aaCatalogPath(home)), { recursive: true });
    writeFileSync(aaCatalogPath(home), JSON.stringify({
      fetchedAt: '2026-08-25T12:00:00.000Z',
      intelligenceIndexVersion: 4.1,
      models: { m: { codingIndex: 50, blendedPriceUsd: 1 } },
    }));
    expect(loadAaCatalog(home)?.intelligenceIndexVersion).toBeUndefined();
  });
});

// The bug this exists to prevent: the endpoint returns exactly `limit` rows
// with no `has_more`, no total and a 200, so one un-paged request looks like a
// complete fetch. Measured 2026-09-10, that dropped 441 of 694 models and
// every ledger row for one of them resolved to `unpriced`.
describe('ai-pricing pagination', () => {
  const row = (slug: string) => ({
    canonical_slug: slug,
    provider_slug: 'acme',
    metric: 'input_token',
    unit: 'per_1m_tokens',
    currency: 'USD',
    price_numeric: 1,
    tier_key: 'standard',
    batch_flag: 0,
  });

  it('keeps requesting while a page comes back full, and stops on a short one', async () => {
    const full = Array.from({ length: AI_PRICING_PAGE_SIZE }, (_, i) => row(`page1-model-${i}`));
    const requested: string[] = [];

    const result = await cmdCatalogUpdate(home, {
      now: () => new Date('2026-08-25T12:00:00.000Z'),
      fetch: async (input) => {
        requested.push(String(input));
        if (String(input) === aiPricingPageUrl(0)) return response({ data: full });
        if (String(input) === aiPricingPageUrl(AI_PRICING_PAGE_SIZE)) {
          return response({ data: [row('page2-only-model')] });
        }
        return response({ data: [] }, 500);
      },
    });

    expect(requested).toEqual([aiPricingPageUrl(0), aiPricingPageUrl(AI_PRICING_PAGE_SIZE)]);
    // The second page's model is the whole point: it is unreachable without
    // the offset walk, and asserting only on the count would pass without it.
    const cached = JSON.parse(readFileSync(aiPricingPath(home), 'utf8')) as { models: Record<string, unknown> };
    expect(cached.models).toHaveProperty('page2-only-model');
    expect(result).toMatchObject({ aiPricing: { models: AI_PRICING_PAGE_SIZE + 1 } });
  });

  it('stops at the first short page without asking for another', async () => {
    const requested: string[] = [];
    await cmdCatalogUpdate(home, {
      fetch: async (input) => {
        requested.push(String(input));
        return response({ data: [row('only-model')] });
      },
    });
    expect(requested.filter((u) => u.startsWith('https://ai-pricing.fyi/'))).toEqual([aiPricingPageUrl(0)]);
  });
});
