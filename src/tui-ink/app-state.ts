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

export interface CredentialRow {
  source: CredentialSource | 'sonata-key';
  label: string;
  detail: string;
}

export interface AvailableCredentials {
  codex: { expiresInDays: number } | null;
  opencode: { expiresInDays: number } | null;
  key: { source: string } | null;
}

/**
 * Login and api-key are unconditional: neither depends on another tool being
 * installed, so a machine with no harness at all still shows both. Only the
 * import rows are gated on the credential actually existing — an import row
 * that leads nowhere is the thing worth hiding.
 */
export function credentialRowsFor(gateway: string, have: AvailableCredentials): CredentialRow[] {
  const rows: CredentialRow[] = [
    { source: 'sonata', label: `Log in with ${gateway}`, detail: 'device code, no API key needed' },
  ];
  for (const name of ['codex', 'opencode'] as const) {
    const found = have[name];
    if (found === null) continue;
    rows.push({
      source: name,
      label: `Import from ${name}`,
      detail: found.expiresInDays < 0 ? 'expired — re-login in that tool' : `expires in ${found.expiresInDays}d`,
    });
  }
  rows.push({ source: 'sonata-key', label: 'Enter an API key', detail: 'metered billing' });
  return rows;
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
      return { ...state, harnesses: value as string[] };
    case 2:
      return { ...state, providerKeys: value as string[] };
    case 3:
      return { ...state, nativeKeys: value as string[] };
    case 4:
      return { ...state, roles: value as string[] };
    case 5: {
      const { role, models } = value as PerRoleModelsValue;
      return {
        ...state,
        perRoleModels: { ...state.perRoleModels, [role]: models },
      };
    }
    case 6: {
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
