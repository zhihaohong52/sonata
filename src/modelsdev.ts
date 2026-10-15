/**
 * Per-token prices from models.dev.
 *
 * The public catalog is fetched explicitly by `sonata catalog update`, cached
 * under the user's config directory, and never committed to this repository.
 * Only hand-written synthetic fixtures are checked in.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ModelApi, Rates } from './config.js';
import { planEndpointFor } from './plans.js';

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
  /**
   * provider id -> model id -> display name.
   *
   * A provider's slug is its own: DeepSeek serves V4.1 Flash as the
   * versionless alias `deepseek-flash`, and no catalog keyed by versioned
   * model can be asked about that. The display name is the one field every
   * provider agrees on for the same weights (`DeepSeek V4.1 Flash` under all
   * thirty that list it), so it is what joins a slug to a ranking. Absent on
   * a cache written before this field existed, which reads as "unknown".
   */
  names?: Record<string, Record<string, string>>;
  /**
   * provider id -> its endpoint and the models it serves only on another
   * protocol than chat completions, and which.
   *
   * models.dev names each provider's SDK package and overrides it per model
   * where the model speaks another protocol. On an OpenAI-compatible provider
   * (`@ai-sdk/openai-compatible`, chat completions) a model overridden to
   * `@ai-sdk/openai` is reached on `/responses`, and one overridden to
   * `@ai-sdk/google` on Google's `generateContent`. Measured 2026-10-14 on
   * OpenCode Go: `gpt-6-luna` answers chat completions with
   * `ModelProtocolUnsupported` and serves on `/responses`;
   * `gemini-4-argon-contributor` refuses chat completions, `/responses` and
   * `/messages` alike and serves `generateContent`. A protocol is a fact about
   * an endpoint, so the provider's `api` URL is kept with it and a gateway is
   * matched by its base URL, never by its name or pricing. Absent on a cache
   * written before this field existed, which reads as "unknown".
   */
  protocols?: Record<string, { api: string; models: Record<string, ModelApi> }>;
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
 * Read `name` for every model models.dev publishes one for, costed or not —
 * the rate normalizer requires a `cost` block, and an uncosted model still
 * has a name.
 */
export function normalizeModelsDevNames(doc: unknown): NonNullable<ModelsDevCache['names']> {
  if (!isRecord(doc)) return {};
  const names: NonNullable<ModelsDevCache['names']> = {};
  for (const [providerId, rawProvider] of Object.entries(doc)) {
    if (providerId === '' || !isRecord(rawProvider) || !isRecord(rawProvider.models)) continue;
    const models: Record<string, string> = {};
    for (const [modelId, rawModel] of Object.entries(rawProvider.models)) {
      if (modelId === '' || !isRecord(rawModel)) continue;
      const name = rawModel.name;
      if (typeof name !== 'string' || name.trim() === '') continue;
      models[modelId] = name.trim();
    }
    if (Object.keys(models).length > 0) names[providerId] = models;
  }
  return names;
}

/** The SDK package models.dev names for each protocol a model may override to. */
const PROTOCOL_FOR_NPM: Readonly<Record<string, ModelApi>> = {
  '@ai-sdk/openai': 'responses',
  '@ai-sdk/google': 'google',
};

/** `ModelsDevCache.protocols` from a models.dev document. */
export function normalizeModelsDevProtocols(doc: unknown): NonNullable<ModelsDevCache['protocols']> {
  if (!isRecord(doc)) return {};
  const out: NonNullable<ModelsDevCache['protocols']> = {};
  for (const [providerId, rawProvider] of Object.entries(doc)) {
    if (providerId === '' || !isRecord(rawProvider) || !isRecord(rawProvider.models)) continue;
    if (rawProvider.npm !== '@ai-sdk/openai-compatible' || typeof rawProvider.api !== 'string') continue;
    const models: Record<string, ModelApi> = {};
    for (const [id, model] of Object.entries(rawProvider.models).sort(([a], [b]) => a.localeCompare(b))) {
      const npm = isRecord(model) && isRecord(model.provider) ? model.provider.npm : undefined;
      const api = typeof npm === 'string' ? PROTOCOL_FOR_NPM[npm] : undefined;
      if (id !== '' && api !== undefined) models[id] = api;
    }
    if (Object.keys(models).length > 0) out[providerId] = { api: rawProvider.api, models };
  }
  return out;
}

/** Host and path, without a trailing slash: how two endpoint URLs are compared. */
function endpointOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    return undefined;
  }
}

/**
 * The protocol the endpoint at `baseUrl` serves `id` on, when it is not chat
 * completions, with the URL models.dev lists that provider at.
 *
 * Matched by endpoint: a provider counts when its models.dev `api` URL is
 * `baseUrl`, or when `baseUrl` is a plan endpoint whose list provider it is
 * (`planEndpointFor` — OpenCode Go answers on `/zen/go` and `/inference/go`,
 * and models.dev lists only the second). Never by gateway name or
 * `pricing_provider`, which say where a price comes from, not what the
 * endpoint speaks: a reseller priced at OpenCode Go's rates may well serve
 * the same model on chat completions. `endpoint` lets a caller see that the
 * match was by plan and the listed URL differs — OpenCode Go serves Google's
 * protocol only on `/inference/go`.
 */
export function requiredApi(
  cache: Pick<ModelsDevCache, 'protocols'> | undefined,
  baseUrl: string | undefined,
  id: string,
): { api: ModelApi; endpoint: string } | undefined {
  if (cache?.protocols === undefined || baseUrl === undefined) return undefined;
  const endpoint = endpointOf(baseUrl);
  if (endpoint === undefined) return undefined;
  const plan = planEndpointFor(baseUrl)?.listProvider;
  for (const [provider, entry] of Object.entries(cache.protocols)) {
    const api = entry.models[id];
    if (api !== undefined && (provider === plan || endpointOf(entry.api) === endpoint)) return { api, endpoint: entry.api };
  }
  return undefined;
}

/** Whether `a` and `b` name the same endpoint: host and path, trailing slash aside. */
export function sameEndpoint(a: string, b: string): boolean {
  const left = endpointOf(a);
  return left !== undefined && left === endpointOf(b);
}

/**
 * The display name models.dev gives an upstream id, under the providers a
 * gateway names — and only those.
 *
 * Unlike a context window, a *slug* is not a property of the model: `nan`
 * files `deepseek-v4-flash` as V4.1 Flash while DeepSeek itself files that
 * slug as V4 Flash. So the search is the one pricing performs — the gateway's
 * `pricing_provider` list, in order, exact slug first and then the bare-id
 * match against a vendor-qualified key — never every provider. Two matches
 * naming different models is a coin flip, and answers nothing.
 */
export function displayNameFor(
  names: NonNullable<ModelsDevCache['names']> | undefined,
  providers: readonly string[],
  id: string,
): string | undefined {
  if (names === undefined || id === '') return undefined;
  const wanted = id.includes(':') ? id.slice(0, id.indexOf(':')) : id;
  if (wanted === '') return undefined;
  const bareWanted = wanted.includes('/') ? wanted.slice(wanted.indexOf('/') + 1) : wanted;
  for (const provider of providers) {
    const table = names[provider];
    if (table === undefined) continue;
    const exact = table[wanted];
    if (exact !== undefined) return exact;
    let found: string | undefined;
    for (const [key, name] of Object.entries(table)) {
      const slash = key.indexOf('/');
      if (slash <= 0 || slash === key.length - 1) continue;
      if (key.slice(slash + 1) !== bareWanted) continue;
      if (found === undefined) { found = name; continue; }
      if (found !== name) { found = undefined; break; }
    }
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * The names a ranking catalog may be asked about for an upstream id: the id
 * itself, then its models.dev display name spelled as a model id. Order is
 * precedence — `normalizedFor` in catalog.ts tries these in turn and the
 * first that scores wins, so the name can only add a score where the id
 * found none. The spelling is the obvious one (`DeepSeek V4.1 Flash` →
 * `deepseek-v4.1-flash`); `aaMatchKey` folds the dot on lookup, and a name
 * that spells the same as the id is not offered twice.
 */
export function catalogSpellingsFor(
  names: NonNullable<ModelsDevCache['names']> | undefined,
  providers: readonly string[],
  id: string,
): string[] {
  const name = displayNameFor(names, providers, id);
  if (name === undefined) return [id];
  const spelled = name.toLowerCase().replace(/\s+/g, '-');
  return spelled === id ? [id] : [id, spelled];
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
  // An id that is nothing but the suffix leaves no name to match. An empty
  // name matches any key whose model part is empty (`vendor/`), which would
  // hand a real candidate that provider's window.
  if (wanted === '') return undefined;
  const bareWanted = wanted.includes('/') ? wanted.slice(wanted.indexOf('/') + 1) : wanted;
  const seen = new Map<number, number>();
  for (const models of Object.values(contexts)) {
    for (const [key, window] of Object.entries(models)) {
      const slash = key.indexOf('/');
      const bare = slash === -1 ? key : key.slice(slash + 1);
      if (bare === '') continue;
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
    // `names` is optional and consulted per lookup, so a malformed map must
    // not fail the cache the prices still depend on — nor survive to throw
    // inside a ranking. Keep the well-formed provider tables, drop the rest.
    const names = validNames(doc.names);
    if (names === undefined) delete doc.names; else doc.names = names;
    const protocols = validProtocols(doc.protocols);
    if (protocols === undefined) delete doc.protocols; else doc.protocols = protocols;
    return doc;
  } catch {
    return undefined;
  }
}

function validNames(raw: unknown): NonNullable<ModelsDevCache['names']> | undefined {
  if (!isRecord(raw)) return undefined;
  const names: NonNullable<ModelsDevCache['names']> = {};
  for (const [providerId, table] of Object.entries(raw)) {
    if (providerId === '' || !isRecord(table)) continue;
    const models: Record<string, string> = {};
    for (const [modelId, name] of Object.entries(table)) {
      if (modelId !== '' && typeof name === 'string' && name !== '') models[modelId] = name;
    }
    if (Object.keys(models).length > 0) names[providerId] = models;
  }
  return Object.keys(names).length > 0 ? names : undefined;
}

function validProtocols(raw: unknown): NonNullable<ModelsDevCache['protocols']> | undefined {
  if (!isRecord(raw)) return undefined;
  const out: NonNullable<ModelsDevCache['protocols']> = {};
  for (const [providerId, entry] of Object.entries(raw)) {
    if (providerId === '' || !isRecord(entry) || typeof entry.api !== 'string' || !isRecord(entry.models)) continue;
    const models: Record<string, ModelApi> = {};
    for (const [id, api] of Object.entries(entry.models)) {
      if (id !== '' && (api === 'responses' || api === 'google')) models[id] = api;
    }
    if (Object.keys(models).length > 0) out[providerId] = { api: entry.api, models };
  }
  return Object.keys(out).length > 0 ? out : undefined;
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
