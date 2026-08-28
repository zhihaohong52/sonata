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

/**
 * The free language-models endpoint, not `/data/llms/models`.
 *
 * It is the only one that publishes
 * `artificial_analysis_intelligence_index_cost.cost_per_task` — the dollars to
 * run one benchmark task, which prices the *work* rather than the tokens — and
 * `artificial_analysis_agentic_index`, the closest published proxy to what a
 * sonata subagent does. It is paginated, so every page is fetched.
 */
const AA_MODELS_URL = 'https://artificialanalysis.ai/api/v2/language/models/free';

/** Pages are 200 models; this bounds a malformed `total_pages` rather than looping forever. */
const AA_MAX_PAGES = 20;
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

  const entries: unknown[] = [];
  let indexVersion: string | undefined;
  for (let page = 1; page <= AA_MAX_PAGES; page += 1) {
    const response = await fetchFn(`${AA_MODELS_URL}?page=${page}`, { headers: { 'x-api-key': key } });
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
    entries.push(...body.data);

    // Scores are only comparable within one index version, so a cache that
    // silently mixed two would rank models against different scales.
    const version = isRecord(body) && body.intelligence_index_version !== undefined
      ? String(body.intelligence_index_version)
      : undefined;
    if (version !== undefined) {
      if (indexVersion !== undefined && indexVersion !== version) {
        throw new Error(
          `sonata catalog update: response changed index version mid-fetch (${indexVersion} then ${version}) — ` +
          'retry, rather than caching two incomparable scales',
        );
      }
      indexVersion = version;
    }

    const pagination = isRecord(body) && isRecord(body.pagination) ? body.pagination : undefined;
    if (pagination?.has_more !== true) break;
  }

  const models: AaCatalog['models'] = {};
  for (const value of entries) {
    if (!isRecord(value)) continue;
    const name = modelName(value);
    const codingIndex = numberAt(value, 'evaluations', 'artificial_analysis_coding_index');
    const intelligenceIndex = numberAt(value, 'evaluations', 'artificial_analysis_intelligence_index');
    const agenticIndex = numberAt(value, 'evaluations', 'artificial_analysis_agentic_index');
    const costPerTask = numberAt(
      value, 'artificial_analysis_intelligence_index_cost', 'cost_per_task', 'total_cost',
    );
    // This endpoint publishes per-token rates but no blended figure, so the
    // 3:1 input:output blend the old endpoint served is computed here. It is
    // the weaker cost measure — kept only for models AA has not costed per
    // task — but every model needs *some* price or it cannot be ranked at all.
    const input = numberAt(value, 'pricing', 'price_1m_input_tokens');
    const output = numberAt(value, 'pricing', 'price_1m_output_tokens');
    const blendedPriceUsd = input !== undefined && output !== undefined
      ? (input * 3 + output) / 4
      : undefined;

    // A model needs a capability score and a price to be rankable; anything
    // else here is a bonus.
    const capability = agenticIndex ?? codingIndex ?? intelligenceIndex;
    const price = costPerTask ?? blendedPriceUsd;
    if (name === undefined || capability === undefined || price === undefined) continue;
    models[name] = {
      codingIndex: codingIndex ?? capability,
      blendedPriceUsd: blendedPriceUsd ?? price,
      ...(intelligenceIndex === undefined ? {} : { intelligenceIndex }),
      ...(agenticIndex === undefined ? {} : { agenticIndex }),
      ...(costPerTask === undefined ? {} : { costPerTask }),
    };
  }

  // Do not silently replace a usable ranking cache with an unusable response.
  if (Object.keys(models).length === 0) {
    throw new Error(
      'sonata catalog update: response carried no usable model — expected ' +
      'an evaluations index and either a cost_per_task or per-token pricing ' +
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
