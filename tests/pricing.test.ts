import { describe, expect, it } from 'vitest';

import type { ModelsDevCache } from '../src/modelsdev.js';
import { parseConfig } from '../src/config.js';
import { costOf, inWindow, ratesFor, resolvePrice } from '../src/pricing.js';

const at = (iso: string) => new Date(iso);
const WRAP = { from: '16:30', to: '00:30', input: 0.11, output: 0.33 };

describe('inWindow', () => {
  it('matches inside a same-day window', () => {
    expect(inWindow({ from: '09:00', to: '17:00' }, at('2026-08-27T12:00:00Z'))).toBe(true);
  });

  it('excludes outside a same-day window', () => {
    expect(inWindow({ from: '09:00', to: '17:00' }, at('2026-08-27T08:59:00Z'))).toBe(false);
  });

  it('matches the evening half of a window crossing midnight', () => {
    expect(inWindow(WRAP, at('2026-08-27T18:00:00Z'))).toBe(true);
  });

  it('matches the morning half of a window crossing midnight', () => {
    expect(inWindow(WRAP, at('2026-08-27T00:10:00Z'))).toBe(true);
  });

  it('excludes the gap in a window crossing midnight', () => {
    expect(inWindow(WRAP, at('2026-08-27T08:00:00Z'))).toBe(false);
  });

  it('includes the from boundary and excludes the to boundary', () => {
    expect(inWindow(WRAP, at('2026-08-27T16:30:00Z'))).toBe(true);
    expect(inWindow(WRAP, at('2026-08-27T00:30:00Z'))).toBe(false);
  });

  it('reads UTC, not local time', () => {
    expect(inWindow({ from: '22:00', to: '23:59' }, at('2026-08-27T23:00:00Z'))).toBe(true);
  });
});

describe('ratesFor', () => {
  const price = { input: 0.44, output: 1.32, windows: [WRAP] };

  it('uses the window rate inside the window', () => {
    expect(ratesFor(price, at('2026-08-27T18:00:00Z'))).toMatchObject({ input: 0.11, output: 0.33 });
  });

  it('falls back to the flat rate outside every window', () => {
    expect(ratesFor(price, at('2026-08-27T08:00:00Z'))).toMatchObject({ input: 0.44, output: 1.32 });
  });

  it('resolves overlapping windows by declaration order', () => {
    const two = {
      windows: [
        { from: '00:00', to: '23:59', input: 1 },
        { from: '10:00', to: '11:00', input: 2 },
      ],
    };
    expect(ratesFor(two, at('2026-08-27T10:30:00Z'))!.input).toBe(1);
  });

  it('returns undefined when there is no price at all', () => {
    expect(ratesFor(undefined, at('2026-08-27T10:00:00Z'))).toBeUndefined();
  });
});

describe('costOf', () => {
  it('prices input, cached input and output per million tokens', () => {
    const cost = costOf(
      { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheCreation: 0 },
      { input: 0.44, cachedInput: 0.014, cacheWrite: 0.66, output: 1.32 },
    );
    expect(cost).toBeCloseTo(0.44 + 1.32 + 0.014, 10);
  });

  it('prices cache creation at cache_write rather than input', () => {
    expect(costOf(
      { input: 0, output: 0, cacheRead: 0, cacheCreation: 1_000_000 },
      { input: 0.44, cacheWrite: 0.66 },
    )).toBeCloseTo(0.66, 10);
  });

  it('falls back to input for cache creation when cache_write is absent', () => {
    expect(costOf(
      { input: 0, output: 0, cacheRead: 0, cacheCreation: 1_000_000 },
      { input: 0.44 },
    )).toBeCloseTo(0.44, 10);
  });

  it('treats a missing rate as zero for that dimension only', () => {
    expect(costOf(
      { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheCreation: 0 },
      { input: 1 },
    )).toBeCloseTo(1, 10);
  });

  it('prices a zero rate as zero, not as unknown', () => {
    expect(costOf({ input: 5_000_000, output: 0, cacheRead: 0, cacheCreation: 0 }, { input: 0 })).toBe(0);
  });
});

describe('resolvePrice', () => {
  const TOML = `
[models."flash"]
gateway = "acme"
id = "deepseek-v4-flash"

[models."flash".price]
input = 1

[models."plain"]
gateway = "acme"
id = "deepseek-v4-pro"

[models."scraped"]
gateway = "acme"
id = "deepseek-v4-flash"

[models."windowed"]
gateway = "acme"
id = "deepseek-v4-windowed"

[models."windowed".price]
input = 4
windows = [{ from = "16:30", to = "00:30" }]

[native.gateways."acme"]
base_url = "https://example.invalid/v1"
pricing_provider = "deepseek"

[native.gateways."acme".price]
input = 2

[models."bare"]
gateway = "nogw"
id = "deepseek-v4-flash"

[native.gateways."nogw"]
base_url = "https://example.invalid/v1"
`;
  const config = parseConfig(TOML);
  const tokens = { input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0 };
  const cache: ModelsDevCache = {
    fetchedAt: '2026-08-26T15:31:30.637Z',
    providers: { deepseek: { 'deepseek-v4-flash': { input: 3, output: 9 } } },
  };
  const now = at('2026-08-27T12:00:00Z');
  const noGatewayPrice = parseConfig(TOML.replace('[native.gateways."acme".price]\ninput = 2\n', ''));

  it('prefers the model price', () => {
    expect(resolvePrice(config, 'flash', tokens, now, cache)).toEqual({ source: 'model', totalUsd: 1 });
  });

  it('falls back to the gateway price', () => {
    expect(resolvePrice(config, 'plain', tokens, now, cache)).toEqual({ source: 'gateway', totalUsd: 2 });
  });

  it('falls through an empty matching window to the flat rate', () => {
    expect(resolvePrice(config, 'windowed', tokens, at('2026-08-27T18:00:00Z'), cache)).toEqual({
      source: 'model',
      totalUsd: 4,
    });
  });

  it('falls back to models.dev when the gateway declares a provider', () => {
    expect(resolvePrice(noGatewayPrice, 'scraped', tokens, now, cache)).toEqual({
      source: 'models-dev',
      totalUsd: 3,
      observedAt: '2026-08-26T15:31:30.637Z',
    });
  });

  it('uses the first configured provider that lists the model', () => {
    const providerConfig = parseConfig(TOML.replace(
      'pricing_provider = "deepseek"',
      'pricing_provider = ["missing", "fireworks", "deepseek"]',
    ).replace('[native.gateways."acme".price]\ninput = 2\n', ''));
    const providerCache: ModelsDevCache = {
      fetchedAt: '2026-08-26T15:31:30.637Z',
      providers: {
        fireworks: { 'deepseek-v4-flash': { input: 7 } },
        deepseek: { 'deepseek-v4-flash': { input: 3 } },
      },
    };
    expect(resolvePrice(providerConfig, 'scraped', tokens, now, providerCache)).toEqual({
      source: 'models-dev', totalUsd: 7, observedAt: '2026-08-26T15:31:30.637Z',
    });
    expect(providerConfig.native!.gateways.acme.pricingProvider).toEqual(['missing', 'fireworks', 'deepseek']);
  });

  it('reports none when the gateway declares no pricing_provider', () => {
    expect(resolvePrice(config, 'bare', tokens, now, cache)).toEqual({ source: 'none' });
  });

  it('reports none for an unknown key', () => {
    expect(resolvePrice(config, 'nope', tokens, now, cache)).toEqual({ source: 'none' });
    expect(resolvePrice(config, undefined, tokens, now, cache)).toEqual({ source: 'none' });
  });

  it('records observedAt for a models.dev price', () => {
    expect(resolvePrice(noGatewayPrice, 'scraped', tokens, now, cache)).toEqual({
      source: 'models-dev',
      totalUsd: 3,
      observedAt: '2026-08-26T15:31:30.637Z',
    });
  });

  it('relabels models.dev prices as covered for OAuth subscriptions', () => {
    const oauth = parseConfig(TOML.replace(
      'base_url = "https://example.invalid/v1"',
      'auth = "codex-oauth"',
    ).replace('[native.gateways."acme".price]\ninput = 2\n', ''));
    expect(resolvePrice(oauth, 'scraped', tokens, now, cache)).toEqual({
      source: 'covered', totalUsd: 3, observedAt: '2026-08-26T15:31:30.637Z',
    });
    expect(resolvePrice(noGatewayPrice, 'scraped', tokens, now, cache)).toEqual({
      source: 'models-dev', totalUsd: 3, observedAt: '2026-08-26T15:31:30.637Z',
    });
  });

  it('keeps unknown subscription rates unpriced', () => {
    const oauth = parseConfig(TOML.replace(
      'base_url = "https://example.invalid/v1"',
      'auth = "codex-oauth"',
    ).replace('[native.gateways."acme".price]\ninput = 2\n', ''));
    expect(resolvePrice(oauth, 'scraped', tokens, now)).toEqual({ source: 'none' });
  });

  it('relabels hand-written prices as covered for OAuth subscriptions', () => {
    const oauth = parseConfig(TOML.replace(
      'base_url = "https://example.invalid/v1"',
      'auth = "codex-oauth"',
    ));
    expect(resolvePrice(oauth, 'plain', tokens, now, cache)).toEqual({ source: 'covered', totalUsd: 2 });
  });

  it('treats a non-finite computed price as unpriced, not a fabricated zero', () => {
    // A malformed models.dev cache (e.g. a non-numeric scraped rate that JSON
    // loaded as Infinity) used to multiply out to Infinity silently, then
    // round-trip as a confident zero. It must instead decline to price.
    const badCache: ModelsDevCache = {
      fetchedAt: '2026-08-26T15:31:30.637Z',
      providers: { deepseek: { 'deepseek-v4-flash': { input: Infinity, output: 9 } } },
    };
    expect(resolvePrice(noGatewayPrice, 'scraped', tokens, now, badCache)).toEqual({ source: 'none' });
  });
});

// A scraped table is not a statement of intent the way a hand-written [price]
// block is, so a partial one declines rather than filling gaps with zero. A
// row priced $0 is worse than an unpriced one: it counts as priced, vanishes
// from the unpriced tally, and `[budget] daily_usd` treats the volume as free.
describe('a partial models.dev rate table declines rather than pricing at zero', () => {
  const at = new Date('2026-09-10T00:00:00Z');
  const config = parseConfig(`
[models."m"]
gateway = "gw"
id = "m"

[native.gateways."gw"]
base_url = "https://gw.example/v1"
pricing_provider = "acme"
`);
  const cache = (rates: Record<string, number>) => ({
    fetchedAt: '2026-09-10T00:00:00Z',
    providers: { acme: { m: rates } },
  });

  it('declines when input tokens were used but no input rate exists', () => {
    const price = resolvePrice(
      config, 'm',
      { input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0 },
      at, cache({ output: 2 }),
    );
    // The bug this pins: previously { source: 'models-dev', totalUsd: 0 }.
    expect(price).toEqual({ source: 'none' });
  });

  it('declines when output tokens were used but no output rate exists', () => {
    const price = resolvePrice(
      config, 'm',
      { input: 0, output: 1_000_000, cacheRead: 0, cacheCreation: 0 },
      at, cache({ input: 2 }),
    );
    expect(price).toEqual({ source: 'none' });
  });

  it('still prices when the unrated dimensions carry no tokens', () => {
    const price = resolvePrice(
      config, 'm',
      { input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0 },
      at, cache({ input: 2 }),
    );
    expect(price).toMatchObject({ source: 'models-dev', totalUsd: 2 });
  });

  // cacheCreation bills at cacheWrite ?? input, so input alone covers it.
  it('accepts cache-creation tokens covered by the input rate alone', () => {
    const price = resolvePrice(
      config, 'm',
      { input: 0, output: 0, cacheRead: 0, cacheCreation: 1_000_000 },
      at, cache({ input: 2 }),
    );
    expect(price).toMatchObject({ source: 'models-dev', totalUsd: 2 });
  });
});

// models.dev keys each provider the way that provider does: `openai` files a
// bare `gpt-5.6-terra`, `openrouter` files `nvidia/nemotron-3.5-lightning:free`.
// normalizeModelName strips exactly the vendor prefix and `:free` suffix that
// key depends on, so a normalized-only lookup priced every OpenRouter row as
// unpriced — ~2,870 real ledger rows on this machine.
describe('models.dev lookup tries the raw upstream id before the normalized name', () => {
  const at = new Date('2026-09-10T00:00:00Z');
  const config = parseConfig(`
[models."or"]
gateway = "gw"
id = "nvidia/nemotron-3.5-lightning:free"

[native.gateways."gw"]
base_url = "https://gw.example/v1"
pricing_provider = "openrouter"
`);

  it('matches a slug carrying a vendor prefix and a serving-variant suffix', () => {
    const price = resolvePrice(
      config, 'or',
      { input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0 },
      at,
      {
        fetchedAt: '2026-09-10T00:00:00Z',
        providers: { openrouter: { 'nvidia/nemotron-3.5-lightning:free': { input: 3, output: 9 } } },
      },
    );
    expect(price).toMatchObject({ source: 'models-dev', totalUsd: 3 });
  });

  it('still matches a provider that files the model under its bare name', () => {
    const bare = parseConfig(`
[models."m"]
gateway = "gw"
id = "gpt-5.6-terra"

[native.gateways."gw"]
base_url = "https://gw.example/v1"
pricing_provider = "openai"
`);
    const price = resolvePrice(
      bare, 'm',
      { input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0 },
      at,
      { fetchedAt: '2026-09-10T00:00:00Z', providers: { openai: { 'gpt-5.6-terra': { input: 2, output: 12 } } } },
    );
    expect(price).toMatchObject({ source: 'models-dev', totalUsd: 2 });
  });

  // Provider order is the user's stated preference and must outrank an exact
  // id match found under a later provider.
  it('prefers an earlier provider over an exact match in a later one', () => {
    const ordered = parseConfig(`
[models."m"]
gateway = "gw"
id = "shared/model:free"

[native.gateways."gw"]
base_url = "https://gw.example/v1"
pricing_provider = ["first", "second"]
`);
    const price = resolvePrice(
      ordered, 'm',
      { input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0 },
      at,
      {
        fetchedAt: '2026-09-10T00:00:00Z',
        providers: {
          // normalizeModelName('shared/model:free') is 'model' — it keeps the
          // last path segment and drops the serving-variant suffix.
          first: { model: { input: 1, output: 1 } },
          second: { 'shared/model:free': { input: 99, output: 99 } },
        },
      },
    );
    expect(price).toMatchObject({ source: 'models-dev', totalUsd: 1 });
  });
});
