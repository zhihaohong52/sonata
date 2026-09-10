import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModelsDev, modelsDevPath, normalizeModelsDev } from '../src/modelsdev.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'modelsdev', 'api.json');

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'sonata-modelsdev-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('normalizeModelsDev', () => {
  const doc = JSON.parse(readFileSync(FIXTURE, 'utf8')) as unknown;

  it('groups rates by provider then model and maps cache rates', () => {
    expect(normalizeModelsDev(doc).deepseek['deepseek-v4-flash']).toEqual({
      input: 0.44, output: 1.32, cachedInput: 0.014, cacheWrite: 0.66,
    });
  });

  it('keeps providers distinct and ignores long-context tiers', () => {
    const providers = normalizeModelsDev(doc);
    expect(providers.fireworks['deepseek-v4-flash'].input).toBe(0.9);
    expect(providers.deepseek['deepseek-v4-flash'].input).toBe(0.44);
  });

  it('keeps models with any valid rate and skips malformed models', () => {
    const providers = normalizeModelsDev(doc);
    expect(providers.deepseek['output-only']).toEqual({ output: 2 });
    expect(providers.deepseek['no-cost']).toBeUndefined();
    expect(providers.deepseek['bad-cost']).toBeUndefined();
  });

  it('ignores malformed documents', () => {
    expect(normalizeModelsDev(null)).toEqual({});
    expect(normalizeModelsDev({ broken: { models: [] } })).toEqual({});
  });
});

describe('loadModelsDev', () => {
  it('returns undefined when absent', () => {
    expect(loadModelsDev(home)).toBeUndefined();
  });

  it('round-trips a written cache', () => {
    mkdirSync(dirname(modelsDevPath(home)), { recursive: true });
    writeFileSync(modelsDevPath(home), JSON.stringify({
      fetchedAt: '2026-09-10T15:31:30.637Z',
      providers: { deepseek: { 'deepseek-v4-flash': { input: 0.44, cacheWrite: 0.66 } } },
    }));
    expect(loadModelsDev(home)!.providers.deepseek['deepseek-v4-flash'].cacheWrite).toBe(0.66);
  });

  it('returns undefined for corrupt or malformed caches', () => {
    mkdirSync(dirname(modelsDevPath(home)), { recursive: true });
    writeFileSync(modelsDevPath(home), '{not json');
    expect(loadModelsDev(home)).toBeUndefined();
    writeFileSync(modelsDevPath(home), JSON.stringify({ fetchedAt: 'x', providers: { p: { m: {} } } }));
    expect(loadModelsDev(home)).toBeUndefined();
    writeFileSync(modelsDevPath(home), JSON.stringify({ fetchedAt: 'x', providers: { p: { m: { unexpected: 1 } } } }));
    expect(loadModelsDev(home)).toBeUndefined();
    writeFileSync(modelsDevPath(home), JSON.stringify({ fetchedAt: 'x', providers: { p: { m: { input: -1 } } } }));
    expect(loadModelsDev(home)).toBeUndefined();
    writeFileSync(modelsDevPath(home), JSON.stringify({ fetchedAt: 'x', providers: { p: {} } }));
    expect(loadModelsDev(home)).toBeUndefined();
    writeFileSync(modelsDevPath(home), JSON.stringify({ fetchedAt: 42, providers: {} }));
    expect(loadModelsDev(home)).toBeUndefined();
  });
});
