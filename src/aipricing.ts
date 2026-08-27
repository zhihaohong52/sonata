/**
 * Scraped per-token prices from ai-pricing.fyi.
 *
 * The site publishes no licence, so this is treated exactly like the
 * Artificial Analysis catalog: fetched with an explicit `sonata catalog
 * update`, cached under the user's own config directory, and never committed
 * to this repository. Only a hand-written fixture is.
 *
 * Rows are keyed model -> provider, never flattened to model alone: one model
 * spans an 8x price range across serving providers, so which provider a
 * gateway resells is information sonata cannot infer and must be told.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { normalizeModelName } from './catalog.js';
import type { Rates } from './config.js';

export const AI_PRICING_URL = 'https://ai-pricing.fyi/v1/prices/current?limit=1000';
export const AI_PRICING_ATTRIBUTION = 'Prices from ai-pricing.fyi — https://ai-pricing.fyi';

export interface AiPricingCache {
  fetchedAt: string;
  /** normalized model name -> serving provider slug -> rates */
  models: Record<string, Record<string, Rates>>;
}

export function aiPricingPath(home: string): string {
  return join(home, '.config', 'sonata', 'ai-pricing.json');
}

const METRIC: Record<string, keyof Rates> = {
  input_token: 'input',
  output_token: 'output',
  cached_input_token: 'cachedInput',
};

export function normalizeAiPricingRows(rows: unknown[]): AiPricingCache['models'] {
  const out: AiPricingCache['models'] = {};
  for (const raw of rows) {
    if (raw === null || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const field = typeof row.metric === 'string' ? METRIC[row.metric] : undefined;
    if (field === undefined) continue;
    // A batch or EUR row priced into the same slot would be a wrong number
    // wearing the right label.
    if (row.unit !== 'per_1m_tokens' || row.currency !== 'USD') continue;
    if (row.batch_flag === 1 || (row.tier_key !== null && row.tier_key !== undefined && row.tier_key !== 'standard')) continue;
    const slug = row.canonical_slug;
    const provider = row.provider_slug;
    const price = row.price_numeric;
    if (typeof slug !== 'string' || typeof provider !== 'string') continue;
    if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) continue;
    const model = normalizeModelName(slug);
    out[model] ??= {};
    out[model][provider] ??= {};
    out[model][provider][field] = price;
  }
  return out;
}

export function loadAiPricing(home: string): AiPricingCache | undefined {
  const path = aiPricingPath(home);
  if (!existsSync(path)) return undefined;
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8')) as AiPricingCache;
    if (typeof doc.fetchedAt !== 'string') return undefined;
    if (doc.models === null || typeof doc.models !== 'object' || Array.isArray(doc.models)) return undefined;
    if (!modelsAreValid(doc.models)) return undefined;
    return doc;
  } catch {
    return undefined;
  }
}

/**
 * A provider record must be non-empty and contain no unrecognized rate keys
 * and at least one recognized one, with every present rate a finite,
 * non-negative number — otherwise `costOf` would silently price volume at 0
 * (empty record, or one with no recognized key) or produce a wrong `totalUsd`
 * from a string/non-finite value.
 */
const RATE_KEYS: ReadonlySet<string> = new Set(['input', 'cachedInput', 'output']);

function modelsAreValid(models: Record<string, Record<string, Rates>>): boolean {
  for (const providers of Object.values(models)) {
    if (providers === null || typeof providers !== 'object' || Array.isArray(providers)) return false;
    const entries = Object.entries(providers);
    if (entries.length === 0) return false;
    for (const [provider, rates] of entries) {
      if (rates === null || typeof rates !== 'object' || Array.isArray(rates)) return false;
      const entries2 = Object.entries(rates);
      let recognized = 0;
      for (const [key, value] of entries2) {
        // A key outside `Rates` (e.g. `{ unexpected: 1 }`) reads as an empty
        // record to `costOf` — every recognized field defaults to 0 — so it
        // must be rejected rather than silently billing $0.
        if (!RATE_KEYS.has(key)) return false;
        recognized += 1;
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return false;
      }
      if (recognized === 0) return false; // an empty record prices nothing, so `costOf` would say 0
    }
  }
  return true;
}
