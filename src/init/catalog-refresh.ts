import { hasTaskCost, loadAaCatalog, type AaCatalog } from '../catalog.js';
import { cmdCatalogUpdate } from '../commands/catalog.js';
import { loadModelsDev, type ModelsDevCache } from '../modelsdev.js';
import { resolveKeyFromSource } from '../native/credentials.js';
import { catalogSpellingsForGateway } from '../pricing.js';
import type { NativeCandidate } from './helpers.js';

/**
 * How recent a catalog has to be before init stops refetching it for a model
 * it does not cover.
 *
 * Coverage, not age, is what triggers the refresh: a model released yesterday
 * is missing from a catalog fetched last week, and the 30-day age warning in
 * `sonata doctor` never fires on that. But a model AA has genuinely not scored
 * yet stays uncovered after a refresh too, so without this floor every init
 * would refetch the whole catalog for it.
 */
export const CATALOG_REFRESH_MIN_AGE_HOURS = 12;

export interface CatalogRefreshDeps {
  home: string;
  /** Whether an Artificial Analysis key is stored — there is nothing to refresh with otherwise. */
  hasKey: () => boolean;
  /** Fetch and write the catalogs; resolves with AA's outcome. */
  update: () => Promise<{ models: number } | { error: Error }>;
  now: () => Date;
}

/** The real machine: the stored AA key and `sonata catalog update`. */
export function realCatalogRefreshDeps(home: string): CatalogRefreshDeps {
  return {
    home,
    hasKey: () => resolveKeyFromSource('artificialanalysis', home, 'sonata') !== undefined,
    update: async () => (await cmdCatalogUpdate(home)).aa,
    now: () => new Date(),
  };
}

/**
 * Candidate keys the cached catalog cannot rank — the models init's picker
 * leaves out. Resolved through the same spellings the picker uses, so a model
 * counted here is exactly one the picker would hide.
 */
export function uncoveredCandidates(
  candidates: readonly NativeCandidate[],
  catalog: AaCatalog,
  modelsDev: ModelsDevCache | undefined,
): string[] {
  const gatewayNames = [...new Set(candidates.map((candidate) => candidate.gateway))];
  return candidates
    .filter((candidate) => !hasTaskCost(
      candidate.key,
      catalog,
      gatewayNames,
      () => catalogSpellingsForGateway(modelsDev, { name: candidate.gateway, auth: candidate.auth }, candidate.id),
    ))
    .map((candidate) => candidate.key);
}

/**
 * Refreshes the ranking catalog before the wizard reads it, when a discovered
 * model is missing from it.
 *
 * Without this a new harness model — `gpt-6.1-sol` from codex — was silently
 * absent from the picker until the user thought to run `sonata catalog
 * update`, and it recurred with every model release. Never fatal: a failed
 * fetch leaves the existing cache, and init goes on with it.
 */
export async function refreshCatalogIfUncovered(
  candidates: readonly NativeCandidate[],
  deps: CatalogRefreshDeps,
  out: (line: string) => void,
): Promise<void> {
  if (candidates.length === 0 || !deps.hasKey()) return;
  const catalog = loadAaCatalog(deps.home);
  let reason: string;
  if (catalog === undefined) {
    reason = 'no ranking catalog cached';
  } else {
    // An unreadable stamp counts as old: refreshing is what repairs it.
    const fetchedAt = Date.parse(catalog.fetchedAt);
    const ageHours = Number.isFinite(fetchedAt) ? (deps.now().getTime() - fetchedAt) / 3_600_000 : Infinity;
    if (ageHours < CATALOG_REFRESH_MIN_AGE_HOURS) return;
    const missing = uncoveredCandidates(candidates, catalog, loadModelsDev(deps.home));
    if (missing.length === 0) return;
    const shown = missing.slice(0, 3).join(', ');
    reason = `${missing.length} model${missing.length === 1 ? '' : 's'} not in the ranking catalog (${shown}${missing.length > 3 ? ', …' : ''})`;
  }
  out(`  ${reason} — refreshing it from Artificial Analysis…`);
  const result = await deps.update();
  if ('error' in result) {
    out(`  ! catalog refresh failed: ${result.error.message} — ranking from the cached catalog`);
  } else {
    out(`  catalog refreshed: ${result.models} models`);
  }
}
