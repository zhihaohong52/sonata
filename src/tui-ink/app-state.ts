import type { InitState } from './types.js';

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
    default:
      return state;
  }
}

export function providersForHarnesses(providers: ProviderOption[], harnesses: string[] | undefined): ProviderOption[] {
  const selected = new Set(harnesses);
  return providers.filter((provider) => provider.harness === 'config' || selected.has(provider.harness));
}

export function candidatesForProviders(candidates: CandidateOption[], providers: ProviderOption[], providerKeys: string[] | undefined): CandidateOption[] {
  const selectedKeys = new Set(providerKeys);
  const gateways = new Set(
    providers.filter((provider) => selectedKeys.has(provider.key)).map((provider) => provider.provider),
  );
  return candidates.filter((candidate) => gateways.has(candidate.gateway));
}
