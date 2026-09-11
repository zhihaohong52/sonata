/**
 * Per-token prices from models.dev.
 *
 * The public catalog is fetched explicitly by `sonata catalog update`, cached
 * under the user's config directory, and never committed to this repository.
 * Only hand-written synthetic fixtures are checked in.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Rates } from './config.js';

export const MODELS_DEV_URL = 'https://models.dev/api.json';
export const MODELS_DEV_ATTRIBUTION = 'Prices from models.dev — https://models.dev';

export interface ModelsDevCache {
  fetchedAt: string;
  /** provider id -> model id -> USD-per-million-token rates */
  providers: Record<string, Record<string, Rates>>;
  /**
   * provider id -> model id -> context window in tokens.
   *
   * Kept separate from `providers` because rates and windows are independent
   * facts: models.dev lists models it has not costed, and those still have a
   * real window. Folding them together would drop exactly the models this map
   * exists to describe. Absent on a cache written before this field existed,
   * which reads as "unknown" and falls back to the built-in default.
   */
  contexts?: Record<string, Record<string, number>>;
}

export function modelsDevPath(home: string): string {
  return join(home, '.config', 'sonata', 'models-dev.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Extract usable base rates; long-context and tier rates require request size. */
export function normalizeModelsDev(doc: unknown): ModelsDevCache['providers'] {
  if (!isRecord(doc)) return {};
  const providers: ModelsDevCache['providers'] = {};
  for (const [providerId, rawProvider] of Object.entries(doc)) {
    if (providerId === '' || !isRecord(rawProvider) || !isRecord(rawProvider.models)) continue;
    const models: Record<string, Rates> = {};
    for (const [modelId, rawModel] of Object.entries(rawProvider.models)) {
      if (modelId === '' || !isRecord(rawModel) || !isRecord(rawModel.cost)) continue;
      const cost = rawModel.cost;
      const rates: Rates = {};
      if (validRate(cost.input)) rates.input = cost.input;
      if (validRate(cost.output)) rates.output = cost.output;
      if (validRate(cost.cache_read)) rates.cachedInput = cost.cache_read;
      if (validRate(cost.cache_write)) rates.cacheWrite = cost.cache_write;
      if (Object.keys(rates).length > 0) models[modelId] = rates;
    }
    if (Object.keys(models).length > 0) providers[providerId] = models;
  }
  return providers;
}

/**
 * Read `limit.context` for every model models.dev publishes one for.
 *
 * Independent of `normalizeModelsDev`, which requires a `cost` block and would
 * otherwise discard an uncosted model's window along with its missing price.
 */
export function normalizeModelsDevContexts(doc: unknown): NonNullable<ModelsDevCache['contexts']> {
  if (!isRecord(doc)) return {};
  const contexts: NonNullable<ModelsDevCache['contexts']> = {};
  for (const [providerId, rawProvider] of Object.entries(doc)) {
    if (providerId === '' || !isRecord(rawProvider) || !isRecord(rawProvider.models)) continue;
    const models: Record<string, number> = {};
    for (const [modelId, rawModel] of Object.entries(rawProvider.models)) {
      if (modelId === '' || !isRecord(rawModel) || !isRecord(rawModel.limit)) continue;
      const context = rawModel.limit.context;
      // A non-positive or non-finite window is not a smaller window, it is a
      // missing one — and treating it as a number would hand the model a
      // context budget of zero.
      if (typeof context !== 'number' || !Number.isFinite(context) || context <= 0) continue;
      models[modelId] = context;
    }
    if (Object.keys(models).length > 0) contexts[providerId] = models;
  }
  return contexts;
}

/**
 * The context window models.dev reports for an upstream model id.
 *
 * Unlike a *price*, a window is a property of the model rather than of who
 * resells it, so every provider is searched rather than only the ones a
 * gateway names — there is no `pricing_provider` equivalent to consult and no
 * need for one. The slash-suffix match is the same one pricing uses: a config
 * carries the bare upstream id while OpenRouter and others vendor-qualify.
 *
 * When providers disagree, the **most commonly published** window wins, with
 * the smaller value breaking a tie. Taking the minimum was tried and is wrong
 * by most of its own magnitude: `glm-5.2` is published by a dozen providers
 * between 202752 and 1048576, the great majority at ~1M, and one outlier
 * capping at 202752 dragged every tier containing that model down with it —
 * measured, an 5x understatement. The mode is what the model actually is;
 * a single reseller's cap is not, and sonata cannot know which reseller a
 * gateway fronts anyway. The tie-break stays conservative because an
 * overstated window fails hard at the upstream while an understated one only
 * wastes context.
 */
export function contextWindowFor(
  contexts: NonNullable<ModelsDevCache['contexts']> | undefined,
  id: string,
): number | undefined {
  if (contexts === undefined || id === '') return undefined;
  // A serving-variant suffix (`:free`, `:nitro`, `:floor`) selects a route for
  // the same weights, so it cannot change the window — and models.dev files
  // the row without it. `:` appears in no upstream model name, so cutting at
  // the first one is unambiguous. Same strip `normalizeModelName` performs.
  const wanted = id.includes(':') ? id.slice(0, id.indexOf(':')) : id;
  const bareWanted = wanted.includes('/') ? wanted.slice(wanted.indexOf('/') + 1) : wanted;
  const seen = new Map<number, number>();
  for (const models of Object.values(contexts)) {
    for (const [key, window] of Object.entries(models)) {
      const slash = key.indexOf('/');
      const bare = slash === -1 ? key : key.slice(slash + 1);
      if (key !== wanted && bare !== wanted && bare !== bareWanted) continue;
      seen.set(window, (seen.get(window) ?? 0) + 1);
    }
  }
  let best: number | undefined;
  let bestCount = 0;
  for (const [window, count] of seen) {
    if (count > bestCount || (count === bestCount && best !== undefined && window < best)) {
      best = window;
      bestCount = count;
    }
  }
  return best;
}

export function loadModelsDev(home: string): ModelsDevCache | undefined {
  const path = modelsDevPath(home);
  if (!existsSync(path)) return undefined;
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8')) as ModelsDevCache;
    if (typeof doc.fetchedAt !== 'string') return undefined;
    if (!isRecord(doc.providers) || !providersAreValid(doc.providers)) return undefined;
    return doc;
  } catch {
    return undefined;
  }
}

const RATE_KEYS: ReadonlySet<string> = new Set(['input', 'cachedInput', 'cacheWrite', 'output']);

/** Reject records that `costOf` would otherwise silently treat as zero. */
function providersAreValid(providers: Record<string, Record<string, Rates>>): boolean {
  if (Object.keys(providers).length === 0) return false;
  for (const [providerId, models] of Object.entries(providers)) {
    if (providerId === '' || !isRecord(models) || Object.keys(models).length === 0) return false;
    for (const [modelId, rates] of Object.entries(models)) {
      if (modelId === '' || !isRecord(rates)) return false;
      const entries = Object.entries(rates);
      if (entries.length === 0) return false;
      for (const [key, value] of entries) {
        if (!RATE_KEYS.has(key) || !validRate(value)) return false;
      }
    }
  }
  return true;
}

/**
 * The window `sonata init` assumes when nothing better is known.
 *
 * It is a guess, and for most models a wrong one — 19 of 24 models on the
 * development machine carried it, including models whose real window is 1M.
 * A guess is indistinguishable from a decision once written to `sonata.toml`,
 * which is why `enrichContextWindows` replaces this value and only this value.
 */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * Fill in real context windows from models.dev before a config is written.
 *
 * Only a candidate still carrying `DEFAULT_CONTEXT_WINDOW` is touched. A
 * different value came from somewhere — an existing `sonata.toml`, or a
 * hand edit — and models.dev is a better guess than sonata's default but not
 * better than a decision someone made. That distinction is the whole reason
 * this runs over the default rather than over everything.
 *
 * A model models.dev has never heard of keeps the default, because the
 * alternative is inventing a window, and an overstated one fails hard at the
 * upstream rather than merely wasting context.
 */
export function enrichContextWindows(
  candidates: Map<string, { id: string; contextWindow: number }>,
  contexts: NonNullable<ModelsDevCache['contexts']> | undefined,
): void {
  if (contexts === undefined) return;
  for (const candidate of candidates.values()) {
    if (candidate.contextWindow !== DEFAULT_CONTEXT_WINDOW) continue;
    const known = contextWindowFor(contexts, candidate.id);
    if (known !== undefined) candidate.contextWindow = known;
  }
}
