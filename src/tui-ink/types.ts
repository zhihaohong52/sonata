import type { CredentialSource } from '../config.js';

export type ConfigScope = 'project' | 'global';
export type HookScope = 'project' | 'global' | 'skip';

export interface InitState {
  configScope?: ConfigScope;
  harnesses?: string[];           // which harnesses to import from
  providerKeys?: string[];
  nativeKeys?: string[];          // selected native model keys
  roles?: string[];
  perRoleModels?: Record<string, string[]>; // legacy role -> model keys
  tiers?: Record<string, { simple: string[]; complex: string[] }>;
  hookScope?: HookScope;
  /**
   * BYOK provider -> the API key typed in the wizard.
   *
   * In memory only. `runInitTui` renders in-process and resolves with this
   * object, so nothing here is ever serialized; `cmdInit` writes these to the
   * key store after the confirm gate, which is also why cancelling stores
   * nothing. Never render it, never log it.
   */
  byokKeys?: Record<string, string>;
  /** BYOK provider -> the model ids chosen or typed for it. */
  byokModels?: Record<string, string[]>;
  /** Providers typed in directly through the wizard's "Add a custom provider" flow. */
  customProviders?: Array<{ name: string; url: string }>;
  /** Custom-provider name -> wire format, only recorded for the non-default choice. */
  customWireFormats?: Record<string, 'anthropic'>;
  /**
   * Gateway -> where its credential comes from. A recorded choice, unlike
   * `oauthProvidersFor`'s sniffing, which now only computes the default.
   * Holds no credential material — a login writes through LiteLLM to disk.
   */
  credentialSources?: Record<string, CredentialSource>;
}

// The JSON written by the Ink app, read by cmdInit
export interface TuiResult {
  cancelled: boolean;
  state: InitState;
}