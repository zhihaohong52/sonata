import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseConfig, expectedAgentNames, tierAgentNames, type SonataConfig } from '../../src/config.js';
import { plan, type CredentialProbe } from '../../src/init/plan.js';
import { deriveInitState } from '../../src/init/helpers.js';
import { litellmRequired } from '../../src/native/providers.js';
import { aaCatalogPath } from '../../src/catalog.js';
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

  // The real scenario for both tests below: an EXISTING config being re-run.
  // With no saved models, every model counts as newly added and is merged at
  // its proposal rank, which swamps any saved order — so a harness without
  // this cannot tell stickiness from a fresh proposal at all.
  // Deliberately a partial config: these tests care only about the saved
  // models, and `as unknown as SonataConfig` says that, where the previous
  // `as never` said nothing and made the value unspreadable below.
  const existing = {
    unifiedModels: {
      'acme-fast': { gateway: 'acme', id: 'fast' },
      'flaky-slow': { gateway: 'flaky-gw', id: 'slow' },
    },
  } as unknown as SonataConfig;

  it('carries an existing [budget] through a whole init', () => {
    // The sibling failure a nativeTomlFor test alone cannot catch: the writer
    // emits the key correctly but the call site never passes it. Only a
    // round-trip through the real plan proves the wiring.
    const p = plan(
      env({ configsByScope: { project: { ...existing, budget: { dailyUsd: 25 } } as SonataConfig } }),
      state, noCredentials, opts);
    expect(parseConfig(p.configToml).budget).toEqual({ dailyUsd: 25 });
  });

  it('keeps a hand-ordered tier by default', () => {
    // Stickiness is deliberate: a hand-tuned ranking must survive an ordinary
    // `sonata init`, which is why a saved list wins over a fresh proposal.
    const p = plan(
      env({ configsByScope: { project: existing } }),
      { ...state, tiers: { code: { simple: ['flaky-slow'], complex: ['flaky-slow'] } } },
      noCredentials, opts);
    expect(parseConfig(p.configToml).tiers!.code.simple).toEqual(['flaky-slow']);
  });

  it('discards a saved ranking when reproposeTiers is set', () => {
    // The gap this closes: a saved list could never be re-proposed, so a
    // `simple` written before the catalog changed stayed frozen forever.
    // Measured on a real config — `simple` led with a candidate 4.5x dearer
    // per task than `normal`'s, which is the tier split exactly inverted.
    const saved = { code: { simple: ['flaky-slow'], complex: ['flaky-slow'] } };
    const e = env({ configsByScope: { project: existing } });
    const sticky = plan(e, { ...state, tiers: saved }, noCredentials, opts);
    const fresh = plan(e, { ...state, tiers: saved, reproposeTiers: true }, noCredentials, opts);

    // The flag must actually change the outcome.
    expect(parseConfig(fresh.configToml).tiers!.code)
      .not.toEqual(parseConfig(sticky.configToml).tiers!.code);
    // And it must restore the candidate stickiness had frozen out.
    expect(parseConfig(fresh.configToml).tiers!.code.simple).toContain('acme-fast');
  });

  it('emits a normal tier for every role', () => {
    const p = plan(env(), state, noCredentials, opts);
    const tiers = parseConfig(p.configToml).tiers!;
    // The whole feature is unreachable if init never writes the list.
    expect(tiers.code!.normal).toBeDefined();
    expect(tiers.code!.normal!.length).toBeGreaterThan(0);
  });

  it('emits a config that parses and defines every model its tiers name', () => {
    const p = plan(env(), state, noCredentials, opts);
    const back = parseConfig(p.configToml);
    const defined = new Set(Object.keys(back.unifiedModels));
    for (const key of [...back.tiers!.code.simple, ...back.tiers!.code.complex]) {
      expect(defined).toContain(key);
    }
  });

  it('keeps a saved effort pin when no catalog is available', () => {
    // The validation error tells users to hand-pin a model after catalog
    // levels appear. A later init without that catalog must not erase it.
    const existing = {
      unifiedModels: { 'acme-fast': { gateway: 'acme', id: 'fast' } },
      tiers: { code: { simple: ['acme-fast@high'], complex: ['acme-fast@high'] } },
    } as never;
    const p = plan(
      env({ configsByScope: { project: existing } }),
      { ...state, tiers: undefined }, noCredentials, opts,
    );
    expect(parseConfig(p.configToml).tiers!.code.simple).toContain('acme-fast@high');
  });

  it('never writes a model key twice', () => {
    const p = plan(env(), state, noCredentials, opts);
    const keys = [...p.configToml.matchAll(/^\[models\."([^"]+)"\]$/gm)].map((m) => m[1]);
    expect(keys).toEqual([...new Set(keys)]);
  });

  it('carries a hand-ranked normal tier from deriveInitState through plan', () => {
    // The sibling failure a deriveInitState test alone cannot catch: plan
    // prefers `state.tiers` over the existing config (`saved = state.tiers?.[role]
    // ?? configForScope?.tiers?.[role]`), so a `normal` dropped while seeding
    // the wizard state leaves `savedLists.normal` undefined and the whole tier
    // falls back to a fresh proposal before anything is written.
    const derived = deriveInitState(parseConfig([
      '[native.gateways."acme"]',
      'base_url = "https://acme.example/v1"',
      '',
      '[native.gateways."flaky-gw"]',
      'base_url = "https://flaky.example/v1"',
      '',
      '[models."acme-fast"]',
      'gateway = "acme"',
      'id = "fast"',
      'context_window = 128000',
      '',
      '[models."flaky-slow"]',
      'gateway = "flaky-gw"',
      'id = "slow"',
      'context_window = 128000',
      '',
      '[tiers.code]',
      'simple = ["acme-fast"]',
      'normal = ["flaky-slow", "acme-fast"]',
      'complex = ["flaky-slow"]',
    ].join('\n')), 'project', []);
    const p = plan(
      env({ configsByScope: { project: existing } }),
      { ...state, tiers: derived.tiers }, noCredentials, opts);
    expect(parseConfig(p.configToml).tiers!.code.normal).toEqual(['flaky-slow', 'acme-fast']);
  });

  it('keeps a normal-only model through deriveInitState → plan, with its [models] entry and position', () => {
    // A model present only in a hand-ranked `normal` list must survive a
    // rewrite: its `[models]` entry (or the tier names a key nothing defines)
    // and its exact place in the ranking. Everything rides deriveInitState —
    // the seeded selection and the seeded tiers — so the chain is exercised
    // end to end rather than each half against its own fixture.
    const parsed = parseConfig(`
[native.gateways."g"]
base_url = "https://g.example/v1"

[models."g-a"]
gateway = "g"
id = "a"
context_window = 128000

[models."g-b"]
gateway = "g"
id = "b"
context_window = 128000

[tiers.code]
simple = ["g-a"]
normal = ["g-b", "g-a"]
complex = ["g-a"]
`);
    const d = deriveInitState(parsed, 'project', []);
    // 'g-b' exists only in `normal` and must be selected for the role all the
    // same — this is where a rewrite used to lose it.
    expect(d.perRoleModels?.code).toEqual(['g-a', 'g-b']);
    const p = plan(
      env({
        configsByScope: { project: parsed },
        allNativeCandidates: [candidate('g-a', 'g', 'a'), candidate('g-b', 'g', 'b')],
      }),
      {
        ...state,
        nativeKeys: d.nativeKeys ?? [],
        roles: d.roles ?? ['code'],
        perRoleModels: d.perRoleModels,
        tiers: d.tiers,
      },
      noCredentials, opts);
    const back = parseConfig(p.configToml);
    expect(back.unifiedModels['g-a']).toBeDefined();
    expect(back.unifiedModels['g-b']).toMatchObject({ gateway: 'g', id: 'b' });
    expect(back.tiers!.code.normal).toEqual(['g-b', 'g-a']);
  });
});

describe('plan — the agent count it promises', () => {
  // The summary is the one screen whose job is to say what is about to be
  // written, and it counted roles × models — a rule `sync` does not use. A role
  // whose `simple` and `complex` lists match collapses to a single file, so a
  // two-model, four-role config was promised 8 files and given 4. Assert the
  // invariant rather than a literal: the promise must equal what `sync`'s own
  // rule yields for the very config this plan emits.
  const promisedAgentCount = (summary: string[]): number => {
    const line = summary.find((l) => l.includes('in .claude/agents/'));
    return Number(/agents\s+(\d+) file/.exec(line ?? '')?.[1]);
  };

  for (const [name, tiers] of [
    ['tiers that collapse', { code: { simple: ['acme-fast', 'flaky-slow'], complex: ['acme-fast', 'flaky-slow'] } }],
    ['tiers as the fixture reconciles them', state.tiers],
  ] as const) {
    it(`promises exactly what sync will write, for ${name}`, () => {
      const p = plan(env(), { ...state, tiers: { code: { simple: [...tiers.code.simple], complex: [...tiers.code.complex] } } }, noCredentials, opts);
      const written = tierAgentNames(parseConfig(p.configToml).tiers!);
      expect(promisedAgentCount(p.summary)).toBe(written.length);
    });
  }

  it('includes auto agents in the promised count when auto-routing is enabled', () => {
    const existing = {
      autoRoute: { classifier: 'jev', minConfidence: 0.5 },
      unifiedModels: {
        'acme-fast': { gateway: 'acme', id: 'fast' },
        'flaky-slow': { gateway: 'flaky-gw', id: 'slow' },
      },
    } as unknown as SonataConfig;
    const p = plan(env({ configsByScope: { project: existing } }), state, noCredentials, opts);
    const written = expectedAgentNames(parseConfig(p.configToml));
    expect(written).toContain('code-auto');
    expect(promisedAgentCount(p.summary)).toBe(written.length);
  });

  it('says "1 file" rather than "1 files"', () => {
    const collapsed = { code: { simple: ['acme-fast', 'flaky-slow'], complex: ['acme-fast', 'flaky-slow'] } };
    const p = plan(env(), { ...state, tiers: collapsed }, noCredentials, opts);
    expect(p.summary).toContain('    agents  1 file in .claude/agents/');
  });
});

describe('plan — the key-check notices', () => {
  it('names the sonata repair path for a gateway with no key', () => {
    const p = plan(env(), state, noCredentials, opts);
    expect(p.notices).toContain('  ! acme: no key — run `sonata auth add acme`');
  });

  it('does not report a gateway as keyless when the wizard just took its key', () => {
    // The key is still only in memory at plan time — `apply` writes it — so a
    // disk probe cannot see it. Reporting it missing contradicted the
    // `✓ stored the key for acme` line printed moments later, and sent the
    // user to `sonata auth add` for a key they had just typed.
    const p = plan(env(), { ...state, byokKeys: { acme: 'sk-typed-in-the-wizard' } }, noCredentials, opts);
    expect(p.notices).toContain('  ✓ acme: key entered in this run');
    expect(p.notices).not.toContain('  ! acme: no key — run `sonata auth add acme`');
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
describe('plan — whether it installs litellm', () => {
  it('plans an install when the config it writes routes through litellm', () => {
    const p = plan(env(), state, noCredentials, opts);
    expect(p.installLitellm).toBe(true);
    expect(p.summary.join('\n')).toMatch(/litellm.*install/);
  });

  it('plans none when every gateway speaks anthropic natively', () => {
    // The whole point of the exercise: such a user needs no Python at all.
    const anthropic = candidate('an-fast', 'an-gw', 'fast');
    const p = plan(
      env({
        allNativeCandidates: [{ ...anthropic, wireFormat: 'anthropic' as const }],
        providerBaseUrls: { 'an-gw': 'https://an.example/v1' },
        gatewayAuth: new Map([['an-gw', 'api-key' as const]]),
        offered: [{ harness: 'opencode', provider: 'an-gw', key: 'opencode/an-gw', count: 1 }],
      }),
      {
        ...state,
        providerKeys: ['opencode/an-gw'],
        nativeKeys: ['an-fast'],
        tiers: { code: { simple: ['an-fast'], complex: ['an-fast'] } },
      },
      noCredentials, opts,
    );
    expect(p.installLitellm).toBe(false);
    expect(p.summary.join('\n')).toMatch(/litellm.*not needed/);
  });

  it('derives the flag from the emitted TOML, not from the selections', () => {
    // `serve` makes the same call against that same file, so the two can only
    // agree if this one reads what was actually written.
    const p = plan(env(), state, noCredentials, opts);
    expect(p.installLitellm).toBe(litellmRequired(parseConfig(p.configToml)));
  });
});

describe('plan — the CLAUDE.md guidance block', () => {
  it('defaults to the project CLAUDE.md', () => {
    const p = plan(env(), state, noCredentials, opts);
    expect(p.guidance).toEqual({ scope: 'project', path: '/repo/CLAUDE.md', autoRoute: false });
  });

  it('writes into the user CLAUDE.md at global scope', () => {
    const p = plan(env(), { ...state, guidance: 'global' as const }, noCredentials, opts);
    expect(p.guidance.path).toBe('/home/u/.claude/CLAUDE.md');
  });

  // Declining must be a real no-op: this is the one artifact that lands in a
  // file sonata does not own, so `skip` may not leave a path behind for apply
  // to write to.
  it('plans no path at all when skipped', () => {
    const p = plan(env(), { ...state, guidance: 'skip' as const }, noCredentials, opts);
    expect(p.guidance).toEqual({ scope: 'skip' });
    expect(p.guidance.path).toBeUndefined();
  });

  // The single confirm gate is the consent step, so it has to name the foreign
  // file it is about to edit — otherwise "Write these changes?" hides it.
  it('names the file in the summary the confirm prompt shows', () => {
    const p = plan(env(), state, noCredentials, opts);
    expect(p.summary.join('\n')).toContain('/repo/CLAUDE.md');
  });

  it('says so in the summary when skipped', () => {
    const p = plan(env(), { ...state, guidance: 'skip' as const }, noCredentials, opts);
    expect(p.summary.join('\n')).toContain('no CLAUDE.md block');
  });
});

describe('plan — preserves pricing settings across a rewrite', () => {
  // The unit test on nativeTomlFor passes even when `plan` forgets to pass the
  // existing config, which is exactly how this shipped broken: the writer had
  // no way to know, and the caller had no test. Measured on a real config,
  // one rewrite flipped a gateway from priced to unpriced between two requests
  // a minute apart, and unpriced volume is excluded from `[budget] daily_usd`.
  const existing = {
    avoidGateways: [],
    native: {
      gateways: {
        acme: { baseUrl: 'https://acme.example/v1', auth: 'api-key', pricingProvider: ['openai', 'deepseek'] },
        'flaky-gw': { baseUrl: 'https://flaky.example/v1', auth: 'api-key', price: { input: 2, output: 8 } },
      },
    },
    unifiedModels: { 'acme-fast': { price: { input: 1, output: 4 } } },
  } as never;

  it('keeps a gateway pricing_provider', () => {
    const p = plan(env({ configsByScope: { project: existing } }), state, noCredentials, opts);
    expect(parseConfig(p.configToml).native!.gateways.acme.pricingProvider).toEqual(['openai', 'deepseek']);
  });

  it('keeps a hand-written gateway price', () => {
    const p = plan(env({ configsByScope: { project: existing } }), state, noCredentials, opts);
    expect(parseConfig(p.configToml).native!.gateways['flaky-gw'].price).toMatchObject({ input: 2, output: 8 });
  });

  it('keeps a hand-written model price', () => {
    const p = plan(env({ configsByScope: { project: existing } }), state, noCredentials, opts);
    expect(parseConfig(p.configToml).unifiedModels['acme-fast'].price).toMatchObject({ input: 1, output: 4 });
  });
});


describe('plan — effort variants', () => {
  const homeWithFamilies = () => {
    const home = mkdtempSync(join(tmpdir(), 'sonata-plan-home-'));
    const path = aaCatalogPath(home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      fetchedAt: '2026-09-13T00:00:00Z',
      models: {
        fast: { codingIndex: 71, blendedPriceUsd: 0.45, agenticIndex: 42, costPerTask: 0.18, family: 'fast', effort: 'max' },
        'fast-high': { codingIndex: 60, blendedPriceUsd: 0.45, agenticIndex: 36, costPerTask: 0.04, family: 'fast', effort: 'high' },
        slow: { codingIndex: 50, blendedPriceUsd: 2, agenticIndex: 30, costPerTask: 0.5 },
      },
    }));
    return home;
  };

  it('writes only pinned candidates for a model with variants, and the config loads', () => {
    const home = homeWithFamilies();
    const p = plan(env({ home }), { ...state, tiers: undefined }, noCredentials, { ...opts, home });
    const back = parseConfig(p.configToml);
    for (const candidate of [...back.tiers!.code.simple, ...back.tiers!.code.complex]) {
      if (candidate.startsWith('acme-fast')) expect(candidate).toMatch(/^acme-fast@(high|max)$/);
    }
    expect(back.tiers!.code.simple[0]).toBe('acme-fast@high');
    // `complex` leads with @max now that the cost band is deleted: 42 against
    // 36 is a six-point edge, well outside `AA_CAPABILITY_TIE_MARGIN`, so it
    // is a real capability difference rather than benchmark noise and the
    // strong tier takes it. The band used to credit both rungs with the
    // family's best and let price decide; that crediting leaked across
    // families and is what this design replaced.
    //
    // The wasteful-tail gate would demote @max if it bought little for the
    // money. Here it buys six points for 4.5x, which pays.
    expect(back.tiers!.code.complex[0]).toBe('acme-fast@max');
    expect(back.tiers!.code.complex).toContain('acme-fast@high');
  });

  it('re-proposes a saved bare candidate that now has variants instead of dropping it', () => {
    const home = homeWithFamilies();
    const saved = { code: { simple: ['flaky-slow', 'acme-fast'], complex: ['acme-fast', 'flaky-slow'] } };
    const p = plan(env({ home }), { ...state, tiers: saved }, noCredentials, { ...opts, home });
    const back = parseConfig(p.configToml);
    expect(back.tiers!.code.simple).not.toContain('acme-fast');
    expect(back.tiers!.code.simple).toEqual(expect.arrayContaining(['acme-fast@high', 'acme-fast@max', 'flaky-slow']));
    expect(back.tiers!.code.complex).toEqual(expect.arrayContaining(['acme-fast@max', 'acme-fast@high', 'flaky-slow']));
  });
});

describe('plan — [auto_route] from the Setup step', () => {
  // Setup's answer is the only thing that may change this table. It is also
  // the only writer of it, so a step that was not reached must leave the
  // saved table byte-identical rather than re-emit a defaulted one.
  const savedAutoRoute = {
    classifier: 'jev' as const,
    baseUrl: 'https://api.typesafe.ai',
    model: 'jev-1.13',
    minConfidence: 0.3,
  };
  const withSaved = (autoRoute?: typeof savedAutoRoute) => env({
    configsByScope: {
      project: { ...(autoRoute === undefined ? {} : { autoRoute }) } as unknown as SonataConfig,
    },
  });

  it('keeps the saved table when the step was not used', () => {
    const p = plan(withSaved(savedAutoRoute), state, noCredentials, opts);
    const back = parseConfig(p.configToml);
    expect(back.autoRoute).toEqual(savedAutoRoute);
    expect(p.guidance.autoRoute).toBe(true);
  });

  it('writes no table when the step turned auto-route off', () => {
    const p = plan(withSaved(savedAutoRoute), { ...state, autoRoute: null }, noCredentials, opts);
    const back = parseConfig(p.configToml);
    expect(back.autoRoute).toBeUndefined();
    expect(p.configToml).not.toContain('[auto_route]');
    expect(p.guidance.autoRoute).toBe(false);
  });

  it('keeps the pinned model and min_confidence when the URL is unchanged', () => {
    const p = plan(withSaved(savedAutoRoute), {
      ...state, autoRoute: { baseUrl: 'https://api.typesafe.ai' },
    }, noCredentials, opts);
    const back = parseConfig(p.configToml);
    expect(back.autoRoute).toEqual({
      classifier: 'jev', baseUrl: 'https://api.typesafe.ai', model: 'jev-1.13', minConfidence: 0.3,
    });
  });

  it('drops a pinned model when the URL changes — a model belongs to its URL', () => {
    const p = plan(withSaved(savedAutoRoute), {
      ...state, autoRoute: { baseUrl: 'https://openrouter.ai/api' },
    }, noCredentials, opts);
    const back = parseConfig(p.configToml);
    expect(back.autoRoute).toEqual({
      classifier: 'jev', baseUrl: 'https://openrouter.ai/api', minConfidence: 0.3,
    });
  });

  it('writes a first [auto_route] at the default min_confidence, and follows the guidance flag', () => {
    const p = plan(withSaved(), {
      ...state, autoRoute: { baseUrl: 'http://localhost:8000' },
    }, noCredentials, opts);
    const back = parseConfig(p.configToml);
    expect(back.autoRoute).toEqual({ classifier: 'jev', baseUrl: 'http://localhost:8000', minConfidence: 0.5 });
    expect(p.guidance.autoRoute).toBe(true);
  });

  it('puts the decision key in keysToStore beside the provider keys', () => {
    const p = plan(withSaved(), {
      ...state,
      autoRoute: { baseUrl: 'https://api.typesafe.ai' },
      byokKeys: { acme: 'sk-provider' },
      decisionKey: { gateway: 'typesafe', key: 'sk-decision' },
    }, noCredentials, opts);
    expect(p.keysToStore).toEqual([
      { gateway: 'acme', key: 'sk-provider' },
      { gateway: 'typesafe', key: 'sk-decision' },
    ]);
  });

  it('stores nothing for a decision key there is none of', () => {
    const p = plan(withSaved(), { ...state, autoRoute: { baseUrl: 'https://api.typesafe.ai' } }, noCredentials, opts);
    expect(p.keysToStore).toEqual([]);
  });
});
