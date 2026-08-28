import { byokCandidateKey } from '../native/models.js';
import type { CredentialSource } from '../config.js';
import type { InitState } from './types.js';

/**
 * Pseudo-harnesses: providers that come from somewhere other than a detected
 * harness catalogue, and so must survive the harness filter in step 2.
 *
 * `config` is a gateway already named in sonata.toml; `byok` is a well-known
 * provider the user can name directly. Neither belongs to a harness, so
 * deselecting every harness must not hide them — which is the whole point for
 * `byok`, whose case is having no harness at all.
 */
export const PSEUDO_HARNESSES: readonly string[] = ['config', 'byok'];

/** The `byok/<name>` picker key for a provider. */
export function byokProviderKey(name: string): string {
  return `byok/${name}`;
}

/** The provider name behind a `byok/<name>` picker key, or undefined. */
export function byokProviderName(key: string): string | undefined {
  return key.startsWith('byok/') ? key.slice('byok/'.length) : undefined;
}

export interface ByokModelsValue {
  provider: string;
  ids: string[];
}

export interface ProviderOption {
  key: string;
  harness: string;
  provider: string;
  count: number;
}

export interface CandidateOption {
  key: string;
  gateway: string;
  id: string;
  label: string;
}

export interface PerRoleModelsValue {
  role: string;
  models: string[];
}

export interface TierSelectionValue {
  role: string;
  tier: 'simple' | 'complex';
  ranked: string[];
}

export interface AvailableCredentials {
  codex: { expiresInDays: number | null } | null;
  opencode: { expiresInDays: number | null } | null;
  key: { source: string } | null;
  /**
   * Whether entering an API key for this gateway actually goes anywhere: true
   * for a gateway that already authenticates with a key, or an OAuth gateway
   * whose real API base URL is known (so the wizard can switch it over). An
   * OAuth-only gateway with an unrecognized name has nowhere for a typed key
   * to be sent, so the row is worth hiding rather than accepting input that
   * fails after the wizard has already exited.
   */
  keyEntryAvailable: boolean;
}

export type InitAction =
  | { type: 'chooseCredentialSource'; gateway: string; source: CredentialSource }
  | { type: 'back' };

export function reduceInit(prev: { step: number; state: InitState }, action: InitAction): { step: number; state: InitState } {
  switch (action.type) {
    case 'chooseCredentialSource':
      return {
        ...prev,
        step: prev.step,
        state: {
          ...prev.state,
          credentialSources: { ...prev.state.credentialSources, [action.gateway]: action.source },
        },
      };
    case 'back':
      return { ...prev, step: Math.max(0, prev.step - 1) };
  }
}

export function applyStep(state: InitState, step: number, value: unknown): InitState {
  switch (step) {
    case 0:
      return { ...state, configScope: value as InitState['configScope'] };
    case 1:
      return { ...state, providerKeys: value as string[] };
    case 2:
      return { ...state, nativeKeys: value as string[] };
    case 3:
      return { ...state, roles: value as string[] };
    case 4: {
      if (typeof value === 'object' && value !== null && 'tier' in value) {
        const { role, tier, ranked } = value as TierSelectionValue;
        return {
          ...state,
          tiers: {
            ...state.tiers,
            [role]: {
              ...(state.tiers?.[role] ?? { simple: [], complex: [] }),
              [tier]: ranked,
            },
          },
        };
      }
      const { role, models } = value as PerRoleModelsValue;
      return {
        ...state,
        perRoleModels: { ...state.perRoleModels, [role]: models },
      };
    }
    case 5: {
      // A BYOK provider's chosen models. They join `nativeKeys` here rather than
      // later, because step 5 offers roles a choice from `nativeKeys` — a model
      // missing from it cannot be assigned to any role, so the wizard would
      // appear to accept it and then write nothing.
      const { provider, ids } = value as ByokModelsValue;
      const keys = ids.map((id) => byokCandidateKey(provider, id));
      // Drop what this provider contributed last time before adding what it
      // contributes now: the user can walk back into this step and deselect,
      // and a key left behind would still be written to the config.
      const stale = new Set((state.byokModels?.[provider] ?? []).map((id) => byokCandidateKey(provider, id)));
      const kept = (state.nativeKeys ?? []).filter((key) => !stale.has(key));
      return {
        ...state,
        byokModels: { ...state.byokModels, [provider]: ids },
        nativeKeys: [...kept, ...keys.filter((key) => !kept.includes(key))],
      };
    }
    default:
      return state;
  }
}

export function providersForHarnesses(providers: ProviderOption[], harnesses: string[] | undefined): ProviderOption[] {
  const selected = new Set(harnesses);
  return providers.filter((provider) =>
    PSEUDO_HARNESSES.includes(provider.harness) || selected.has(provider.harness));
}

export function candidatesForProviders(candidates: CandidateOption[], providers: ProviderOption[], providerKeys: string[] | undefined): CandidateOption[] {
  const selectedKeys = new Set(providerKeys);
  const gateways = new Set(
    providers.filter((provider) => selectedKeys.has(provider.key)).map((provider) => provider.provider),
  );
  return candidates.filter((candidate) => gateways.has(candidate.gateway));
}

/**
 * A lookup key for one (gateway, id) pair.
 *
 * Both halves are free-form — an id routinely carries `/`, `-` and `.` — so
 * they are JSON-encoded rather than joined by a separator, which would make
 * `a` + `b/c` collide with `a/b` + `c`.
 */
function gatewayIdKey(gateway: string, id: string): string {
  return JSON.stringify([gateway, id]);
}

/**
 * Harness-derived candidates with a gateway's live `/models` answer swapped in.
 *
 * A harness catalogue is a snapshot: it keeps listing a model the gateway has
 * since dropped, and misses one it has since added. Where the gateway itself
 * answered, its list is authoritative — so a gateway present in
 * `liveByGateway` has its candidates **replaced**, which is what actually
 * retires a stale entry. A gateway absent from it (unreachable, no key, OAuth,
 * timed out) keeps the harness list untouched, so a failed refresh degrades to
 * today's behaviour rather than emptying the picker.
 *
 * An id the harness already listed keeps that candidate's existing key: the
 * key is what `nativeKeys` and the written config are addressed by, so
 * reconstructing it would silently deselect models the user had already
 * chosen. Only a genuinely new id mints a key.
 */
export function mergeLiveCandidates(
  candidates: CandidateOption[],
  liveByGateway: Record<string, string[]>,
): CandidateOption[] {
  const refreshed = new Set(Object.keys(liveByGateway));
  const existing = new Map(candidates.map((candidate) => [gatewayIdKey(candidate.gateway, candidate.id), candidate]));
  const candidateFor = (gateway: string, id: string): CandidateOption =>
    existing.get(gatewayIdKey(gateway, id))
      ?? { key: byokCandidateKey(gateway, id), gateway, id, label: `${gateway}/${id}` };

  const out: CandidateOption[] = [];
  const done = new Set<string>();
  // A refreshed gateway's live list is emitted where that gateway first
  // appeared, so refreshing does not reshuffle the picker.
  for (const candidate of candidates) {
    if (!refreshed.has(candidate.gateway)) { out.push(candidate); continue; }
    if (done.has(candidate.gateway)) continue;
    done.add(candidate.gateway);
    for (const id of liveByGateway[candidate.gateway]!) out.push(candidateFor(candidate.gateway, id));
  }
  // A gateway the harness listed nothing for still contributes what it serves.
  for (const [gateway, ids] of Object.entries(liveByGateway)) {
    if (done.has(gateway)) continue;
    for (const id of ids) out.push(candidateFor(gateway, id));
  }
  return out;
}

/**
 * The keys a tier's RankedSelect screen offers, in stable order.
 *
 * A saved ranking can name a harness-only key that has no native route and
 * is therefore absent from `nativeKeys` — RankedSelect's `initialIndices`
 * silently drops any `initialRanked` value missing from `items`, so building
 * items from `nativeKeys` alone would make merely confirming this screen
 * rewrite the tier without that fallback. Appending the missing keys keeps
 * them selectable and preserved across a no-op confirm.
 *
 * `allNativeKeys` is the full universe of natively-routable keys independent
 * of what's currently selected: a key absent from `nativeKeys` is only
 * preserved if it never had a native route at all, never when it has one but
 * its provider was temporarily deselected this session.
 */
export function tierPickerKeys(nativeKeys: string[], initialRanked: string[], allNativeKeys: string[] = nativeKeys): string[] {
  const nativeUniverse = new Set(allNativeKeys);
  const fallbackKeys = initialRanked.filter((key) => !nativeKeys.includes(key) && !nativeUniverse.has(key));
  return [...nativeKeys, ...fallbackKeys];
}

/**
 * Providers with an actually detected credential — the bulk-import screen's
 * contents. A harness's model catalogue listing a provider is not the same as
 * a credential existing for it. Covers both a codex/opencode OAuth grant and a
 * plain API key sitting in another harness's own store (e.g. opencode's
 * `auth.json`): the latter is resolved live at request time by
 * `resolveKeys`/`resolveKeyFromSource`, never copied into sonata's own store,
 * so it is exactly as safe to list here as the OAuth case.
 *
 * Already-configured providers are NOT excluded: the screen doubles as a
 * toggle — the caller pre-checks whichever of these are already configured
 * and unchecking one is how a provider gets removed again.
 */
export function importableProviders(
  providers: ProviderOption[],
  availability: Record<string, AvailableCredentials>,
): ProviderOption[] {
  const seen = new Set<string>();
  const out: ProviderOption[] = [];
  for (const provider of providers) {
    if (seen.has(provider.provider)) continue;
    const have = availability[provider.provider];
    if (have === undefined || (have.codex === null && have.opencode === null && have.key === null)) continue;
    seen.add(provider.provider);
    out.push(provider);
  }
  return out;
}

/**
 * The Add-provider search list: every known provider not already configured
 * in this run, deduped by name (a provider can appear once per harness that
 * knows it) and sorted for a stable, scannable list.
 */
export function addProviderCatalog(
  providers: ProviderOption[],
  configuredGateways: readonly string[],
): ProviderOption[] {
  const configured = new Set(configuredGateways);
  const seen = new Set<string>();
  const out: ProviderOption[] = [];
  for (const provider of providers) {
    if (configured.has(provider.provider) || seen.has(provider.provider)) continue;
    seen.add(provider.provider);
    out.push(provider);
  }
  return out.sort((a, b) => a.provider.localeCompare(b.provider));
}

/**
 * The gateway names already configured in this run, resolved from
 * `providerKeys` — a catalogued provider's key resolves through the provider
 * list, a byok/custom provider's key resolves through `byokProviderName`.
 */
export function configuredProviderNames(providerKeys: readonly string[], providers: ProviderOption[]): string[] {
  const byKey = new Map(providers.map((p) => [p.key, p.provider]));
  return providerKeys
    .map((key) => byokProviderName(key) ?? byKey.get(key))
    .filter((name): name is string => name !== undefined);
}

/**
 * Which of the "Import from other harnesses" candidates are already stored
 * — by exact key, not by provider name. Two harnesses can list the same
 * provider name (e.g. both opencode and Pi offering "google"); matching by
 * name alone (as `configuredProviderNames` does, for other purposes where
 * that's the right question) would mark every same-named row as
 * already-imported regardless of which harness's key is actually stored —
 * pre-ticking a harness the user never selected, every time the wizard
 * runs, with no way to make it stick unticked.
 */
export function alreadyImportedKeys(providerKeys: readonly string[], importable: readonly ProviderOption[]): Set<string> {
  const stored = new Set(providerKeys);
  return new Set(importable.filter((provider) => stored.has(provider.key)).map((provider) => provider.key));
}

export function validateCustomProviderName(name: string, existingNames: readonly string[]): string | undefined {
  const trimmed = name.trim();
  if (trimmed === '') return 'A name is required.';
  if (existingNames.some((existing) => existing.toLowerCase() === trimmed.toLowerCase())) {
    return `"${trimmed}" is already a provider — pick a different name.`;
  }
  return undefined;
}

export function validateProviderUrl(url: string): string | undefined {
  const trimmed = url.trim();
  if (trimmed === '') return 'A base URL is required.';
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return 'Enter a full URL, including https://.';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'The URL must start with http:// or https://.';
  }
  return undefined;
}
