import { describe, it, expect } from 'vitest';
import { scriptedState } from '../../src/init/scripted-state.js';
import type { InitEnvironment } from '../../src/init/discover.js';
import type { InitOptions } from '../../src/init/helpers.js';

const env = (over: Partial<InitEnvironment> = {}): InitEnvironment => ({
  cwd: '/tmp/test',
  home: '/home/test',
  tmux: { installed: true, version: '3.4', problems: [] },
  harnesses: [],
  problems: [],
  // The byok/<name> row is offered but `byokProviders` omits it (no live
  // detection produced a URL) and `WELL_KNOWN_PROVIDER_URLS` does not name it
  // either. `addByokCandidates` therefore silently skips minting a candidate.
  offered: [{ harness: 'byok', provider: 'made-up', key: 'byok/made-up', count: 0 }],
  allNativeCandidates: [],
  providerBaseUrls: {},
  gatewayAuth: new Map(),
  oauthProviders: new Map(),
  byokProviders: [],
  configsByScope: {},
  existingHookScope: undefined,
  copilotUsable: false,
  ...over,
});

const opts = (over: Partial<InitOptions> = {}): InitOptions => ({
  cwd: '/tmp/repo',
  home: '/home/u',
  packageRoot: '/pkg',
  yes: true,
  ...over,
});

describe('scriptedState', () => {
  it('reports an actionable error instead of crashing on a BYOK gateway with no known URL', () => {
    // Regression: `addByokCandidates` silently skipped gateways with no URL
    // (neither in `byokUrls` nor in `WELL_KNOWN_PROVIDER_URLS`), and the
    // resulting `undefined` in `inScopeNative` crashed `inScopeNativeByKey`
    // on `c.key` BEFORE any check could surface an actionable message. A
    // crash replaced the error the user needed to see.
    expect(() => scriptedState(
      env(),
      opts({ providers: ['byok/made-up'], models: ['made-up-x'] }),
    )).toThrow(/made-up/);
  });

  it('takes the --providers order as the gateway ranking', () => {
    // The flag's order is the only ranking a scripted install ever states, so
    // it is the ranking — not detection order, which would silently reorder
    // the user's list.
    const candidates = [
      { key: 'b-m', gateway: 'b', id: 'm', contextWindow: 128000, baseUrl: 'https://b.example/v1', auth: 'api-key' as const },
      { key: 'a-m', gateway: 'a', id: 'm', contextWindow: 128000, baseUrl: 'https://a.example/v1', auth: 'api-key' as const },
    ];
    const richEnv = env({
      offered: [
        { harness: 'opencode', provider: 'a', key: 'opencode/a', count: 1 },
        { harness: 'opencode', provider: 'b', key: 'opencode/b', count: 1 },
      ],
      allNativeCandidates: candidates,
    });
    const { state } = scriptedState(richEnv, opts({ providers: ['opencode/b', 'opencode/a'], models: ['b-m', 'a-m'] }));
    expect(state.gatewayOrder).toEqual(['b', 'a']);
  });

  it('leaves gatewayOrder undefined when --providers is absent', () => {
    // Absent means "no opinion" — plan then falls back to the ranking saved
    // in the config. Inventing one from detection order would overwrite it.
    const candidates = [
      { key: 'a-m', gateway: 'a', id: 'm', contextWindow: 128000, baseUrl: 'https://a.example/v1', auth: 'api-key' as const },
    ];
    const richEnv = env({
      offered: [{ harness: 'opencode', provider: 'a', key: 'opencode/a', count: 1 }],
      allNativeCandidates: candidates,
    });
    const { state } = scriptedState(richEnv, opts({ models: ['a-m'] }));
    expect(state.gatewayOrder).toBeUndefined();
  });
});
