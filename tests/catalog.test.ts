import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  normalizeModelName, lookupModel, proposeTiers, loadAaCatalog, aaCatalogPath,
  aaCatalogAgeDays, aaLookupNames, catalogCoverage, SIMPLE_COST_CEILING,
  type AaCatalog,
} from '../src/catalog.js';

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
