import { describe, it, expect } from 'vitest';
import { nativeTomlFor, replaceTiersBlock, tomlKey } from '../../src/init/toml.js';
import { parseConfig, CODEX_OAUTH_BASE_URL, COPILOT_OAUTH_BASE_URL } from '../../src/config.js';
import type { NativeCandidate } from '../../src/commands/init.js';

describe('tomlKey', () => {
  it('quotes a simple key', () => {
    expect(tomlKey('simple')).toBe('"simple"');
  });

  it('escapes quotes and backslashes', () => {
    expect(tomlKey('a"b')).toBe('"a\\"b"');
    expect(tomlKey('a\\b')).toBe('"a\\\\b"');
  });

  it('escapes control characters', () => {
    expect(tomlKey('\n')).toBe('"\\n"');
    expect(tomlKey('\t')).toBe('"\\t"');
    expect(tomlKey('\b')).toBe('"\\b"');
    expect(tomlKey('\f')).toBe('"\\f"');
    expect(tomlKey('\r')).toBe('"\\r"');
  });

  it('escapes DEL (0x7f) as unicode', () => {
    expect(tomlKey('\x7f')).toBe('"\\u007f"');
  });

  it('escapes NUL (0x00) as unicode', () => {
    expect(tomlKey('\x00')).toBe('"\\u0000"');
  });
});

describe('nativeTomlFor', () => {
  const cand = (gw: string, id: string): NativeCandidate => ({
    key: `${gw}-${id}`, gateway: gw, id, contextWindow: 128000, baseUrl: `https://${gw}.example/v1`,
  });

  it('writes a normal tier and reads it back', () => {
    // The round trip is the test that matters: init rewrites the whole file,
    // so a key it reads but does not write back is deleted on the next run.
    const c = cand('acme', 'sprinter');
    const toml = nativeTomlFor(
      { code: [c] },
      {},
      { code: { simple: ['acme-sprinter'], normal: ['acme-sprinter', 'acme-sprinter@high'], complex: ['acme-sprinter@high'] } },
    );
    expect(parseConfig(toml).tiers?.code).toEqual({
      simple: ['acme-sprinter'],
      normal: ['acme-sprinter', 'acme-sprinter@high'],
      complex: ['acme-sprinter@high'],
    });
  });

  it('omits normal entirely when a role has none', () => {
    const c = cand('acme', 'sprinter');
    const toml = nativeTomlFor(
      { code: [c] },
      {},
      { code: { simple: ['acme-sprinter'], complex: ['acme-sprinter@high'] } },
    );
    expect(toml).not.toContain('normal =');
    expect(parseConfig(toml).tiers?.code.normal).toBeUndefined();
  });

  it('writes an effort-pinned tier candidate back verbatim', () => {
    const c = cand('acme', 'sprinter');
    const out = nativeTomlFor({ code: [c] }, {}, { code: { simple: ['acme-sprinter@high'], complex: ['acme-sprinter@max', 'acme-sprinter@high'] } });
    const cfg = parseConfig(out);
    expect(cfg.tiers?.code.simple).toEqual(['acme-sprinter@high']);
    expect(cfg.tiers?.code.complex).toEqual(['acme-sprinter@max', 'acme-sprinter@high']);
  });

  it('writes native gateways, unified models, and tiers', () => {
    const out = nativeTomlFor({ code: [cand('opencode', 'deepseek-v4-flash')] });
    expect(out).toContain('[native.gateways."opencode"]');
    expect(out).toContain('[models."opencode-deepseek-v4-flash"]');
    expect(out).toContain('[tiers."code"]');
    expect(out).not.toContain('[native.models.');
    expect(out).not.toContain('[generate.native]');
    expect(out).not.toContain('[generate.roles]');

    const cfg = parseConfig(out);
    expect(cfg.unifiedModels['opencode-deepseek-v4-flash']).toEqual({
      gateway: 'opencode', id: 'deepseek-v4-flash', contextWindow: 128000,
    });
    expect(cfg.tiers?.code.simple).toEqual(['opencode-deepseek-v4-flash']);
    expect(cfg.tiers?.code.complex).toEqual(['opencode-deepseek-v4-flash']);
  });

  it('defines a model once even when several roles use it', () => {
    const c = cand('opencode', 'kimi-k3');
    const out = nativeTomlFor({ code: [c], plan: [c] });
    expect(out.match(/\[models\./g)).toHaveLength(1);
    expect(parseConfig(out).tiers?.plan.simple).toEqual(['opencode-kimi-k3']);
  });

  it('writes each role with its own tier lists', () => {
    const out = nativeTomlFor({
      code: [cand('opencode', 'kimi-k3')],
      review: [cand('opencode', 'kimi-k3'), cand('opencode', 'grok-4.5')],
    });
    const cfg = parseConfig(out);
    expect(cfg.tiers?.code.simple).toEqual(['opencode-kimi-k3']);
    expect([...(cfg.tiers?.review.complex ?? [])].sort()).toEqual(['opencode-grok-4.5', 'opencode-kimi-k3']);
  });

  it('emits hardcoded [run] defaults when no existing run settings are given', () => {
    const out = nativeTomlFor({ code: [cand('opencode', 'kimi-k3')] });
    expect(out).toContain('tail_window_seconds = 20');
    expect(out).toContain('stall_timeout_seconds = 120');
    expect(out).toContain('run_timeout_seconds = 1800');
    expect(out).toContain('dispatch_window_seconds = 1500');
  });

  it('preserves existing [run] settings when given', () => {
    const out = nativeTomlFor(
      { code: [cand('opencode', 'kimi-k3')] },
      {},
      undefined,
      {},
      [],
      {
        tailWindowSeconds: 33,
        stallTimeoutSeconds: 222,
        runTimeoutSeconds: 4444,
        dispatchWindowSeconds: 3000,
      },
    );
    expect(out).toContain('tail_window_seconds = 33');
    expect(out).toContain('stall_timeout_seconds = 222');
    expect(out).toContain('run_timeout_seconds = 4444');
    expect(out).toContain('dispatch_window_seconds = 3000');
  });
});

describe('nativeTomlFor — provider', () => {
  it('emits provider for an anthropic-wire-format candidate', () => {
    const toml = nativeTomlFor({
      code: [{
        key: 'custom-claude-clone', gateway: 'custom', id: 'claude-clone',
        contextWindow: 128000, baseUrl: 'https://example.com/v1', auth: 'api-key',
        wireFormat: 'anthropic',
      }],
    });
    // `provider` supersedes `wire_format`; a wizard still writing the old key
    // would make every freshly created config a legacy one.
    expect(toml).toMatch(/\[native\.gateways\."custom"\][\s\S]*provider = "anthropic"/);
    expect(toml).not.toContain('wire_format');
  });

  it('omits the key entirely for an openai (default) candidate', () => {
    const toml = nativeTomlFor({
      code: [{
        key: 'custom-gpt', gateway: 'custom', id: 'gpt',
        contextWindow: 128000, baseUrl: 'https://example.com/v1', auth: 'api-key',
      }],
    });
    expect(toml).not.toContain('wire_format');
    expect(toml).not.toContain('provider =');
  });
});

describe('nativeTomlFor — codex-oauth gateways', () => {
  const codexCandidate: NativeCandidate = {
    key: 'luna', gateway: 'codex', id: 'gpt-5.6-luna',
    contextWindow: 128000, baseUrl: CODEX_OAUTH_BASE_URL, auth: 'codex-oauth',
  };
  const keyCandidate: NativeCandidate = {
    key: 'ds', gateway: 'acme', id: 'deepseek-v4-flash-0731',
    contextWindow: 128000, baseUrl: 'https://gateway.acme.example/v1', auth: 'api-key',
  };

  it('writes auth instead of base_url for a subscription gateway', () => {
    const toml = nativeTomlFor({ code: [codexCandidate] });
    expect(toml).toContain('[native.gateways."codex"]');
    expect(toml).toContain('auth = "codex-oauth"');
    // A metered URL here is the exact config that authenticates then 429s.
    expect(toml).not.toContain('api.openai.com');
    expect(toml).not.toContain('base_url');
  });

  it('still writes base_url for an api-key gateway alongside it', () => {
    const toml = nativeTomlFor({ code: [codexCandidate, keyCandidate] });
    expect(toml).toContain('auth = "codex-oauth"');
    expect(toml).toContain('base_url = "https://gateway.acme.example/v1"');
  });

  it('round-trips through parseConfig', () => {
    const config = parseConfig(nativeTomlFor({ code: [codexCandidate, keyCandidate] }));
    expect(config.native!.gateways.codex).toMatchObject({
      baseUrl: CODEX_OAUTH_BASE_URL, auth: 'codex-oauth',
    });
    // A new OAuth gateway is born with a pricing provider derived from its
    // auth — without one it can never reach `relabelCovered` and subscription
    // work reads as unpriced rather than covered.
    expect(config.native!.gateways.codex.pricingProvider).toEqual(['openai']);
    expect(config.native!.gateways.acme.auth).toBe('api-key');
  });
});

describe('nativeTomlFor — copilot-oauth', () => {
  it('writes auth and no base_url, and round-trips', () => {
    const candidate: NativeCandidate = {
      key: 'copilot-gpt4o', gateway: 'github-copilot', id: 'gpt-4o',
      contextWindow: 128000, baseUrl: COPILOT_OAUTH_BASE_URL, auth: 'copilot-oauth',
    };
    const toml = nativeTomlFor({ code: [candidate] });
    expect(toml).toContain('auth = "copilot-oauth"');
    expect(toml).not.toContain('base_url');

    const config = parseConfig(toml);
    expect(config.native!.gateways['github-copilot']).toMatchObject({
      baseUrl: COPILOT_OAUTH_BASE_URL, auth: 'copilot-oauth',
    });
    expect(config.native!.gateways['github-copilot'].pricingProvider).toEqual(['github-copilot']);
  });
});

describe('nativeTomlFor — avoid_gateways', () => {
  const candidate = {
    key: 'acme-m', gateway: 'acme', id: 'm', contextWindow: 128000,
    baseUrl: 'https://acme.example/v1', auth: 'api-key' as const,
  };

  it('round-trips through parseConfig', () => {
    // The bug this catches: a bare key emitted after a [models."…"] header
    // belongs to that table, so the setting was written, silently ignored, and
    // `sonata init` re-proposed the ordering it existed to prevent. Asserting
    // on the text alone would have passed.
    const toml = nativeTomlFor(
      { code: [candidate] }, {}, undefined, {}, [candidate], undefined, ['acme'],
    );
    expect(parseConfig(toml).avoidGateways).toEqual(['acme']);
  });

  it('emits the key before any table header', () => {
    const toml = nativeTomlFor(
      { code: [candidate] }, {}, undefined, {}, [candidate], undefined, ['acme'],
    );
    const keyAt = toml.indexOf('avoid_gateways');
    const firstTableAt = toml.indexOf('[');
    expect(keyAt).toBeGreaterThanOrEqual(0);
    expect(keyAt).toBeLessThan(firstTableAt);
  });

  it('omits the key entirely when nothing is avoided', () => {
    const toml = nativeTomlFor({ code: [candidate] }, {}, undefined, {}, [candidate]);
    expect(toml).not.toContain('avoid_gateways');
    expect(parseConfig(toml).avoidGateways).toBeUndefined();
  });
});
// Issue #31: a config written by init had no `pricing_provider` on any
// gateway, so `resolvePrice` returned `source: 'none'` at its
// `provider === undefined` guard before models.dev was consulted at all —
// 173 requests, $0.0000 priced, everything unpriced on a real machine config.
describe('nativeTomlFor — originating pricing_provider', () => {
  const gw = (gateway: string) => ({
    key: `${gateway}-m`, gateway, id: 'm', contextWindow: 128000,
    baseUrl: 'https://example.test/v1', auth: 'api-key' as const,
  });

  it('proposes a models.dev provider for a gateway it is writing for the first time', () => {
    const config = parseConfig(nativeTomlFor({ code: [gw('deepseek')] }));
    expect(config.native!.gateways.deepseek.pricingProvider).toEqual(['deepseek']);
  });

  it('uses the models.dev id, not the LiteLLM one, for Gemini', () => {
    // LiteLLM calls this provider `gemini`; models.dev files it as `google`.
    // Reusing PROVIDER_FOR_GATEWAY here would look right and silently miss.
    const config = parseConfig(nativeTomlFor({ code: [gw('google')] }));
    expect(config.native!.gateways.google.pricingProvider).toEqual(['google']);
  });

  it('leaves a gateway it cannot identify unpriced rather than guessing', () => {
    const toml = nativeTomlFor({ code: [gw('my-private-proxy')] });
    expect(toml).not.toContain('pricing_provider');
    expect(parseConfig(toml).native!.gateways['my-private-proxy'].pricingProvider).toBeUndefined();
  });

  // The property that makes origination *declinable*, and the reason it is
  // keyed on the gateway being new rather than on the key being absent.
  it('never re-adds a pricing_provider the user deleted from an existing gateway', () => {
    const existing = parseConfig(nativeTomlFor({ code: [gw('deepseek')] }));
    expect(existing.native!.gateways.deepseek.pricingProvider).toEqual(['deepseek']);

    // The user deletes the line; the gateway itself stays.
    const edited = parseConfig([
      'schema_version = 1',
      '[native.gateways."deepseek"]',
      'base_url = "https://example.test/v1"',
      '[models."deepseek-m"]',
      'gateway = "deepseek"',
      'id = "m"',
      'context_window = 128000',
    ].join('\n'));
    expect(edited.native!.gateways.deepseek.pricingProvider).toBeUndefined();

    const rewritten = nativeTomlFor({ code: [gw('deepseek')] }, {}, undefined, {}, [], undefined, [], edited);
    expect(rewritten).not.toContain('pricing_provider');
  });

  it('preserves a pricing_provider the user changed, rather than re-proposing its own', () => {
    const edited = parseConfig([
      'schema_version = 1',
      '[native.gateways."deepseek"]',
      'base_url = "https://example.test/v1"',
      'pricing_provider = ["openrouter"]',
      '[models."deepseek-m"]',
      'gateway = "deepseek"',
      'id = "m"',
      'context_window = 128000',
    ].join('\n'));
    const rewritten = parseConfig(nativeTomlFor({ code: [gw('deepseek')] }, {}, undefined, {}, [], undefined, [], edited));
    expect(rewritten.native!.gateways.deepseek.pricingProvider).toEqual(['openrouter']);
  });
});

describe('nativeTomlFor — settings init must not silently drop', () => {
  const candidate = {
    key: 'acme-m', gateway: 'acme', id: 'm', contextWindow: 128000,
    baseUrl: 'https://acme.example/v1', auth: 'api-key' as const,
  };
  const write = (existing?: Parameters<typeof nativeTomlFor>[7]) => nativeTomlFor(
    { code: [candidate] }, {}, undefined, {}, [candidate], undefined, [], existing,
  );

  // The defect this exists to prevent, measured on a real config: a gateway's
  // `pricing_provider` was read by parseConfig, used by resolvePrice, and
  // written back by nobody — so `sonata init` deleted it on every rewrite and
  // every model on that gateway silently became unpriced. Unpriced volume is
  // excluded from `[budget] daily_usd`, so the cap quietly stopped counting
  // that spend too. Exactly the bug `avoid_gateways` is written back to avoid.
  it('round-trips a gateway pricing_provider', () => {
    const toml = write({
      native: { gateways: { acme: { baseUrl: 'https://acme.example/v1', auth: 'api-key', pricingProvider: ['openai', 'deepseek'] } } },
    } as never);
    expect(parseConfig(toml).native!.gateways.acme.pricingProvider).toEqual(['openai', 'deepseek']);
  });

  it('round-trips a gateway price block', () => {
    const toml = write({
      native: { gateways: { acme: { baseUrl: 'https://acme.example/v1', auth: 'api-key', price: { input: 1.5, output: 6, cacheWrite: 2, cachedInput: 0.1 } } } },
    } as never);
    expect(parseConfig(toml).native!.gateways.acme.price).toMatchObject({ input: 1.5, output: 6, cacheWrite: 2, cachedInput: 0.1 });
  });

  // A window is the whole point of a hand-written price for a peak/off-peak
  // gateway; preserving the rates but dropping the windows would charge peak
  // rates around the clock.
  it('round-trips price windows in declaration order', () => {
    const toml = write({
      native: { gateways: { acme: { baseUrl: 'https://acme.example/v1', auth: 'api-key', price: {
        input: 1, output: 2,
        windows: [{ from: '00:30', to: '08:30', input: 0.5, output: 1 }, { from: '08:30', to: '00:30', input: 1, output: 2 }],
      } } } },
    } as never);
    const back = parseConfig(toml).native!.gateways.acme.price!;
    expect(back.windows).toHaveLength(2);
    expect(back.windows![0]).toMatchObject({ from: '00:30', to: '08:30', input: 0.5 });
    expect(back.windows![1]).toMatchObject({ from: '08:30', to: '00:30', input: 1 });
  });

  it('round-trips a per-model price block', () => {
    const toml = write({ unifiedModels: { 'acme-m': { price: { input: 3, output: 15 } } } } as never);
    expect(parseConfig(toml).unifiedModels['acme-m'].price).toMatchObject({ input: 3, output: 15 });
  });

  // A harness-only model is written by a *different* loop from the native one,
  // and the first fix for this bug patched only the native loop — so the same
  // deletion survived one block further down. A harness-routed model is a
  // `sonata dispatch` fallback candidate whose rates are just as hand-written.
  it('round-trips a harness-only model price, partial rates and windows included', () => {
    const toml = nativeTomlFor(
      { code: [candidate] }, {}, undefined,
      { 'kimi-k3': { harness: 'opencode', harnessId: 'openrouter/kimi-k3' } },
      [candidate], undefined, [],
      { unifiedModels: { 'kimi-k3': { price: {
        // Output only: a partial table must stay partial rather than gaining
        // an invented input rate of 0, which would read as "free".
        output: 9,
        windows: [{ from: '00:30', to: '08:30', output: 4.5 }],
      } } } } as never,
    );
    const back = parseConfig(toml).unifiedModels['kimi-k3'];
    expect(back.harness).toBe('opencode');
    expect(back.price).toMatchObject({ output: 9 });
    expect(back.price!.input).toBeUndefined();
    expect(back.price!.windows).toHaveLength(1);
    expect(back.price!.windows![0]).toMatchObject({ from: '00:30', to: '08:30', output: 4.5 });
  });

  it('writes nothing extra when there is nothing to preserve', () => {
    const toml = write();
    expect(toml).not.toContain('pricing_provider');
    expect(toml).not.toContain('.price');
    expect(parseConfig(toml).native!.gateways.acme.pricingProvider).toBeUndefined();
  });
});


describe('replaceTiersBlock — normal tier', () => {
  const existingToml = [
    'schema_version = 1',
    '',
    '[native.gateways."acme"]',
    'base_url = "https://acme.example/v1"',
    '',
    '[models."acme-a"]',
    'gateway = "acme"',
    'id = "a"',
    'context_window = 128000',
    '',
    '[models."acme-b"]',
    'gateway = "acme"',
    'id = "b"',
    'context_window = 128000',
    '',
    '[tiers.code]',
    'simple = ["acme-a"]',
    'complex = ["acme-b"]',
    '',
  ].join('\n');

  it('round-trips a normal tier', () => {
    const rewritten = replaceTiersBlock(existingToml, {
      code: { simple: ['acme-a'], normal: ['acme-a', 'acme-b'], complex: ['acme-b'] },
    });
    expect(parseConfig(rewritten).tiers?.code.normal).toEqual(['acme-a', 'acme-b']);
  });
});
