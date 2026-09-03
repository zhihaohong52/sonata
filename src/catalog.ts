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

export const AA_ATTRIBUTION =
  'Model rankings by Artificial Analysis — https://artificialanalysis.ai';

/** Coding Index at or above this ⇒ complex-eligible. Chosen so today's
 * mid-tier coders (deepseek-v4-flash class) sit just above the line. */
export const AA_CAPABLE_CODING_INDEX = 40;

/**
 * Blended $/1M tokens at or below this ⇒ cheap enough for the simple tier.
 *
 * Only reaches the simple tier for a model AA has **not** costed per task;
 * `SIMPLE_COST_CEILING` decides the ones it has. Kept because a per-1M rate is
 * the only price such a model has.
 */
export const AA_CHEAP_BLENDED_PRICE_USD = 1.0;

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
 * **Relative**, for the reason `SIMPLE_CAPABILITY_FLOOR` is: an absolute bar
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

export interface CatalogEntry {
  capable: boolean;
  cheap: boolean;
  source: 'curated' | 'aa' | 'default';
}

export interface AaCatalog {
  fetchedAt: string;
  models: Record<string, AaEntry>;
}

export interface AaEntry {
  codingIndex: number;
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
 * What one unit of work costs, best available measure first.
 *
 * `costPerTask` prices the work; the blended per-1M rate only prices tokens
 * and is a weaker proxy, kept for models AA has not costed.
 */
export function costOfEntry(entry: AaEntry): number {
  return entry.costPerTask ?? entry.blendedPriceUsd;
}

/**
 * A model must reach this fraction of the best score among the *selected*
 * models to be eligible for a simple tier.
 *
 * Relative, not absolute: an absolute floor is wrong in both directions —
 * it excludes everything when a user's whole selection is modest, and admits
 * junk when their selection is strong. The simple tier optimises
 * capability-per-dollar, and without a floor a very cheap, very weak model
 * wins on ratio alone.
 *
 * Set where it is to keep the tier *deep* as well as good. A tier is a ranked
 * fallback list, so a floor strict enough to admit one model leaves the router
 * nothing to fall through to and sends the first failure straight to 529 and
 * the dispatch lane. Measured on a real 17-model config, 0.85 admitted exactly
 * one model where 0.75 admits four.
 *
 * The floor is not only a depth control: it also decides the *leader*, because
 * a model it admits can outrank the others on value. On that same config,
 * raising it to 0.85 excludes the cheapest model and promotes a stronger,
 * dearer one. So it trades capability against both cost and resilience, and
 * moving it changes what grunt work actually runs on — not merely what stands
 * behind that choice.
 */
export const SIMPLE_CAPABILITY_FLOOR = 0.75;



/**
 * The key an AA score is stored and looked up under.
 *
 * AA writes versions with dashes (`glm-5-3`) where sonata, ai-pricing.fyi and
 * every gateway write dots (`glm-5.3`), so a name that is otherwise identical
 * never joins — measured on a real 17-model config, only 3 matched, and the
 * other 14 fell back to a constant rank that made the sort a no-op. Going
 * dots-to-dashes is the safe direction: dashes are load-bearing inside real
 * names (`deepseek-v4-flash`), so the reverse would be ambiguous. Verified
 * collision-free across both catalogs (0 of 258 ai-pricing, 0 of 233 AA).
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

/** The AA row for a normalized name, trying each spelling it may be filed
 *  under. Dots-to-dashes is applied to every candidate, not only the first. */
function aaEntryFor(normalized: string, aa?: AaCatalog): AaEntry | undefined {
  if (aa === undefined) return undefined;
  for (const name of aaLookupNames(normalized)) {
    const hit = aa.models[name] ?? aa.models[aaMatchKey(name)];
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** Our own judgement, not AA data. Kept deliberately small: the default for
 * anything unlisted is capable-not-cheap, the direction that never silently
 * hands hard work to a weak model. */
const CURATED: Record<string, { capable: boolean; cheap: boolean }> = {
  'deepseek-v4-flash': { capable: true, cheap: true },
  'deepseek-v4-pro': { capable: true, cheap: false },
  'gpt-5.6-luna': { capable: true, cheap: true },
  'gpt-5.6-terra': { capable: true, cheap: false },
  'gpt-5.6-sol': { capable: true, cheap: false },
  'kimi-k3': { capable: true, cheap: true },
  'kimi-k3-free': { capable: false, cheap: true },
  'glm-5.3': { capable: true, cheap: true },
  'grok-4.6': { capable: true, cheap: false },
  'gemini-3.7-flash': { capable: true, cheap: true },
  'qwen3.8-max': { capable: true, cheap: false },
  'ox-alpha-free': { capable: false, cheap: true },
};

export function lookupModel(name: string, aa?: AaCatalog, providers: readonly string[] = []): CatalogEntry {
  const normalized = normalizeModelName(name, providers);
  const scored = aaEntryFor(normalized, aa);
  if (scored !== undefined) {
    return {
      capable: scored.codingIndex >= AA_CAPABLE_CODING_INDEX,
      cheap: scored.blendedPriceUsd <= AA_CHEAP_BLENDED_PRICE_USD,
      source: 'aa',
    };
  }
  const curated = CURATED[normalized];
  if (curated !== undefined) return { ...curated, source: 'curated' };
  return { capable: true, cheap: false, source: 'default' };
}

export interface TierProposal { simple: string[]; complex: string[] }

/** The AA row behind a model key, joined through the match key. */
function scoreFor(key: string, aa?: AaCatalog, providers: readonly string[] = []): AaEntry | undefined {
  return aaEntryFor(normalizeModelName(key, providers), aa);
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
): { scored: string[]; unscored: string[] } {
  const scored: string[] = [];
  const unscored: string[] = [];
  for (const key of modelKeys) {
    (scoreFor(key, aa, providers) !== undefined ? scored : unscored).push(key);
  }
  return { scored, unscored };
}

/** Rank for ordering within a tier: the role's AA score when known, else a
 * fixed mid score so curated/default models interleave stably. */
function rank(
  key: string,
  aa?: AaCatalog,
  providers: readonly string[] = [],
): { index: number; price: number } {
  const scored = scoreFor(key, aa, providers);
  return scored !== undefined
    ? { index: capabilityOf(scored), price: costOfEntry(scored) }
    : { index: AA_CAPABLE_CODING_INDEX, price: AA_CHEAP_BLENDED_PRICE_USD };
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
function valueOf(r: { index: number; price: number }): number {
  return r.index / Math.max(r.price, 0.01);
}

export function proposeTiers(
  modelKeys: string[],
  aa?: AaCatalog,
  providers: readonly string[] = [],
  avoided: ReadonlySet<string> = new Set(),
): TierProposal {
  const rankOf = (k: string) => rank(k, aa, providers);
  // An avoided model sorts after every non-avoided one, whatever it scores.
  // Demotion, not exclusion: the tier keeps it as a fallback candidate, so
  // avoiding a gateway costs preference rather than the depth a ranked list
  // exists to provide.
  const avoidance = (a: string, b: string) => Number(avoided.has(a)) - Number(avoided.has(b));
  // Complex work wants the most capable model, cost breaking ties — including
  // a near-tie: a capability gap within AA_CAPABILITY_TIE_MARGIN is treated as
  // noise rather than a real edge, so price decides it the same as an exact
  // tie would. A real edge (bigger than the margin) still wins outright.
  const byCapability = (a: string, b: string) => {
    const ra = rankOf(a); const rb = rankOf(b);
    const gap = Math.abs(rb.index - ra.index) <= AA_CAPABILITY_TIE_MARGIN ? 0 : rb.index - ra.index;
    return avoidance(a, b) || gap || ra.price - rb.price;
  };
  // Simple work wants the most capability per dollar, capability breaking ties.
  const byValue = (a: string, b: string) => {
    const ra = rankOf(a); const rb = rankOf(b);
    return avoidance(a, b) || valueOf(rb) - valueOf(ra) || rb.index - ra.index;
  };

  const complex = modelKeys.filter((k) => lookupModel(k, aa, providers).capable).sort(byCapability);
  // The floor is relative to the best model actually selected, so it adapts to
  // the user's own set rather than to an absolute score that is wrong whenever
  // their selection is uniformly strong or uniformly modest.
  // Measured over the models that can actually lead the tier: including an
  // avoided model here could raise the bar high enough to exclude everything
  // preferred, inverting the setting's intent.
  const preferred = modelKeys.filter((k) => !avoided.has(k));
  const leaders = preferred.length > 0 ? preferred : modelKeys;
  const best = Math.max(0, ...leaders.map((k) => rankOf(k).index));
  // The cost bar is relative to the cheapest model that can actually *enter*
  // the tier — not merely the cheapest one selected. `best` gets away with
  // reading every leader because it is a `Math.max`, which a weak model cannot
  // drag down; the ceiling is a `Math.min`, which one absolutely can. A very
  // cheap, very weak model would set a bar so low that nothing eligible clears
  // it, `simple` would come back empty, and the fallback would mirror the
  // complex set — the tier silently ceasing to discriminate, which is the whole
  // failure the floor exists to prevent. So the same two predicates that decide
  // membership below also decide who is allowed to set the bar.
  //
  // Avoided models are already out (`leaders`), for the same reason the
  // capability floor is measured over `preferred`: an avoided model setting the
  // bar would move it for models the user asked to demote, which is not what
  // avoidance means.
  //
  // Measured over per-task costs only. `rankOf().price` falls back to a per-1M
  // rate when AA has not costed a model, and the two are different units by
  // two orders of magnitude — a ratio that mixes them would read an uncosted
  // model as ~30x dearer than it is and refuse it on a unit error.
  const perTask = (k: string) => scoreFor(k, aa, providers)?.costPerTask;
  const eligible = (k: string): boolean => lookupModel(k, aa, providers).capable
    && rankOf(k).index >= best * SIMPLE_CAPABILITY_FLOOR;
  const costs = leaders
    .filter(eligible)
    .map(perTask)
    .filter((c): c is number => c !== undefined && c > 0);
  const ceiling = costs.length > 0 ? Math.min(...costs) * SIMPLE_COST_CEILING : undefined;
  // A model AA has not costed per task has no place on that scale, so it keeps
  // the absolute judgement it had before: the curated table's `cheap`, or the
  // per-1M bar. That is the pre-existing behaviour for exactly the models this
  // change has no better information about.
  const isCheap = (k: string): boolean => {
    const cost = perTask(k);
    if (cost === undefined || ceiling === undefined) return lookupModel(k, aa, providers).cheap;
    return cost <= ceiling;
  };
  // Same `eligible` the ceiling is measured over, so who sets the bar and who
  // is judged against it cannot drift apart.
  const simple = modelKeys.filter((k) => eligible(k) && isCheap(k)).sort(byValue);
  // A tier must always resolve to something: with no capable model, everything
  // is complex-eligible; with no cheap-capable model, simple mirrors complex.
  // The fallback is sorted too — raw input order would break the documented
  // "index descending, price ascending" ordering on exactly the path where no
  // model cleared the threshold.
  const complexFinal = complex.length > 0 ? complex : [...modelKeys].sort(byCapability);
  // Falls back to the complex set, but re-sorted by value: the reason to
  // fall back is that nothing cleared the cheap bar, not that cost stopped
  // mattering for grunt work.
  const simpleFinal = simple.length > 0 ? simple : [...complexFinal].sort(byValue);
  return { simple: simpleFinal, complex: complexFinal };
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

export function aaCatalogPath(home: string): string {
  return join(home, '.config', 'sonata', 'catalog.json');
}

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
    const models: Record<string, { codingIndex: number; blendedPriceUsd: number }> = {};
    for (const [name, entry] of Object.entries(doc.models)) {
      if (
        entry !== null &&
        typeof entry === 'object' &&
        Number.isFinite(entry.codingIndex) &&
        Number.isFinite(entry.blendedPriceUsd)
      ) {
        models[name] = entry;
      }
    }
    if (Object.keys(models).length === 0) return undefined;
    return { fetchedAt: doc.fetchedAt, models };
  } catch {
    return undefined;
  }
}
