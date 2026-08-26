import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  aaCatalogPath,
  normalizeModelName,
  type AaCatalog,
} from '../catalog.js';
import {
  AI_PRICING_URL,
  aiPricingPath,
  normalizeAiPricingRows,
  type AiPricingCache,
} from '../aipricing.js';
import { resolveKeyFromSource } from '../native/credentials.js';

const AA_MODELS_URL = 'https://artificialanalysis.ai/api/v2/data/llms/models';
const AA_GATEWAY = 'artificialanalysis';

interface AaModelResponse {
  data?: unknown;
}

interface AiPricingResponse {
  data?: unknown;
}

export interface CatalogUpdateSuccess {
  models: number;
  path: string;
  fetchedAt: string;
}

export interface CatalogUpdateFailure {
  error: Error;
}

export interface CatalogUpdateResult {
  aa: CatalogUpdateSuccess | CatalogUpdateFailure;
  aiPricing: CatalogUpdateSuccess | CatalogUpdateFailure;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function numberAt(value: unknown, ...path: string[]): number | undefined {
  let current: unknown = value;
  for (const part of path) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return typeof current === 'number' && Number.isFinite(current) ? current : undefined;
}

function modelName(entry: Record<string, unknown>): string | undefined {
  // Slugs are the stable provider/model spelling; display names are the fallback.
  for (const field of ['slug', 'name']) {
    if (typeof entry[field] === 'string' && entry[field].trim() !== '') {
      return normalizeModelName(entry[field]);
    }
  }
  return undefined;
}

function nowIso(deps: { now?: () => Date }): string {
  return (deps.now ?? (() => new Date()))().toISOString();
}

async function updateAaCatalog(
  home: string,
  fetchFn: typeof fetch,
  deps: { now?: () => Date },
): Promise<CatalogUpdateSuccess> {
  const key = resolveKeyFromSource(AA_GATEWAY, home, 'sonata');
  if (key === undefined) {
    throw new Error(
      'sonata catalog update: no key stored — run `sonata auth add artificialanalysis` ' +
      '(free key at https://artificialanalysis.ai)',
    );
  }

  const response = await fetchFn(AA_MODELS_URL, { headers: { 'x-api-key': key } });
  if (!response.ok) {
    const reason = response.status === 401 || response.status === 403 ? 'key rejected' : 'request failed';
    throw new Error(`sonata catalog update: ${reason} (HTTP ${response.status})`);
  }

  let body: unknown;
  try {
    body = await response.json() as AaModelResponse;
  } catch {
    throw new Error('sonata catalog update: malformed response body');
  }
  if (!isRecord(body) || !Array.isArray(body.data)) {
    throw new Error('sonata catalog update: malformed response body (expected data array)');
  }

  const models: AaCatalog['models'] = {};
  for (const value of body.data) {
    if (!isRecord(value)) continue;
    const name = modelName(value);
    const codingIndex = numberAt(value, 'evaluations', 'artificial_analysis_coding_index');
    const blendedPriceUsd = numberAt(value, 'pricing', 'price_1m_blended_3_to_1');
    if (name === undefined || codingIndex === undefined || blendedPriceUsd === undefined) continue;
    models[name] = { codingIndex, blendedPriceUsd };
  }

  // Do not silently replace a usable ranking cache with an unusable response.
  if (Object.keys(models).length === 0) {
    throw new Error(
      'sonata catalog update: response carried no usable model — expected ' +
      'evaluations.artificial_analysis_coding_index and pricing.price_1m_blended_3_to_1 ' +
      'on at least one entry; leaving the existing cache untouched',
    );
  }

  const fetchedAt = nowIso(deps);
  const catalog: AaCatalog = { fetchedAt, models };
  const path = aaCatalogPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o600 });
  return { models: Object.keys(models).length, path, fetchedAt };
}

async function updateAiPricing(
  home: string,
  fetchFn: typeof fetch,
  deps: { now?: () => Date },
): Promise<CatalogUpdateSuccess> {
  const response = await fetchFn(AI_PRICING_URL);
  if (!response.ok) {
    throw new Error(`sonata catalog update: ai-pricing request failed (HTTP ${response.status})`);
  }

  let body: unknown;
  try {
    body = await response.json() as AiPricingResponse;
  } catch {
    throw new Error('sonata catalog update: malformed ai-pricing response body');
  }
  if (!isRecord(body) || !Array.isArray(body.data)) {
    throw new Error('sonata catalog update: malformed ai-pricing response body (expected data array)');
  }

  const models = normalizeAiPricingRows(body.data);
  // A schema change that rejects every row must preserve the last known prices
  // rather than silently turn every later ledger entry into an unpriced one.
  if (Object.keys(models).length === 0) {
    throw new Error(
      'sonata catalog update: ai-pricing response contained no usable price rows; ' +
      'leaving the existing cache untouched',
    );
  }
  const fetchedAt = nowIso(deps);
  const catalog: AiPricingCache = { fetchedAt, models };
  const path = aiPricingPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o600 });
  return { models: Object.keys(models).length, path, fetchedAt };
}

function outcome<T>(promise: Promise<T>): Promise<T | CatalogUpdateFailure> {
  return promise.catch((error: unknown) => ({
    error: error instanceof Error ? error : new Error(String(error)),
  }));
}

/** Fetch independent catalogs so an optional source never blocks the other cache. */
export async function cmdCatalogUpdate(
  home: string,
  deps: { fetch?: typeof fetch; now?: () => Date } = {},
): Promise<CatalogUpdateResult> {
  const fetchFn = deps.fetch ?? fetch;
  const [aa, aiPricing] = await Promise.all([
    outcome(updateAaCatalog(home, fetchFn, deps)),
    outcome(updateAiPricing(home, fetchFn, deps)),
  ]);
  return { aa, aiPricing };
}
