import { describe, it, expect } from 'vitest';
import { providerForBaseUrl, PROVIDER_FOR_GATEWAY } from '../../src/native/providers.js';

describe('providerForBaseUrl', () => {
  it('gives a known vendor its native provider', () => {
    expect(providerForBaseUrl('google')).toBe('gemini');
    expect(providerForBaseUrl('deepseek')).toBe('deepseek');
  });

  it('falls back to openai for an endpoint nobody has classified', () => {
    // `openai` is the default for the UNKNOWN, not for known vendors: an
    // OpenAI-compatible shim is the safest guess when we know nothing, and the
    // worst guess when we do.
    expect(providerForBaseUrl('my-corp-proxy')).toBe('openai');
  });

  it('only names providers LiteLLM actually has', () => {
    const known = new Set(['openai', 'anthropic', 'gemini', 'deepseek', 'mistral', 'groq']);
    for (const p of Object.values(PROVIDER_FOR_GATEWAY)) expect(known).toContain(p);
  });
});

import { transportFor, litellmRequired } from '../../src/native/providers.js';
import type { NativeGatewayConfig, SonataConfig } from '../../src/config.js';

const gw = (o: Partial<NativeGatewayConfig>): NativeGatewayConfig =>
  ({ baseUrl: 'https://x/v1', auth: 'api-key', ...o }) as NativeGatewayConfig;

describe('transportFor', () => {
  it('routes an anthropic api-key gateway directly', () => {
    expect(transportFor(gw({ provider: 'anthropic' }), 'x')).toBe('direct');
  });

  it('routes every other api-key gateway through litellm', () => {
    expect(transportFor(gw({ provider: 'gemini' }), 'x')).toBe('litellm');
    expect(transportFor(gw({}), 'x')).toBe('litellm');
  });

  it('routes oauth gateways through litellm whatever their provider', () => {
    // Their dialect is fixed by their auth: chatgpt needs mode: responses,
    // copilot needs a token exchange. Neither is a plain Anthropic endpoint.
    for (const auth of ['codex-oauth', 'copilot-oauth'] as const) {
      expect(transportFor(gw({ auth }), 'x')).toBe('litellm');
    }
  });

  it('uses the table when the gateway declares no provider', () => {
    expect(transportFor(gw({}), 'anthropic')).toBe('direct');
  });
});

describe('litellmRequired', () => {
  const cfg = (gateways: Record<string, NativeGatewayConfig>, keys: string[]): SonataConfig => ({
    unifiedModels: Object.fromEntries(keys.map((k) => [k, { gateway: k.split(':')[0], id: 'x' }])),
    tiers: { code: { simple: keys, complex: keys } },
    native: { gateways },
  }) as unknown as SonataConfig;

  it('is false when every tier model is on an anthropic gateway', () => {
    expect(litellmRequired(cfg({ or: gw({ provider: 'anthropic' }) }, ['or:a']))).toBe(false);
  });

  it('is true when any tier model needs translation', () => {
    expect(litellmRequired(cfg(
      { or: gw({ provider: 'anthropic' }), g: gw({ provider: 'gemini' }) },
      ['or:a', 'g:b'],
    ))).toBe(true);
  });

  it('counts a model no tier lists — a bare model key is routable', () => {
    // Not a hypothetical: `tests/commands/serve.test.ts` drives a `[models]`
    // entry that appears in no tier through the router by name, and the
    // request is forwarded to litellm without `resolveTier` ever being called.
    // Scoping this to tier membership started no child for that config and
    // 502'd against an upstream that was never launched.
    const c = cfg({ or: gw({ provider: 'anthropic' }), g: gw({ provider: 'gemini' }) }, ['or:a']);
    (c as { unifiedModels: Record<string, unknown> }).unifiedModels['g:untiered'] = { gateway: 'g', id: 'x' };
    expect(litellmRequired(c)).toBe(true);
  });

  it('is false for a gateway with no models against it', () => {
    // Declaring a gateway is not routing to it, so a leftover `[native.gateways]`
    // entry still costs no Python.
    expect(litellmRequired({
      unifiedModels: {}, native: { gateways: { g: gw({ provider: 'gemini' }) } },
    } as unknown as SonataConfig)).toBe(false);
  });

  it('is false for an empty config', () => {
    expect(litellmRequired({ unifiedModels: {}, native: { gateways: {} } } as unknown as SonataConfig)).toBe(false);
  });
});

describe('litellmRequired on a pre-[tiers] config', () => {
  // A legacy config routes through `[native.models]` and has no tiers at all.
  // Gating purely on tiers would report `not-required` for it, `serve` would
  // start no child, and every request would 502 against an upstream that was
  // never launched — a silent regression for exactly the installs that have
  // not migrated yet.
  const legacy = (gateways: Record<string, NativeGatewayConfig>): SonataConfig => ({
    unifiedModels: {},
    native: { gateways, models: { flash: { gateway: 'g', id: 'x', contextWindow: 1 } } },
  }) as unknown as SonataConfig;

  it('is true when its gateway needs translation', () => {
    expect(litellmRequired(legacy({ g: gw({ provider: 'gemini' }) }))).toBe(true);
  });

  it('is false when its gateway speaks anthropic', () => {
    expect(litellmRequired(legacy({ g: gw({ provider: 'anthropic' }) }))).toBe(false);
  });
});
