import { TIER_NAMES, type SonataConfig } from '../../config.js';
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
    // `TIER_NAMES` rather than a literal: this repository has a documented
    // failure where a constant rebuilt at a new call site drifts from its
    // definition — `tiersCollapse` was rebuilt three times and one copy was
    // wrong, promising 8 agent files where `sync` wrote 4. A literal here
    // would silently omit any tier later added to the enum.
    for (const tier of TIER_NAMES) {
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

/**
 * The tiers reaching a model, short enough to stay on one line.
 *
 * Listing the aliases does not survive contact with a real config: four roles
 * × three tiers is twelve names, which wrapped to three lines at 72 columns
 * and to three again at 100. A wrapped row stops being a row, which is the one
 * thing the board grammar does not allow — and twelve names answer a question
 * nobody asks, since what a reader wants here is "can anything reach this".
 *
 * Roles are grouped by the tier set they share, because that is the shape a
 * real config has: models are usually reachable at the same tiers across every
 * role, so one group covers all four. A model reachable differently per role
 * is the interesting case, and grouping is what makes it stand out instead of
 * hiding in a list where every entry looks alike.
 */
export function summariseTiers(tiers: readonly string[]): string {
  if (tiers.length === 0) return 'no tier reaches it';
  const byRole = new Map<string, string[]>();
  for (const alias of tiers) {
    // Split on the LAST hyphen: the tier is one segment, the role may not be.
    const cut = alias.lastIndexOf('-');
    if (cut <= 0) continue;
    const role = alias.slice(0, cut);
    const list = byRole.get(role) ?? [];
    list.push(alias.slice(cut + 1));
    byRole.set(role, list);
  }
  if (byRole.size === 0) return tiers.join(', ');
  const groups = new Map<string, string[]>();
  for (const [role, list] of byRole) {
    // Ordered by TIER_NAMES, not alphabetically, so the grouping key is stable
    // and the tiers read in the order they escalate.
    const set = TIER_NAMES.filter((tier) => list.includes(tier)).join(', ');
    groups.set(set, [...(groups.get(set) ?? []), role]);
  }
  return [...groups]
    .map(([set, roles]) => `${set} (${roles.length === 1 ? roles[0]! : `${roles.length} roles`})`)
    .join(' · ');
}
