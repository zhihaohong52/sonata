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
}

// The JSON written by the Ink app, read by cmdInit
export interface TuiResult {
  cancelled: boolean;
  state: InitState;
}