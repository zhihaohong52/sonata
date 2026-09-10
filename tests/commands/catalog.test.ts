import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { cmdCatalogUpdate } from '../../src/commands/catalog.js';
import { aaCatalogPath, loadAaCatalog } from '../../src/catalog.js';
import { MODELS_DEV_URL, modelsDevPath } from '../../src/modelsdev.js';
import { cmdAuthAdd } from '../../src/commands/auth.js';

// Both response fixtures are synthetic and hand-written, never API redistributions.
let home: string;

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'sonata-catalog-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const aaFixture = () => JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/aa/models.json'), 'utf8'));
const modelsDevFixture = () => JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/modelsdev/api.json'), 'utf8'));

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const isModelsDev = (input: string | URL | Request) => String(input) === MODELS_DEV_URL;

function bothFixtures(input: string | URL | Request, init?: RequestInit): Response {
  if (isModelsDev(input)) {
    expect(init).toBeUndefined();
    return response(modelsDevFixture());
  }
  expect(String(input)).toBe('https://artificialanalysis.ai/api/v2/language/models/free?page=1');
  expect(new Headers(init?.headers).get('x-api-key')).toBe('synthetic-key');
  return response(aaFixture());
}

describe('cmdCatalogUpdate', () => {
  it('fetches and caches AA scores and public models.dev rates', async () => {
    cmdAuthAdd({ home, gateway: 'artificialanalysis', key: 'synthetic-key' });
    const result = await cmdCatalogUpdate(home, {
      fetch: async (input, init) => bothFixtures(input, init),
      now: () => new Date('2026-09-10T12:00:00.000Z'),
    });

    expect(result.aa).toEqual({ models: 3, path: aaCatalogPath(home), fetchedAt: '2026-09-10T12:00:00.000Z' });
    expect(result.modelsDev).toEqual({ models: 3, path: modelsDevPath(home), fetchedAt: '2026-09-10T12:00:00.000Z' });
    expect(JSON.parse(readFileSync(aaCatalogPath(home), 'utf8'))).toMatchObject({
      fetchedAt: '2026-09-10T12:00:00.000Z',
      intelligenceIndexVersion: '4.1',
      models: { 'gpt-5.6-luna': { codingIndex: 72.5, blendedPriceUsd: 0.42 } },
    });
    expect(JSON.parse(readFileSync(modelsDevPath(home), 'utf8'))).toMatchObject({
      fetchedAt: '2026-09-10T12:00:00.000Z',
      providers: { deepseek: { 'deepseek-v4-flash': { input: 0.44, output: 1.32, cachedInput: 0.014, cacheWrite: 0.66 } } },
    });
  });

  it('writes AA when models.dev fails', async () => {
    cmdAuthAdd({ home, gateway: 'artificialanalysis', key: 'synthetic-key' });
    const result = await cmdCatalogUpdate(home, {
      fetch: async (input, init) => isModelsDev(input) ? response({}, 503) : bothFixtures(input, init),
    });
    expect(result.aa).not.toHaveProperty('error');
    expect(result.modelsDev).toHaveProperty('error');
    expect(readFileSync(aaCatalogPath(home), 'utf8')).toContain('gpt-5.6-luna');
  });

  it('writes models.dev without an AA key', async () => {
    const calls: string[] = [];
    const result = await cmdCatalogUpdate(home, {
      fetch: async (input, init) => {
        calls.push(String(input));
        expect(init).toBeUndefined();
        return response(modelsDevFixture());
      },
    });
    expect(calls).toEqual([MODELS_DEV_URL]);
    expect(result.aa).toHaveProperty('error');
    expect(result.modelsDev).not.toHaveProperty('error');
    expect(readFileSync(modelsDevPath(home), 'utf8')).toContain('deepseek-v4-flash');
  });

  it('reports a rejected AA key without preventing models.dev', async () => {
    cmdAuthAdd({ home, gateway: 'artificialanalysis', key: 'synthetic-key' });
    const result = await cmdCatalogUpdate(home, {
      fetch: async (input) => isModelsDev(input) ? response(modelsDevFixture()) : response({ error: 'nope' }, 403),
    });
    expect(result.aa).toMatchObject({ error: expect.objectContaining({ message: expect.stringMatching(/key rejected.*403/i) }) });
    expect(result.modelsDev).not.toHaveProperty('error');
  });

  it('keeps an existing AA cache when its response contains no usable entries', async () => {
    cmdAuthAdd({ home, gateway: 'artificialanalysis', key: 'synthetic-key' });
    await cmdCatalogUpdate(home, { fetch: async (input, init) => bothFixtures(input, init) });
    const before = readFileSync(aaCatalogPath(home), 'utf8');
    const result = await cmdCatalogUpdate(home, {
      fetch: async (input) => isModelsDev(input) ? response(modelsDevFixture()) : response({ data: [] }),
    });
    expect(result.aa).toMatchObject({ error: expect.objectContaining({ message: expect.stringMatching(/no usable model/i) }) });
    expect(readFileSync(aaCatalogPath(home), 'utf8')).toBe(before);
  });

  it('keeps existing models.dev prices when no response model is usable while AA succeeds', async () => {
    cmdAuthAdd({ home, gateway: 'artificialanalysis', key: 'synthetic-key' });
    await cmdCatalogUpdate(home, { fetch: async (input, init) => bothFixtures(input, init) });
    const before = readFileSync(modelsDevPath(home), 'utf8');
    const result = await cmdCatalogUpdate(home, {
      fetch: async (input, init) => isModelsDev(input)
        ? response({ p: { models: { m: { cost: { input: 'wrong' } } } } })
        : bothFixtures(input, init),
    });
    expect(result.modelsDev).toMatchObject({ error: expect.objectContaining({ message: expect.stringMatching(/no usable model/i) }) });
    expect(readFileSync(modelsDevPath(home), 'utf8')).toBe(before);
    expect(result.aa).not.toHaveProperty('error');
  });

  it('reports malformed AA responses without blocking models.dev', async () => {
    cmdAuthAdd({ home, gateway: 'artificialanalysis', key: 'synthetic-key' });
    const result = await cmdCatalogUpdate(home, {
      fetch: async (input) => isModelsDev(input) ? response(modelsDevFixture()) : response({ models: [] }),
    });
    expect(result.aa).toMatchObject({ error: expect.objectContaining({ message: expect.stringMatching(/malformed/i) }) });
    expect(result.modelsDev).not.toHaveProperty('error');
  });

  it('leaves models.dev cache untouched for malformed responses', async () => {
    await cmdCatalogUpdate(home, { fetch: async () => response(modelsDevFixture()) });
    const before = readFileSync(modelsDevPath(home), 'utf8');
    const result = await cmdCatalogUpdate(home, { fetch: async () => response([]) });
    expect(result.modelsDev).toHaveProperty('error');
    expect(readFileSync(modelsDevPath(home), 'utf8')).toBe(before);
  });
});

describe('the cached index version survives a round trip', () => {
  it('loadAaCatalog reads back the version cmdCatalogUpdate wrote', async () => {
    cmdAuthAdd({ home, gateway: 'artificialanalysis', key: 'synthetic-key' });
    await cmdCatalogUpdate(home, { fetch: async (input, init) => bothFixtures(input, init) });
    expect(loadAaCatalog(home)?.intelligenceIndexVersion).toBe('4.1');
  });

  it('a cache written before the version existed still loads', () => {
    mkdirSync(dirname(aaCatalogPath(home)), { recursive: true });
    writeFileSync(aaCatalogPath(home), JSON.stringify({
      fetchedAt: '2026-08-25T12:00:00.000Z', models: { m: { codingIndex: 50, blendedPriceUsd: 1 } },
    }));
    expect(loadAaCatalog(home)?.models.m.codingIndex).toBe(50);
  });
});
