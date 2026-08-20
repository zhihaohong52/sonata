export type ConfigScope = 'project' | 'global';
export type HookScope = 'project' | 'global' | 'skip';

export interface InitState {
  configScope?: ConfigScope;
  harnesses?: string[];           // which harnesses to import from
  providerKeys?: string[];
  nativeKeys?: string[];          // selected native model keys
  roles?: string[];
  perRoleModels?: Record<string, string[]>; // role -> model keys
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
}

// The JSON written by the Ink app, read by cmdInit
export interface TuiResult {
  cancelled: boolean;
  state: InitState;
}