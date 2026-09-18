import type { SonataConfig } from '../../config.js';
import { splitCandidate } from '../../effort.js';

/** One configured model as the models screen draws it. */
export interface ModelRow { key: string; route: string; tiers: string[] }

/**
 * Models and the tier aliases that can reach them.
 *
 * Tier entries carry an optional reasoning-effort suffix, but reachability is
 * still a property of the configured model key; comparing the whole candidate
 * would make an effort-pinned model appear untiered.
 */
export function modelRows(config: SonataConfig): ModelRow[] {
  const tiersByKey = new Map<string, string[]>();
  for (const [role, lists] of Object.entries(config.tiers ?? {})) {
    for (const tier of ['simple', 'normal', 'complex'] as const) {
      const candidates = lists[tier];
      if (candidates === undefined) continue;
      for (const candidate of candidates) {
        const key = splitCandidate(candidate).key;
        const tiers = tiersByKey.get(key) ?? [];
        const alias = `${role}-${tier}`;
        if (!tiers.includes(alias)) tiers.push(alias);
        tiersByKey.set(key, tiers);
      }
    }
  }
  return Object.entries(config.unifiedModels).map(([key, model]) => ({
    key,
    route: model.gateway !== undefined
      ? `${model.gateway}/${model.id}`
      : `${model.harness}/${model.harnessId}`,
    tiers: tiersByKey.get(key) ?? [],
  }));
}

/** Models configured but absent from every tier are unreachable by an alias. */
export function modelsUntiered(rows: readonly ModelRow[]): string[] {
  return rows.filter((row) => row.tiers.length === 0).map((row) => row.key);
}
