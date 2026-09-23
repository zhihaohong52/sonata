/**
 * Which models are worth which work.
 *
 * Two data sources feed tier assignment: a small curated table (our own
 * judgement, shipped with sonata) and an optional Artificial Analysis cache
 * the *user* fetched with their own key (`sonata catalog update`). AA's free
 * tier licenses internal use only — no redistribution — so nothing derived
 * from AA data may ever be committed to this repository. The curated table is
 * deliberately hand-written from experience, not from AA numbers.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EFFORT_LEVELS, isEffort, joinCandidate, splitCandidate, type Effort } from './effort.js';
import type { SonataConfig } from './config.js';
import { frontierIndices, keptAfterGate, kneeIndex, type Point } from './frontier.js';

export const AA_ATTRIBUTION =
  'Model rankings by Artificial Analysis — https://artificialanalysis.ai';

/**
 * The capability an unscored model is ranked as: a mid-table stand-in, so a
 * model the catalog does not know sorts among known ones rather than first or
 * last.
 *
 * This used to be `AA_CAPABLE_CODING_INDEX`, a threshold that excluded any
 * catalog-scored model with a coding index below 40 from every tier. It was
 * removed: it gated on a score no tier ranks by, it excluded rather than
 * demoted, it could not judge a new model (no coding index yet), and when
 * every candidate failed it the fallback ranked them all anyway. Measured on
 * the real catalog, the best of the 27 models it caught had under a third of
 * the value of the model leading `simple`, so the frontier already sinks them.
 */
export const UNSCORED_PLACEHOLDER_INDEX = 40;

/**
 * A model may cost at most this multiple of the cheapest *selected* model's
 * per-task cost and still be eligible for a simple tier.
 *
 * Relative and per-task, for two separate reasons.
 *
 * **Per-task**, because that is what the tier is already ordered by. Admission
 * used to test `blendedPriceUsd <= AA_CHEAP_BLENDED_PRICE_USD` — dollars per
 * million *tokens* — while `valueOf` ranked what got in by
 * capability-per-task-dollar. So the gate and the ranking priced different
 * things, and the gate priced the one AA's own docs call the weaker proxy: a
 * per-1M rate says nothing about how many tokens a model burns reaching an
 * answer. Measured on a real 24-model config, `gemini-3.8-flash` was refused
 * at $1.50/1M while costing $0.577/task — less per unit of work than five
 * models that got in, and a sixth of the way to the $1/1M bar it failed.
 *
 * **Relative**, because an absolute bar
 * is wrong in both directions. A user whose whole selection is expensive gets
 * an empty simple tier and falls back to mirroring complex, which stops the
 * tier discriminating at all; one whose selection is uniformly cheap gets
 * everything admitted and no cost tier worth the name.
 *
 * Set where it is for depth. On that same config the cheapest selected model
 * is $0.0487/task, so 12x admits six models — a real fallback chain — where
 * the old absolute bar admitted three distinct ones and 4x would admit three.
 */
export const SIMPLE_COST_CEILING = 12;

/**
 * A capability gap this small or smaller is noise, not a real edge — so the
 * complex tier breaks it on price the same way it breaks an exact tie.
 *
 * Measured case: `qwen3.8-max` (agentic index 58.4, $0.91/task) outranked
 * `glm-5.3-flash` (58.2, $0.087/task) on a 0.2-point, 0.34% capability lead —
 * over 10x the cost for a difference indistinguishable from benchmark noise.
 * `glm-5.3-flash` is itself Pareto-undominated across the whole AA catalog
 * (nothing beats it on both capability and cost); `qwen3.8-max` is not — a
 * cheaper, *more* capable model exists (`glm-5.3`, 59.1 @ $0.68/task). That
 * second case needed no fix: plain capability-descending order already put
 * the higher-scoring, cheaper model first regardless of this margin. This
 * constant exists only for the gap a raw capability sort can't resolve on its
 * own — two models close enough that ranking them by score alone is noise,
 * not signal, and cost should call it instead.
 */
export const AA_CAPABILITY_TIE_MARGIN = 1.0;

/**
 * The capability *class* a score falls in — the margin applied transitively.
 *
 * "Within the margin" cannot be asked pairwise. Tolerance is not transitive:
 * with scores 52.1, 51.5 and 51.0 the first two are a tie and so are the last
 * two, but 52.1 and 51.0 are 1.1 apart and rank outright. Add prices running
 * the other way (3.0, 2.0, 1.0) and the comparator cycles — B beats A on
 * price, C beats B on price, A beats C on capability. Measured on exactly
 * that fixture: six input permutations produced THREE different orderings of
 * the same three candidates, so the tier a user got depended on the order
 * their models happened to be declared in.
 *
 * Quantising first makes the comparison an integer equality, which cannot
 * cycle. The cost is a boundary: two scores either side of a class edge are
 * separated even when closer together than the margin. That is the standard
 * trade for bucketing, and it is the safe direction — it can only ever rank
 * by capability where the old code ranked by price, never produce an order
 * that depends on input.
 */
export function capabilityClass(index: number): number {
  return Math.round(index / AA_CAPABILITY_TIE_MARGIN);
}

/*
 * `COMPLEX_COST_BAND` is deleted.
 *
 * It credited a rung with its family's best score so rungs within 7 points of
 * their ladder's top competed on price instead of capability. It was the
 * source of two defects in a day: the credit leaked across families, so
 * `sol@high` (really 42.3) was compared as 47.0 and beat `mimo` at 46.3
 * despite costing more, and on one real config it placed five strictly
 * dominated candidates above `mimo`. Expressed pairwise it was also not
 * transitive, producing a genuine 3-cycle that made the sort depend on input
 * order.
 *
 * The frontier replaces it and needs no machinery to enforce the property the
 * band kept breaking: a dominated candidate cannot outrank what dominates it,
 * because a dominator is both more capable and better value, so either sort
 * key already places it first. What the band was *invented* for — declining to
 * pay for the top of an effort ladder — is now `keptAfterGate`, which asks
 * whether the rung's marginal return justifies its marginal cost rather than
 * whether its score is close to its family's best.
 */

export interface CatalogEntry {
  capable: boolean;
  source: 'curated' | 'aa' | 'default';
}

export interface AaCatalog {
  fetchedAt: string;
  /**
   * The `intelligence_index_version` the scores in `models` were published
   * under, absent in a cache written before it was recorded.
   *
   * The fetch already refuses a response whose version changes mid-pagination,
   * because two scales are not comparable — but that guarantee held only
   * *within* one fetch while the number was discarded on write, so a cache
   * scored under v4.2 was indistinguishable from one scored under v4.3 and
   * nothing could ever notice the scale had moved underneath a ranking.
   */
  intelligenceIndexVersion?: string;
  models: Record<string, AaEntry>;
}

export interface AaEntry {
  /**
   * AA's coding index, when AA has published one. Absent for a model AA has
   * scored on intelligence only — which is every model in its first days.
   *
   * It used to be filled with whichever score the row DID have, so a new
   * model's intelligence score (20.9 for `gpt-6-luna@low`) sat in this field
   * and was judged against `AA_CAPABLE_CODING_INDEX`, a coding-scale
   * threshold on which intelligence runs roughly half as high. The model
   * failed it and was dropped from `simple` and `normal` entirely. Measured:
   * 26 of 152 costed rows carried a stand-in, the frontier's knee among them.
   */
  codingIndex?: number;
  blendedPriceUsd: number;
  /** All absent in a cache written before these were collected. */
  intelligenceIndex?: number;
  /**
   * How well the model does agentic work — tools, terminal, multi-step tasks.
   * The closest published proxy to what a sonata subagent actually does, so it
   * is preferred over the coding index where present.
   */
  agenticIndex?: number;
  /**
   * Dollars to run one Artificial Analysis Intelligence Index task.
   *
   * Preferred over `blendedPriceUsd` because it prices *the work*, not the
   * tokens: a per-1M rate says nothing about how many tokens a model spends
   * reaching an answer, and a verbose model can cost more per task than a
   * pricier-per-token terse one.
   */
  costPerTask?: number;
  /**
   * The model this row is one effort level of, and which level. Read from
   * the parenthetical in AA's display name at `catalog update` — `GPT-5.6
   * Luna (max)` is slug `gpt-5-6-luna`, `… (low)` is `gpt-5-6-luna-low` —
   * so the unsuffixed default row is a member of its family too, and the
   * family knows which level its default is. A row whose name carries no
   * level was scored with no reasoning in play, so it is recorded at `none`
   * and is its own family — every row a current `catalog update` writes
   * therefore carries both fields. They are absent only on a cache written
   * before this was recorded, which is the "cannot check" state `loadConfig`
   * skips on.
   */
  family?: string;
  effort?: Effort;
}

/**
 * Capability, best available measure first.
 *
 * Every sonata role — code, review, plan, explore — runs as an agentic
 * subagent driving tools in a loop, so the agentic index describes all four
 * better than a coding or reasoning score does. The fallbacks exist for models
 * AA has not scored agentically and for caches written before it was
 * collected, not as a per-role choice.
 */
export function capabilityOf(entry: AaEntry): number {
  return entry.agenticIndex ?? entry.codingIndex ?? entry.intelligenceIndex ?? 0;
}

/**
 * Capability as the `complex` tier measures it: reasoning first.
 *
 * `complex` is the one tier defined by judgement rather than throughput —
 * "needs a design decision affecting other components, or is ambiguous about
 * what done means" — and the agentic index does not describe that. It
 * describes driving tools in a loop, which every tier does equally.
 *
 * The two disagree materially rather than academically. Measured 2026-09-21
 * over one project's 22 complex candidates: on the agentic index
 * `glm-5.3-flash` (50.9), `gpt-5.6-sol@max` (50.2) and `gpt-6-astra@max`
 * (51.0) all sit inside `AA_CAPABILITY_TIE_MARGIN`, so the tie-break decided
 * the top of the tier — and the tie-break is *cost*, in the one tier
 * deliberately left cost-uncapped. The cheapest of the three led. On the
 * intelligence index the same three are 41.8 / 47.0 / 52.7, a 10.9 spread
 * the margin cannot swallow, so the ranking is decided by the measurement
 * rather than by the price.
 *
 * **Every tier ranks on this now, `simple` and `normal` included.** They used
 * `capabilityOf` (agentic first), on the reasoning that throughput is the
 * right numerator for a value tier. The coverage figure that justified it —
 * "agentic on 95%" — did not hold: AA publishes agentic scores days after
 * intelligence, so every new model arrives without one. Measured on one real
 * config: 22 of 36 candidates had an agentic score, all 36 an intelligence
 * one. `capabilityOf` then fell back per model, putting two scales on one
 * frontier axis, and the knee it found (`glm-5.3-flash`, agentic 50.9) was
 * not even on the frontier when measured on one scale — `mimo-v2.6-pro` beats
 * it on intelligence and on price. A metric only a subset of the candidates
 * carry cannot rank all of them.
 */
export function reasoningOf(entry: AaEntry): number {
  return entry.intelligenceIndex ?? entry.agenticIndex ?? entry.codingIndex ?? 0;
}

/**
 * The key an AA score is stored and looked up under.
 *
 * AA writes versions with dashes (`glm-5-3`) where sonata and models.dev
 * every gateway write dots (`glm-5.3`), so a name that is otherwise identical
 * never joins — measured on a real 17-model config, only 3 matched, and the
 * other 14 fell back to a constant rank that made the sort a no-op. Going
 * dots-to-dashes is the safe direction: dashes are load-bearing inside real
 * names (`deepseek-v4-flash`), so the reverse would be ambiguous. Verified
 * collision-free across both catalogs.
 */
export function aaMatchKey(name: string): string {
  return name.replace(/\./g, '-');
}

/**
 * Collapses the many spellings of one model to a single name: harness and
 * provider prefixes go (`opencode-acme-…`, `openai/…`), and a trailing MMDD
 * date suffix goes (`-0731`). Idempotent, so a normalized name can be
 * normalized again safely.
 *
 * `providers` names the gateways actually configured, and is how a provider
 * sonata has never heard of gets stripped. The built-in list below can only
 * cover providers someone thought to hardcode; every other user's gateway fell
 * through to the `default` catalog entry (capable, not cheap), quietly keeping
 * its models out of the simple tier. Pass the config's gateway names and that
 * stops being a guess.
 */
export function normalizeModelName(raw: string, providers: readonly string[] = []): string {
  let name = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw;
  // Sonata keys are exactly `<harness>-<provider>-<model>`, so only the first
  // two segments are ours to remove. A `while` loop re-matches its own output
  // and keeps eating past that structure, corrupting a model whose real name
  // happens to begin with a reserved word (`openai-…`, `pi-…`). So stripping
  // is two ordered passes — at most one harness prefix, then at most one
  // provider prefix — never a loop that can run again.
  const HARNESS_PREFIXES = ['opencode-', 'codex-', 'pi-', 'reasonix-', 'claude-harness-'];
  // Configured gateways first and longest-first, so `openai-codex-x` loses the
  // whole gateway name rather than the shorter `openai-` that also matches.
  const PROVIDER_PREFIXES = [
    ...providers.map((provider) => `${provider}-`),
    'openrouter-', 'openai-', 'google-', 'anthropic-',
  ].sort((a, b) => b.length - a.length);
  for (const prefix of HARNESS_PREFIXES) {
    if (name.startsWith(prefix) && name.length > prefix.length) {
      name = name.slice(prefix.length);
      break;
    }
  }
  for (const prefix of PROVIDER_PREFIXES) {
    if (name.startsWith(prefix) && name.length > prefix.length) {
      name = name.slice(prefix.length);
      break;
    }
  }
  // OpenRouter addresses a serving variant with a `:suffix` (`:free`,
  // `:nitro`, `:floor`) — a routing preference for the same weights, never a
  // different model, so it must not change the name a score is looked up
  // under. Unambiguous to strip: `:` appears in no model name AA publishes,
  // which is why this is done here rather than guessed at lookup time.
  // Measured: `openrouter-nvidia-nemotron-3-super-120b-a12b:free` matched
  // nothing while AA held that exact row minus the suffix.
  name = name.replace(/:[^:]+$/, '');
  return name.replace(/-\d{4}$/, '');
}

/**
 * The names a score may be stored under, best first.
 *
 * A sonata key flattens `vendor/model` to `vendor-model`, so OpenRouter's
 * namespaced refs (`z-ai/glm-5.2`) arrive as `z-ai-glm-5.2` with nothing left
 * to tell the vendor from the model — the slash `normalizeModelName` strips on
 * is long gone by then. AA publishes the bare model (`glm-5-2`), so the
 * namespaced form joins nothing and falls through to the capable-not-cheap
 * default.
 *
 * Dropping leading segments recovers it. Two properties keep the guess safe:
 * candidates are tried in order and the **full name always wins**, so this can
 * never move a model that already matches; and a shortened name is only
 * accepted on an *exact* catalog hit. The worst case is therefore a wrong
 * score where today there is no score at all — and "no score" is itself a
 * guess, not an abstention.
 *
 * Bounded at two drops (a vendor namespace is one segment, occasionally a
 * hyphenated one like `z-ai`) and stops before the remainder gets short enough
 * to collide by accident. A candidate must also still carry a digit: a model
 * name stripped to its bare form keeps its version (`glm-5.2`, `qwen3.8-max`),
 * while the tail of a long undotted name does not (`gemini-2.5-flash-lite`
 * would otherwise offer `flash-lite`, which is a family, not a model, and is
 * exactly the sort of thing another vendor might publish under).
 */
export function aaLookupNames(normalized: string): string[] {
  const names = [normalized];
  let rest = normalized;
  for (let drop = 0; drop < 2; drop++) {
    const dash = rest.indexOf('-');
    if (dash < 0) break;
    rest = rest.slice(dash + 1);
    // A one- or two-character tail is a fragment, not a model name.
    if (rest.length < 3 || !rest.includes('-')) break;
    if (!/\d/.test(rest)) continue;
    names.push(rest);
  }
  return names;
}

export interface CatalogFamily {
  /** The family's catalog name (the default row's key). */
  name: string;
  /** The level AA evaluated the unsuffixed row at — absent if every row is suffixed. */
  default?: Effort;
  /** Every scored level, in `EFFORT_LEVELS` order. */
  variants: Map<Effort, AaEntry>;
}

/**
 * Rows grouped by family, built once per catalog object. A `WeakMap` keyed on
 * the catalog rather than a field on it, so a cache loaded from disk and a
 * catalog literal in a test are indexed the same way and neither is mutated.
 */
const familyIndex = new WeakMap<AaCatalog, Map<string, CatalogFamily>>();

function familiesOf(aa: AaCatalog): Map<string, CatalogFamily> {
  let index = familyIndex.get(aa);
  if (index !== undefined) return index;
  index = new Map();
  for (const [key, entry] of Object.entries(aa.models)) {
    if (entry.family === undefined || entry.effort === undefined) continue;
    let fam = index.get(entry.family);
    if (fam === undefined) {
      fam = { name: entry.family, variants: new Map() };
      index.set(entry.family, fam);
    }
    fam.variants.set(entry.effort, entry);
    if (key === entry.family) fam.default = entry.effort;
  }
  // Order every family's variants weakest-first so callers can rely on it.
  for (const fam of index.values()) {
    const ordered = new Map<Effort, AaEntry>();
    for (const level of EFFORT_LEVELS) {
      const entry = fam.variants.get(level);
      if (entry !== undefined) ordered.set(level, entry);
    }
    fam.variants = ordered;
  }
  familyIndex.set(aa, index);
  return index;
}

/**
 * The effort family a normalized model name belongs to.
 *
 * A family of one is still a family: AA's only DeepSeek V4.1 Flash row is
 * "(Reasoning, Max Effort)", and that is a level to pin, not a level-less
 * model — offered bare, the key ranks on the max-effort score and runs at
 * whatever the gateway defaults to. A row stating no level is recorded at
 * `none` for the same reason, so it too is a singleton family and
 * `expandCandidates` emits `<key>@none`. Only a model the catalog does not
 * hold, or a cache written before families were recorded, has none — which
 * is the state `loadConfig` cannot check and skips on.
 *
 * Resolved through the same spellings `aaEntryFor` tries, so a name that finds
 * its score also finds its family.
 */
export function catalogFamily(normalized: string | readonly string[], aa?: AaCatalog): CatalogFamily | undefined {
  if (aa === undefined) return undefined;
  const families = familiesOf(aa);
  for (const offered of typeof normalized === 'string' ? [normalized] : normalized) {
    for (const name of aaLookupNames(offered)) {
      for (const spelling of [name, aaMatchKey(name)]) {
        const entry = aa.models[spelling];
        const fam = entry?.family !== undefined ? families.get(entry.family) : families.get(spelling);
        // The first spelling that identifies a model wins, even if it has no family.
        if (entry !== undefined || fam !== undefined) return fam;
      }
    }
  }
  return undefined;
}

export interface UnpinnedCandidate {
  role: string;
  tier: 'simple' | 'normal' | 'complex';
  /** The bare config key as written in the tier list. */
  key: string;
  family: CatalogFamily;
}

/** The resolver a config-reading caller gets when it supplies none: id, else harness id, else the key. */
function configIdUpstream(config: Pick<SonataConfig, 'unifiedModels'>): UpstreamFor {
  return (key) => {
    const model = config.unifiedModels[key];
    return model?.id ?? model?.harnessId ?? key;
  };
}

export function unpinnedCandidates(
  config: Pick<SonataConfig, 'tiers' | 'unifiedModels' | 'native'>,
  aa?: AaCatalog,
  upstreamFor: UpstreamFor = configIdUpstream(config),
): UnpinnedCandidate[] {
  if (aa === undefined || config.tiers === undefined) return [];
  const gateways = Object.keys(config.native?.gateways ?? {});
  const out: UnpinnedCandidate[] = [];
  for (const [role, lists] of Object.entries(config.tiers)) {
    // `normal` is included, and was missing: it was added after this refusal
    // and the loop was never widened, so a bare key in `normal` alone slipped
    // through the very check that exists to stop a candidate ranking on one
    // row's score and then running at the gateway's default. Guarded rather
    // than indexed, because `normal` is optional and absent is valid.
    for (const tier of ['simple', 'normal', 'complex'] as const) {
      for (const candidate of lists[tier] ?? []) {
        const { key, effort } = splitCandidate(candidate);
        if (effort !== undefined) continue;
        const family = catalogFamily(normalizedFor(key, gateways, upstreamFor), aa);
        if (family !== undefined) out.push({ role, tier, key, family });
      }
    }
  }
  return out;
}

export function assertEffortsPinned(
  config: Pick<SonataConfig, 'tiers' | 'unifiedModels' | 'native'>,
  aa?: AaCatalog,
  upstreamFor?: UpstreamFor,
): void {
  const unpinned = unpinnedCandidates(config, aa, upstreamFor);
  if (unpinned.length === 0) return;
  const lines = unpinned.map(({ role, tier, key, family }) => {
    const levels = [...family.variants.keys()].join(', ');
    const fallback = family.default ?? [...family.variants.keys()].at(-1)!;
    return `tiers.${role}.${tier} "${key}" names a model the catalog scores at levels ${levels}`
      + ` (its default is ${family.default ?? 'unstated'}) but pins none — it would be ranked at that default`
      + ` and run at the gateway's own. Write "${key}@${fallback}" (or another level).`;
  });
  throw new Error(`sonata.toml: ${lines.join('\n')}\nRun \`sonata init\` to re-rank every tier with effort levels.`);
}

/**
 * How a config *key* becomes the upstream *id* a catalog lookup needs.
 *
 * Tier lists hold config keys while the catalog is keyed by upstream id, and
 * a key is only *usually* `<gateway>-<id>`: a hand-named key
 * (`[models."luna"]` with `id = "gpt-5.6-luna"`) has no prefix to strip, so
 * normalizing the key itself finds nothing. Every candidate-facing helper
 * takes one, defaulting to identity — which is what leaves a catalog-less run
 * and a caller that supplies no resolver behaving exactly as before.
 */
export type UpstreamFor = (key: string) => string | readonly string[];

const identityUpstream: UpstreamFor = (key) => key;

/**
 * A key as the names the catalog is asked about, in order.
 *
 * Usually one: the upstream id. A resolver may offer more — a vendor's
 * versionless alias (`deepseek-flash`) can never be shortened into AA's
 * versioned key, but the display name models.dev gives that slug can be
 * (`DeepSeek V4.1 Flash` → `deepseek-v4.1-flash`). Order is precedence: the
 * first spelling that scores wins, so a later one can only add a score where
 * there was none, never move a model that already matches.
 */
export function normalizedFor(key: string, providers: readonly string[], upstreamFor: UpstreamFor): string[] {
  const upstream = upstreamFor(key);
  const spellings = typeof upstream === 'string' ? [upstream] : upstream;
  // Each spelling is offered stripped of the configured gateway names, then
  // as-is. A *key* needs the strip (`deepseek-deepseek-v4-pro`); an *id* the
  // resolver has already freed of its gateway carries none — and a vendor's
  // model names begin with the vendor, so a gateway called `deepseek` made
  // the strip eat `deepseek-` off `deepseek-v4-pro` and ask AA about
  // `v4-pro`. Stripped first keeps every lookup that was right unchanged; the
  // unstripped form only ever adds a hit where the strip left none.
  return [...new Set(spellings.flatMap((name) => [
    normalizeModelName(name, providers),
    normalizeModelName(name),
  ]))];
}

/**
 * The AA row for a normalized name, trying each spelling it may be filed
 * under. With an effort, the family's row at that level — and nothing else:
 * a level on a model the catalog does not score by level is unscored, never
 * silently the bare row. */
function aaEntryFor(normalized: string | readonly string[], aa?: AaCatalog, effort?: Effort): AaEntry | undefined {
  if (aa === undefined) return undefined;
  if (effort !== undefined) return catalogFamily(normalized, aa)?.variants.get(effort);
  for (const spelling of typeof normalized === 'string' ? [normalized] : normalized) {
    for (const name of aaLookupNames(spelling)) {
      const hit = aa.models[name] ?? aa.models[aaMatchKey(name)];
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

/** Our own judgement, not AA data. Kept deliberately small: the default for
 * anything unlisted is capable-not-cheap, the direction that never silently
 * hands hard work to a weak model. */
const CURATED: Record<string, { capable: boolean }> = {
  'deepseek-v4-flash': { capable: true },
  'deepseek-v4-pro': { capable: true },
  'gpt-5.6-luna': { capable: true },
  'gpt-5.6-terra': { capable: true },
  'gpt-5.6-sol': { capable: true },
  'kimi-k3': { capable: true },
  'kimi-k3-free': { capable: false },
  'glm-5.3': { capable: true },
  'grok-4.6': { capable: true },
  'gemini-3.7-flash': { capable: true },
  'qwen3.8-max': { capable: true },
  'ox-alpha-free': { capable: false },
};

export function lookupModel(
  name: string,
  aa?: AaCatalog,
  providers: readonly string[] = [],
  upstreamFor: UpstreamFor = identityUpstream,
): CatalogEntry {
  const { key, effort } = splitCandidate(name);
  const normalized = normalizedFor(key, providers, upstreamFor);
  const scored = aaEntryFor(normalized, aa, effort);
  if (scored !== undefined) {
    return {
      // Always eligible. A scored model's place is decided by the frontier and
      // the tier's sort, which demote a weak model to the end of the list
      // rather than removing it — see `UNSCORED_PLACEHOLDER_INDEX` for the
      // threshold this replaced and why.
      capable: true,
      source: 'aa',
    };
  }
  // A curated judgement is about the model, whichever level it runs at.
  const curated = normalized.map((spelling) => CURATED[spelling]).find((entry) => entry !== undefined);
  if (curated !== undefined) return { ...curated, source: 'curated' };
  return { capable: true, source: 'default' };
}

export interface TierProposal { simple: string[]; normal: string[]; complex: string[] }

/** The AA row behind a candidate (`key` or `key@effort`), joined through the match key. */
function scoreFor(
  candidate: string,
  aa?: AaCatalog,
  providers: readonly string[] = [],
  upstreamFor: UpstreamFor = identityUpstream,
): AaEntry | undefined {
  const { key, effort } = splitCandidate(candidate);
  return aaEntryFor(normalizedFor(key, providers, upstreamFor), aa, effort);
}

/** Whether AA supplies the per-task cost required for init ranking. */
export function hasTaskCost(
  candidate: string,
  aa?: AaCatalog,
  providers: readonly string[] = [],
  upstreamFor: UpstreamFor = identityUpstream,
): boolean {
  // Without a cache there is no exclusion data; preserve the built-in path.
  if (aa === undefined) return true;
  // Finite, not merely present: a hand-edited or foreign-written cache can
  // carry `null`, a string or a NaN, and `.toFixed(3)` on the ranking label
  // throws on the first two while the third ranks on a meaningless number.
  const cost = scoreFor(candidate, aa, providers, upstreamFor)?.costPerTask;
  return typeof cost === 'number' && Number.isFinite(cost);
}

/** Keep only candidates AA can compare on its dollars-per-task scale. */
export function taskCostedCandidates(
  candidates: readonly string[],
  aa?: AaCatalog,
  providers: readonly string[] = [],
  upstreamFor: UpstreamFor = identityUpstream,
): string[] {
  return candidates.filter((candidate) => hasTaskCost(candidate, aa, providers, upstreamFor));
}

/**
 * Each key as the candidates a ranking may choose between: one per scored
 * level for a model the catalog knows by level, the bare key otherwise. A
 * candidate that already names a level is passed through — the caller has
 * decided. Identity without a catalog, which is what keeps every existing
 * caller's behaviour unchanged until a catalog with families is present.
 */
export function expandCandidates(
  keys: readonly string[],
  aa?: AaCatalog,
  providers: readonly string[] = [],
  upstreamFor: UpstreamFor = identityUpstream,
): string[] {
  return keys.flatMap((candidate) => {
    const { key, effort } = splitCandidate(candidate);
    if (effort !== undefined) return [candidate];
    const fam = catalogFamily(normalizedFor(key, providers, upstreamFor), aa);
    return fam === undefined ? [candidate] : [...fam.variants.keys()].map((level) => joinCandidate(key, level));
  });
}

/**
 * Whether the catalog turns this bare key into pinned candidates at all.
 *
 * Counted by *difference*, not by how many levels came back: a family of one
 * expands to a single candidate that is not the bare key, and the whole point
 * is that the bare key must not survive. Counting `> 1` dropped exactly that
 * model, which is how a single-level saved key was silently deleted from a
 * tier rather than re-proposed.
 */
export function hasEffortVariants(
  key: string,
  aa?: AaCatalog,
  providers: readonly string[] = [],
  upstreamFor: UpstreamFor = identityUpstream,
): boolean {
  const expanded = expandCandidates([key], aa, providers, upstreamFor);
  return expanded.length > 1 || expanded[0] !== key;
}

/**
 * The variants of every *bare* saved candidate whose model has effort levels.
 *
 * A config written before effort existed, or a legacy migration, holds bare
 * keys; once a catalog with families is present those keys are refused at
 * load, so the wizard must re-propose them rather than drop them. They are
 * handed to `reconcileTierList` as `added`, which inserts each at the rank
 * the proposal gives it — the same treatment as a model selected for the
 * first time, which is what a never-ranked level is.
 */
export function unpinnedVariants(
  saved: readonly string[] | undefined,
  aa?: AaCatalog,
  providers: readonly string[] = [],
  upstreamFor: UpstreamFor = identityUpstream,
): string[] {
  return (saved ?? []).flatMap((candidate) => {
    const { effort } = splitCandidate(candidate);
    if (effort !== undefined) return [];
    const expanded = expandCandidates([candidate], aa, providers, upstreamFor);
    // Difference, not count: a family of one yields a single *pinned*
    // candidate, and the saved bare key it replaces is the thing being
    // repaired. A `> 1` test dropped it from the tier instead.
    return expanded.length > 1 || expanded[0] !== candidate ? expanded : [];
  });
}

/**
 * A ranking row: `<key> @<effort>`, then the capability and the cost the
 * ranking actually sorts on, so a user comparing two rows sees the numbers
 * that ordered them. Per-task cost where AA costed the model, else the
 * per-1M blend — labelled, because the two are different units.
 */
/**
 * The measured facts a board row draws, as fields rather than a padded string.
 *
 * `candidateLabel` below hand-padded these into one line, which made the row
 * a formatting decision taken in the catalog rather than a layout decision
 * taken by the screen. Columns cannot align across rows that way, and a
 * narrow terminal cannot drop a column it cannot find.
 *
 * `capability` is reported on the metric the asking tier actually sorts by,
 * passed in by the caller. The old label always printed `capabilityOf`
 * (agentic) even after `complex` began ranking on intelligence, so the number
 * on screen did not explain the order it appeared in.
 */
export interface CandidateFacts {
  key: string;
  effort?: Effort;
  /** Undefined when the catalog does not score this model. */
  capability?: number;
  /** Undefined when AA publishes no cost per task; the row is then unrankable. */
  costPerTask?: number;
}

/** A candidate's measurements for the ranking board — capability on the given metric and cost per task — or just its key and effort when the catalog does not score it. */
export function candidateFacts(
  candidate: string,
  aa?: AaCatalog,
  providers: readonly string[] = [],
  upstreamFor: UpstreamFor = identityUpstream,
  metric: (entry: AaEntry) => number = capabilityOf,
): CandidateFacts {
  const { key, effort } = splitCandidate(candidate);
  const entry = scoreFor(candidate, aa, providers, upstreamFor);
  if (entry === undefined) return { key, effort };
  return { key, effort, capability: metric(entry), costPerTask: entry.costPerTask };
}

export function candidateLabel(
  candidate: string,
  aa?: AaCatalog,
  providers: readonly string[] = [],
  upstreamFor: UpstreamFor = identityUpstream,
): string {
  const { key, effort } = splitCandidate(candidate);
  const head = effort === undefined ? key : `${key} @${effort}`;
  const entry = scoreFor(candidate, aa, providers, upstreamFor);
  if (entry === undefined) return head;
  if (entry.costPerTask === undefined) return `${head}  (AA publishes no cost-per-task — add by hand to sonata.toml)`;
  return `${head.padEnd(32)} ${reasoningOf(entry).toFixed(1).padStart(4)}  $${entry.costPerTask.toFixed(3)}/task`;
}

/**
 * Which of `modelKeys` the ranking catalog can actually score.
 *
 * Freshness is measured in days, which is the wrong instrument for the failure
 * it is meant to catch: a catalog fetched three days ago is reported fresh and
 * still knows nothing about a model released two days ago, so selecting that
 * model ranks it from the capable-not-cheap default with no warning anywhere.
 * Coverage answers the question age was standing in for — does this catalog
 * know the models *this user selected* — and it is free to compute.
 */
export function catalogCoverage(
  modelKeys: readonly string[],
  aa?: AaCatalog,
  providers: readonly string[] = [],
  upstreamFor: UpstreamFor = identityUpstream,
): { scored: string[]; unscored: string[] } {
  const scored: string[] = [];
  const unscored: string[] = [];
  for (const key of modelKeys) {
    (scoreFor(key, aa, providers, upstreamFor) !== undefined ? scored : unscored).push(key);
  }
  return { scored, unscored };
}

/** Rank for ordering within a tier: the role's AA score when known, else a
 * fixed mid score so curated/default models interleave stably. */
function rank(
  key: string,
  aa?: AaCatalog,
  providers: readonly string[] = [],
  upstreamFor: UpstreamFor = identityUpstream,
  metric: (entry: AaEntry) => number = capabilityOf,
): { index: number; price: number } {
  const scored = scoreFor(key, aa, providers, upstreamFor);
  return scored !== undefined
    ? { index: metric(scored), price: scored.costPerTask ?? 0 }
    : { index: UNSCORED_PLACEHOLDER_INDEX, price: 0 };
}

/**
 * Capability per dollar — how a simple tier is ordered.
 *
 * A simple tier exists to do grunt work cheaply, so the model that returns the
 * most capability per dollar wins, not the most capable model that happens to
 * clear a price threshold (which is what this used to do, and is backwards for
 * a tier whose whole purpose is cost). Price is floored before dividing so a
 * free model sorts first rather than dividing by zero.
 */
/**
 * Capability per task-dollar.
 *
 * No price floor. This divided by `max(price, 0.01)`, a guard from when
 * prices were per-token rates, and per-task costs now run well under a cent:
 * `gpt-6-luna@low` costs $0.0045 and `gpt-5.6-luna@low` $0.0098, both floored
 * to $0.01, so the halved price vanished and a 0.1-point intelligence gap
 * decided `simple`'s lead the wrong way. A non-positive price is not "very
 * cheap", it is missing data, and scores zero — the spec's rule that a zero
 * cost per task is unscored, not free.
 */
function valueOf(r: { index: number; price: number }): number {
  return r.price > 0 ? r.index / r.price : 0;
}

/**
 * Rank a role's selected models into the three tiers.
 *
 * Each tier is one sort key over the two quantities AA publishes — a coding
 * index and a cost per task. `complex` takes capability, cost breaking a
 * near-tie; `normal` takes capability per task-dollar; `simple` is `normal`
 * filtered to a cost cap, so it never sorts independently and cannot disagree
 * with `normal` about order.
 *
 * Only candidates AA prices per task are considered (`taskCostedCandidates`),
 * because capability-per-token and capability-per-task are different units and
 * ranking across them is an arithmetic error, not a judgement.
 *
 * Three properties are deliberate and easy to undo by accident:
 * `simple` is a *subsequence* of `normal`, not a prefix — value is not
 * monotonic in cost; the cap is anchored to the best-value model, which
 * therefore always clears it, so `simple` is never empty on any config; and
 * there is no capability floor, because a floor makes the value ranking
 * collapse into the cost ranking and `normal` becomes a copy of `simple`.
 *
 * Avoided gateways are demoted rather than excluded, and never set either bar.
 */
export function proposeTiers(
  modelKeys: string[],
  aa?: AaCatalog,
  providers: readonly string[] = [],
  avoided: ReadonlySet<string> = new Set(),
  upstreamFor: UpstreamFor = identityUpstream,
): TierProposal {
  // Rank over every scored level of every selected model. A model AA scores
  // at several efforts is several candidates here - luna@high and luna@max
  // are different capability/cost points, and which one a tier wants is the
  // whole question. Identity without families, so a catalog-less run (and
  // every existing caller) sees exactly the keys it passed.
  // With a catalog, only AA's per-task scale is valid. Without one, keep the
  // built-in proposal path usable because there is no exclusion data yet.
  const candidates = taskCostedCandidates(expandCandidates(modelKeys, aa, providers, upstreamFor), aa, providers, upstreamFor);
  const bareKey = (candidate: string): string => splitCandidate(candidate).key;
  // Two rankers, because the tiers measure different things. `simple` and
  // `normal` are value tiers and want throughput per dollar; `complex` is a
  // judgement tier and wants reasoning. See `reasoningOf`.
  // Intelligence for every tier, not agentic for the value tiers. Agentic
  // is missing for every model AA has only just scored — measured, 14 of 36
  // candidates on one real config — and `capabilityOf` then fell back to
  // intelligence per model, so the value frontier plotted old models by
  // agentic and new ones by intelligence on one axis. That mixed axis made
  // `glm-5.3-flash` the knee (agentic 50.9) although `mimo-v2.6-pro` beats
  // it on intelligence AND price. Intelligence is the one score AA publishes
  // for every model from day one, and the scale its own frontier chart uses.
  const rankOf = (k: string) => rank(k, aa, providers, upstreamFor, reasoningOf);
  const rankReasoning = (k: string) => rank(k, aa, providers, upstreamFor, reasoningOf);
  // An avoided model sorts after every non-avoided one, whatever it scores.
  // Demotion, not exclusion: the tier keeps it as a fallback candidate, so
  // avoiding a gateway costs preference rather than the depth a ranked list
  // exists to provide.
  const avoidance = (a: string, b: string) => Number(avoided.has(bareKey(a))) - Number(avoided.has(bareKey(b)));
  // When capability and price both tie, the higher effort level leads. The
  // levels of one model are the case: AA prices a level-less row per 1M
  // tokens, so every level shares one price, and adjacent levels sit inside
  // the tie margin — with nothing left to order them the sort kept
  // `expandCandidates`' weakest-first order, ranking `@low` above `@medium`
  // at the same price. A level exists to think harder; at equal cost it wins.
  const levelOf = (k: string): number => {
    const { effort } = splitCandidate(k);
    return effort === undefined ? -1 : EFFORT_LEVELS.indexOf(effort);
  };
  const byLevel = (a: string, b: string) => levelOf(b) - levelOf(a);

  const capable = (k: string): boolean => lookupModel(k, aa, providers, upstreamFor).capable;
  const perTask = (k: string): number | undefined => scoreFor(k, aa, providers, upstreamFor)?.costPerTask;

  /**
   * The frontier geometry for one metric.
   *
   * Computed per tier rather than once, because the tiers measure different
   * things — `capabilityOf` is throughput and `reasoningOf` is judgement, a
   * split `catalog.ts` already makes for measured reasons — and bounding a
   * value tier with a knee derived from a metric it does not rank on is the
   * same unit-mixing error as comparing a per-task cost with a per-token one.
   * They genuinely differ: on one real config the agentic knee is
   * `glm-5.3-flash` and the intelligence knee is `mimo-v2.6-pro`.
   *
   * The knee is taken from the FULL frontier and the gate applied after, never
   * the reverse. `kneeIndex` records why: Kneedle measures against a chord
   * between the endpoints, the gate removes the far endpoint, and a knee
   * computed afterwards would inherit the gate's tuned fraction.
   */
  const geometryFor = (metric: (entry: AaEntry) => number) => {
    const pool = candidates.filter((k) => capable(k) && (perTask(k) ?? 0) > 0);
    const points: Point[] = pool.map((k) => ({
      capability: rank(k, aa, providers, upstreamFor, metric).index,
      cost: perTask(k) ?? 0,
    }));
    const order = frontierIndices(points);
    const frontier = order.map((i) => points[i]!);
    // `undefined` when the frontier has no knee (too few points, or no
    // tradeoff to find). Then there is nothing to promote in `normal`, and
    // `complex`'s floor is -Infinity so every candidate counts as at-or-above
    // it — plain capability order, which is what the spec's degradation says.
    const at = kneeIndex(frontier);
    const knee = at === undefined ? undefined : pool[order[at]!];
    const kept = keptAfterGate(frontier);
    const wasteful = new Set(order.slice(kept).map((i) => pool[i]!));
    return {
      knee,
      wasteful,
      kneeCapability: at === undefined ? Number.NEGATIVE_INFINITY : frontier[at]!.capability,
    };
  };

  const valueGeometry = geometryFor(reasoningOf);
  const powerGeometry = geometryFor(reasoningOf);

  /**
   * A gated rung sorts after every rung that pays, whatever it scores.
   *
   * Demotion rather than exclusion, exactly as `avoid_gateways` demotes: the
   * tier keeps it as a last-resort candidate, so declining to pay for it costs
   * preference rather than the depth a ranked list exists to provide. Ordered
   * after the avoidance term, since a gate is sonata's judgement and avoidance
   * is the user's.
   */
  const gateOrder = (set: ReadonlySet<string>) =>
    (a: string, b: string) => Number(set.has(a)) - Number(set.has(b));

  /**
   * Dominated candidates need no term of their own, and that is provable: if X
   * dominates Y then X is at least as capable AND costs no more, so `byValue`
   * and `byCapability` both already place X first. Checked exhaustively
   * against a real catalog — 1762 dominating pairs, zero violations under
   * either key. An explicit demotion pass was not merely redundant, it
   * introduced an inversion that ranked a weaker frontier rung above a
   * stronger dominated one inside a capability-ordered tier.
   */
  const byCapability = (a: string, b: string) => {
    const ra = rankReasoning(a); const rb = rankReasoning(b);
    return avoidance(a, b)
      || gateOrder(powerGeometry.wasteful)(a, b)
      // Knee-and-above leads; below-knee follows as fallback depth rather than
      // being excluded. The knee decides the lead, not membership — excluding
      // left one real config's `complex` with five live candidates, so a
      // provider-wide 402 would exhaust it while capable models sat unused.
      || Number(ra.index < powerGeometry.kneeCapability) - Number(rb.index < powerGeometry.kneeCapability)
      // The tie margin survives the band's deletion, and it has to: the gate
      // cannot reach this case. Measured — `qwen3.8-max` (58.4) outranked
      // `glm-5.3-flash` (58.2) on a 0.2-point edge while costing 10.5x as
      // much per task. Both sit on the frontier (dearer AND better), and a
      // two-point frontier can never be gated, so raw capability order alone
      // pays ten times over for a gap that is benchmark noise.
      //
      // Compared as a quantised CLASS rather than a pairwise tolerance,
      // because a pairwise one is not transitive: it produced a genuine
      // 3-cycle on a real fixture, which made the sort depend on input order
      // and the tier differ run to run.
      || capabilityClass(rb.index) - capabilityClass(ra.index)
      || ra.price - rb.price
      // A real capability edge breaks an equal price, after the class has had
      // its say: where there is no money to save there is nothing to trade,
      // and suppressing the difference would pick the worse rung for nothing.
      || rb.index - ra.index
      || byLevel(a, b);
  };
  // Simple work wants the most capability per dollar, capability breaking
  // ties. At one price, value *is* capability, so a score inside the tie
  // margin is the same noise it is above — a lower level scoring 0.3 higher
  // is not an edge, and the level decides as it does there.
  //
  // Every candidate left here has an AA per-task cost, so capability per
  // dollar is one comparable unit rather than a mix of work and token prices.
  const byValue = (a: string, b: string) => {
    const ra = rankOf(a); const rb = rankOf(b);
    const gated = gateOrder(valueGeometry.wasteful)(a, b);
    if (gated !== 0) return avoidance(a, b) || gated;
    if (ra.price === rb.price && capabilityClass(ra.index) === capabilityClass(rb.index)) {
      return avoidance(a, b) || byLevel(a, b);
    }
    return avoidance(a, b) || valueOf(rb) - valueOf(ra) || rb.index - ra.index || byLevel(a, b);
  };

  const complex = candidates.filter(capable).sort(byCapability);
  const valueOrdered = candidates.filter(capable).sort(byValue);

  /**
   * `normal` leads with the knee, and that is the point of computing one.
   *
   * Used only as a boundary, the best balance point on the frontier led
   * nothing — the analysis was performed and then discarded. `normal` is the
   * *default* tier and means "you know what to change but not exactly how";
   * leading it with the cheapest thing on offer is not a sensible default, and
   * it also gave `simple` and `normal` the same lead, which is the collapse
   * `SIMPLE_CAPABILITY_FLOOR` caused and was deleted for.
   *
   * An avoided or gated knee does not lead: those two judgements outrank this
   * one, and promoting a model the user asked to avoid would make
   * `avoid_gateways` a suggestion.
   */
  const knee = valueGeometry.knee;
  const kneeLeads = knee !== undefined
    && !avoided.has(bareKey(knee))
    && !valueGeometry.wasteful.has(knee)
    && valueOrdered.includes(knee);
  const normal = kneeLeads
    ? [knee!, ...valueOrdered.filter((k) => k !== knee)]
    : valueOrdered;

  // Anchor the cap to the best-value model that can actually lead. Avoided
  // models remain fallbacks but must not raise the price paid by preferred ones.
  //
  // Anchored on the VALUE order rather than on `normal`, because `normal` now
  // leads with the knee — which is deliberately not the cheapest model, so
  // using it would raise the cap by whatever the knee costs and let `simple`
  // reach models it exists to exclude.
  const anchor = valueOrdered.find((k) => !avoided.has(bareKey(k))) ?? valueOrdered[0];
  const anchorCost = anchor === undefined ? undefined : perTask(anchor);
  const ceiling = anchorCost === undefined ? undefined : anchorCost * SIMPLE_COST_CEILING;
  // Filtering the value order rather than sorting again is what stops `simple`
  // disagreeing with it about order: it never does its own sort.
  //
  // The result is a **subsequence, not a prefix**. Value is not monotonic in
  // cost — a dearer model with a much better score outranks a cheap weak one —
  // so an over-ceiling candidate can sit ahead of an under-ceiling one and the
  // filter skips past it. Truncating at the first over-ceiling candidate would
  // drop the qualifying cheap models behind it, the opposite of what a cheap
  // tier is for.
  const simple = ceiling === undefined ? [] : valueOrdered.filter((k) => {
    const cost = perTask(k);
    return cost !== undefined && cost <= ceiling;
  });

  const complexFinal = complex.length > 0 ? complex : [...candidates].sort(byCapability);
  const normalFinal = normal.length > 0 ? normal : [...complexFinal].sort(byValue);
  const simpleFinal = simple.length > 0 ? simple : normalFinal;
  return { simple: simpleFinal, normal: normalFinal, complex: complexFinal };
}

/**
 * How long a ranking cache stays trustworthy.
 *
 * Not a correctness bound — a stale catalog still ranks — but model releases
 * and price cuts land continuously, so an old one silently proposes tiers
 * built on superseded scores. Thirty days is long enough not to nag and short
 * enough that a whole model generation cannot pass unnoticed.
 */
export const AA_CATALOG_MAX_AGE_DAYS = 30;

/** Whole days since a catalog was fetched, or undefined if the stamp is unreadable. */
export function aaCatalogAgeDays(fetchedAt: string, now: Date): number | undefined {
  const at = Date.parse(fetchedAt);
  if (!Number.isFinite(at)) return undefined;
  // A stamp from the future is a clock disagreement, not freshness to report
  // as negative age; treat it as current.
  return Math.max(0, Math.floor((now.getTime() - at) / 86_400_000));
}

/** Where the cached Artificial Analysis catalog lives under a home directory. */
export function aaCatalogPath(home: string): string {
  return join(home, '.config', 'sonata', 'catalog.json');
}

/** Read the cached Artificial Analysis catalog, or `undefined` when there is none or it will not parse. */
export function loadAaCatalog(home: string): AaCatalog | undefined {
  const path = aaCatalogPath(home);
  if (!existsSync(path)) return undefined;
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8')) as AaCatalog;
    if (typeof doc.fetchedAt !== 'string' || typeof doc.models !== 'object' || doc.models === null) return undefined;
    // Validate each entry, not just the top level: a missing, null, string or
    // non-finite score passes the shape check and then misclassifies the model
    // (`undefined >= 40` is `false`, silently "not capable"). A partially-
    // corrupt cache is still useful, so drop the bad entries and keep the good;
    // degrade to no cache only when nothing survives.
    const models: Record<string, AaEntry> = {};
    for (const [name, entry] of Object.entries(doc.models)) {
      if (
        entry !== null &&
        typeof entry === 'object' &&
        // At least one real score, not specifically a coding one: a coding
        // index is optional now, and requiring it here would drop exactly
        // the rows the stand-in bug was hiding — at load time instead.
        [entry.codingIndex, entry.agenticIndex, entry.intelligenceIndex].some((v) => Number.isFinite(v)) &&
        Number.isFinite(entry.blendedPriceUsd)
      ) {
        // An unknown level is a hand-edit or a foreign writer; the score is
        // still good, so keep the row and drop only the field.
        const { effort, costPerTask, ...rest } = entry as AaEntry;
        // Same treatment as `effort`: the row's score is still good, so drop
        // only the malformed field and let the model read as uncosted.
        const kept: AaEntry = typeof costPerTask === 'number' && Number.isFinite(costPerTask)
          ? { ...rest, costPerTask }
          : rest;
        models[name] = effort !== undefined && isEffort(effort) ? { ...kept, effort } : kept;
      }
    }
    if (Object.keys(models).length === 0) return undefined;
    return {
      fetchedAt: doc.fetchedAt,
      // Only a string survives: the writer stringifies it, so anything else in
      // the file is a hand-edit or a foreign writer, and a version that is not
      // a version is worse than none — it would read as a known scale.
      ...(typeof doc.intelligenceIndexVersion === 'string'
        ? { intelligenceIndexVersion: doc.intelligenceIndexVersion }
        : {}),
      models,
    };
  } catch {
    return undefined;
  }
}
