/**
 * Which decision model a URL serves best (spec 2026-10-01-decision-model-selection).
 *
 * A URL lists its decision models (`GET /v1/models`); JevBench scores them;
 * the highest capability wins and cost only breaks a tie. Matching is exact
 * after normalisation — a guessed match would rank a model on another
 * model's score, the failure the AA lookup rules exist to prevent. With no
 * scored model, OpenRouter defaults to `~typesafe/jev-latest`, TypeSafe to
 * `jev-latest` (required by its endpoint), and other hosts receive no model.
 */
import type { DecisionCatalog, DecisionCatalogEntry } from '../decision-catalog.js';
import { OPENROUTER_DEFAULT_DECISION_MODEL, TYPESAFE_DEFAULT_DECISION_MODEL } from '../config.js';

export interface ListedDecisionModel { id: string; pricePerToken?: number }

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A `/v1/models` body as decision models, or undefined when it is no list at all. */
export function parseModelListing(json: unknown): ListedDecisionModel[] | undefined {
  if (!isRecord(json)) return undefined;
  if (Array.isArray(json.models)) {
    return json.models.flatMap((m): ListedDecisionModel[] => {
      const id = isRecord(m) ? (typeof m.id === 'string' ? m.id : typeof m.name === 'string' ? m.name : undefined) : undefined;
      return id === undefined ? [] : [{ id }];
    });
  }
  if (Array.isArray(json.data)) {
    // OpenRouter-style: one list for every model, so only entries that say
    // they output decisions count — never a chat model.
    return json.data.flatMap((m): ListedDecisionModel[] => {
      if (!isRecord(m) || typeof m.id !== 'string') return [];
      const outputs = isRecord(m.architecture) ? m.architecture.output_modalities : undefined;
      if (!Array.isArray(outputs) || !outputs.includes('decisions')) return [];
      const price = isRecord(m.pricing) ? Number(m.pricing.prompt) : Number.NaN;
      return [{ id: m.id, ...(Number.isFinite(price) && price >= 0 ? { pricePerToken: price } : {}) }];
    });
  }
  return undefined;
}

/** Lower-case; drop `~`, a `vendor/` prefix, a `:variant`, and a trailing `.0`. */
export function normalizeDecisionId(id: string): string {
  return id.toLowerCase().replace(/^~/, '').replace(/^.*\//, '').replace(/:[^:]*$/, '').replace(/\.0$/, '');
}

const repoTail = (repo: string | undefined): string | undefined => repo?.replace(/\/+$/, '').split('/').pop();

export function scoreFor(id: string, catalog: DecisionCatalog | undefined): DecisionCatalogEntry | undefined {
  if (catalog === undefined) return undefined;
  const want = normalizeDecisionId(id);
  return catalog.systems.find((s) => normalizeDecisionId(s.key) === want)
    ?? catalog.systems.find((s) => {
      const tail = repoTail(s.repo);
      return tail !== undefined && normalizeDecisionId(tail) === want;
    });
}

export function defaultDecisionModel(baseUrl: string): string | undefined {
  try {
    const hostname = new URL(baseUrl).hostname;
    if (hostname === 'openrouter.ai') return OPENROUTER_DEFAULT_DECISION_MODEL;
    if (hostname === 'api.typesafe.ai') return TYPESAFE_DEFAULT_DECISION_MODEL;
    return undefined;
  } catch {
    return undefined;
  }
}

export interface DecisionChoice { model: string | undefined; reason: string; ranked: Array<{ id: string; capability?: number }> }

export function chooseDecisionModel(opts: {
  baseUrl: string; pinned?: string; listed: ListedDecisionModel[] | undefined; catalog: DecisionCatalog | undefined;
}): DecisionChoice {
  if (opts.pinned !== undefined) return { model: opts.pinned, reason: 'pinned', ranked: [] };
  const rows = (opts.listed ?? []).map((m, index) => ({ ...m, index, capability: scoreFor(m.id, opts.catalog)?.capability }));
  rows.sort((a, b) => {
    // Scored before unscored; then capability; then price (unlisted last); then listed order.
    if ((a.capability === undefined) !== (b.capability === undefined)) return a.capability === undefined ? 1 : -1;
    if (a.capability !== undefined && b.capability !== undefined && a.capability !== b.capability) return b.capability - a.capability;
    // Unscored models keep their listed order: price only breaks a tie between scores.
    if (a.capability === undefined) return a.index - b.index;
    const pa = a.pricePerToken ?? Number.POSITIVE_INFINITY;
    const pb = b.pricePerToken ?? Number.POSITIVE_INFINITY;
    return pa !== pb ? pa - pb : a.index - b.index;
  });
  const ranked = rows.map((r) => ({ id: r.id, ...(r.capability === undefined ? {} : { capability: r.capability }) }));
  const best = rows[0];
  if (best !== undefined && best.capability !== undefined) {
    return { model: best.id, reason: `JevBench capability ${best.capability.toFixed(1)}`, ranked };
  }
  const why = opts.listed === undefined ? 'no model list' : opts.catalog === undefined ? 'no decision catalog' : 'no listed model is scored';
  return { model: defaultDecisionModel(opts.baseUrl), reason: `${why} — URL default`, ranked };
}

/** `GET <base>/v1/models`, cached per URL: 1 h on success, 5 min after a failure. */
export class ModelListCache {
  private readonly entries = new Map<string, { at: number; ok: boolean; listed?: ListedDecisionModel[] }>();
  private readonly pending = new Map<string, Promise<ListedDecisionModel[] | undefined>>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly failureTtlMs: number;
  private readonly timeoutMs: number;

  constructor(private readonly fetchFn: typeof fetch, opts: { now?: () => number; ttlMs?: number; failureTtlMs?: number; timeoutMs?: number } = {}) {
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? 60 * 60_000;
    this.failureTtlMs = opts.failureTtlMs ?? 5 * 60_000;
    this.timeoutMs = opts.timeoutMs ?? 3_000;
  }

  async list(baseUrl: string, key: string | undefined): Promise<ListedDecisionModel[] | undefined> {
    const hit = this.entries.get(baseUrl);
    if (hit !== undefined && this.now() - hit.at < (hit.ok ? this.ttlMs : this.failureTtlMs)) return hit.listed;
    const inFlight = this.pending.get(baseUrl);
    if (inFlight !== undefined) return inFlight;
    const fetching = this.fetchList(baseUrl, key);
    this.pending.set(baseUrl, fetching);
    try {
      return await fetching;
    } finally {
      this.pending.delete(baseUrl);
    }
  }

  private async fetchList(baseUrl: string, key: string | undefined): Promise<ListedDecisionModel[] | undefined> {
    let listed: ListedDecisionModel[] | undefined;
    try {
      const res = await this.fetchFn(`${baseUrl}/v1/models`, {
        headers: key === undefined ? {} : { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      listed = res.ok ? parseModelListing(await res.json()) : undefined;
    } catch {
      listed = undefined;
    }
    this.entries.set(baseUrl, { at: this.now(), ok: listed !== undefined, listed });
    return listed;
  }
}
