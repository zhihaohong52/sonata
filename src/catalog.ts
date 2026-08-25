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
  models: Record<string, { codingIndex: number; blendedPriceUsd: number }>;
}

/**
 * Collapses the many spellings of one model to a single name: harness and
 * provider prefixes go (`opencode-anexto-…`, `openai/…`), and a trailing
 * MMDD date suffix goes (`-0731`). Idempotent, so a normalized name can be
 * normalized again safely.
 */
export function normalizeModelName(raw: string): string {
  let name = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw;
  const PREFIXES = ['opencode-', 'codex-', 'pi-', 'reasonix-', 'claude-harness-',
    'anexto-', 'openrouter-', 'openai-', 'google-', 'anthropic-'];
  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const p of PREFIXES) {
      if (name.startsWith(p) && name.length > p.length) { name = name.slice(p.length); stripped = true; }
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

export function lookupModel(name: string, aa?: AaCatalog): CatalogEntry {
  const normalized = normalizeModelName(name);
  const scored = aa?.models[normalized];
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

/** Rank for ordering within a tier: AA coding index when known, else a fixed
 * mid score so curated/default models interleave stably. */
function rank(key: string, aa?: AaCatalog): { index: number; price: number } {
  const scored = aa?.models[normalizeModelName(key)];
  return scored !== undefined
    ? { index: scored.codingIndex, price: scored.blendedPriceUsd }
    : { index: AA_CAPABLE_CODING_INDEX, price: AA_CHEAP_BLENDED_PRICE_USD };
}

export function proposeTiers(modelKeys: string[], aa?: AaCatalog): TierProposal {
  const byRank = (a: string, b: string) => {
    const ra = rank(a, aa); const rb = rank(b, aa);
    return rb.index - ra.index || ra.price - rb.price;
  };
  const complex = modelKeys.filter((k) => lookupModel(k, aa).capable).sort(byRank);
  const simple = modelKeys
    .filter((k) => { const e = lookupModel(k, aa); return e.capable && e.cheap; })
    .sort(byRank);
  // A tier must always resolve to something: with no capable model, everything
  // is complex-eligible; with no cheap-capable model, simple mirrors complex.
  const complexFinal = complex.length > 0 ? complex : [...modelKeys];
  const simpleFinal = simple.length > 0 ? simple : complexFinal;
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
    return doc;
  } catch {
    return undefined;
  }
}
