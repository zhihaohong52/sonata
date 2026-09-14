/**
 * Turning token counts into money, or honestly declining to.
 *
 * Resolution order is model price, gateway price, models.dev price, then nothing.
 * A scraped price applies only when the gateway identifies its serving provider:
 * the same model can cost materially different amounts across providers.
 */
import { isOauthGatewayAuth, type NativeGatewayAuth, type PriceConfig, type PriceWindow, type Rates, type SonataConfig } from './config.js';
import type { LedgerPrice } from './ledger.js';
import type { UsageTokens } from './native/usage.js';
import { normalizeModelName, type UpstreamFor } from './catalog.js';
import { catalogSpellingsFor, type ModelsDevCache } from './modelsdev.js';

function minutes(hhmm: string): number {
  const [hours, minutesPart] = hhmm.split(':');
  return Number(hours) * 60 + Number(minutesPart);
}

function hasRates(rates: Rates): boolean {
  return rates.input !== undefined || rates.cachedInput !== undefined || rates.cacheWrite !== undefined || rates.output !== undefined;
}

/**
 * UTC only. A window ending at or before its start wraps over midnight, so its
 * two matching ranges must be joined rather than treated as an empty interval.
 */
export function inWindow(window: PriceWindow, at: Date): boolean {
  const time = at.getUTCHours() * 60 + at.getUTCMinutes();
  const from = minutes(window.from);
  const to = minutes(window.to);
  return from <= to ? time >= from && time < to : time >= from || time < to;
}

export function ratesFor(price: PriceConfig | undefined, at: Date): Rates | undefined {
  if (price === undefined) return undefined;

  for (const window of price.windows ?? []) {
    if (inWindow(window, at)) {
      const windowRates: Rates = {
        input: window.input,
        cachedInput: window.cachedInput,
        cacheWrite: window.cacheWrite,
        output: window.output,
      };
      // An empty override must not turn unknown pricing into a confident zero.
      if (hasRates(windowRates)) return windowRates;
    }
  }

  const flat: Rates = {
    input: price.input,
    cachedInput: price.cachedInput,
    cacheWrite: price.cacheWrite,
    output: price.output,
  };
  return hasRates(flat) ? flat : undefined;
}

const PER_MILLION = 1_000_000;

export function costOf(tokens: UsageTokens, rates: Rates): number {
  return (
    (tokens.input * (rates.input ?? 0)
      + tokens.cacheRead * (rates.cachedInput ?? 0)
      + tokens.cacheCreation * (rates.cacheWrite ?? rates.input ?? 0)
      + tokens.output * (rates.output ?? 0))
    / PER_MILLION
  );
}

/**
 * Whether `rates` can price every dimension `tokens` actually uses.
 *
 * A dimension with no tokens needs no rate — pricing a request that created no
 * cache entries must not fail for want of a cache-write rate. Cache creation
 * is covered by `cacheWrite` *or* `input`, matching what `costOf` charges it.
 */
export function ratesCoverTokens(tokens: UsageTokens, rates: Rates): boolean {
  if (tokens.input > 0 && rates.input === undefined) return false;
  if (tokens.output > 0 && rates.output === undefined) return false;
  if (tokens.cacheRead > 0 && rates.cachedInput === undefined) return false;
  if (tokens.cacheCreation > 0 && rates.cacheWrite === undefined && rates.input === undefined) return false;
  return true;
}

/** OAuth subscriptions value work at list rates but never bill per token. */
function relabelCovered(auth: NativeGatewayAuth | undefined, price: LedgerPrice): LedgerPrice {
  if (price.source === 'none' || auth === undefined || !isOauthGatewayAuth(auth)) return price;
  return { ...price, source: 'covered' };
}

/**
 * The provider consulted when every named `pricing_provider` comes up empty.
 *
 * models.dev's first-party entries lag: `deepseek-v4.1-flash` is absent from
 * its `deepseek` provider while eight resellers publish it. OpenRouter is the
 * broadest of those and quotes this model at the lab's own list rate, which is
 * what a gateway reselling at list actually charges. It is a *proxy* — a
 * gateway that marks up is priced wrong by that markup — so it is consulted
 * only after every provider the config named, never instead of one.
 */
export const PRICE_FALLBACK_PROVIDER = 'openrouter';

/**
 * Which models.dev provider serves a gateway of this name.
 *
 * This is NOT `PROVIDER_FOR_GATEWAY` (`src/native/providers.ts`) and must not
 * be folded into it. That table names *LiteLLM* provider prefixes, which pick
 * a wire format; this one names *models.dev* provider ids, which pick a price
 * table. The namespaces overlap enough to look interchangeable and are not:
 * LiteLLM wants `gemini` where models.dev files `google`, so sharing one table
 * would produce a lookup that silently returns no rate — the failure mode
 * hardest to notice, since an unpriced row looks exactly like a model nobody
 * has published a price for.
 *
 * Every id here was checked against a real models.dev feed. A gateway whose id
 * could not be confirmed is deliberately absent rather than guessed: an absent
 * entry costs a `pricing_provider` line the user types themselves, while a
 * wrong one prices real spend against the wrong provider's rates — and one
 * model spans an 8x range across serving providers.
 *
 * A name alone is only ever a *proposal*. It says nothing about markup: these
 * rates are right for a gateway reselling at the lab's list rate, which is the
 * same assumption `pricing_provider` already carries wherever it is set by hand.
 */
export const MODELSDEV_PROVIDER_FOR_GATEWAY: Record<string, string> = {
  openai: 'openai',
  'openai-codex': 'openai',
  codex: 'openai',
  anthropic: 'anthropic',
  deepseek: 'deepseek',
  // models.dev files Gemini under `google`; LiteLLM calls the same provider
  // `gemini`. This line is the whole reason the two tables stay separate.
  google: 'google',
  mistral: 'mistral',
  xai: 'xai',
  openrouter: 'openrouter',
  groq: 'groq',
  together: 'togetherai',
  together_ai: 'togetherai',
  fireworks: 'fireworks-ai',
  fireworks_ai: 'fireworks-ai',
  cerebras: 'cerebras',
  deepinfra: 'deepinfra',
  'deep-infra': 'deepinfra',
  nebius: 'nebius',
  perplexity: 'perplexity',
  novita: 'novita-ai',
  'github-copilot': 'github-copilot',
  opencode: 'opencode',
  'opencode-go': 'opencode-go',
  azure: 'azure',
  huggingface: 'huggingface',
  moonshotai: 'moonshotai',
  zai: 'zai',
  minimax: 'minimax',
  nvidia: 'nvidia',
  nvidia_nim: 'nvidia',
  vercel: 'vercel',
  siliconflow: 'siliconflow',
  modelscope: 'modelscope',
  baseten: 'baseten',
  chutes: 'chutes',
  venice: 'venice',
  upstage: 'upstage',
  cohere: 'cohere',
};

/** What an OAuth credential proves about whose models a gateway serves. */
const MODELSDEV_PROVIDER_FOR_AUTH: Record<string, string> = {
  'codex-oauth': 'openai',
  'copilot-oauth': 'github-copilot',
};

/**
 * A `pricing_provider` proposal for a gateway, or `undefined` when sonata
 * cannot say.
 *
 * Auth is consulted **before** the name, because the name is the less reliable
 * of the two: a gateway called `codex` serves OpenAI models, and a user is
 * free to name a gateway anything at all, while an OAuth credential can only
 * ever reach the backend that issued it.
 *
 * `undefined` is a real answer, and the common one for a custom gateway. A
 * caller must leave the key out rather than substitute a default — an
 * unpriced row states that sonata does not know, which is the truth, whereas a
 * wrong provider states a number that is wrong by its own markup.
 */
export function proposePricingProvider(
  gateway: string,
  auth: NativeGatewayAuth | undefined,
): string[] | undefined {
  const byAuth = auth === undefined ? undefined : MODELSDEV_PROVIDER_FOR_AUTH[auth];
  const provider = byAuth ?? MODELSDEV_PROVIDER_FOR_GATEWAY[gateway];
  return provider === undefined ? undefined : [provider];
}

/**
 * Match a bare model id against a provider that vendor-qualifies its keys.
 *
 * A sonata config carries the upstream id its gateway serves (`
 * deepseek-v4.1-flash`), while OpenRouter files the same model under
 * `deepseek/deepseek-v4.1-flash`. `normalizeModelName` only ever *strips*
 * prefixes, so nothing here could ever match without comparing the part after
 * the first slash.
 *
 * Two vendors may publish the same model name, so a match is only taken when
 * every candidate agrees on the rate. Choosing between two different prices
 * would be a coin flip on a money value — the same refusal the partial-rate
 * check makes just below.
 */
function qualifiedMatch(table: Record<string, Rates>, name: string): Rates | undefined {
  let found: Rates | undefined;
  if (name === '') return undefined;
  for (const [key, rates] of Object.entries(table)) {
    const slash = key.indexOf('/');
    // The key has to be genuinely vendor-qualified. `/model` carries no
    // vendor and `vendor/` carries no model, and both satisfied a naive
    // suffix test — the first pricing any id that happened to follow a stray
    // slash, the second matching whatever an empty name was compared against.
    if (slash <= 0 || slash === key.length - 1) continue;
    if (key.slice(slash + 1) !== name) continue;
    if (found === undefined) { found = rates; continue; }
    if (!sameRates(found, rates)) return undefined;
  }
  return found;
}

function sameRates(a: Rates, b: Rates): boolean {
  return a.input === b.input && a.output === b.output
    && a.cachedInput === b.cachedInput && a.cacheWrite === b.cacheWrite;
}

/** The named providers, then OpenRouter as the implicit last resort. */
function withFallbackProvider(provider: readonly string[]): readonly string[] {
  return provider.includes(PRICE_FALLBACK_PROVIDER) ? provider : [...provider, PRICE_FALLBACK_PROVIDER];
}

/**
 * The spellings a ranking catalog may be asked about for a model a gateway
 * serves: the id, then its models.dev display name (`catalogSpellingsFor`).
 *
 * The providers consulted are the ones pricing consults — the gateway's
 * `pricing_provider`, else the proposal its name and auth would have earned,
 * then OpenRouter — because a slug is only meaningful under its own provider.
 * A gateway created this run has no config yet, which is why the proposal
 * stands in: that is exactly the BYOK DeepSeek gateway whose every model
 * ranked from the unscored default.
 */
export function catalogSpellingsForGateway(
  modelsDev: ModelsDevCache | undefined,
  gateway: { name: string; auth?: NativeGatewayAuth; pricingProvider?: readonly string[] } | undefined,
  id: string,
): string[] {
  if (modelsDev?.names === undefined || gateway === undefined) return [id];
  const named = gateway.pricingProvider ?? proposePricingProvider(gateway.name, gateway.auth) ?? [];
  return catalogSpellingsFor(modelsDev.names, withFallbackProvider(named), id);
}

/**
 * A config key as the catalog spellings of the model it names — the resolver
 * every config-reading caller (`sonata agents`, `doctor`, `loadConfig`'s
 * effort check) hands to the catalog helpers.
 */
export function configUpstreamFor(
  config: Pick<SonataConfig, 'unifiedModels' | 'native'>,
  modelsDev: ModelsDevCache | undefined,
): UpstreamFor {
  return (key) => {
    const model = config.unifiedModels[key];
    if (model === undefined) return [key];
    const gatewayName = model.gateway;
    const gateway = gatewayName === undefined ? undefined : config.native?.gateways[gatewayName];
    const id = model.id ?? model.harnessId ?? key;
    if (gatewayName === undefined || gateway === undefined) return [id];
    return catalogSpellingsForGateway(modelsDev, { name: gatewayName, auth: gateway.auth, pricingProvider: gateway.pricingProvider }, id);
  };
}

export function resolvePrice(
  config: SonataConfig,
  key: string | undefined,
  tokens: UsageTokens,
  at: Date,
  modelsDev?: ModelsDevCache,
): LedgerPrice {
  if (key === undefined) return { source: 'none' };
  const model = config.unifiedModels[key];
  if (model === undefined) return { source: 'none' };

  const gateway = model.gateway === undefined ? undefined : config.native?.gateways[model.gateway];

  const modelRates = ratesFor(model.price, at);
  if (modelRates !== undefined) {
    const totalUsd = costOf(tokens, modelRates);
    if (!Number.isFinite(totalUsd)) return { source: 'none' };
    return relabelCovered(gateway?.auth, { source: 'model', totalUsd });
  }

  const gatewayRates = ratesFor(gateway?.price, at);
  if (gatewayRates !== undefined) {
    const totalUsd = costOf(tokens, gatewayRates);
    if (!Number.isFinite(totalUsd)) return { source: 'none' };
    return relabelCovered(gateway?.auth, { source: 'gateway', totalUsd });
  }

  const provider = gateway?.pricingProvider;
  if (provider === undefined || modelsDev === undefined || model.id === undefined) {
    return { source: 'none' };
  }
  // The raw upstream id is tried before the normalized name, because
  // models.dev keys each provider the way that provider does: `openai` files
  // `gpt-5.6-terra`, but `openrouter` files `nvidia/nemotron-3.5-lightning:free`
  // — vendor prefix and serving-variant suffix included. `normalizeModelName`
  // strips exactly those, so a normalized-only lookup could never match an
  // OpenRouter model and every such row priced as unpriced. Raw-first cannot
  // mis-match: an exact hit under the named provider *is* that model. The
  // normalized name stays as the fallback for a config whose id is already
  // bare, and the two collapse to one lookup when they are equal.
  const names = [model.id, normalizeModelName(model.id)];
  const lookup = names[0] === names[1] ? [names[0]] : names;
  // Provider order is the user's stated preference, so it is the outer loop:
  // an exact-but-later provider must not beat an earlier one. OpenRouter is
  // appended as an implicit last resort — never ahead of anything named — so
  // a model the lab itself has not listed can still be priced from the rate
  // models.dev already holds for it. Naming it yourself simply moves it up.
  let scraped: Rates | undefined;
  outer: for (const id of withFallbackProvider(provider)) {
    const table = modelsDev.providers[id];
    if (table === undefined) continue;
    for (const name of lookup) {
      const hit = table[name] ?? qualifiedMatch(table, name);
      if (hit !== undefined) { scraped = hit; break outer; }
    }
  }
  if (scraped === undefined) return { source: 'none' };
  // A scraped rate table is not a statement of intent the way a hand-written
  // `[price]` block is, so a partial one must decline rather than fill the
  // gaps with zero: `costOf` prices an absent dimension at 0 by contract, and
  // a row priced $0 is *worse* than an unpriced one — it counts as priced, so
  // it disappears from the unpriced tally that would otherwise show it, and
  // `[budget] daily_usd` treats the volume as free. Latent today (every one of
  // the 7181 costed models on models.dev carries both input and output), which
  // is exactly why it would go unnoticed if the feed ever changed.
  if (!ratesCoverTokens(tokens, scraped)) return { source: 'none' };

  const totalUsd = costOf(tokens, scraped);
  if (!Number.isFinite(totalUsd)) return { source: 'none' };
  return relabelCovered(gateway?.auth, {
    source: 'models-dev',
    totalUsd,
    observedAt: modelsDev.fetchedAt,
  });
}
