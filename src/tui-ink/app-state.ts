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
 * Providers with an actually detected credential — the bulk-import screen's
 * contents. A harness's model catalogue listing a provider is not the same as
 * a credential existing for it. Covers both a codex/opencode OAuth grant and a
 * plain API key sitting in another harness's own store (e.g. opencode's
 * `auth.json`): the latter is resolved live at request time by
 * `resolveKeys`/`resolveKeyFromSource`, never copied into sonata's own store,
 * so it is exactly as safe to list here as the OAuth case.
 */
export function importableProviders(
  providers: ProviderOption[],
  availability: Record<string, AvailableCredentials>,
  configuredGateways: readonly string[] = [],
): ProviderOption[] {
  const configured = new Set(configuredGateways);
  const seen = new Set<string>();
  const out: ProviderOption[] = [];
  for (const provider of providers) {
    if (configured.has(provider.provider) || seen.has(provider.provider)) continue;
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
