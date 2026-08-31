import { describe, it, expect } from 'vitest';
import {
  addByokCandidates, addLiveCandidates, rewriteOauthToApiKey,
} from '../../src/init/candidates.js';
import type { NativeCandidate } from '../../src/commands/init.js';

const apiKey = (key: string, gateway: string, id: string, baseUrl: string): NativeCandidate =>
  ({ key, gateway, id, contextWindow: 128000, baseUrl, auth: 'api-key' });

const oauth = (key: string, gateway: string, id: string, baseUrl: string): NativeCandidate =>
  ({ key, gateway, id, contextWindow: 128000, baseUrl, auth: 'codex-oauth' });

describe('addByokCandidates', () => {
  it('falls back to WELL_KNOWN_PROVIDER_URLS when the caller did not pass a URL for the gateway', () => {
    // plan() passes env.providerBaseUrls (a live-detected subset); a
    // --providers byok/<x> row whose gateway no harness has surfaced must
    // still get a candidate, or [tiers] in the written config references a
    // model the [models] block never defined.
    const nativeByKey = new Map<string, NativeCandidate>();
    addByokCandidates(nativeByKey, new Map(), { deepseek: ['deepseek-chat'] });
    const c = nativeByKey.get('deepseek-deepseek-chat');
    expect(c).toBeDefined();
    expect(c!.baseUrl).toMatch(/^https:\/\/api\.deepseek\.com/);
    expect(c!.auth).toBe('api-key');
  });

  it('prefers the caller-supplied URL over the well-known one', () => {
    const nativeByKey = new Map<string, NativeCandidate>();
    addByokCandidates(
      nativeByKey,
      new Map([['deepseek', 'https://proxy.example/v1']]),
      { deepseek: ['deepseek-chat'] },
    );
    expect(nativeByKey.get('deepseek-deepseek-chat')!.baseUrl).toBe('https://proxy.example/v1');
  });

  it('skips a gateway that is neither caller-supplied nor well-known', () => {
    const nativeByKey = new Map<string, NativeCandidate>();
    addByokCandidates(nativeByKey, new Map(), { 'made-up-gateway': ['x'] });
    expect(nativeByKey.has('made-up-gateway-x')).toBe(false);
  });
});

describe('addLiveCandidates', () => {
  it('adds a candidate for a live-discovered model that the harness catalogue did not list', () => {
    const nativeByKey = new Map<string, NativeCandidate>();
    addLiveCandidates(
      {
        providerBaseUrls: { acme: 'https://acme.example/v1' },
        gatewayAuth: new Map([['acme', 'api-key' as const]]),
      } as never,
      nativeByKey,
      { acme: ['fresh-model'] },
    );
    const c = nativeByKey.get('acme-fresh-model');
    expect(c).toBeDefined();
    expect(c!.baseUrl).toBe('https://acme.example/v1');
    expect(c!.auth).toBe('api-key');
  });

  it('does not overwrite an existing candidate (the harness one carries routes this cannot know)', () => {
    const existing = apiKey('acme-fresh', 'acme', 'fresh', 'https://harness.example/v1');
    const nativeByKey = new Map([[existing.key, existing]]);
    addLiveCandidates(
      {
        providerBaseUrls: { acme: 'https://acme.example/v1' },
        gatewayAuth: new Map([['acme', 'api-key' as const]]),
      } as never,
      nativeByKey,
      { acme: ['fresh'] },
    );
    expect(nativeByKey.get('acme-fresh')!.baseUrl).toBe('https://harness.example/v1');
  });

  it('skips OAuth-authenticated gateways (their URL is not a bearer endpoint)', () => {
    const nativeByKey = new Map<string, NativeCandidate>();
    addLiveCandidates(
      {
        providerBaseUrls: { chatgpt: 'https://chatgpt.example/v1' },
        gatewayAuth: new Map([['chatgpt', 'codex-oauth' as const]]),
      } as never,
      nativeByKey,
      { chatgpt: ['gpt-5.6'] },
    );
    expect(nativeByKey.has('chatgpt-gpt-5.6')).toBe(false);
  });
});

describe('rewriteOauthToApiKey', () => {
  it('switches a gateway that was OAuth but now has a BYOK key to api-key with the well-known base URL', () => {
    const candidate = oauth('deepseek-chat', 'deepseek', 'chat', 'https://oauth-proxy.example/v1');
    const nativeByKey = new Map([[candidate.key, candidate]]);
    rewriteOauthToApiKey(nativeByKey, { deepseek: 'sk-test' });
    const rewritten = nativeByKey.get('deepseek-chat')!;
    expect(rewritten.auth).toBe('api-key');
    // Must be the well-known URL, not the OAuth endpoint that was on the
    // candidate — the OAuth base URL with api-key auth produces a route
    // that authenticates and then 401s.
    expect(rewritten.baseUrl).toBe('https://api.deepseek.com/v1');
  });

  it('throws with a byte-identical message when a gateway in byokKeys is not in WELL_KNOWN_PROVIDER_URLS', () => {
    // The pre-refactor wizard and --yes paths threw here, but plan() silently
    // skipped — leaving auth: 'api-key' on a candidate with the OAuth base URL,
    // so the config got a route that authenticated and 401d later. The throw
    // is the contract callers test against; the message string is part of it.
    const candidate = oauth('made-up-x', 'made-up', 'x', 'https://oauth.example/v1');
    const nativeByKey = new Map([[candidate.key, candidate]]);
    expect(() => rewriteOauthToApiKey(nativeByKey, { 'made-up': 'sk-test' }))
      .toThrow('sonata init: no API base URL is known for made-up; cannot use an API key.');
  });
});
