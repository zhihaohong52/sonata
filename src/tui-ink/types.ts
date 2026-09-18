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
  /**
   * The ranking captured per role, by tier.
   *
   * `normal` is optional because a config written before the three-tier work
   * has only `simple` and `complex`, and `resolveTierAlias` treats an absent
   * `normal` as valid rather than empty. It was missing from this type
   * entirely until type-checking reached the tests: the wizard has been
   * writing `normal` tiers since the feature shipped, so the type has been
   * describing a shape the code does not produce.
   */
  tiers?: Record<string, { simple: string[]; normal?: string[]; complex: string[] }>;
  /**
   * Discard every saved `[tiers]` ranking and seed from a fresh proposal.
   *
   * A saved list is otherwise sticky forever: `reconcileTierList` merges only
   * newly selected models into it, so a tier written before the catalog
   * changed can never be re-ranked. Measured on a real config, `simple` had
   * frozen while `normal` — added later, and so seeded from a fresh proposal —
   * held the current ranking, leaving `simple` leading with a candidate 4.5x
   * dearer per task than `normal`'s: the tier split exactly inverted.
   *
   * Stickiness stays the default, because a hand-tuned ranking surviving an
   * ordinary `init` is the property it exists to provide. This is the opt-out,
   * and it lives on `InitState` so the wizard and `--yes` cannot disagree
   * about it.
   */
  reproposeTiers?: boolean;
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
  /**
   * Gateway -> the model ids its own `/models` endpoint reported.
   *
   * A live refresh can surface a model the harness catalogue never listed, and
   * such a model has no `NativeCandidate` behind it — so without this, it is
   * selectable and lands in `nativeKeys` and the tiers, but is silently
   * dropped when `[models]` is written, leaving a tier referencing a model the
   * config never defines. `cmdInit` mints the missing candidates from this.
   */
  liveModels?: Record<string, string[]>;
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
  /** Routing mode for tier agents: project, global, or skip. */
  routing?: 'project' | 'global' | 'skip';
  guidance?: 'project' | 'global' | 'skip';
}

// The JSON written by the Ink app, read by cmdInit
export interface TuiResult {
  cancelled: boolean;
  state: InitState;
}