/**
 * JevBench scores for decision models, cached beside the AA catalog.
 *
 * Decision models (Jev and the open models that copy its API) are ranked by
 * JevBench rather than AA, which does not cover them. Pinned to one revision
 * because the site publishes no "latest" index — its root serves an older v1
 * document — so a new revision is adopted by changing JEVBENCH_URL, the way
 * the LiteLLM version is pinned. The data is not committed; tests use a
 * hand-built fixture.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const JEVBENCH_URL = 'https://benchmarkheaven.com/api/jevbench/v1.5.4';
export const JEVBENCH_ATTRIBUTION = 'Decision-model scores by JevBench (Benchmark Heaven) — https://benchmarkheaven.com/jev-models';
const FETCH_TIMEOUT_MS = 30_000;

export interface DecisionCatalogEntry { key: string; display: string; repo?: string; capability: number; usdPer1000?: number }
export interface DecisionCatalog { fetchedAt: string; revision: string; sourceSha256?: string; systems: DecisionCatalogEntry[] }

export function decisionCatalogPath(home: string): string {
  return join(home, '.config', 'sonata', 'decision-catalog.json');
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Capability is the mean of JevBench's intelligence and calibration axes —
 * its own "Capability" figure, which leaves speed and cost out so that cost
 * can only ever break a tie (the spec's quality-first rule).
 */
function entryOf(system: unknown): DecisionCatalogEntry | undefined {
  if (system === null || typeof system !== 'object') return undefined;
  const s = system as { key?: unknown; display?: unknown; repo?: unknown; axes?: { intelligence?: unknown; calibration?: unknown }; cost?: { usd_per_1000?: unknown } };
  if (typeof s.key !== 'string' || !finite(s.axes?.intelligence) || !finite(s.axes?.calibration)) return undefined;
  return {
    key: s.key,
    display: typeof s.display === 'string' ? s.display : s.key,
    ...(typeof s.repo === 'string' ? { repo: s.repo } : {}),
    capability: (s.axes.intelligence + s.axes.calibration) / 2,
    ...(finite(s.cost?.usd_per_1000) && s.cost.usd_per_1000 >= 0 ? { usdPer1000: s.cost.usd_per_1000 } : {}),
  };
}

export function parseJevBench(json: unknown, fetchedAt: string): DecisionCatalog {
  const doc = json as { revision?: unknown; source_sha256?: unknown; systems?: unknown };
  if (doc === null || typeof doc !== 'object' || !Array.isArray(doc.systems)) {
    throw new Error('malformed JevBench response (expected a systems array)');
  }
  return {
    fetchedAt,
    revision: typeof doc.revision === 'string' ? doc.revision : 'unknown',
    ...(typeof doc.source_sha256 === 'string' ? { sourceSha256: doc.source_sha256 } : {}),
    systems: doc.systems.map(entryOf).filter((e): e is DecisionCatalogEntry => e !== undefined),
  };
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
  const response = await fetchFn(JEVBENCH_URL, { redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`JevBench request failed (HTTP ${response.status})`);
  let json: unknown;
  try { json = await response.json(); } catch { throw new Error('malformed JevBench response body'); }
  const fetchedAt = (deps.now?.() ?? new Date()).toISOString();
  const catalog = parseJevBench(json, fetchedAt);
  const path = decisionCatalogPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o600 });
  return { systems: catalog.systems.length, path, fetchedAt, revision: catalog.revision };
}
