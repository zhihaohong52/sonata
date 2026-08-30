import { describe, it, expect } from 'vitest';
import { parseConfig } from '../../src/config.js';
import { plan, type CredentialProbe } from '../../src/init/plan.js';
import type { InitEnvironment } from '../../src/init/discover.js';

const noCredentials: CredentialProbe = {
  hasKey: () => false,
  hasOauthCredential: () => false,
  autoSource: () => null,
  copilotUsable: false,
};

const candidate = (key: string, gateway: string, id: string) =>
  ({ key, gateway, id, contextWindow: 128000, baseUrl: `https://${gateway}.example/v1`, auth: 'api-key' as const });

const env = (over: Partial<InitEnvironment> = {}): InitEnvironment => ({
  cwd: '/repo',
  home: '/home/u',
  tmux: { installed: true, version: '3.4', problems: [] },
  harnesses: [], problems: [],
  offered: [{ harness: 'opencode', provider: 'acme', key: 'opencode/acme', count: 2 }],
  allNativeCandidates: [candidate('acme-fast', 'acme', 'fast'), candidate('flaky-slow', 'flaky-gw', 'slow')],
  providerBaseUrls: { acme: 'https://acme.example/v1', 'flaky-gw': 'https://flaky.example/v1' },
  gatewayAuth: new Map([['acme', 'api-key' as const], ['flaky-gw', 'api-key' as const]]),
  oauthProviders: new Map(), byokProviders: [], configsByScope: {},
  existingHookScope: undefined, copilotUsable: false,
  ...over,
});

const state = {
  configScope: 'project' as const,
  providerKeys: ['opencode/acme'],
  nativeKeys: ['acme-fast', 'flaky-slow'],
  roles: ['code'],
  tiers: { code: { simple: ['acme-fast'], complex: ['acme-fast', 'flaky-slow'] } },
  hookScope: 'project' as const,
  routing: 'project' as const,
};

const opts = { cwd: '/repo', home: '/home/u', packageRoot: '/pkg' };

describe('plan — the config it emits', () => {
  it('keeps avoid_gateways bound to the top level, not to a table', () => {
    // The 0.3.4 defect: avoid_gateways was written after a [table] header,
    // so TOML bound it to that table and it was silently ignored. Only a
    // round-trip catches this — the broken output still parsed.
    const p = plan(
      env({ configsByScope: { project: { avoidGateways: ['flaky-gw'] } as never } }),
      state, noCredentials, opts);
    const back = parseConfig(p.configToml);
    expect(back.avoidGateways).toEqual(['flaky-gw']);
  });

  it('emits a config that parses and defines every model its tiers name', () => {
    const p = plan(env(), state, noCredentials, opts);
    const back = parseConfig(p.configToml);
    const defined = new Set(Object.keys(back.unifiedModels));
    for (const key of [...back.tiers!.code.simple, ...back.tiers!.code.complex]) {
      expect(defined).toContain(key);
    }
  });

  it('never writes a model key twice', () => {
    const p = plan(env(), state, noCredentials, opts);
    const keys = [...p.configToml.matchAll(/^\[models\."([^"]+)"\]$/gm)].map((m) => m[1]);
    expect(keys).toEqual([...new Set(keys)]);
  });
});

describe('plan — the key-check notices', () => {
  it('names the sonata repair path for a gateway with no key', () => {
    const p = plan(env(), state, noCredentials, opts);
    expect(p.notices).toContain('  ! acme: no key — run `sonata auth add acme`');
  });

  it('reports the pinned source rather than automatic precedence', () => {
    const credentials: CredentialProbe = { ...noCredentials, hasKey: (g, s) => g === 'acme' && s === 'sonata' };
    const p = plan(env(), { ...state, credentialSources: { acme: 'sonata' } }, credentials, opts);
    expect(p.notices).toContain('  ✓ acme: key from sonata');
  });

  it('tells an opencode-sourced gateway that sonata does not manage its credentials', () => {
    const p = plan(env(), { ...state, credentialSources: { acme: 'opencode' } }, noCredentials, opts);
    expect(p.notices).toContain(
      '  ! acme: no key from opencode — log into opencode itself, sonata does not manage its credentials');
  });
});

describe('plan — paths', () => {
  it('points sync at the global config directory when the scope is global', () => {
    const p = plan(env(), { ...state, configScope: 'global' }, noCredentials, opts);
    expect(p.syncCwd).toBe('/home/u/.config/sonata');
    expect(p.skillPath).toBe('/home/u/.claude/skills/sonata-loop/SKILL.md');
  });

  it('points sync at the repository when the scope is project', () => {
    const p = plan(env(), state, noCredentials, opts);
    expect(p.syncCwd).toBe('/repo');
    expect(p.skillPath).toBe('/repo/.claude/skills/sonata-loop/SKILL.md');
  });
});