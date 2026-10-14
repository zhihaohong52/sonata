import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModelsDev, modelsDevPath, needsResponsesApi, normalizeModelsDev, normalizeModelsDevResponsesOnly } from '../src/modelsdev.js';

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

  it('drops a malformed names map rather than failing the cache or a later lookup', () => {
    mkdirSync(dirname(modelsDevPath(home)), { recursive: true });
    const providers = { deepseek: { 'deepseek-v4-flash': { input: 0.44, output: 1.32 } } };
    writeFileSync(modelsDevPath(home), JSON.stringify({ fetchedAt: 'x', providers, names: null }));
    expect(loadModelsDev(home)!.names).toBeUndefined();
    writeFileSync(modelsDevPath(home), JSON.stringify({ fetchedAt: 'x', providers, names: { deepseek: null, ok: { 'deepseek-flash': 'DeepSeek V4.1 Flash' }, bad: { m: 7 } } }));
    expect(loadModelsDev(home)!.names).toEqual({ ok: { 'deepseek-flash': 'DeepSeek V4.1 Flash' } });
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

describe('normalizeModelsDevResponsesOnly', () => {
  // models.dev's OpenCode Go entry, trimmed: the provider speaks chat
  // completions, and three models override it. Measured 2026-10-14 against
  // the real API: `gpt-6-luna` serves only `/responses`, `minimax-m3` serves
  // chat completions (and Anthropic Messages), `glm-5.3-flash` chat only.
  const doc = {
    'opencode-go': {
      npm: '@ai-sdk/openai-compatible',
      api: 'https://opencode.ai/inference/go/v1',
      models: {
        'gpt-6-luna': { name: 'GPT-6 Luna', provider: { npm: '@ai-sdk/openai' } },
        'minimax-m3': { name: 'MiniMax M3', provider: { npm: '@ai-sdk/anthropic' } },
        'glm-5.3-flash': { name: 'GLM 5.3 Flash' },
      },
    },
    reseller: {
      npm: '@ai-sdk/openai-compatible', api: 'https://reseller.example/v1',
      models: { 'gpt-6-luna': { provider: { npm: '@ai-sdk/openai' } } },
    },
    // The OpenAI provider itself: its models are all `@ai-sdk/openai`, which
    // says nothing about an override, so nothing is recorded for it.
    openai: { npm: '@ai-sdk/openai', api: 'https://api.openai.com/v1', models: { 'gpt-6-luna': { provider: { npm: '@ai-sdk/openai' } } } },
  };
  const cache = { responsesOnly: normalizeModelsDevResponsesOnly(doc) };

  it('records only the models an OpenAI-compatible provider overrides onto the Responses API, with its endpoint', () => {
    expect(cache.responsesOnly).toEqual({
      'opencode-go': { api: 'https://opencode.ai/inference/go/v1', ids: ['gpt-6-luna'] },
      reseller: { api: 'https://reseller.example/v1', ids: ['gpt-6-luna'] },
    });
    expect(normalizeModelsDevResponsesOnly(null)).toEqual({});
  });

  it('matches a gateway by its endpoint — either OpenCode Go path — never by anything else', () => {
    expect(needsResponsesApi(cache, 'https://opencode.ai/inference/go/v1', 'gpt-6-luna')).toBe(true);
    expect(needsResponsesApi(cache, 'https://opencode.ai/zen/go/v1/', 'gpt-6-luna')).toBe(true);
    expect(needsResponsesApi(cache, 'https://opencode.ai/zen/go/v1', 'minimax-m3')).toBe(false);
    // Another endpoint serving the same id says nothing about this one.
    expect(needsResponsesApi(cache, 'https://other.example/v1', 'gpt-6-luna')).toBe(false);
    expect(needsResponsesApi(cache, 'https://reseller.example/v1', 'gpt-6-luna')).toBe(true);
    expect(needsResponsesApi(cache, undefined, 'gpt-6-luna')).toBe(false);
    expect(needsResponsesApi(undefined, 'https://opencode.ai/zen/go/v1', 'gpt-6-luna')).toBe(false);
  });

  it('survives a cache round trip, and a malformed map is dropped rather than failing the cache', () => {
    mkdirSync(dirname(modelsDevPath(home)), { recursive: true });
    const providers = { deepseek: { 'deepseek-v4-flash': { input: 0.44, output: 1.32 } } };
    writeFileSync(modelsDevPath(home), JSON.stringify({ fetchedAt: 'x', providers,
      responsesOnly: { 'opencode-go': { api: 'https://opencode.ai/inference/go/v1', ids: ['gpt-6-luna', 7] }, old: ['gpt-6-luna'] } }));
    expect(loadModelsDev(home)!.responsesOnly).toEqual({ 'opencode-go': { api: 'https://opencode.ai/inference/go/v1', ids: ['gpt-6-luna'] } });
    writeFileSync(modelsDevPath(home), JSON.stringify({ fetchedAt: 'x', providers, responsesOnly: 'nope' }));
    const loaded = loadModelsDev(home)!;
    expect(loaded.responsesOnly).toBeUndefined();
    expect(loaded.providers).toEqual(providers);
  });
});
