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

/** Blended $/1M tokens at or below this ⇒ cheap enough for the simple tier. */
export const AA_CHEAP_BLENDED_PRICE_USD = 1.0;

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
 */
export const SIMPLE_CAPABILITY_FLOOR = 0.85;



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
  return name.replace(/-\d{4}$/, '');
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
  const scored = aa?.models[normalized] ?? aa?.models[aaMatchKey(normalized)];
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
  const normalized = normalizeModelName(key, providers);
  return aa?.models[normalized] ?? aa?.models[aaMatchKey(normalized)];
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
): TierProposal {
  const rankOf = (k: string) => rank(k, aa, providers);
  // Complex work wants the most capable model, cost only breaking ties.
  const byCapability = (a: string, b: string) => {
    const ra = rankOf(a); const rb = rankOf(b);
    return rb.index - ra.index || ra.price - rb.price;
  };
  // Simple work wants the most capability per dollar, capability breaking ties.
  const byValue = (a: string, b: string) => {
    const ra = rankOf(a); const rb = rankOf(b);
    return valueOf(rb) - valueOf(ra) || rb.index - ra.index;
  };

  const complex = modelKeys.filter((k) => lookupModel(k, aa, providers).capable).sort(byCapability);
  // The floor is relative to the best model actually selected, so it adapts to
  // the user's own set rather than to an absolute score that is wrong whenever
  // their selection is uniformly strong or uniformly modest.
  const best = Math.max(0, ...modelKeys.map((k) => rankOf(k).index));
  const simple = modelKeys
    .filter((k) => {
      const e = lookupModel(k, aa, providers);
      return e.capable && e.cheap && rankOf(k).index >= best * SIMPLE_CAPABILITY_FLOOR;
    })
    .sort(byValue);
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
