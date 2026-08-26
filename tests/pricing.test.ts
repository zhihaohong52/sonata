import { describe, expect, it } from 'vitest';

import type { AiPricingCache } from '../src/aipricing.js';
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
      { input: 0.44, cachedInput: 0.014, output: 1.32 },
    );
    expect(cost).toBeCloseTo(0.44 + 1.32 + 0.014, 10);
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
  const cache: AiPricingCache = {
    fetchedAt: '2026-08-26T15:31:30.637Z',
    models: { 'deepseek-v4-flash': { deepseek: { input: 3, output: 9 } } },
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

  it('falls back to ai-pricing when the gateway declares a provider', () => {
    expect(resolvePrice(noGatewayPrice, 'scraped', tokens, now, cache)).toEqual({
      source: 'ai-pricing',
      totalUsd: 3,
      observedAt: '2026-08-26T15:31:30.637Z',
    });
  });

  it('reports none when the gateway declares no pricing_provider', () => {
    expect(resolvePrice(config, 'bare', tokens, now, cache)).toEqual({ source: 'none' });
  });

  it('reports none for an unknown key', () => {
    expect(resolvePrice(config, 'nope', tokens, now, cache)).toEqual({ source: 'none' });
    expect(resolvePrice(config, undefined, tokens, now, cache)).toEqual({ source: 'none' });
  });

  it('records observedAt for a scraped price', () => {
    expect(resolvePrice(noGatewayPrice, 'scraped', tokens, now, cache)).toEqual({
      source: 'ai-pricing',
      totalUsd: 3,
      observedAt: '2026-08-26T15:31:30.637Z',
    });
  });
});
