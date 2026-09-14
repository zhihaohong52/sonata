import { describe, it, expect } from 'vitest';
import { parseConfig } from '../src/config.js';
import { configUpstreamFor, catalogSpellingsForGateway } from '../src/pricing.js';
import type { ModelsDevCache } from '../src/modelsdev.js';

const modelsDev: ModelsDevCache = {
  fetchedAt: '2026-09-10T12:00:00.000Z',
  providers: { deepseek: { 'deepseek-flash': { input: 0.15, output: 0.6 } } },
  names: {
    deepseek: { 'deepseek-flash': 'DeepSeek V4.1 Flash' },
    openrouter: { 'deepseek/deepseek-v4.1-flash': 'DeepSeek V4.1 Flash' },
  },
};

describe('catalogSpellingsForGateway', () => {
  it('reads the gateway\'s own pricing_provider list', () => {
    expect(catalogSpellingsForGateway(modelsDev, { name: 'acme', pricingProvider: ['deepseek'] }, 'deepseek-flash'))
      .toEqual(['deepseek-flash', 'deepseek-v4.1-flash']);
  });

  it('proposes a provider from the gateway name when none is configured', () => {
    // Exactly the BYOK case: a gateway created this run has no config yet.
    expect(catalogSpellingsForGateway(modelsDev, { name: 'deepseek' }, 'deepseek-flash'))
      .toEqual(['deepseek-flash', 'deepseek-v4.1-flash']);
  });

  it('falls back to OpenRouter after the named providers, as pricing does', () => {
    expect(catalogSpellingsForGateway(modelsDev, { name: 'acme', pricingProvider: ['openai'] }, 'deepseek-v4.1-flash'))
      .toEqual(['deepseek-v4.1-flash']);
    expect(catalogSpellingsForGateway(modelsDev, { name: 'acme', pricingProvider: ['openai'] }, 'deepseek/deepseek-v4.1-flash'))
      .toEqual(['deepseek/deepseek-v4.1-flash', 'deepseek-v4.1-flash']);
  });

  it('offers only the id without a cache or a gateway', () => {
    expect(catalogSpellingsForGateway(undefined, { name: 'deepseek' }, 'deepseek-flash')).toEqual(['deepseek-flash']);
    expect(catalogSpellingsForGateway(modelsDev, undefined, 'deepseek-flash')).toEqual(['deepseek-flash']);
  });
});

describe('configUpstreamFor', () => {
  const config = parseConfig(`
schema_version = 1
[native.gateways."ds"]
base_url = "https://api.deepseek.com/v1"
pricing_provider = ["deepseek"]
[models."ds-deepseek-flash"]
gateway = "ds"
id = "deepseek-flash"
[models."luna"]
harness = "codex"
id = "gpt-5.6-luna"
[tiers.code]
simple = ["ds-deepseek-flash"]
complex = ["ds-deepseek-flash"]
`);

  it('resolves a native key to its id and the display-name spelling', () => {
    expect(configUpstreamFor(config, modelsDev)('ds-deepseek-flash')).toEqual(['deepseek-flash', 'deepseek-v4.1-flash']);
  });

  it('resolves a harness-only key to its harness id, and an unknown key to itself', () => {
    expect(configUpstreamFor(config, modelsDev)('luna')).toEqual(['gpt-5.6-luna']);
    expect(configUpstreamFor(config, modelsDev)('nope')).toEqual(['nope']);
  });
});
