import { describe, it, expect } from 'vitest';
import { nativeTomlFor, tomlKey } from '../../src/init/toml.js';
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
    expect(config.native!.gateways.codex).toEqual({
      baseUrl: CODEX_OAUTH_BASE_URL, auth: 'codex-oauth',
    });
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
    expect(config.native!.gateways['github-copilot']).toEqual({
      baseUrl: COPILOT_OAUTH_BASE_URL, auth: 'copilot-oauth',
    });
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

  it('writes nothing extra when there is nothing to preserve', () => {
    const toml = write();
    expect(toml).not.toContain('pricing_provider');
    expect(toml).not.toContain('.price');
    expect(parseConfig(toml).native!.gateways.acme.pricingProvider).toBeUndefined();
  });
});
