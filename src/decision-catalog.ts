/**
 * Artificial Analysis Decision Index scores for decision models, cached beside
 * the AA catalog.
 *
 * Decision models (Jev and the open models that copy its API) are ranked by
 * AA's Decision Index — a weighted average of AA-Omniscience-Decision,
 * HLE-MultiChoice, When2Call and WildGuardTest — with its efficiency figures
 * (cost and time per task) breaking ties. AA's v2 API does not cover decision
 * models, so the leaderboard page is the source: it embeds one JSON object per
 * model (`kind: "decisionModel"`) in its Next.js payload, which `parseDecisionIndex`
 * lifts out. That is scraping an undocumented shape, so a page that changes
 * fails the update loudly (zero decision models is an error) and the previous
 * cache stays in place. The data is not committed; tests use a hand-built
 * fixture.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const DECISION_INDEX_URL = 'https://artificialanalysis.ai/evaluations/artificial-analysis-decision-index';
export const DECISION_INDEX_REVISION = 'Decision Index v1.0';
export const DECISION_INDEX_ATTRIBUTION = 'Decision-model scores by Artificial Analysis — https://artificialanalysis.ai/evaluations/artificial-analysis-decision-index';
const FETCH_TIMEOUT_MS = 30_000;

export interface DecisionCatalogEntry {
  key: string; display: string; repo?: string;
  /** The Decision Index score (0–100). */
  capability: number;
  /** Cost per 1,000 tasks in USD (AA publishes it per task; the efficiency tab shows it per 1M). */
  usdPer1000?: number;
  /** Median time per task, in milliseconds. */
  msPerTask?: number;
}
export interface DecisionCatalog { fetchedAt: string; revision: string; sourceSha256?: string; systems: DecisionCatalogEntry[] }

export function decisionCatalogPath(home: string): string {
  return join(home, '.config', 'sonata', 'decision-catalog.json');
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The object starting at `start` (a `{`), by brace depth with strings skipped. */
function objectAt(text: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return undefined;
}

/**
 * Capability is AA's own Decision Index, which leaves cost and speed out so
 * that they can only ever break a tie (the spec's quality-first rule).
 */
function entryOf(row: unknown): DecisionCatalogEntry | undefined {
  if (row === null || typeof row !== 'object') return undefined;
  const r = row as { slug?: unknown; name?: unknown; indexScore?: unknown; costPerTaskUsd?: unknown; timePerTaskMs?: unknown };
  if (typeof r.slug !== 'string' || !finite(r.indexScore)) return undefined;
  return {
    key: r.slug,
    display: typeof r.name === 'string' ? r.name : r.slug,
    capability: r.indexScore,
    ...(finite(r.costPerTaskUsd) && r.costPerTaskUsd >= 0 ? { usdPer1000: r.costPerTaskUsd * 1000 } : {}),
    ...(finite(r.timePerTaskMs) && r.timePerTaskMs >= 0 ? { msPerTask: r.timePerTaskMs } : {}),
  };
}

/** The decision models in the leaderboard page's HTML; throws when it holds none. */
export function parseDecisionIndex(html: string, fetchedAt: string): DecisionCatalog {
  // The payload sits inside JS string literals, so its quotes are escaped.
  const text = html.replace(/\\"/g, '"');
  const systems: DecisionCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/\{"slug":"[^"]+","kind":"decisionModel"/g)) {
    const raw = objectAt(text, match.index);
    if (raw === undefined) continue;
    let entry: DecisionCatalogEntry | undefined;
    try { entry = entryOf(JSON.parse(raw)); } catch { continue; }
    if (entry !== undefined && !seen.has(entry.key)) {
      seen.add(entry.key);
      systems.push(entry);
    }
  }
  if (systems.length === 0) throw new Error('no decision models found on the Decision Index page (its format may have changed)');
  return { fetchedAt, revision: DECISION_INDEX_REVISION, systems };
}

export function loadDecisionCatalog(home: string): DecisionCatalog | undefined {
  const path = decisionCatalogPath(home);
  if (!existsSync(path)) return undefined;
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8')) as DecisionCatalog;
    if (typeof doc.fetchedAt !== 'string' || !Array.isArray(doc.systems)) return undefined;
    const systems = doc.systems.filter((e) => e !== null && typeof e === 'object'
      && typeof e.key === 'string' && finite(e.capability));
    return { ...doc, systems };
  } catch {
    return undefined;
  }
}

export async function updateDecisionCatalog(
  home: string, fetchFn: typeof fetch, deps: { now?: () => Date },
): Promise<{ systems: number; path: string; fetchedAt: string; revision: string }> {
  const response = await fetchFn(DECISION_INDEX_URL, { redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Decision Index request failed (HTTP ${response.status})`);
  let html: string;
  try { html = await response.text(); } catch { throw new Error('malformed Decision Index response body'); }
  const fetchedAt = (deps.now?.() ?? new Date()).toISOString();
  const catalog = parseDecisionIndex(html, fetchedAt);
  const path = decisionCatalogPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o600 });
  return { systems: catalog.systems.length, path, fetchedAt, revision: catalog.revision };
}
