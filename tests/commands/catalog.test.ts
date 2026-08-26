import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdCatalogUpdate } from '../../src/commands/catalog.js';
import { aaCatalogPath } from '../../src/catalog.js';
import { AI_PRICING_URL, aiPricingPath } from '../../src/aipricing.js';
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

function bothFixtures(input: string | URL | Request, init?: RequestInit): Response {
  if (String(input) === AI_PRICING_URL) {
    expect(init).toBeUndefined();
    return response(pricingFixture());
  }
  expect(input).toBe('https://artificialanalysis.ai/api/v2/data/llms/models');
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
      models: {
        'gpt-5.6-luna': { codingIndex: 72.5, blendedPriceUsd: 0.42 },
        'deepseek-v4-flash': { codingIndex: 48, blendedPriceUsd: 0.18 },
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
      fetch: async (input, init) => String(input) === AI_PRICING_URL ? response({}, 503) : bothFixtures(input, init),
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

    expect(calls).toEqual([AI_PRICING_URL]);
    expect(result.aa).toHaveProperty('error');
    expect(result.aiPricing).not.toHaveProperty('error');
    expect(readFileSync(aiPricingPath(home), 'utf8')).toContain('deepseek-v4-flash');
  });

  it('reports a rejected AA key without preventing ai-pricing', async () => {
    cmdAuthAdd({ home, gateway: 'artificialanalysis', key: 'synthetic-key' });
    const result = await cmdCatalogUpdate(home, {
      fetch: async (input) => String(input) === AI_PRICING_URL ? response(pricingFixture()) : response({ error: 'nope' }, 403),
    });
    expect(result.aa).toMatchObject({ error: expect.objectContaining({ message: expect.stringMatching(/key rejected.*403/i) }) });
    expect(result.aiPricing).not.toHaveProperty('error');
  });

  it('keeps an existing AA cache when its response contains no usable entries', async () => {
    cmdAuthAdd({ home, gateway: 'artificialanalysis', key: 'synthetic-key' });
    await cmdCatalogUpdate(home, { fetch: async (input, init) => bothFixtures(input, init) });
    const before = readFileSync(aaCatalogPath(home), 'utf8');

    const result = await cmdCatalogUpdate(home, {
      fetch: async (input) => String(input) === AI_PRICING_URL ? response(pricingFixture()) : response({ data: [] }),
    });
    expect(result.aa).toMatchObject({ error: expect.objectContaining({ message: expect.stringMatching(/no usable model/i) }) });
    expect(readFileSync(aaCatalogPath(home), 'utf8')).toBe(before);
  });

  it('keeps existing prices when no response rows are usable while AA succeeds', async () => {
    cmdAuthAdd({ home, gateway: 'artificialanalysis', key: 'synthetic-key' });
    await cmdCatalogUpdate(home, { fetch: async (input, init) => bothFixtures(input, init) });
    const before = readFileSync(aiPricingPath(home), 'utf8');

    const result = await cmdCatalogUpdate(home, {
      fetch: async (input, init) => String(input) === AI_PRICING_URL
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
      fetch: async (input) => String(input) === AI_PRICING_URL ? response(pricingFixture()) : response({ models: [] }),
    });
    expect(result.aa).toMatchObject({ error: expect.objectContaining({ message: expect.stringMatching(/malformed/i) }) });
    expect(result.aiPricing).not.toHaveProperty('error');
  });
});
