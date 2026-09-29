// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const SPINNER_ONLY = /^[⠁-⣿|/\\-]+$/;

import type { SonataConfig, TierLists, UnifiedModelConfig } from './config.js';
import { normalizeModelName } from './catalog.js';

export function stripAnsi(s: string): string {
  return s.replace(ANSI, '');
}

export function cleanPane(raw: string): string[] {
  return stripAnsi(raw)
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.length > 0 && !SPINNER_ONLY.test(l.trim()));
}

export function newLines(prev: string[], next: string[]): string[] {
  if (prev.length === 0) return next;

  // Align `prev` inside `next`, allowing for `offset` lines scrolled off the
  // top — least scroll first, which is the longest overlap. The last line of
  // `prev` is exempt from the match: it is the one line a terminal routinely
  // rewrites in place (a prompt since typed after, a redrawn progress line),
  // and requiring it re-emitted the entire capture whenever it changed.
  const last = prev.length - 1;
  for (let offset = 0; offset <= last; offset++) {
    let aligned = true;
    for (let i = 0; offset + i < last; i++) {
      if (i >= next.length || prev[offset + i] !== next[i]) { aligned = false; break; }
    }
    if (!aligned) continue;
    // `start` is where prev's last line sits in next; it is new only if it
    // changed.
    const start = last - offset;
    return next[start] === prev[last] ? next.slice(start + 1) : next.slice(start);
  }
  return next;
}


/**
 * Convert the pre-tier registry and generators into the unified registry and
 * ranked lists. Legacy keys are retained when normalization would confuse two
 * different upstream models.
 */
export function migrateLegacyConfig(config: SonataConfig): {
  models: Record<string, UnifiedModelConfig>;
  tiers: Record<string, TierLists>;
} {
  const models: Record<string, UnifiedModelConfig> = {};
  const normalizedUpstreams = new Map<string, string>();
  // Two different gateways can each hold a model whose id normalizes to the
  // same string (e.g. "gateway-a/latest" and "gateway-b/latest" both reduce
  // to "latest") — that collision carries no gateway/provider identity to
  // disambiguate by, since a legacy harness entry (harness + id only) has
  // none either. Marking the upstream ambiguous instead of letting the
  // second native key silently overwrite the first in normalizedUpstreams
  // stops a later legacy entry from being merged into whichever native
  // model happened to be inserted last — pairing one provider's harness
  // route with a different provider's native route without anyone choosing
  // that pairing.
  const ambiguousUpstreams = new Set<string>();

  for (const [key, model] of Object.entries(config.native?.models ?? {})) {
    models[key] = { gateway: model.gateway, id: model.id, contextWindow: model.contextWindow };
    const upstream = normalizeModelName(model.id);
    if (normalizedUpstreams.has(upstream)) {
      ambiguousUpstreams.add(upstream);
    } else {
      normalizedUpstreams.set(upstream, key);
    }
  }

  const migratedKeys = new Map<string, string>();
  for (const [oldKey, model] of Object.entries(config.models)) {
    const candidate = normalizeModelName(oldKey);
    const upstream = normalizeModelName(model.id);
    const existingKey = ambiguousUpstreams.has(upstream) ? undefined : normalizedUpstreams.get(upstream);
    if (existingKey !== undefined) {
      models[existingKey] = { ...models[existingKey], harness: model.harness, harnessId: model.id };
      migratedKeys.set(oldKey, existingKey);
      continue;
    }
    const occupied = models[candidate];
    if (occupied !== undefined) {
      // Same normalized key, but different upstream. If the legacy spelling
      // itself is already occupied too (an exact-key collision, e.g. a
      // [native.models."x"] and a non-mergeable legacy [models."x"]), there
      // is nothing distinct left to fall back to — invent a key that cannot
      // collide with anything already in `models`, rather than overwriting
      // whichever entry got there first.
      let fallbackKey = oldKey;
      if (models[fallbackKey] !== undefined) {
        let suffix = 2;
        while (models[`${oldKey}-${suffix}`] !== undefined) suffix++;
        fallbackKey = `${oldKey}-${suffix}`;
      }
      models[fallbackKey] = { harness: model.harness, harnessId: model.id };
      migratedKeys.set(oldKey, fallbackKey);
      continue;
    }
    models[candidate] = { harness: model.harness, harnessId: model.id };
    migratedKeys.set(oldKey, candidate);
  }

  const tiers: Record<string, TierLists> = {};
  const roles = new Set([...Object.keys(config.generate.roles), ...Object.keys(config.native?.generate ?? {})]);
  for (const role of roles) {
    const native = config.native?.generate?.[role] ?? [];
    const harness = (config.generate.roles[role] ?? []).map((key) => migratedKeys.get(key) ?? key);
    const ordered = [...native, ...harness].filter((key, index, list) => list.indexOf(key) === index);
    tiers[role] = { simple: [...ordered], complex: [...ordered] };
  }
  return { models, tiers };
}
