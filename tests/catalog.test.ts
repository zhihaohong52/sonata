import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { parseConfig } from '../src/config.js';
import {
  normalizeModelName, lookupModel, proposeTiers, loadAaCatalog, aaCatalogPath,
  aaCatalogAgeDays, aaLookupNames, catalogCoverage, SIMPLE_COST_CEILING,
  catalogFamily, expandCandidates, hasEffortVariants, unpinnedVariants, candidateLabel,
  unpinnedCandidates, assertEffortsPinned,
  type AaCatalog,
} from '../src/catalog.js';
import { plan, type CredentialProbe } from '../src/init/plan.js';
import { rankableCandidates } from '../src/commands/agents.js';
import { splitCandidate } from '../src/effort.js';
import type { InitEnvironment } from '../src/init/discover.js';

describe('normalizeModelName', () => {
  it('strips harness/provider prefixes and date suffixes', () => {
    expect(normalizeModelName('acme-deepseek-v4-flash-0731', ['acme'])).toBe('deepseek-v4-flash');
    expect(normalizeModelName('opencode-acme-deepseek-v4-pro-0813', ['acme'])).toBe('deepseek-v4-pro');
    expect(normalizeModelName('openai/gpt-5.6-terra')).toBe('gpt-5.6-terra');
    expect(normalizeModelName('gpt-5.6-luna')).toBe('gpt-5.6-luna');
  });

  it('is idempotent', () => {
    expect(normalizeModelName(normalizeModelName('acme-deepseek-v4-flash-0731', ['acme'])))
      .toBe('deepseek-v4-flash');
  });

  it('remains idempotent on a full harness-provider-model key', () => {
    const once = normalizeModelName('opencode-acme-deepseek-v4-pro-0813', ['acme']);
    expect(once).toBe('deepseek-v4-pro');
    expect(normalizeModelName(once)).toBe('deepseek-v4-pro');
  });

  it('bounds stripping to one harness then one provider, keeping a reserved-word model name', () => {
    // A model genuinely named "openai-something"/"pi-something": the unbounded
    // loop ate the model's own prefix past the provider segment. Two passes
    // strip the key's harness and provider, then stop.
    expect(normalizeModelName('opencode-openrouter-openai-something')).toBe('openai-something');
    expect(normalizeModelName('codex-openai-pi-something')).toBe('pi-something');
  });
});

describe('lookupModel', () => {
  it('classifies curated models without AA data', () => {
    expect(lookupModel('deepseek-v4-flash')).toMatchObject({ capable: true, cheap: true, source: 'curated' });
    expect(lookupModel('gpt-5.6-terra')).toMatchObject({ capable: true, cheap: false, source: 'curated' });
  });

  it('defaults unknown models to capable-not-cheap — never demote silently', () => {
    expect(lookupModel('mystery-model-9000')).toEqual({ capable: true, cheap: false, source: 'default' });
  });

  it('prefers AA data over the curated table when present', () => {
    const aa: AaCatalog = {
      fetchedAt: '2026-08-25T00:00:00Z',
      models: { 'deepseek-v4-flash': { codingIndex: 10, blendedPriceUsd: 0.2 } },
    };
    // AA says this model is below the capable threshold: not complex-eligible.
    expect(lookupModel('deepseek-v4-flash', aa)).toMatchObject({ capable: false, source: 'aa' });
  });
});

describe('proposeTiers', () => {
  it('splits keys into simple (cheap) and complex (capable), ranked', () => {
    const aa: AaCatalog = {
      fetchedAt: '2026-08-25T00:00:00Z',
      models: {
        'deepseek-v4-flash': { codingIndex: 45, blendedPriceUsd: 0.3 },
        'gpt-5.6-luna': { codingIndex: 42, blendedPriceUsd: 0.5 },
        'deepseek-v4-pro': { codingIndex: 60, blendedPriceUsd: 2.5 },
        'gpt-5.6-terra': { codingIndex: 70, blendedPriceUsd: 6.0 },
      },
    };
    const tiers = proposeTiers(
      ['deepseek-v4-flash', 'gpt-5.6-luna', 'deepseek-v4-pro', 'gpt-5.6-terra'], aa,
    );
    // complex = most capable first, cost only breaking ties
    expect(tiers.complex[0]).toBe('gpt-5.6-terra');
    expect(tiers.complex).toContain('deepseek-v4-pro');
    // simple = most capability per unit cost. Here the cheap models (45, 42)
    // sit below the 0.85 floor relative to the best model (70), so nothing
    // clears it and the fallback value-ranks the whole set — which still puts
    // the cheap-and-effective models first, and keeps the expensive ones only
    // as later fallback candidates.
    expect(tiers.simple).toEqual([
      'deepseek-v4-flash', 'gpt-5.6-luna', 'deepseek-v4-pro', 'gpt-5.6-terra',
    ]);
  });

  it('ranks the simple tier by capability per cost, not by capability', () => {
    // The whole point of the simple tier: a model 40% as capable for 4% of the
    // cost beats the strongest model, which is what grunt work should run on.
    const aa: AaCatalog = {
      fetchedAt: '2026-08-25T00:00:00Z',
      models: {
        'cheap-and-good': { codingIndex: 58, blendedPriceUsd: 1, agenticIndex: 58, costPerTask: 0.09 },
        'top-and-dear': { codingIndex: 60, blendedPriceUsd: 1, agenticIndex: 60, costPerTask: 0.95 },
      },
    };
    const tiers = proposeTiers(['top-and-dear', 'cheap-and-good'], aa);
    expect(tiers.complex[0]).toBe('top-and-dear');
    expect(tiers.simple[0]).toBe('cheap-and-good');
  });

  it('prefers the agentic index over the coding index', () => {
    // Every sonata role runs as an agentic subagent, so where AA scored that
    // directly it is the closer measure — even when the coding index disagrees.
    const aa: AaCatalog = {
      fetchedAt: '2026-08-25T00:00:00Z',
      models: {
        'better-agent': { codingIndex: 40, blendedPriceUsd: 1, agenticIndex: 59, costPerTask: 0.5 },
        'better-coder': { codingIndex: 80, blendedPriceUsd: 1, agenticIndex: 45, costPerTask: 0.5 },
      },
    };
    expect(proposeTiers(['better-coder', 'better-agent'], aa).complex[0]).toBe('better-agent');
  });

  it('excludes a cheap but weak model from the simple tier', () => {
    // Without the floor, a model that is very cheap and very weak wins on
    // ratio alone and grunt work silently degrades.
    const aa: AaCatalog = {
      fetchedAt: '2026-08-25T00:00:00Z',
      models: {
        'strong': { codingIndex: 60, blendedPriceUsd: 1, agenticIndex: 60, costPerTask: 0.5 },
        'near-strong': { codingIndex: 55, blendedPriceUsd: 1, agenticIndex: 55, costPerTask: 0.1 },
        'junk': { codingIndex: 20, blendedPriceUsd: 1, agenticIndex: 20, costPerTask: 0.001 },
      },
    };
    const tiers = proposeTiers(['strong', 'near-strong', 'junk'], aa);
    expect(tiers.simple[0]).toBe('near-strong');
    expect(tiers.simple).not.toContain('junk');
  });

  it('a model too weak to enter the simple tier cannot set its cost ceiling', () => {
    // The ceiling is a `Math.min`, so unlike the capability floor's `Math.max`
    // one very cheap model drags it down for everyone. Measured over every
    // selected model, `junk` at $0.001/task set a $0.012 ceiling that nothing
    // eligible could clear: `simple` came back empty and fell back to mirroring
    // `complex`, so the tier stopped discriminating at exactly the moment its
    // gate was strictest. `lavish` is the witness — capable and above the
    // floor, but genuinely too dear for grunt work, so it belongs in `complex`
    // and not in `simple`. The fallback would have carried it in.
    const aa: AaCatalog = {
      fetchedAt: '2026-08-25T00:00:00Z',
      models: {
        'strong': { codingIndex: 60, blendedPriceUsd: 1, agenticIndex: 60, costPerTask: 0.5 },
        'value': { codingIndex: 55, blendedPriceUsd: 1, agenticIndex: 55, costPerTask: 0.1 },
        'lavish': { codingIndex: 58, blendedPriceUsd: 1, agenticIndex: 58, costPerTask: 8 },
        'junk': { codingIndex: 20, blendedPriceUsd: 1, agenticIndex: 20, costPerTask: 0.001 },
      },
    };
    const tiers = proposeTiers(['strong', 'value', 'lavish', 'junk'], aa);
    // Ceiling is min($0.50, $0.10, $8.00) x 12 = $1.20 — `junk` does not vote.
    expect(tiers.simple).toEqual(['value', 'strong']);
    expect(tiers.complex).toContain('lavish');
  });

  it('never returns an empty complex list when any model exists', () => {
    const tiers = proposeTiers(['mystery-model-9000']);
    expect(tiers.complex).toEqual(['mystery-model-9000']);
    // no cheap models: simple mirrors complex so the tier still resolves
    expect(tiers.simple).toEqual(['mystery-model-9000']);
  });

  it('breaks a coding-index tie by price, cheaper first', () => {
    const aa: AaCatalog = {
      fetchedAt: '2026-08-25T00:00:00Z',
      models: {
        'gpt-5.6-luna': { codingIndex: 50, blendedPriceUsd: 0.9 },
        'deepseek-v4-flash': { codingIndex: 50, blendedPriceUsd: 0.2 },
      },
    };
    const tiers = proposeTiers(['gpt-5.6-luna', 'deepseek-v4-flash'], aa);
    expect(tiers.complex).toEqual(['deepseek-v4-flash', 'gpt-5.6-luna']);
  });

  it('ranks the all-below-threshold fallback rather than raw input order', () => {
    const aa: AaCatalog = {
      fetchedAt: '2026-08-25T00:00:00Z',
      models: {
        'gpt-5.6-luna': { codingIndex: 30, blendedPriceUsd: 0.5 },
        'deepseek-v4-flash': { codingIndex: 20, blendedPriceUsd: 0.2 },
        'kimi-k3': { codingIndex: 35, blendedPriceUsd: 0.4 },
      },
    };
    // None clears the capable threshold, so the fallback takes every key —
    // and must still rank by index desc, not the order they were passed in.
    const tiers = proposeTiers(['gpt-5.6-luna', 'deepseek-v4-flash', 'kimi-k3'], aa);
    expect(tiers.complex).toEqual(['kimi-k3', 'gpt-5.6-luna', 'deepseek-v4-flash']);
  });

  it('breaks a near-tied capability gap by price rather than the marginal edge', () => {
    // The measured case AA_CAPABILITY_TIE_MARGIN exists for: qwen3.8-max
    // (58.4) outranked glm-5.3-flash (58.2) on a 0.2-point edge despite
    // costing over 10x as much per task. A gap this small is noise, not
    // signal, so price should decide it the same as an exact tie would.
    const aa: AaCatalog = {
      fetchedAt: '2026-08-25T00:00:00Z',
      models: {
        'qwen3.8-max': { codingIndex: 71.8, blendedPriceUsd: 3, agenticIndex: 58.4, costPerTask: 0.9133 },
        'glm-5.3-flash': { codingIndex: 71.5, blendedPriceUsd: 0.2375, agenticIndex: 58.2, costPerTask: 0.0869 },
      },
    };
    const tiers = proposeTiers(['qwen3.8-max', 'glm-5.3-flash'], aa);
    expect(tiers.complex).toEqual(['glm-5.3-flash', 'qwen3.8-max']);
  });

  it('still lets a capability gap bigger than the margin win outright', () => {
    const aa: AaCatalog = {
      fetchedAt: '2026-08-25T00:00:00Z',
      models: {
        // 2-point gap, wider than AA_CAPABILITY_TIE_MARGIN (1.0) — a real
        // edge, so the pricier-but-more-capable model still wins.
        'pricier-and-better': { codingIndex: 60, blendedPriceUsd: 3, agenticIndex: 60, costPerTask: 1 },
        'cheaper-and-close': { codingIndex: 58, blendedPriceUsd: 0.2, agenticIndex: 58, costPerTask: 0.1 },
      },
    };
    const tiers = proposeTiers(['cheaper-and-close', 'pricier-and-better'], aa);
    expect(tiers.complex[0]).toBe('pricier-and-better');
  });
});

describe('loadAaCatalog', () => {
  it('reads the cache file and returns undefined when absent or corrupt', () => {
    const home = mkdtempSync(join(tmpdir(), 'sonata-catalog-'));
    expect(loadAaCatalog(home)).toBeUndefined();
    const path = aaCatalogPath(home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ fetchedAt: 'x', models: { m: { codingIndex: 1, blendedPriceUsd: 1 } } }));
    expect(loadAaCatalog(home)?.models.m.codingIndex).toBe(1);
    writeFileSync(path, '{ not json');
    expect(loadAaCatalog(home)).toBeUndefined();
  });

  it('drops entries with non-numeric scores while keeping their valid siblings', () => {
    const home = mkdtempSync(join(tmpdir(), 'sonata-catalog-'));
    const path = aaCatalogPath(home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      fetchedAt: 'x',
      models: {
        good: { codingIndex: 60, blendedPriceUsd: 1.2 },
        missing: { codingIndex: 60 },                  // blendedPriceUsd undefined
        nullPrice: { codingIndex: 60, blendedPriceUsd: null },
        stringIndex: { codingIndex: 'high', blendedPriceUsd: 0.5 },
        infinite: { codingIndex: Infinity, blendedPriceUsd: 0.5 },
      },
    }));
    const loaded = loadAaCatalog(home);
    expect(loaded).toBeDefined();
    expect(Object.keys(loaded!.models)).toEqual(['good']);
    expect(loaded!.models.good.codingIndex).toBe(60);
  });

  it('keeps family and effort, and drops an effort that is not a known level', () => {
    const home = mkdtempSync(join(tmpdir(), 'sonata-aa-'));
    const path = aaCatalogPath(home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      fetchedAt: '2026-09-13T00:00:00Z',
      models: {
        'sprinter': { codingIndex: 70, blendedPriceUsd: 0.45, family: 'sprinter', effort: 'max' },
        'sprinter-turbo': { codingIndex: 10, blendedPriceUsd: 0.45, family: 'sprinter', effort: 'turbo' },
      },
    }));
    const aa = loadAaCatalog(home)!;
    expect(aa.models['sprinter']).toMatchObject({ family: 'sprinter', effort: 'max' });
    expect(aa.models['sprinter-turbo']).toEqual({ codingIndex: 10, blendedPriceUsd: 0.45, family: 'sprinter' });
  });

  it('returns undefined when every entry is invalid', () => {
    const home = mkdtempSync(join(tmpdir(), 'sonata-catalog-'));
    const path = aaCatalogPath(home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      fetchedAt: 'x',
      models: {
        a: { codingIndex: 'nope', blendedPriceUsd: 0.5 },
        b: { codingIndex: 50 },
      },
    }));
    expect(loadAaCatalog(home)).toBeUndefined();
  });
});

describe('normalizeModelName — configured providers', () => {
  it('strips a provider prefix the built-in list has never heard of', () => {
    // Regression: the built-in list can only cover providers someone thought
    // to hardcode. Every other user's gateway fell through to the `default`
    // catalog entry (capable, not cheap) and dropped out of the simple tier.
    expect(normalizeModelName('acme-deepseek-v4-flash-0731')).toBe('acme-deepseek-v4-flash');
    expect(normalizeModelName('acme-deepseek-v4-flash-0731', ['acme'])).toBe('deepseek-v4-flash');
  });

  it('prefers the longest matching provider, not the first', () => {
    // `openai-` also matches `openai-codex-…`; stripping it would leave a
    // `codex-` fragment glued to the model name.
    expect(normalizeModelName('openai-codex-gpt-5.5', ['openai-codex', 'openai'])).toBe('gpt-5.5');
  });

  it('stays idempotent with providers supplied', () => {
    const once = normalizeModelName('acme-glm-5.3', ['acme']);
    expect(normalizeModelName(once, ['acme'])).toBe(once);
  });

  it('still strips a harness prefix before the provider one', () => {
    expect(normalizeModelName('opencode-acme-kimi-k3', ['acme'])).toBe('kimi-k3');
  });

  it('lets a configured provider reach its curated entry', () => {
    expect(lookupModel('acme-kimi-k3').source).toBe('default');
    expect(lookupModel('acme-kimi-k3', undefined, ['acme'])).toMatchObject({
      capable: true, cheap: true, source: 'curated',
    });
  });

  it('puts a configured provider\'s cheap models back in the simple tier', () => {
    const keys = ['acme-kimi-k3', 'acme-grok-4.6'];
    // Unstripped, neither model is cheap, so no model clears the simple bar
    // and the documented fallback makes simple mirror complex — the tier stops
    // discriminating at all, which is the damage this fixes.
    expect(proposeTiers(keys).simple).toEqual(proposeTiers(keys).complex);
    expect(proposeTiers(keys, undefined, ['acme']).simple).toEqual(['acme-kimi-k3']);
  });
});

describe('aaCatalogAgeDays', () => {
  it('counts whole days since the fetch', () => {
    expect(aaCatalogAgeDays('2026-08-01T00:00:00Z', new Date('2026-08-31T00:00:00Z'))).toBe(30);
  });

  it('returns undefined for an unreadable stamp', () => {
    // A corrupt stamp must not read as "age 0" and silently pass the freshness
    // check — the caller needs to tell "fresh" from "cannot tell".
    expect(aaCatalogAgeDays('not-a-date', new Date('2026-08-31T00:00:00Z'))).toBeUndefined();
  });

  it('treats a future stamp as current rather than negative', () => {
    // Clock disagreement, not freshness worth reporting as a negative age.
    expect(aaCatalogAgeDays('2027-01-01T00:00:00Z', new Date('2026-08-31T00:00:00Z'))).toBe(0);
  });
});

describe('proposeTiers — avoided gateways', () => {
  const aa: AaCatalog = {
    fetchedAt: '2026-08-25T00:00:00Z',
    models: {
      'best': { codingIndex: 60, blendedPriceUsd: 1, agenticIndex: 60, costPerTask: 0.1 },
      'good': { codingIndex: 55, blendedPriceUsd: 1, agenticIndex: 55, costPerTask: 0.5 },
    },
  };

  it('demotes an avoided model rather than dropping it', () => {
    // Demotion, not exclusion: the tier keeps it as a fallback, so avoiding a
    // gateway costs preference rather than the depth a ranked list provides.
    const t = proposeTiers(['best', 'good'], aa, [], new Set(['best']));
    expect(t.complex).toEqual(['good', 'best']);
    expect(t.simple).toContain('best');
  });

  it('leaves ordering untouched when nothing is avoided', () => {
    expect(proposeTiers(['good', 'best'], aa).complex).toEqual(['best', 'good']);
  });

  it('measures the simple floor over models that can actually lead', () => {
    // With the strongest model avoided, keeping it in the floor calculation
    // could raise the bar until nothing preferred qualifies — inverting the
    // setting's intent.
    const wide: AaCatalog = {
      fetchedAt: '2026-08-25T00:00:00Z',
      models: {
        'avoided-top': { codingIndex: 90, blendedPriceUsd: 1, agenticIndex: 90, costPerTask: 0.9 },
        'preferred': { codingIndex: 50, blendedPriceUsd: 1, agenticIndex: 50, costPerTask: 0.05 },
      },
    };
    const t = proposeTiers(['avoided-top', 'preferred'], wide, [], new Set(['avoided-top']));
    expect(t.simple[0]).toBe('preferred');
  });
});

describe('proposeTiers — the simple tier admits on cost per task', () => {
  // The bug this replaces: admission tested `blendedPriceUsd` (dollars per 1M
  // tokens) while ranking *inside* the tier used `costPerTask` (dollars per
  // unit of work). A model could be cheap to run and dear per token, and the
  // gate would refuse the very model the ranking would have put first.
  const aa: AaCatalog = {
    fetchedAt: '2026-09-01T00:00:00Z',
    models: {
      // Cheapest per task — sets the ceiling at 0.05 * SIMPLE_COST_CEILING.
      'cheapest': { codingIndex: 60, agenticIndex: 60, blendedPriceUsd: 0.2, costPerTask: 0.05 },
      // Over the old $1.00/1M bar, well inside the per-task ceiling.
      'dear-per-token': { codingIndex: 58, agenticIndex: 58, blendedPriceUsd: 1.5, costPerTask: 0.4 },
      // Under the old bar, and far outside the per-task ceiling: verbose enough
      // that cheap tokens still add up to expensive work.
      'dear-per-task': { codingIndex: 62, agenticIndex: 62, blendedPriceUsd: 0.9, costPerTask: 5.0 },
    },
  };

  it('admits a model the per-1M bar refused', () => {
    // Pin what the old gate said, so this test fails loudly if the absolute
    // bar ever comes back.
    expect(lookupModel('dear-per-token', aa).cheap).toBe(false);
    expect(0.4).toBeLessThanOrEqual(0.05 * SIMPLE_COST_CEILING);
    expect(proposeTiers(['cheapest', 'dear-per-token', 'dear-per-task'], aa).simple)
      .toEqual(['cheapest', 'dear-per-token']);
  });

  it('refuses a model the per-1M bar admitted', () => {
    expect(lookupModel('dear-per-task', aa).cheap).toBe(true);
    expect(proposeTiers(['cheapest', 'dear-per-task'], aa).simple).toEqual(['cheapest']);
  });

  it('measures the ceiling against the cheapest selected model, not an absolute', () => {
    // Same three models minus the cheap one: the ceiling moves with the
    // selection, so 0.4 now sets it and 5.0 is still outside.
    const t = proposeTiers(['dear-per-token', 'dear-per-task'], aa);
    expect(t.simple).toEqual(['dear-per-token']);
  });

  it('keeps the absolute judgement for a model AA has not costed per task', () => {
    // The change has no better information about an uncosted model, so it must
    // not move one: `cheap` still comes from the per-1M bar (or the curated
    // table), exactly as before.
    const mixed: AaCatalog = {
      fetchedAt: '2026-09-01T00:00:00Z',
      models: {
        'costed': { codingIndex: 60, agenticIndex: 60, blendedPriceUsd: 0.2, costPerTask: 0.05 },
        'uncosted-cheap': { codingIndex: 58, agenticIndex: 58, blendedPriceUsd: 0.5 },
        'uncosted-dear': { codingIndex: 59, agenticIndex: 59, blendedPriceUsd: 4.0 },
      },
    };
    const t = proposeTiers(['costed', 'uncosted-cheap', 'uncosted-dear'], mixed);
    expect(t.simple).toContain('costed');
    expect(t.simple).toContain('uncosted-cheap');
    expect(t.simple).not.toContain('uncosted-dear');
  });

  it('falls back entirely to the absolute bar when nothing is costed per task', () => {
    // No per-task cost anywhere means no scale to be relative on, so there is
    // no ceiling at all and behaviour is the pre-change one.
    const none: AaCatalog = {
      fetchedAt: '2026-09-01T00:00:00Z',
      models: {
        'a': { codingIndex: 60, agenticIndex: 60, blendedPriceUsd: 0.3 },
        'b': { codingIndex: 58, agenticIndex: 58, blendedPriceUsd: 3.0 },
      },
    };
    expect(proposeTiers(['a', 'b'], none).simple).toEqual(['a']);
  });
});

describe('aaLookupNames', () => {
  it('always tries the full name first', () => {
    expect(aaLookupNames('z-ai-glm-5.2')[0]).toBe('z-ai-glm-5.2');
  });

  it('drops up to two leading segments of a flattened vendor namespace', () => {
    // `z-ai/glm-5.2` flattens to `z-ai-glm-5.2`; AA files it as `glm-5.2`.
    expect(aaLookupNames('z-ai-glm-5.2')).toEqual(['z-ai-glm-5.2', 'ai-glm-5.2', 'glm-5.2']);
  });

  it('offers nothing beyond the full name when there is nothing to drop', () => {
    expect(aaLookupNames('kimi')).toEqual(['kimi']);
    // A single remaining segment is a fragment, not a model name.
    expect(aaLookupNames('glm-5.2')).toEqual(['glm-5.2']);
  });

  it('refuses a candidate carrying no version digit', () => {
    // `flash-lite` is a family another vendor might also publish under; a bare
    // model name keeps its version, so requiring a digit is what separates them.
    expect(aaLookupNames('gemini-2.5-flash-lite')).not.toContain('flash-lite');
  });
});

describe('lookupModel — namespaced OpenRouter refs', () => {
  it('matches a shortened name when the full one is absent', () => {
    const aa: AaCatalog = {
      fetchedAt: '2026-09-01T00:00:00Z',
      models: { 'glm-5-2': { codingIndex: 55, blendedPriceUsd: 0.4 } },
    };
    expect(lookupModel('openrouter-z-ai-glm-5.2', aa).source).toBe('aa');
  });

  it('prefers the full name over any shortened one', () => {
    // The full name winning is what makes the guess safe: it can never move a
    // model that already matches.
    const aa: AaCatalog = {
      fetchedAt: '2026-09-01T00:00:00Z',
      models: {
        'z-ai-glm-5-2': { codingIndex: 55, blendedPriceUsd: 9.0 },
        'glm-5-2': { codingIndex: 55, blendedPriceUsd: 0.1 },
      },
    };
    expect(lookupModel('openrouter-z-ai-glm-5.2', aa).cheap).toBe(false);
  });

  it('strips an OpenRouter serving variant', () => {
    // `:free`/`:nitro` picks a serving route for the same weights, so it must
    // not change the name a score is looked up under.
    expect(normalizeModelName('openrouter-nvidia-nemotron-3-super-120b-a12b:free'))
      .toBe('nvidia-nemotron-3-super-120b-a12b');
    expect(normalizeModelName('z-ai/glm-5.2:nitro')).toBe('glm-5.2');
    // The date-suffix strip still runs after it.
    expect(normalizeModelName('openrouter-deepseek-v4-flash-0731:free')).toBe('deepseek-v4-flash');
  });
});

describe('catalogCoverage', () => {
  const aa: AaCatalog = {
    fetchedAt: '2026-09-01T00:00:00Z',
    models: { 'deepseek-v4-flash': { codingIndex: 45, blendedPriceUsd: 0.3 } },
  };

  it('splits scored from unscored', () => {
    expect(catalogCoverage(['deepseek-v4-flash', 'brand-new-3.9'], aa))
      .toEqual({ scored: ['deepseek-v4-flash'], unscored: ['brand-new-3.9'] });
  });

  it('resolves a key through its configured gateway prefix', () => {
    // Coverage must agree with ranking about what is scored, so it normalizes
    // the same way — including the caller's own gateway names.
    expect(catalogCoverage(['acme-deepseek-v4-flash-0731'], aa, ['acme']).unscored).toEqual([]);
  });

  it('reports everything unscored with no catalog at all', () => {
    // The case age cannot describe: no catalog is not "0 days old".
    expect(catalogCoverage(['deepseek-v4-flash'], undefined).unscored)
      .toEqual(['deepseek-v4-flash']);
  });
});


const FAMILY_AA: AaCatalog = {
  fetchedAt: '2026-09-13T00:00:00Z',
  models: {
    'gpt-5-6-luna': { codingIndex: 71, blendedPriceUsd: 0.45, agenticIndex: 42.7, costPerTask: 0.178, family: 'gpt-5-6-luna', effort: 'max' },
    'gpt-5-6-luna-xhigh': { codingIndex: 68, blendedPriceUsd: 0.45, agenticIndex: 39.5, costPerTask: 0.085, family: 'gpt-5-6-luna', effort: 'xhigh' },
    'gpt-5-6-luna-high': { codingIndex: 60, blendedPriceUsd: 0.45, agenticIndex: 35.6, costPerTask: 0.044, family: 'gpt-5-6-luna', effort: 'high' },
    'gpt-5-6-luna-low': { codingIndex: 44, blendedPriceUsd: 0.45, agenticIndex: 17.9, costPerTask: 0.0098, family: 'gpt-5-6-luna', effort: 'low' },
    'gpt-5-6-terra': { codingIndex: 78, blendedPriceUsd: 4.5, agenticIndex: 43.7, costPerTask: 1.399, family: 'gpt-5-6-terra', effort: 'max' },
    'gpt-5-6-terra-high': { codingIndex: 70, blendedPriceUsd: 4.5, agenticIndex: 37.6, costPerTask: 0.338, family: 'gpt-5-6-terra', effort: 'high' },
    'deepseek-v4-flash': { codingIndex: 65, blendedPriceUsd: 0.66, agenticIndex: 41.7, costPerTask: 0.22 },
    // A family of one: AA scored it at one level and named it. Not variants.
    'lonely': { codingIndex: 50, blendedPriceUsd: 1, family: 'lonely', effort: 'high' },
  },
};

const FAMILY_COLLISION_AA: AaCatalog = {
  fetchedAt: '2026-09-13T00:00:00Z',
  models: {
    // This exact spelling identifies a singleton family.
    'vendor-gpt-5.6-luna': { codingIndex: 50, blendedPriceUsd: 1, family: 'vendor-gpt-5.6-luna', effort: 'high' },
    // The shortened spelling identifies a different model with variants.
    'gpt-5-6-luna': { codingIndex: 71, blendedPriceUsd: 0.45, family: 'gpt-5-6-luna', effort: 'max' },
    'gpt-5-6-luna-high': { codingIndex: 60, blendedPriceUsd: 0.45, family: 'gpt-5-6-luna', effort: 'high' },
  },
};

describe('catalogFamily', () => {
  it('groups rows by family and knows the default level', () => {
    const fam = catalogFamily('gpt-5.6-luna', FAMILY_AA)!;
    expect(fam.name).toBe('gpt-5-6-luna');
    expect(fam.default).toBe('max');
    expect([...fam.variants.keys()]).toEqual(['low', 'high', 'xhigh', 'max']);
    expect(fam.variants.get('high')?.costPerTask).toBe(0.044);
  });
  it('is undefined for a model with fewer than two scored levels', () => {
    expect(catalogFamily('deepseek-v4-flash', FAMILY_AA)).toBeUndefined();
    expect(catalogFamily('lonely', FAMILY_AA)).toBeUndefined();
    expect(catalogFamily('gpt-5.6-luna', undefined)).toBeUndefined();
  });
  it('finds a family through the same spellings a score is found through', () => {
    // An OpenRouter-flattened ref still reaches its family.
    expect(catalogFamily('openai-gpt-5.6-luna', FAMILY_AA)?.name).toBe('gpt-5-6-luna');
  });
  it('guards against a shortened-spelling family collision', () => {
    expect(catalogFamily('vendor-gpt-5.6-luna', FAMILY_COLLISION_AA)).toBeUndefined();
    expect(lookupModel('vendor-gpt-5.6-luna@high', FAMILY_COLLISION_AA).source).not.toBe('aa');
  });
});

describe('expandCandidates', () => {
  it('expands a key with variants into one candidate per level, weakest first', () => {
    expect(expandCandidates(['gpt-5.6-luna', 'deepseek-v4-flash'], FAMILY_AA)).toEqual([
      'gpt-5.6-luna@low', 'gpt-5.6-luna@high', 'gpt-5.6-luna@xhigh', 'gpt-5.6-luna@max',
      'deepseek-v4-flash',
    ]);
  });
  it('is the identity without a catalog', () => {
    expect(expandCandidates(['gpt-5.6-luna'], undefined)).toEqual(['gpt-5.6-luna']);
  });
  it('leaves an already-pinned candidate alone', () => {
    expect(expandCandidates(['gpt-5.6-luna@high'], FAMILY_AA)).toEqual(['gpt-5.6-luna@high']);
  });
  it('recovers the id through configured gateway names', () => {
    expect(hasEffortVariants('codex-gpt-5.6-luna', FAMILY_AA, ['codex'])).toBe(true);
    expect(hasEffortVariants('deepseek-v4-flash', FAMILY_AA)).toBe(false);
  });
});

describe('unpinnedVariants', () => {
  it('expands only the bare saved keys that have variants', () => {
    expect(unpinnedVariants(['gpt-5.6-luna', 'deepseek-v4-flash', 'gpt-5.6-terra@high'], FAMILY_AA)).toEqual([
      'gpt-5.6-luna@low', 'gpt-5.6-luna@high', 'gpt-5.6-luna@xhigh', 'gpt-5.6-luna@max',
    ]);
    expect(unpinnedVariants(undefined, FAMILY_AA)).toEqual([]);
  });
});

const PINNABLE = `
[models."luna"]
gateway = "codex"
id = "gpt-5.6-luna"
[models."flash"]
gateway = "deepseek"
id = "deepseek-v4-flash"
[native.gateways."codex"]
auth = "codex-oauth"
[native.gateways."deepseek"]
base_url = "https://api.deepseek.example/v1"
[tiers.code]
simple = ["luna", "flash"]
complex = ["luna@max", "flash"]
`;

describe('unpinnedCandidates / assertEffortsPinned', () => {
  it('names a bare candidate whose model the catalog scores at several levels', () => {
    const config = parseConfig(PINNABLE);
    const found = unpinnedCandidates(config, FAMILY_AA);
    expect(found.map((u) => [u.role, u.tier, u.key])).toEqual([['code', 'simple', 'luna']]);
    expect(found[0].family.default).toBe('max');
    expect(() => assertEffortsPinned(config, FAMILY_AA)).toThrow(
      /tiers\.code\.simple "luna".*levels low, high, xhigh, max.*default is max.*"luna@max".*sonata init/s,
    );
  });

  it('is silent with no catalog, and for a fully pinned config', () => {
    const config = parseConfig(PINNABLE);
    expect(() => assertEffortsPinned(config, undefined)).not.toThrow();
    const pinned = parseConfig(PINNABLE.replace('simple = ["luna", "flash"]', 'simple = ["luna@high", "flash"]'));
    expect(() => assertEffortsPinned(pinned, FAMILY_AA)).not.toThrow();
  });

  it('resolves the upstream id through the gateway name, not the config key', () => {
    // `[models."codex-gpt-5.6-luna"]` with id `gpt-5.6-luna` is the same model.
    const config = parseConfig(PINNABLE.replace(/"luna"/g, '"codex-gpt-5.6-luna"').replace(/"luna@max"/, '"codex-gpt-5.6-luna@max"'));
    expect(unpinnedCandidates(config, FAMILY_AA).map((u) => u.key)).toEqual(['codex-gpt-5.6-luna']);
  });
});

/**
 * The invariant the two editors exist to satisfy: for anything
 * `assertEffortsPinned` refuses, both a re-run of `sonata init` and
 * `sonata agents` must produce a pin that clears it.
 *
 * This was violated by resolving the catalog family through two different
 * names. The refusal resolves a candidate through its model's upstream *id*
 * (the rule `cmdDoctor` follows), while expansion resolved through the config
 * *key* — so for a hand-named key the two disagreed, the refusal fired, and no
 * editor could offer the level that would clear it. `sonata init` re-wrote the
 * same bare candidate and aborted in `loadConfig`; `sonata agents` could not
 * even open, since it loads the config first. The only way out was hand-editing
 * `sonata.toml`, which is what makes this a merge blocker rather than a wart.
 *
 * Asserted as a property of the refused set, not of `PINNABLE`: a fixture
 * added later is covered without touching the assertion.
 */
describe('effort pinning — every editor can repair what loadConfig refuses', () => {
  const noCredentials: CredentialProbe = {
    hasKey: () => false,
    hasOauthCredential: () => false,
    autoSource: () => null,
    copilotUsable: false,
  };

  const nativeCandidate = (key: string, gateway: string, id: string) => ({
    key, gateway, id, contextWindow: 128000,
    baseUrl: `https://${gateway}.example/v1`, auth: 'api-key' as const,
  });

  const pinned = (list: readonly string[], key: string): boolean => list.some((candidate) => {
    const parts = splitCandidate(candidate);
    return parts.key === key && parts.effort !== undefined;
  });

  it('offers a pin for every refused candidate, in plan() and in the agents editor', () => {
    const config = parseConfig(PINNABLE);
    const refused = unpinnedCandidates(config, FAMILY_AA);
    // If the fixture ever stops being refusable this test would pass vacuously.
    expect(refused.map((u) => [u.role, u.tier, u.key])).toEqual([['code', 'simple', 'luna']]);

    // `plan` reads the catalog off disk, as `cmdInit` does.
    const home = mkdtempSync(join(tmpdir(), 'sonata-pin-'));
    const catalogPath = aaCatalogPath(home);
    mkdirSync(dirname(catalogPath), { recursive: true });
    writeFileSync(catalogPath, JSON.stringify(FAMILY_AA));

    const env: InitEnvironment = {
      cwd: '/repo',
      home,
      tmux: { installed: true, version: '3.4', problems: [] },
      harnesses: [], problems: [], offered: [],
      allNativeCandidates: [
        nativeCandidate('luna', 'codex', 'gpt-5.6-luna'),
        nativeCandidate('flash', 'deepseek', 'deepseek-v4-flash'),
      ],
      providerBaseUrls: {},
      gatewayAuth: new Map(),
      oauthProviders: new Map(), byokProviders: [], configsByScope: { project: config },
      existingHookScope: undefined, copilotUsable: false,
    };
    // No `tiers` in state: the saved lists come from the config being repaired,
    // which is what `sonata init` reads when it opens on a refused config.
    const state = {
      configScope: 'project' as const,
      providerKeys: [],
      nativeKeys: ['luna', 'flash'],
      roles: ['code'],
      hookScope: 'project' as const,
      routing: 'project' as const,
    };
    const planned = plan(env, state, noCredentials, { cwd: '/repo', home, packageRoot: '/pkg' });
    const emitted = parseConfig(planned.configToml).tiers!;

    for (const { role, tier, key } of refused) {
      expect(pinned(emitted[role]![tier], key)).toBe(true);
      expect(pinned(rankableCandidates(config, FAMILY_AA), key)).toBe(true);
    }
    // The point of the pin: what `plan` emits loads. A pin that clears the
    // message but not `loadConfig` would satisfy the two lines above and none
    // of the invariant.
    const emittedConfig = parseConfig(planned.configToml);
    expect(() => assertEffortsPinned(emittedConfig, FAMILY_AA)).not.toThrow();
  });
});

describe('plan() ranks a BYOK gateway\'s models through models.dev names', () => {
  const noCredentials: CredentialProbe = {
    hasKey: () => false,
    hasOauthCredential: () => false,
    autoSource: () => null,
    copilotUsable: false,
  };

  it('pins the alias and the vendor-prefixed id at their scored levels', () => {
    // DeepSeek's own slugs: `deepseek-flash` is the versionless alias for
    // V4.1 Flash, and `deepseek-v4-pro` begins with the gateway's name. AA
    // scores both by level, so both must be re-proposed as pinned variants —
    // a bare key here is what `loadConfig` refuses.
    const home = mkdtempSync(join(tmpdir(), 'sonata-alias-'));
    const catalogPath = aaCatalogPath(home);
    mkdirSync(dirname(catalogPath), { recursive: true });
    writeFileSync(catalogPath, JSON.stringify({
      fetchedAt: '2026-09-13T00:00:00Z',
      models: {
        'deepseek-v4-1-flash': { codingIndex: 60, blendedPriceUsd: 0.5, family: 'deepseek-v4-1-flash', effort: 'max' },
        'deepseek-v4-1-flash-high': { codingIndex: 55, blendedPriceUsd: 0.5, family: 'deepseek-v4-1-flash', effort: 'high' },
        'deepseek-v4-pro': { codingIndex: 59, blendedPriceUsd: 0.54, family: 'deepseek-v4-pro', effort: 'max' },
        'deepseek-v4-pro-high': { codingIndex: 58, blendedPriceUsd: 0.54, family: 'deepseek-v4-pro', effort: 'high' },
      },
    }));
    writeFileSync(join(dirname(catalogPath), 'models-dev.json'), JSON.stringify({
      fetchedAt: '2026-09-13T00:00:00Z',
      providers: { deepseek: { 'deepseek-flash': { input: 0.15, output: 0.6 } } },
      names: { deepseek: { 'deepseek-flash': 'DeepSeek V4.1 Flash' } },
    }));

    const candidate = (key: string, id: string) => ({
      key, gateway: 'deepseek', id, contextWindow: 128000,
      baseUrl: 'https://api.deepseek.example/v1', auth: 'api-key' as const,
    });
    const env: InitEnvironment = {
      cwd: '/repo',
      home,
      tmux: { installed: true, version: '3.4', problems: [] },
      harnesses: [], problems: [], offered: [],
      allNativeCandidates: [
        candidate('deepseek-deepseek-flash', 'deepseek-flash'),
        candidate('deepseek-deepseek-v4-pro', 'deepseek-v4-pro'),
      ],
      providerBaseUrls: {},
      gatewayAuth: new Map(),
      oauthProviders: new Map(), byokProviders: [], configsByScope: {},
      existingHookScope: undefined, copilotUsable: false,
    };
    const state = {
      configScope: 'project' as const,
      providerKeys: [],
      nativeKeys: ['deepseek-deepseek-flash', 'deepseek-deepseek-v4-pro'],
      roles: ['code'],
      hookScope: 'project' as const,
      routing: 'project' as const,
    };
    const planned = plan(env, state, noCredentials, { cwd: '/repo', home, packageRoot: '/pkg' });
    const emitted = parseConfig(planned.configToml).tiers!.code;
    expect(emitted.complex).toEqual(expect.arrayContaining([
      'deepseek-deepseek-flash@max', 'deepseek-deepseek-flash@high',
      'deepseek-deepseek-v4-pro@max', 'deepseek-deepseek-v4-pro@high',
    ]));
    expect(emitted.complex).not.toContain('deepseek-deepseek-flash');
  });
});

describe('lookupModel / scoreFor with an effort', () => {
  it('scores a candidate at its own level', () => {
    expect(lookupModel('gpt-5.6-luna@low', FAMILY_AA)).toEqual({ capable: true, cheap: true, source: 'aa' });
    // 44 >= 40 keeps it capable; the bare row is the max row.
    expect(lookupModel('gpt-5.6-luna', FAMILY_AA).source).toBe('aa');
  });
  it('treats an effort on a model with no family as unscored', () => {
    // `lonely` is scored at one level only, so `@high` finds no family — and
    // it is not in the curated table, so it falls through to the default.
    expect(lookupModel('lonely@high', FAMILY_AA).source).toBe('default');
  });
});

describe('candidateLabel', () => {
  it('shows the level, the capability and the per-task cost', () => {
    expect(candidateLabel('gpt-5.6-luna@xhigh', FAMILY_AA)).toMatch(/^gpt-5\.6-luna @xhigh\s+39\.5\s+\$0\.085\/task$/);
    expect(candidateLabel('deepseek-v4-flash', FAMILY_AA)).toMatch(/^deepseek-v4-flash\s+41\.7\s+\$0\.220\/task$/);
  });
  it('aligns the numbers across rows', () => {
    const a = candidateLabel('gpt-5.6-luna@xhigh', FAMILY_AA);
    const b = candidateLabel('deepseek-v4-flash', FAMILY_AA);
    expect(a.indexOf('39.5')).toBe(b.indexOf('41.7'));
  });
  it('falls back to the per-1M rate, and to the bare key with no catalog', () => {
    expect(candidateLabel('lonely', FAMILY_AA)).toMatch(/^lonely\s+50\.0\s+\$1\.00\/1M$/);
    expect(candidateLabel('gpt-5.6-luna@max', undefined)).toBe('gpt-5.6-luna @max');
  });
});


describe('proposeTiers — effort variants', () => {
  it('ranks variants as candidates: complex by capability, simple by value above the floor', () => {
    const tiers = proposeTiers(['gpt-5.6-luna', 'gpt-5.6-terra', 'deepseek-v4-flash'], FAMILY_AA);
    // terra@max 43.7 edges luna@max 42.7 — within the 1.0 tie margin, so
    // price decides: luna@max ($0.178) beats terra@max ($1.399).
    expect(tiers.complex.slice(0, 3)).toEqual(['gpt-5.6-luna@max', 'gpt-5.6-terra@max', 'deepseek-v4-flash']);
    // Floor = 0.75 × 43.7 = 32.8: luna@high (35.6) clears it and leads on
    // value; luna@low (17.9) does not, whatever its cost.
    expect(tiers.simple[0]).toBe('gpt-5.6-luna@high');
    expect(tiers.simple).not.toContain('gpt-5.6-luna@low');
    expect(tiers.simple).toContain('gpt-5.6-luna@xhigh');
  });

  it('demotes every variant of an avoided model, by bare key', () => {
    const tiers = proposeTiers(['gpt-5.6-luna', 'deepseek-v4-flash'], FAMILY_AA, [], new Set(['gpt-5.6-luna']));
    expect(tiers.complex[0]).toBe('deepseek-v4-flash');
    expect(tiers.simple[0]).toBe('deepseek-v4-flash');
  });

  it('is unchanged for a catalog without families', () => {
    const aa: AaCatalog = {
      fetchedAt: '2026-08-25T00:00:00Z',
      models: {
        'cheap-and-good': { codingIndex: 58, blendedPriceUsd: 1, agenticIndex: 58, costPerTask: 0.09 },
        'top-and-dear': { codingIndex: 60, blendedPriceUsd: 1, agenticIndex: 60, costPerTask: 0.95 },
      },
    };
    expect(proposeTiers(['top-and-dear', 'cheap-and-good'], aa)).toEqual({
      complex: ['top-and-dear', 'cheap-and-good'],
      simple: ['cheap-and-good', 'top-and-dear'],
    });
  });
});

describe('lookupModel — an upstream resolver may offer several spellings', () => {
  // DeepSeek's API serves V4.1 Flash as the versionless alias `deepseek-flash`,
  // which no segment-dropping can turn into AA's `deepseek-v4-1-flash`. The
  // resolver offers the alias first and a display-name-derived spelling after
  // it, and the first spelling that scores wins.
  const aa: AaCatalog = {
    fetchedAt: '2026-09-01T00:00:00Z',
    models: {
      'deepseek-v4-1-flash': { codingIndex: 55, blendedPriceUsd: 0.4, family: 'deepseek-v4-1-flash', effort: 'max' },
      'deepseek-flash-x': { codingIndex: 10, blendedPriceUsd: 9.0 },
    },
  };
  const spellings = (key: string) => key === 'deepseek-deepseek-flash' ? ['deepseek-flash', 'deepseek-v4.1-flash'] : key;

  it('scores an alias through its later spelling when the first misses', () => {
    expect(lookupModel('deepseek-deepseek-flash', aa, ['deepseek'], spellings)).toMatchObject({ source: 'aa', cheap: true });
    expect(candidateLabel('deepseek-deepseek-flash', aa, ['deepseek'], spellings)).toContain('55.0');
  });

  it('lets the first spelling win when it scores', () => {
    const direct: AaCatalog = {
      fetchedAt: '2026-09-01T00:00:00Z',
      models: { ...aa.models, 'deepseek-flash': { codingIndex: 20, blendedPriceUsd: 9.0 } },
    };
    expect(lookupModel('deepseek-deepseek-flash', direct, ['deepseek'], spellings).cheap).toBe(false);
  });

  it('finds the family through a later spelling too', () => {
    const fam: AaCatalog = {
      fetchedAt: '2026-09-01T00:00:00Z',
      models: {
        'deepseek-v4-1-flash': { codingIndex: 55, blendedPriceUsd: 0.4, family: 'deepseek-v4-1-flash', effort: 'max' },
        'deepseek-v4-1-flash-high': { codingIndex: 50, blendedPriceUsd: 0.3, family: 'deepseek-v4-1-flash', effort: 'high' },
      },
    };
    expect(expandCandidates(['deepseek-deepseek-flash'], fam, ['deepseek'], spellings))
      .toEqual(['deepseek-deepseek-flash@high', 'deepseek-deepseek-flash@max']);
  });

  it('is unchanged for a resolver returning one string', () => {
    expect(lookupModel('deepseek-deepseek-flash', aa, ['deepseek'], (k) => k).source).toBe('default');
  });
});

describe('lookupModel — a gateway named after the vendor', () => {
  // `upstreamFor` hands back the bare id, which carries no gateway prefix —
  // but the vendor's own model names begin with the vendor, and a gateway
  // called `deepseek` made the provider strip eat `deepseek-` off
  // `deepseek-v4-pro` and ask AA about `v4-pro`. Measured on a BYOK DeepSeek
  // gateway: every one of its models ranked from the unscored default.
  const aa: AaCatalog = {
    fetchedAt: '2026-09-01T00:00:00Z',
    models: {
      'deepseek-v4-pro': { codingIndex: 59, blendedPriceUsd: 0.54, family: 'deepseek-v4-pro', effort: 'max' },
      'deepseek-v4-pro-high': { codingIndex: 58, blendedPriceUsd: 0.54, family: 'deepseek-v4-pro', effort: 'high' },
    },
  };
  const id = (key: string) => key === 'deepseek-deepseek-v4-pro' ? 'deepseek-v4-pro' : key;

  it('still scores an id that begins with the gateway name', () => {
    expect(lookupModel('deepseek-deepseek-v4-pro', aa, ['deepseek'], id).source).toBe('aa');
    expect(expandCandidates(['deepseek-deepseek-v4-pro'], aa, ['deepseek'], id))
      .toEqual(['deepseek-deepseek-v4-pro@high', 'deepseek-deepseek-v4-pro@max']);
  });

  it('still strips the gateway off a key the resolver leaves alone', () => {
    expect(lookupModel('deepseek-deepseek-v4-pro', aa, ['deepseek']).source).toBe('aa');
  });
});

describe('proposeTiers — effort breaks a capability-and-price tie', () => {
  // Gemini 3.7 Flash at `low` and `medium` score 71.0 and 71.5 — inside the
  // tie margin — and AA costs neither per task, so both fall to the same
  // per-1M blend. With nothing left to order them the sort kept input order,
  // which is weakest level first. The whole point of a level is that a
  // higher one thinks harder; at the same price it should lead.
  const aa: AaCatalog = {
    fetchedAt: '2026-09-13T00:00:00Z',
    models: {
      'gemini-3-7-flash': { codingIndex: 72, blendedPriceUsd: 1.5, agenticIndex: 72, family: 'gemini-3-7-flash', effort: 'high' },
      'gemini-3-7-flash-medium': { codingIndex: 71.5, blendedPriceUsd: 1.5, agenticIndex: 71.5, family: 'gemini-3-7-flash', effort: 'medium' },
      'gemini-3-7-flash-low': { codingIndex: 71, blendedPriceUsd: 1.5, agenticIndex: 71, family: 'gemini-3-7-flash', effort: 'low' },
    },
  };

  it('ranks the higher level first in both tiers', () => {
    const { complex, simple } = proposeTiers(['gemini-3.7-flash'], aa);
    expect(complex).toEqual(['gemini-3.7-flash@high', 'gemini-3.7-flash@medium', 'gemini-3.7-flash@low']);
    expect(simple).toEqual(['gemini-3.7-flash@high', 'gemini-3.7-flash@medium', 'gemini-3.7-flash@low']);
  });

  it('treats an equal-price score inside the tie margin as a tie in the simple tier too', () => {
    // A lower level scoring 0.3 higher is noise, not an edge: at the same
    // price the higher level still leads. `byValue` compared raw value
    // before the level and let the noise decide.
    const noisy: AaCatalog = {
      fetchedAt: aa.fetchedAt,
      models: {
        ...aa.models,
        'gemini-3-7-flash-low': { codingIndex: 71.8, blendedPriceUsd: 1.5, agenticIndex: 71.8, family: 'gemini-3-7-flash', effort: 'low' },
      },
    };
    expect(proposeTiers(['gemini-3.7-flash'], noisy).simple)
      .toEqual(['gemini-3.7-flash@high', 'gemini-3.7-flash@medium', 'gemini-3.7-flash@low']);
  });

  it('still lets a real capability edge or a cheaper price win over the level', () => {
    const edged: AaCatalog = {
      fetchedAt: aa.fetchedAt,
      models: {
        ...aa.models,
        'gemini-3-7-flash-low': { codingIndex: 74, blendedPriceUsd: 1.5, agenticIndex: 74, family: 'gemini-3-7-flash', effort: 'low' },
      },
    };
    expect(proposeTiers(['gemini-3.7-flash'], edged).complex[0]).toBe('gemini-3.7-flash@low');
    const cheaper: AaCatalog = {
      fetchedAt: aa.fetchedAt,
      models: {
        ...aa.models,
        'gemini-3-7-flash-low': { codingIndex: 71, blendedPriceUsd: 0.5, agenticIndex: 71, family: 'gemini-3-7-flash', effort: 'low' },
      },
    };
    expect(proposeTiers(['gemini-3.7-flash'], cheaper).complex[0]).toBe('gemini-3.7-flash@low');
  });
});
