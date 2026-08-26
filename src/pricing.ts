/**
 * Turning token counts into money, or honestly declining to.
 *
 * Resolution order is model price, gateway price, scraped price, then nothing.
 * A scraped price applies only when the gateway identifies its serving provider:
 * the same model can cost materially different amounts across providers.
 */
import type { PriceConfig, PriceWindow, Rates, SonataConfig } from './config.js';
import type { LedgerPrice } from './ledger.js';
import type { UsageTokens } from './native/usage.js';
import { normalizeModelName } from './catalog.js';
import type { AiPricingCache } from './aipricing.js';

function minutes(hhmm: string): number {
  const [hours, minutesPart] = hhmm.split(':');
  return Number(hours) * 60 + Number(minutesPart);
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
      return {
        input: window.input,
        cachedInput: window.cachedInput,
        output: window.output,
      };
    }
  }

  const flat: Rates = {
    input: price.input,
    cachedInput: price.cachedInput,
    output: price.output,
  };
  return flat.input === undefined && flat.cachedInput === undefined && flat.output === undefined
    ? undefined
    : flat;
}

const PER_MILLION = 1_000_000;

export function costOf(tokens: UsageTokens, rates: Rates): number {
  return (
    (tokens.input * (rates.input ?? 0)
      + tokens.cacheRead * (rates.cachedInput ?? 0)
      + tokens.cacheCreation * (rates.input ?? 0)
      + tokens.output * (rates.output ?? 0))
    / PER_MILLION
  );
}

export function resolvePrice(
  config: SonataConfig,
  key: string | undefined,
  tokens: UsageTokens,
  at: Date,
  aiPricing?: AiPricingCache,
): LedgerPrice {
  if (key === undefined) return { source: 'none' };
  const model = config.unifiedModels[key];
  if (model === undefined) return { source: 'none' };

  const modelRates = ratesFor(model.price, at);
  if (modelRates !== undefined) {
    return { source: 'model', totalUsd: costOf(tokens, modelRates) };
  }

  const gateway = model.gateway === undefined ? undefined : config.native?.gateways[model.gateway];
  const gatewayRates = ratesFor(gateway?.price, at);
  if (gatewayRates !== undefined) {
    return { source: 'gateway', totalUsd: costOf(tokens, gatewayRates) };
  }

  const provider = gateway?.pricingProvider;
  if (provider === undefined || aiPricing === undefined || model.id === undefined) {
    return { source: 'none' };
  }
  const scraped = aiPricing.models[normalizeModelName(model.id)]?.[provider];
  if (scraped === undefined) return { source: 'none' };

  return {
    source: 'ai-pricing',
    totalUsd: costOf(tokens, scraped),
    observedAt: aiPricing.fetchedAt,
  };
}
