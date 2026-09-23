import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { parseConfig } from '../src/config.js';
import {
  capabilityClass,
  normalizeModelName, lookupModel, proposeTiers, loadAaCatalog, aaCatalogPath,
  aaCatalogAgeDays, aaLookupNames, catalogCoverage, SIMPLE_COST_CEILING,
  catalogFamily, expandCandidates, hasEffortVariants, unpinnedVariants, candidateLabel,
  unpinnedCandidates, assertEffortsPinned, hasTaskCost,
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
    expect(lookupModel('deepseek-v4-flash')).toEqual({ capable: true, source: 'curated' });
    expect(lookupModel('gpt-5.6-terra')).toEqual({ capable: true, source: 'curated' });
  });

  it('defaults unknown models to capable — ranking requires catalog task costs', () => {
    expect(lookupModel('mystery-model-9000')).toEqual({ capable: true, source: 'default' });
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

/** Order-preserving containment: every element of `sub`, in `full`'s order. */
const isSubsequence = (sub: readonly string[], full: readonly string[]): boolean => {
  let at = 0;
  for (const key of full) if (key === sub[at]) at++;
  return at === sub.length;
};

describe('lookupModel — no published coding index', () => {
  it('reads an unpublished coding index as unknown, not low', () => {
    // `undefined >= 40` is false, which read as "not capable": the same
    // exclusion the stand-in bug caused, reached from the other side.
    const aa: AaCatalog = { fetchedAt: 'x', models: {
      'gpt-6-luna': { intelligenceIndex: 20.9, blendedPriceUsd: 0.2, costPerTask: 0.0045 },
    } };
    expect(lookupModel('gpt-6-luna', aa)).toEqual({ capable: true, source: 'aa' });
  });

  it('still applies the threshold to a coding index AA did publish', () => {
    const aa: AaCatalog = { fetchedAt: 'x', models: { weak: { codingIndex: 20, blendedPriceUsd: 0.2 } } };
    expect(lookupModel('weak', aa).capable).toBe(false);
  });

  it('keeps a cached row that has only an intelligence score', () => {
    // The loader required a coding index, which would have dropped exactly
    // the rows the stand-in bug was hiding — at load time instead.
    const home = mkdtempSync(join(tmpdir(), 'aa-intel-only-'));
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(join(home, '.config', 'sonata', 'catalog.json'), JSON.stringify({
      fetchedAt: '2026-09-23T00:00:00Z',
      models: { 'gpt-6-luna': { intelligenceIndex: 20.9, blendedPriceUsd: 0.2, costPerTask: 0.0045 } },
    }));
    expect(loadAaCatalog(home)?.models['gpt-6-luna']?.intelligenceIndex).toBe(20.9);
  });
});

describe('proposeTiers — one scale for every tier', () => {
  // The real case. `glm` has an agentic score; `mimo`, like every model AA
  // has only just scored, has intelligence alone. Ranking the value tiers on
  // agentic-with-fallback put glm's 50.9 (agentic) on the same axis as mimo's
  // 46.3 (intelligence), and glm became the knee — though on intelligence
  // mimo beats it on capability AND price, so glm is not on the frontier.
  const aa: AaCatalog = { fetchedAt: 'x', models: {
    cheap: { intelligenceIndex: 20.9, blendedPriceUsd: 0.1, costPerTask: 0.0045 },
    mid:   { intelligenceIndex: 33.9, blendedPriceUsd: 0.1, costPerTask: 0.0417 },
    mimo:  { intelligenceIndex: 46.3, blendedPriceUsd: 0.5, costPerTask: 0.1332 },
    glm:   { agenticIndex: 50.9, codingIndex: 59.0, intelligenceIndex: 41.8, blendedPriceUsd: 0.5, costPerTask: 0.2533 },
    top:   { intelligenceIndex: 52.7, blendedPriceUsd: 3, costPerTask: 3.2575 },
  } };

  it('leads normal with the knee measured on intelligence, not a mixed axis', () => {
    expect(proposeTiers(['cheap', 'mid', 'mimo', 'glm', 'top'], aa).normal[0]).toBe('mimo');
  });

  it('never ranks a model above one that beats it on the shared scale', () => {
    // mimo is smarter and cheaper than glm on intelligence; no tier may put
    // glm first.
    const tiers = proposeTiers(['cheap', 'mid', 'mimo', 'glm', 'top'], aa);
    for (const list of [tiers.simple, tiers.normal, tiers.complex]) {
      if (list.includes('glm') && list.includes('mimo')) {
        expect(list.indexOf('mimo')).toBeLessThan(list.indexOf('glm'));
      }
    }
  });
});

describe('proposeTiers — value below a cent per task', () => {
  it('ranks by the real price, not a one-cent floor', () => {
    // The real pair: gpt-6-luna@low 20.9 at $0.0045, gpt-5.6-luna@low 21.0
    // at $0.0098. Flooring both to $0.01 erased a 2.2x price difference and
    // let a 0.1-point gap put the dearer model first in `simple`.
    const aa: AaCatalog = { fetchedAt: 'x', models: {
      newer: { intelligenceIndex: 20.9, blendedPriceUsd: 0.1, costPerTask: 0.0045 },
      older: { intelligenceIndex: 21.0, blendedPriceUsd: 0.1, costPerTask: 0.0098 },
    } };
    const tiers = proposeTiers(['older', 'newer'], aa);
    expect(tiers.simple[0]).toBe('newer');
  });
});

describe('proposeTiers', () => {
  const threeTierAa: AaCatalog = { fetchedAt: '2026-09-16T00:00:00Z', models: {
    // One family at several efforts: capability nearly flat, cost spread wide.
    'flash-low':  { codingIndex: 44, blendedPriceUsd: 1, costPerTask: 0.010 },
    'flash-high': { codingIndex: 63, blendedPriceUsd: 1, costPerTask: 0.044 },
    'pro-max':    { codingIndex: 77, blendedPriceUsd: 1, costPerTask: 1.399 },
  } };

  it('leads normal with the knee, and complex with capability', () => {
    // `flash-high` is the knee: on (log cost, capability) it sits furthest
    // above the chord joining `flash-low` to `pro-max`. `normal` leads with
    // it because the knee is the best balance point and `normal` is the
    // default tier — leading it with the cheapest model available gave it the
    // same lead as `simple`, which is the collapse SIMPLE_CAPABILITY_FLOOR
    // caused and was deleted for.
    const p = proposeTiers(['flash-low', 'flash-high', 'pro-max'], threeTierAa);
    expect(p.normal[0]).toBe('flash-high');
    // Behind the knee, value order resumes.
    expect(p.normal.slice(1)).toEqual(['flash-low', 'pro-max']);
    // `pro-max` buys 14 points for 1.5 cost decades — under a third of the
    // median slope — so the gate demotes it to last. It is demoted, never
    // dropped: the tier keeps it as a fallback.
    expect(p.complex).toEqual(['flash-high', 'flash-low', 'pro-max']);
  });

  it('keeps value order when the frontier is too short to have a knee', () => {
    // Two frontier points have no interior. `kneeIndex` used to answer the
    // cheapest point as a stand-in, and `normal` promoted it over its own
    // value order. Here the cheapest (`weak`, 45 at $0.10) is NOT the best
    // value (`strong`, 90 at $0.15 = 600/$ against 450/$), so the difference
    // is visible: with no knee, value order stands. Both clear the capable
    // threshold, or they would be filtered before any knee was computed and
    // the test would pass whether or not the fix was there.
    const aa: AaCatalog = { fetchedAt: 'x', models: {
      weak:   { codingIndex: 45, blendedPriceUsd: 1, costPerTask: 0.10 },
      strong: { codingIndex: 90, blendedPriceUsd: 1, costPerTask: 0.15 },
    } };
    expect(proposeTiers(['weak', 'strong'], aa).normal[0]).toBe('strong');
  });

  it('makes simple a cost-capped subsequence of the value order', () => {
    // 12 x $0.010 = $0.120, so pro-max is out.
    const p = proposeTiers(['flash-low', 'flash-high', 'pro-max'], threeTierAa);
    expect(p.simple).toEqual(['flash-low', 'flash-high']);
    // **`simple` is no longer a subsequence of `normal`, and that is
    // deliberate.** `normal` promotes the knee to its head, so the two tiers
    // now disagree about which model comes first — cheap tier leads cheap,
    // default tier leads balanced. Asserting the old containment would be
    // asserting the collapse this change exists to undo.
    //
    // What still holds, and is what the property was protecting: `simple`
    // never runs a sort of its own, so it cannot invent an order neither tier
    // asked for. It is the value order, filtered by cost.
    expect(isSubsequence(p.simple, ['flash-low', 'flash-high', 'pro-max'])).toBe(true);
    // And it can only ever contain models `normal` also offers.
    for (const key of p.simple) expect(p.normal).toContain(key);
  });

  it('skips an over-ceiling candidate rather than truncating at it', () => {
    // Constructed to break the prefix reading: `x` outranks `y` on value but
    // sits over the cap, so `simple` skips it and keeps `y`. Truncating at the
    // first over-ceiling candidate would make `simple` a true prefix and drop
    // `y` — a qualifying cheap model — which is the opposite of what the cheap
    // tier is for.
    const aa: AaCatalog = { fetchedAt: 'x', models: {
      a1: { codingIndex: 44, blendedPriceUsd: 1, costPerTask: 0.010 },
      x: { codingIndex: 60, blendedPriceUsd: 1, costPerTask: 0.150 },
      y: { codingIndex: 45, blendedPriceUsd: 1, costPerTask: 0.120 },
    } };
    const p = proposeTiers(['a1', 'x', 'y'], aa);
    expect(p.normal).toEqual(['a1', 'x', 'y']);
    expect(p.simple).toEqual(['a1', 'y']);
    expect(isSubsequence(p.simple, p.normal)).toBe(true);
  });

  it('always admits the anchor, so simple is never empty', () => {
    // Every model expensive: the cap is 12x the best-value model's own cost,
    // and that model therefore always clears it.
    const dear: AaCatalog = { fetchedAt: 'x', models: {
      'a': { codingIndex: 70, blendedPriceUsd: 1, costPerTask: 9.5 },
      'b': { codingIndex: 60, blendedPriceUsd: 1, costPerTask: 40 },
    } };
    const p = proposeTiers(['a', 'b'], dear);
    expect(p.simple.length).toBeGreaterThan(0);
    expect(p.simple[0]).toBe(p.normal[0]);
  });

  it('diverges from normal on a heterogeneous set', () => {
    // Capability varies at similar cost, which is what makes the tiers differ.
    const mixed: AaCatalog = { fetchedAt: 'x', models: {
      'glm':  { codingIndex: 58, blendedPriceUsd: 1, costPerTask: 0.05 },
      'luna': { codingIndex: 76, blendedPriceUsd: 1, costPerTask: 0.11 },
    } };
    const p = proposeTiers(['glm', 'luna'], mixed);
    expect(p.normal[0]).toBe('glm');
    expect(p.complex[0]).toBe('luna');
  });

  it('excludes models without an AA cost-per-task from both tiers', () => {
    const aa: AaCatalog = {
      fetchedAt: '2026-09-15T00:00:00Z',
      models: {
        costed: { codingIndex: 80, agenticIndex: 80, blendedPriceUsd: 0.2, costPerTask: 0.2 },
        uncosted: { codingIndex: 90, agenticIndex: 90, blendedPriceUsd: 0.01 },
      },
    };
    expect(proposeTiers(['uncosted', 'costed'], aa)).toEqual({
      simple: ['costed'],
      normal: ['costed'],
      complex: ['costed'],
    });
  });

  it('splits task-costed keys into simple and complex tiers, ranked', () => {
    const aa: AaCatalog = {
      fetchedAt: '2026-08-25T00:00:00Z',
      models: {
        'deepseek-v4-flash': { codingIndex: 45, blendedPriceUsd: 0.3, costPerTask: 0.3 },
        'gpt-5.6-luna': { codingIndex: 42, blendedPriceUsd: 0.5, costPerTask: 0.5 },
        'deepseek-v4-pro': { codingIndex: 60, blendedPriceUsd: 2.5, costPerTask: 2.5 },
        'gpt-5.6-terra': { codingIndex: 70, blendedPriceUsd: 6.0, costPerTask: 6.0 },
      },
    };
    const tiers = proposeTiers(
      ['deepseek-v4-flash', 'gpt-5.6-luna', 'deepseek-v4-pro', 'gpt-5.6-terra'], aa,
    );
    // complex = most capable first, cost only breaking ties
    expect(tiers.complex[0]).toBe('gpt-5.6-terra');
    expect(tiers.complex).toContain('deepseek-v4-pro');
    // The retired capability floor no longer removes capable models from
    // simple; it is the cost-capped subsequence of the value-ranked normal tier.
    expect(tiers.normal).toEqual([
      'deepseek-v4-flash', 'gpt-5.6-luna', 'deepseek-v4-pro', 'gpt-5.6-terra',
    ]);
    expect(tiers.simple).toEqual([
      'deepseek-v4-flash', 'gpt-5.6-luna', 'deepseek-v4-pro',
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

  it('allows a cheap but weak model when it leads on value', () => {
    // The capability floor is intentionally retired: simple is a cost-capped
    // subsequence of normal, so a very cheap model can lead on capability per dollar.
    const aa: AaCatalog = {
      fetchedAt: '2026-08-25T00:00:00Z',
      models: {
        'strong': { codingIndex: 60, blendedPriceUsd: 1, agenticIndex: 60, costPerTask: 0.5 },
        'near-strong': { codingIndex: 55, blendedPriceUsd: 1, agenticIndex: 55, costPerTask: 0.1 },
        'junk': { codingIndex: 40, blendedPriceUsd: 1, agenticIndex: 40, costPerTask: 0.001 },
      },
    };
    const tiers = proposeTiers(['strong', 'near-strong', 'junk'], aa);
    // `simple` still leads with the cheap weak model; `normal` leads with the
    // knee, which is the whole difference between the two tiers now.
    expect(tiers.simple).toEqual(['junk']);
    expect(tiers.normal).toContain('junk');
  });

  it('anchors the simple ceiling to the best-value model', () => {
    // The cap is anchored to the best-value capable model, not to a
    // capability-floor survivor. Here `junk` leads on value and its $0.001
    // cost sets the $0.012 cap, so the simple tier contains its prefix only.
    const aa: AaCatalog = {
      fetchedAt: '2026-08-25T00:00:00Z',
      models: {
        'strong': { codingIndex: 60, blendedPriceUsd: 1, agenticIndex: 60, costPerTask: 0.5 },
        'value': { codingIndex: 55, blendedPriceUsd: 1, agenticIndex: 55, costPerTask: 0.1 },
        'lavish': { codingIndex: 58, blendedPriceUsd: 1, agenticIndex: 58, costPerTask: 8 },
        'junk': { codingIndex: 40, blendedPriceUsd: 1, agenticIndex: 40, costPerTask: 0.001 },
      },
    };
    const tiers = proposeTiers(['strong', 'value', 'lavish', 'junk'], aa);
    // The ceiling is anchored to the best-VALUE model, not to whatever leads
    // `normal` — `normal` now leads with the knee, which is deliberately not
    // the cheapest, and anchoring there would raise the cap by the knee's
    // price and let `simple` reach models it exists to exclude.
    expect(tiers.simple).toEqual(['junk']);
    expect(tiers.complex).toContain('lavish');
  });

  it('never returns an empty complex list when any model exists', () => {
    const tiers = proposeTiers(['mystery-model-9000']);
    expect(tiers.complex).toEqual(['mystery-model-9000']);
    // no catalog costs: normal is empty and simple falls back to it so the
    // tier still resolves.
    expect(tiers.normal).toEqual(['mystery-model-9000']);
    expect(tiers.simple).toEqual(['mystery-model-9000']);
  });

  it('breaks a coding-index tie by price, cheaper first', () => {
    const aa: AaCatalog = {
      fetchedAt: '2026-08-25T00:00:00Z',
      models: {
        'gpt-5.6-luna': { codingIndex: 50, blendedPriceUsd: 0.9, costPerTask: 0.9 },
        'deepseek-v4-flash': { codingIndex: 50, blendedPriceUsd: 0.2, costPerTask: 0.2 },
      },
    };
    const tiers = proposeTiers(['gpt-5.6-luna', 'deepseek-v4-flash'], aa);
    expect(tiers.complex).toEqual(['deepseek-v4-flash', 'gpt-5.6-luna']);
  });

  it('ranks the all-below-threshold fallback rather than raw input order', () => {
    const aa: AaCatalog = {
      fetchedAt: '2026-08-25T00:00:00Z',
      models: {
        'gpt-5.6-luna': { codingIndex: 30, blendedPriceUsd: 0.5, costPerTask: 0.5 },
        'deepseek-v4-flash': { codingIndex: 20, blendedPriceUsd: 0.2, costPerTask: 0.2 },
        'kimi-k3': { codingIndex: 35, blendedPriceUsd: 0.4, costPerTask: 0.4 },
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

  it('drops a malformed cost-per-task and keeps the row as uncosted', () => {
    const home = mkdtempSync(join(tmpdir(), 'sonata-catalog-'));
    const path = aaCatalogPath(home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      fetchedAt: 'x',
      models: {
        costed: { codingIndex: 60, blendedPriceUsd: 1.2, costPerTask: 0.4 },
        nullCost: { codingIndex: 60, blendedPriceUsd: 1.2, costPerTask: null },
        stringCost: { codingIndex: 60, blendedPriceUsd: 1.2, costPerTask: '0.4' },
        infiniteCost: { codingIndex: 60, blendedPriceUsd: 1.2, costPerTask: Infinity },
      },
    }));
    const aa = loadAaCatalog(home)!;
    // The row survives — only the unusable field goes.
    expect(Object.keys(aa.models).sort()).toEqual(['costed', 'infiniteCost', 'nullCost', 'stringCost']);
    expect(aa.models.costed.costPerTask).toBe(0.4);
    for (const name of ['nullCost', 'stringCost', 'infiniteCost']) {
      expect(aa.models[name].costPerTask).toBeUndefined();
      // Uncosted, so it is never offered and `.toFixed(3)` is never reached.
      expect(hasTaskCost(name, aa)).toBe(false);
    }
    expect(hasTaskCost('costed', aa)).toBe(true);
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
      capable: true, source: 'curated',
    });
  });

  it('puts a configured provider\'s cheap models back in the simple tier', () => {
    const keys = ['acme-kimi-k3', 'acme-grok-4.6'];
    // Unstripped, neither model is cheap, so no model clears the simple bar
    // and the documented fallback makes simple mirror complex — the tier stops
    // discriminating at all, which is the damage this fixes.
    expect(proposeTiers(keys).simple).toEqual(proposeTiers(keys).complex);
    expect(proposeTiers(keys, undefined, ['acme']).simple).toEqual(['acme-kimi-k3', 'acme-grok-4.6']);
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

  it('anchors simple to a preferred model when one can lead', () => {
    // An avoided model must not set the cost anchor for preferred models;
    // avoidance changes preference, not whether the fallback remains available.
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
    expect(0.4).toBeLessThanOrEqual(0.05 * SIMPLE_COST_CEILING);
    expect(proposeTiers(['cheapest', 'dear-per-token', 'dear-per-task'], aa).simple)
      .toEqual(['cheapest', 'dear-per-token']);
  });

  it('refuses a model the per-1M bar admitted', () => {
    expect(proposeTiers(['cheapest', 'dear-per-task'], aa).simple).toEqual(['cheapest']);
  });

  it('measures the ceiling against the cheapest selected model, not an absolute', () => {
    // Same three models minus the cheap one: the ceiling moves with the
    // selection, so 0.4 now sets it and 5.0 is still outside.
    const t = proposeTiers(['dear-per-token', 'dear-per-task'], aa);
    expect(t.simple).toEqual(['dear-per-token']);
  });

  it('excludes every model AA has not costed per task', () => {
    // A per-token rate is not a proxy for task cost in the proposal, so an
    // uncosted model is absent from both tiers even when its token rate is low.
    const mixed: AaCatalog = {
      fetchedAt: '2026-09-01T00:00:00Z',
      models: {
        'costed': { codingIndex: 60, agenticIndex: 60, blendedPriceUsd: 0.2, costPerTask: 0.05 },
        'uncosted-cheap': { codingIndex: 58, agenticIndex: 58, blendedPriceUsd: 0.5 },
        'uncosted-dear': { codingIndex: 59, agenticIndex: 59, blendedPriceUsd: 4.0 },
      },
    };
    const t = proposeTiers(['costed', 'uncosted-cheap', 'uncosted-dear'], mixed);
    expect(t.simple).toEqual(['costed']);
    expect(t.complex).toEqual(['costed']);
  });

  it('does not propose models when the catalog has no task costs', () => {
    // There is no valid ranking scale when AA supplies no task costs.
    const none: AaCatalog = {
      fetchedAt: '2026-09-01T00:00:00Z',
      models: {
        'a': { codingIndex: 60, agenticIndex: 60, blendedPriceUsd: 0.3 },
        'b': { codingIndex: 58, agenticIndex: 58, blendedPriceUsd: 3.0 },
      },
    };
    expect(proposeTiers(['a', 'b'], none).simple).toEqual([]);
    expect(proposeTiers(['a', 'b'], none).complex).toEqual([]);
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
    expect(lookupModel('openrouter-z-ai-glm-5.2', aa).source).toBe('aa');
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
    // No level parenthetical on AA's row: scored with no reasoning in play,
    // so it is a family of one at `none`.
    'deepseek-v4-flash': { codingIndex: 65, blendedPriceUsd: 0.66, agenticIndex: 41.7, costPerTask: 0.22, family: 'deepseek-v4-flash', effort: 'none' },
    // A family of one: AA scored it at one level and *named* it. Offered at
    // that level, since a bare key would run at the gateway's own.
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
  it('is undefined without a catalog, or for a model the catalog does not hold', () => {
    expect(catalogFamily('gpt-5.6-luna', undefined)).toBeUndefined();
    expect(catalogFamily('never-heard-of-it', FAMILY_AA)).toBeUndefined();
  });
  it('reads a row that states no level as a family of one at none', () => {
    // AA scored it with no parenthetical, so no reasoning level was in play.
    // Offered as `@none` rather than bare, so the dispatch states the level
    // the score was measured at instead of taking the gateway's default.
    const fam = catalogFamily('deepseek-v4-flash', FAMILY_AA)!;
    expect([...fam.variants.keys()]).toEqual(['none']);
    expect(expandCandidates(['deepseek-v4-flash'], FAMILY_AA)).toEqual(['deepseek-v4-flash@none']);
    expect(lookupModel('deepseek-v4-flash@none', FAMILY_AA).source).toBe('aa');
  });
  it('is a family of one for a row that states its level', () => {
    // AA's only DeepSeek V4.1 Flash row is "(Reasoning, Max Effort)": one
    // level, explicitly stated. That is a level to pin, not a level-less
    // model — a bare key would rank on that row and run at the gateway's own.
    const fam = catalogFamily('lonely', FAMILY_AA)!;
    expect([...fam.variants.keys()]).toEqual(['high']);
    expect(fam.default).toBe('high');
    expect(expandCandidates(['lonely'], FAMILY_AA)).toEqual(['lonely@high']);
    expect(lookupModel('lonely@high', FAMILY_AA).source).toBe('aa');
  });
  it('finds a family through the same spellings a score is found through', () => {
    // An OpenRouter-flattened ref still reaches its family.
    expect(catalogFamily('openai-gpt-5.6-luna', FAMILY_AA)?.name).toBe('gpt-5-6-luna');
  });
  it('guards against a shortened-spelling family collision', () => {
    // The exact spelling is its own (single-row) family; the shortened one
    // names a different model with more levels. The exact spelling wins, so
    // `@max` — a level only the other model has — is unscored.
    expect(catalogFamily('vendor-gpt-5.6-luna', FAMILY_COLLISION_AA)?.name).toBe('vendor-gpt-5.6-luna');
    expect(lookupModel('vendor-gpt-5.6-luna@max', FAMILY_COLLISION_AA).source).not.toBe('aa');
  });
});

describe('expandCandidates', () => {
  it('expands a key with variants into one candidate per level, weakest first', () => {
    expect(expandCandidates(['gpt-5.6-luna', 'deepseek-v4-flash'], FAMILY_AA)).toEqual([
      'gpt-5.6-luna@low', 'gpt-5.6-luna@high', 'gpt-5.6-luna@xhigh', 'gpt-5.6-luna@max',
      // Its AA row states no level, which is itself a level: `none`.
      'deepseek-v4-flash@none',
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
    // A family of one still replaces the bare key, so it counts.
    expect(hasEffortVariants('deepseek-v4-flash', FAMILY_AA)).toBe(true);
    expect(hasEffortVariants('never-heard-of-it', FAMILY_AA)).toBe(false);
  });
});

describe('unpinnedVariants', () => {
  it('expands every bare saved key the catalog can pin, and leaves pinned ones alone', () => {
    // A family of one counts: `deepseek-v4-flash` becomes `@none`, and the
    // bare key it replaces is exactly what is being repaired — dropping it
    // deleted the model from the tier instead.
    expect(unpinnedVariants(['gpt-5.6-luna', 'deepseek-v4-flash', 'gpt-5.6-terra@high', 'never-heard-of-it'], FAMILY_AA)).toEqual([
      'gpt-5.6-luna@low', 'gpt-5.6-luna@high', 'gpt-5.6-luna@xhigh', 'gpt-5.6-luna@max',
      'deepseek-v4-flash@none',
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
    // `flash` is refused too: its row states no level, so it is a family of
    // one at `none` and a bare key would run at the gateway's default.
    expect(found.map((u) => [u.role, u.tier, u.key])).toEqual([
      ['code', 'simple', 'luna'], ['code', 'simple', 'flash'], ['code', 'complex', 'flash'],
    ]);
    expect(found[0].family.default).toBe('max');
    expect(() => assertEffortsPinned(config, FAMILY_AA)).toThrow(
      /tiers\.code\.simple "luna".*levels low, high, xhigh, max.*default is max.*"luna@max".*sonata init/s,
    );
  });

  it('refuses a bare candidate in `normal` too', () => {
    // `normal` was added after this refusal and the loop was never widened,
    // so a bare key there alone slipped through the very check that stops a
    // candidate ranking on one row's score and then running at whatever the
    // gateway defaults to. Same "two eras in one config" shape as the
    // inverted tier split.
    const config = parseConfig(PINNABLE
      .replace('simple = ["luna", "flash"]', 'simple = ["luna@high", "flash@none"]')
      .replace('complex = ["luna@max", "flash"]', 'complex = ["luna@max", "flash@none"]')
      .replace('complex = ["luna@max"', 'normal = ["luna"]\ncomplex = ["luna@max"'));
    expect(unpinnedCandidates(config, FAMILY_AA).map((u) => [u.tier, u.key]))
      .toEqual([['normal', 'luna']]);
    expect(() => assertEffortsPinned(config, FAMILY_AA)).toThrow(/tiers\.code\.normal "luna"/);
  });

  it('is silent with no catalog, and for a fully pinned config', () => {
    const config = parseConfig(PINNABLE);
    expect(() => assertEffortsPinned(config, undefined)).not.toThrow();
    const pinned = parseConfig(PINNABLE
      .replace('simple = ["luna", "flash"]', 'simple = ["luna@high", "flash@none"]')
      .replace('complex = ["luna@max", "flash"]', 'complex = ["luna@max", "flash@none"]'));
    expect(() => assertEffortsPinned(pinned, FAMILY_AA)).not.toThrow();
  });

  it('resolves the upstream id through the gateway name, not the config key', () => {
    // `[models."codex-gpt-5.6-luna"]` with id `gpt-5.6-luna` is the same model.
    const config = parseConfig(PINNABLE.replace(/"luna"/g, '"codex-gpt-5.6-luna"').replace(/"luna@max"/, '"codex-gpt-5.6-luna@max"'));
    expect(unpinnedCandidates(config, FAMILY_AA).map((u) => u.key))
      .toEqual(['codex-gpt-5.6-luna', 'flash', 'flash']);
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
    expect(refused.map((u) => [u.role, u.tier, u.key])).toEqual([
      ['code', 'simple', 'luna'], ['code', 'simple', 'flash'], ['code', 'complex', 'flash'],
    ]);

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
      // `normal` is optional, so the tier may legitimately be absent; the
      // assertion is about a tier that exists holding a pinned key.
      const list = emitted[role]![tier];
      expect(list).toBeDefined();
      expect(pinned(list!, key)).toBe(true);
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
        'deepseek-v4-1-flash': { codingIndex: 60, blendedPriceUsd: 0.5, costPerTask: 0.2, family: 'deepseek-v4-1-flash', effort: 'max' },
        'deepseek-v4-1-flash-high': { codingIndex: 55, blendedPriceUsd: 0.5, costPerTask: 0.1, family: 'deepseek-v4-1-flash', effort: 'high' },
        'deepseek-v4-pro': { codingIndex: 59, blendedPriceUsd: 0.54, costPerTask: 0.2, family: 'deepseek-v4-pro', effort: 'max' },
        'deepseek-v4-pro-high': { codingIndex: 58, blendedPriceUsd: 0.54, costPerTask: 0.1, family: 'deepseek-v4-pro', effort: 'high' },
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
    expect(lookupModel('gpt-5.6-luna@low', FAMILY_AA)).toEqual({ capable: true, source: 'aa' });
    // 44 >= 40 keeps it capable; the bare row is the max row.
    expect(lookupModel('gpt-5.6-luna', FAMILY_AA).source).toBe('aa');
  });
  it('treats a level the family does not score as unscored', () => {
    // `lonely` is scored at `high` only; `@low` is not a level AA compared,
    // and it is not in the curated table, so it falls through to the default.
    expect(lookupModel('lonely@low', FAMILY_AA).source).toBe('default');
  });
});

describe('candidateLabel', () => {
  it('shows the level, the capability and the per-task cost', () => {
    expect(candidateLabel('gpt-5.6-luna@xhigh', FAMILY_AA)).toMatch(/^gpt-5\.6-luna @xhigh\s+39\.5\s+\$0\.085\/task$/);
    expect(candidateLabel('deepseek-v4-flash@none', FAMILY_AA)).toMatch(/^deepseek-v4-flash @none\s+41\.7\s+\$0\.220\/task$/);
  });
  it('aligns the numbers across rows', () => {
    const a = candidateLabel('gpt-5.6-luna@xhigh', FAMILY_AA);
    const b = candidateLabel('deepseek-v4-flash@none', FAMILY_AA);
    expect(a.indexOf('39.5')).toBe(b.indexOf('41.7'));
  });
  it('falls back to the per-1M rate, and to the bare key with no catalog', () => {
    expect(candidateLabel('lonely@high', FAMILY_AA)).toContain('AA publishes no cost-per-task');
    expect(candidateLabel('gpt-5.6-luna@max', undefined)).toBe('gpt-5.6-luna @max');
  });
});


describe('proposeTiers — the wasteful-tail gate', () => {
  // One ladder whose top rungs cost far more than they add, modelled on the
  // real gpt-6-astra numbers that prompted the band.
  const LADDER: AaCatalog = {
    fetchedAt: '2026-09-21T00:00:00Z',
    models: {
      'astra': { codingIndex: 77, blendedPriceUsd: 3, intelligenceIndex: 52.7, costPerTask: 3.2575, family: 'astra', effort: 'max' },
      'astra-xhigh': { codingIndex: 76, blendedPriceUsd: 3, intelligenceIndex: 52.4, costPerTask: 2.3088, family: 'astra', effort: 'xhigh' },
      'astra-low': { codingIndex: 75, blendedPriceUsd: 3, intelligenceIndex: 45.8, costPerTask: 0.8175, family: 'astra', effort: 'low' },
    },
  };

  it('demotes the rung that buys almost nothing, and keeps it as a fallback', () => {
    // This is the real astra ladder. `@max` buys +0.3 index points over
    // `@xhigh` for 41% more money — 2.0 points per cost decade — so the gate
    // demotes it. `complex` then leads with the strongest rung that actually
    // pays for itself.
    //
    // Demoted, never dropped: the tier keeps it as a last-resort candidate,
    // exactly as `avoid_gateways` demotes, so declining to pay for it costs
    // preference rather than fallback depth.
    const tiers = proposeTiers(['astra'], LADDER);
    expect(tiers.complex[0]).toBe('astra@xhigh');
    expect(tiers.complex[tiers.complex.length - 1]).toBe('astra@max');
    expect(tiers.complex).toEqual(expect.arrayContaining(['astra@max', 'astra@low']));
  });

  it('keeps a top rung that earns its price', () => {
    // The gate is about marginal return, not about being expensive. Give
    // `@max` a real edge over `@xhigh` for the same money and it leads again.
    const earns: AaCatalog = {
      fetchedAt: LADDER.fetchedAt,
      models: { ...LADDER.models, astra: { ...LADDER.models['astra']!, intelligenceIndex: 62.0 } },
    };
    expect(proposeTiers(['astra'], earns).complex[0]).toBe('astra@max');
  });

  it('never prefers a cheaper, genuinely weaker MODEL', () => {
    // The band is a per-ladder claim. Two singleton families 5 apart are not
    // rungs of one ladder, so capability still wins outright however cheap
    // the weaker one is — the cross-model guarantee `complex` rests on.
    const twoModels: AaCatalog = {
      fetchedAt: LADDER.fetchedAt,
      models: {
        'strong': { codingIndex: 70, blendedPriceUsd: 3, intelligenceIndex: 52, costPerTask: 3.0, family: 'strong', effort: 'max' },
        'weak': { codingIndex: 60, blendedPriceUsd: 0.1, intelligenceIndex: 47, costPerTask: 0.01, family: 'weak', effort: 'max' },
      },
    };
    expect(proposeTiers(['strong', 'weak'], twoModels).complex[0]).toBe('strong@max');
  });

  it('lets real capability break an equal price', () => {
    // The band trades capability for money; with no money to save it has
    // nothing to trade, so suppressing the difference would pick the worse
    // rung for nothing.
    const samePrice: AaCatalog = {
      fetchedAt: LADDER.fetchedAt,
      models: {
        'm': { codingIndex: 70, blendedPriceUsd: 1, intelligenceIndex: 50, costPerTask: 0.5, family: 'm', effort: 'high' },
        'm-low': { codingIndex: 72, blendedPriceUsd: 1, intelligenceIndex: 52, costPerTask: 0.5, family: 'm', effort: 'low' },
      },
    };
    expect(proposeTiers(['m'], samePrice).complex[0]).toBe('m@low');
  });

  it('orders identically for every permutation of CHAINED near-ties', () => {
    // The cycle a pairwise tolerance allows, and the one the earlier
    // permutation test could not catch because its fixture did not chain.
    // 52.1 ~ 51.5 and 51.5 ~ 51.0 are both inside the 1.0 margin, but
    // 52.1 - 51.0 = 1.1 is outside it, so capability ranks that pair
    // outright. Prices running the other way then close the loop:
    //   B > A on price, C > B on price, A > C on capability.
    // Measured before `capabilityClass`: six permutations produced THREE
    // different orderings of the same three candidates, so the tier a user
    // got depended on the order their models happened to be declared in.
    const chained: AaCatalog = {
      fetchedAt: '2026-09-21T00:00:00Z',
      models: {
        A: { codingIndex: 70, blendedPriceUsd: 1, intelligenceIndex: 52.1, costPerTask: 3.0, family: 'A', effort: 'max' },
        B: { codingIndex: 70, blendedPriceUsd: 1, intelligenceIndex: 51.5, costPerTask: 2.0, family: 'B', effort: 'max' },
        C: { codingIndex: 70, blendedPriceUsd: 1, intelligenceIndex: 51.0, costPerTask: 1.0, family: 'C', effort: 'max' },
      },
    };
    const permutations = [
      ['A', 'B', 'C'], ['A', 'C', 'B'], ['B', 'A', 'C'],
      ['B', 'C', 'A'], ['C', 'A', 'B'], ['C', 'B', 'A'],
    ];
    const orders = new Set(permutations.map((p) => proposeTiers(p, chained).complex.join(' > ')));
    expect([...orders]).toHaveLength(1);
    // And the same holds for the value tiers, which share the margin.
    expect(new Set(permutations.map((p) => proposeTiers(p, chained).normal.join(' > ')))).toHaveProperty('size', 1);
  });

  it('compares capability by class, so the tolerance cannot cycle', () => {
    // The property directly: equality of an integer class is transitive,
    // where "within 1.0 of each other" is not.
    expect(capabilityClass(52.1)).toBe(capabilityClass(51.5));
    expect(capabilityClass(51.5)).not.toBe(capabilityClass(51.0));
    // The accepted cost of bucketing: a pair closer than the margin can still
    // land either side of a class edge, and is then ranked by capability.
    // That is the safe direction — it never makes the order input-dependent.
    expect(capabilityClass(51.4)).not.toBe(capabilityClass(51.6));
  });

  it('orders identically however the input is shuffled', () => {
    // The band's first implementation compared "same family, both in band?"
    // inside the comparator, which is NOT transitive: it produced a real
    // 3-cycle (deepseek > luna@xhigh > luna@max > deepseek), and a cyclic
    // comparator makes the result depend on input order — so the tier
    // silently differed run to run. Crediting the band as a scalar per
    // candidate is what removes that, and this is the property that proves it.
    const keys = ['gpt-5.6-luna', 'gpt-5.6-terra', 'deepseek-v4-flash'];
    const expected = proposeTiers(keys, FAMILY_AA).complex;
    for (const order of [[...keys].reverse(), [keys[1], keys[2], keys[0]], [keys[2], keys[0], keys[1]]]) {
      expect(proposeTiers(order, FAMILY_AA).complex).toEqual(expected);
    }
  });
});

describe('proposeTiers — effort variants', () => {
  it('ranks variants as candidates: complex by capability, normal and simple by value', () => {
    const tiers = proposeTiers(['gpt-5.6-luna', 'gpt-5.6-terra', 'deepseek-v4-flash'], FAMILY_AA);
    // The frontier decides this now, and it is worth following through.
    //
    // Frontier by ascending cost: luna@low (17.9, $0.0098), luna@high (35.6,
    // $0.044), luna@xhigh (39.5, $0.085), luna@max (42.7, $0.178), then
    // terra@max (43.7, $1.399). `deepseek@none` (41.7, $0.22) and terra@high
    // (37.6, $0.338) are both dominated by luna@max — more capable, cheaper —
    // so neither is on it.
    //
    // Slopes: 27.1, 13.6, 10.0, then **1.1** for the step to terra@max, which
    // buys +1.0 agentic for 7.9x the money. Against a median of 13.6 the bar
    // is 4.5, so terra@max is gated and demoted to the tail.
    //
    // `complex` then ranks the rest by capability: luna@max 42.7,
    // deepseek@none 41.7, luna@xhigh 39.5.
    expect(tiers.complex.slice(0, 3))
      .toEqual(['gpt-5.6-luna@max', 'deepseek-v4-flash@none', 'gpt-5.6-luna@xhigh']);
    // Gated, not dropped: still available once everything better has failed.
    expect(tiers.complex).toContain('gpt-5.6-terra@max');
    // `normal` leads with the knee of the AGENTIC frontier — the metric the
    // value tiers rank by — which is `luna@xhigh`: normalised, it sits 0.402
    // above the chord, against 0.383 for `@high` and 0.377 for `@max`.
    //
    // `simple` still leads with the cheapest, so the two tiers have different
    // heads. That difference is the point: when both led with the cheapest
    // model they were the same tier wearing two names.
    expect(tiers.normal[0]).toBe('gpt-5.6-luna@xhigh');
    // Behind the promoted knee, value order resumes.
    expect(tiers.normal[1]).toBe('gpt-5.6-luna@low');
    expect(tiers.simple).toEqual([
      'gpt-5.6-luna@low', 'gpt-5.6-luna@high', 'gpt-5.6-luna@xhigh',
    ]);
  });

  it('demotes every variant of an avoided model, by bare key', () => {
    const tiers = proposeTiers(['gpt-5.6-luna', 'deepseek-v4-flash'], FAMILY_AA, [], new Set(['gpt-5.6-luna']));
    expect(tiers.complex[0]).toBe('deepseek-v4-flash@none');
    expect(tiers.simple[0]).toBe('deepseek-v4-flash@none');
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
      normal: ['cheap-and-good', 'top-and-dear'],
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
      'deepseek-v4-1-flash': { codingIndex: 55, blendedPriceUsd: 0.4, costPerTask: 0.2, family: 'deepseek-v4-1-flash', effort: 'max' },
      'deepseek-flash-x': { codingIndex: 10, blendedPriceUsd: 9.0 },
    },
  };
  const spellings = (key: string) => key === 'deepseek-deepseek-flash' ? ['deepseek-flash', 'deepseek-v4.1-flash'] : key;

  it('scores an alias through its later spelling when the first misses', () => {
    expect(lookupModel('deepseek-deepseek-flash', aa, ['deepseek'], spellings)).toMatchObject({ source: 'aa' });
    expect(candidateLabel('deepseek-deepseek-flash', aa, ['deepseek'], spellings)).toContain('55.0');
  });

  it('lets the first spelling win when it scores', () => {
    const direct: AaCatalog = {
      fetchedAt: '2026-09-01T00:00:00Z',
      models: { ...aa.models, 'deepseek-flash': { codingIndex: 20, blendedPriceUsd: 9.0 } },
    };
    expect(lookupModel('deepseek-deepseek-flash', direct, ['deepseek'], spellings).source).toBe('aa');
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
      'gemini-3-7-flash': { codingIndex: 72, blendedPriceUsd: 1.5, agenticIndex: 72, costPerTask: 0.5, family: 'gemini-3-7-flash', effort: 'high' },
      'gemini-3-7-flash-medium': { codingIndex: 71.5, blendedPriceUsd: 1.5, agenticIndex: 71.5, costPerTask: 0.5, family: 'gemini-3-7-flash', effort: 'medium' },
      'gemini-3-7-flash-low': { codingIndex: 71, blendedPriceUsd: 1.5, agenticIndex: 71, costPerTask: 0.5, family: 'gemini-3-7-flash', effort: 'low' },
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
        'gemini-3-7-flash-low': { codingIndex: 71.8, blendedPriceUsd: 1.5, agenticIndex: 71.8, costPerTask: 0.5, family: 'gemini-3-7-flash', effort: 'low' },
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
        'gemini-3-7-flash-low': { codingIndex: 74, blendedPriceUsd: 1.5, agenticIndex: 74, costPerTask: 0.5, family: 'gemini-3-7-flash', effort: 'low' },
      },
    };
    expect(proposeTiers(['gemini-3.7-flash'], edged).complex[0]).toBe('gemini-3.7-flash@low');
    // A 1.0 gap at a fifth of the price now goes to the MORE CAPABLE rung,
    // where the deleted cost band made it a tie and let price decide.
    //
    // This is the band's removal showing its cost honestly. 71 against 72 is
    // exactly `AA_CAPABILITY_TIE_MARGIN`, so `capabilityClass` separates them
    // and `complex` — the strong end — takes the edge. The wasteful-tail gate
    // cannot reach it either: with only two points on the frontier the bar is
    // a fraction of a median computed from that single slope, so it can never
    // exceed it, and there is no shape to tell "a bad deal" from "the only
    // deal available". Gaps genuinely inside the margin are still resolved by
    // price, which is the case above.
    const cheaper: AaCatalog = {
      fetchedAt: aa.fetchedAt,
      models: {
        ...aa.models,
        'gemini-3-7-flash-low': { codingIndex: 71, blendedPriceUsd: 0.5, agenticIndex: 71, costPerTask: 0.1, family: 'gemini-3-7-flash', effort: 'low' },
      },
    };
    expect(proposeTiers(['gemini-3.7-flash'], cheaper).complex[0]).toBe('gemini-3.7-flash@high');
    // Inside the margin, price still decides.
    const noise: AaCatalog = {
      fetchedAt: aa.fetchedAt,
      models: {
        ...aa.models,
        'gemini-3-7-flash-low': { codingIndex: 71.8, blendedPriceUsd: 0.5, agenticIndex: 71.8, costPerTask: 0.1, family: 'gemini-3-7-flash', effort: 'low' },
      },
    };
    expect(proposeTiers(['gemini-3.7-flash'], noise).complex[0]).toBe('gemini-3.7-flash@low');
  });
});

describe('proposeTiers — value is measured per task, never across units', () => {
  // Admission already compares per-task costs only, but the simple tier's
  // *sort* divided capability by whichever number a row had: `costPerTask`
  // in dollars per unit of work, or the per-1M blend in dollars per token.
  // Measured: `deepseek-v4-flash@none` (18.9 at $0.12/1M) out-valued
  // `deepseek-flash@max` (39.5 at $0.265/task) — a unit error, not a ranking.
  const aa: AaCatalog = {
    fetchedAt: '2026-09-13T00:00:00Z',
    models: {
      'deepseek-v4-1-flash': { codingIndex: 55, blendedPriceUsd: 0.5, agenticIndex: 39.5, costPerTask: 0.265, family: 'deepseek-v4-1-flash', effort: 'max' },
      'deepseek-v4-flash-non-reasoning': { codingIndex: 45, blendedPriceUsd: 0.12, agenticIndex: 38.9, family: 'deepseek-v4-flash', effort: 'none' },
      'deepseek-v4-flash': { codingIndex: 60, blendedPriceUsd: 0.66, agenticIndex: 41.7, costPerTask: 0.22, family: 'deepseek-v4-flash', effort: 'max' },
    },
  };

  it('ranks every per-task-costed row ahead of every uncosted one in the simple tier', () => {
    expect(proposeTiers(['deepseek-v4.1-flash', 'deepseek-v4-flash'], aa).simple)
      .toEqual(['deepseek-v4-flash@max', 'deepseek-v4.1-flash@max']);
  });

  it('does not rank an all-uncosted set', () => {
    const uncosted: AaCatalog = {
      fetchedAt: aa.fetchedAt,
      models: {
        'a': { codingIndex: 50, blendedPriceUsd: 0.5, agenticIndex: 50 },
        'b': { codingIndex: 52, blendedPriceUsd: 0.9, agenticIndex: 52 },
      },
    };
    expect(proposeTiers(['a', 'b'], uncosted).simple).toEqual([]);
    expect(proposeTiers(['a', 'b'], uncosted).complex).toEqual([]);
  });

  it('excludes an uncosted row rather than comparing its token rate', () => {
    // The uncosted row's $0.12/1M is not comparable to $0.22/task.
    const tied: AaCatalog = {
      fetchedAt: aa.fetchedAt,
      models: {
        'x': { codingIndex: 60, blendedPriceUsd: 0.66, agenticIndex: 41.7, costPerTask: 0.22 },
        'y': { codingIndex: 60, blendedPriceUsd: 0.12, agenticIndex: 41.5 },
      },
    };
    expect(proposeTiers(['x', 'y'], tied).complex).toEqual(['x']);
  });
});
