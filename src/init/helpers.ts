/**
 * Pure helpers shared by the `src/init/*` pipeline modules and `src/commands/init.ts`.
 *
 * Lifted verbatim from `src/commands/init.ts` so the eight `src/init/*`
 * modules can import from a sibling rather than `../commands/init.js` —
 * which is the cycle this file's existence breaks. Nothing here imports
 * `init.ts`; if a helper ever needs to, that one stays behind.
 */
import { join } from 'node:path';
import { splitCandidate } from '../effort.js';
import {
  GLOBAL_CONFIG_RELATIVE, parseConfig,
  isOauthGatewayAuth, oauthGatewayBaseUrl, isAnthropicRoutedName,
  CREDENTIAL_SOURCES, type SonataConfig, type NativeGatewayAuth, type NativeGatewayWireFormat, type CredentialSource,
} from '../config.js';
import { readChatGptOAuth, readOpencodeChatGptOAuth } from '../native/codex-auth.js';
import { readCopilotToken } from '../native/copilot-auth.js';
import type { ModelRef } from '../types.js';
import {
  detectTmux, detectHarnesses, WELL_KNOWN_PROVIDER_URLS,
  type Problem, type HarnessStatus, type DetectEnv, type ProviderSummary,
} from '../detect.js';
import type { InitState } from '../tui-ink/types.js';
import type { AvailableCredentials } from '../tui-ink/app-state.js';
import type { HookScope } from '../settings.js';
import type { InitLog } from '../commands/init-log.js';
import type { WizardData } from '../tui-ink/app.js';
import type { TuiResult } from '../tui-ink/types.js';

export const OPENCODE_RANGE = '>=1.18.0 <2.0.0';

export interface Detection {
  tmux: { installed: boolean; version?: string; problems: Problem[] };
  harnesses: HarnessStatus[];
}

export type Detector = (env: DetectEnv) => Promise<Detection>;

/** Real environment probe. Tests inject a substitute so they stay hermetic. */
export const defaultDetector: Detector = async (env) => ({
  tmux: await detectTmux(),
  harnesses: await detectHarnesses(env),
});

export type ConfigScope = 'project' | 'global';

/**
 * The provider name an OAuth credential is offered under, when more than one
 * harness reports it.
 *
 * Each of these auth kinds names a single account, not a class of gateway:
 * `codex-oauth` *is* the ChatGPT subscription, `copilot-oauth` *is* the GitHub
 * Copilot entitlement. So two providers resolving to the same kind are the
 * same upstream, reached twice.
 */
/** Provider names that can offer an OAuth authentication method even when no
 * existing credential is present. This is capability metadata, not evidence
 * that the user is logged in; keep it separate from oauthProvidersFor.
 */
export const PROVIDER_OAUTH_AUTHS: Readonly<Record<string, NativeGatewayAuth>> = {
  openai: 'codex-oauth',
  'openai-codex': 'codex-oauth',
  codex: 'codex-oauth',
  'github-copilot': 'copilot-oauth',
};

const OAUTH_CANONICAL_PROVIDER: Record<string, string> = {
  'codex-oauth': 'codex',
  'copilot-oauth': 'github-copilot',
};

/**
 * One OAuth credential, one provider row.
 *
 * opencode's `openai` entry is the same ChatGPT credential codex holds —
 * identical `client_id`, which is exactly how `oauthProvidersFor` recognises
 * it. Offering both let the user configure one subscription as two
 * `codex-oauth` gateways serving overlapping models under different keys
 * (`gpt-5.6-luna` and `openai-gpt-5.6-luna`), doubling the generated agents
 * for no added capability.
 *
 * The canonical name only wins when it is actually offered: a machine with
 * opencode but no codex still reaches ChatGPT through `openai`, which is the
 * whole reason that entry is read in the first place.
 */
export function dedupeOauthProviders(
  offered: ProviderSummary[],
  oauthProviders: ReadonlyMap<string, NativeGatewayAuth>,
): ProviderSummary[] {
  const names = new Set(offered.map((provider) => provider.provider));
  return offered.filter((provider) => {
    const auth = oauthProviders.get(provider.provider);
    if (auth === undefined || !isOauthGatewayAuth(auth)) return true;
    const canonical = OAUTH_CANONICAL_PROVIDER[auth];
    if (canonical === undefined || provider.provider === canonical) return true;
    return !names.has(canonical);
  });
}

/** Build wizard credential rows only for the gateway auth type they can serve. */
export function credentialAvailabilityFor(
  providers: Array<{ provider: string }>,
  oauthProviders: Map<string, NativeGatewayAuth>,
  credentials: {
    codex: { expiresInDays: number | null } | null;
    opencode: { expiresInDays: number | null } | null;
    copilot: { expiresInDays: number | null } | null;
  },
  hasKey: (gateway: string) => boolean,
): Record<string, AvailableCredentials> {
  return Object.fromEntries(providers.map((provider) => {
    const auth = oauthProviders.get(provider.provider);
    return [provider.provider, {
      codex: auth === 'codex-oauth' ? credentials.codex : null,
      opencode: auth === 'copilot-oauth'
        ? credentials.copilot
        : auth === 'codex-oauth'
          ? credentials.opencode
          : null,
      key: hasKey(provider.provider) ? { source: 'sonata' } : null,
      // Only an OAuth gateway needs an override target; everything else
      // already authenticates with a key, so entering one always works.
      keyEntryAvailable: auth === undefined || !isOauthGatewayAuth(auth) || Object.hasOwn(WELL_KNOWN_PROVIDER_URLS, provider.provider),
    }];
  }));
}

/**
 * Where a config is written for a scope. The read-side counterpart is
 * `configPath`, which resolves a precedence chain; this picks one location.
 */
export function configPathFor(scope: ConfigScope, cwd: string, home: string): string {
  return scope === 'global'
    ? join(home, GLOBAL_CONFIG_RELATIVE)
    : join(cwd, 'sonata.toml');
}

/**
 * Agents follow the config's scope. Keeping them together is the whole point:
 * `init` in $HOME used to write agents globally and config where only $HOME
 * could read it, producing agents that were offered everywhere and worked
 * nowhere.
 */
export function agentsDirFor(scope: ConfigScope, cwd: string, home: string): string {
  return scope === 'global'
    ? join(home, '.claude', 'agents')
    : join(cwd, '.claude', 'agents');
}

export interface InitOptions {
  cwd: string;
  home: string;
  packageRoot: string;
  /** Non-interactive overrides. When `yes` is set, no prompts are shown. */
  yes?: boolean;
  /** Picker keys, `harness/provider`. Non-interactive override. */
  providers?: string[];
  /** Native model keys. Non-interactive override. */
  models?: string[];
  roles?: string[];
  scope?: HookScope | 'skip';
  /** Whether to install route-auto hooks for tier agents. */
  routing?: 'project' | 'global' | 'skip';
  /** Where to write the "prefer tier agents" block, or `skip` to write none. */
  guidance?: 'project' | 'global' | 'skip';
  /** Where the config and its agents are written. Defaults to `project`. */
  configScope?: ConfigScope;
  /** Repeatable gateway=source overrides for the scripted path. */
  credentialSource?: string[];
  prune?: boolean;
  /**
   * Discard saved `[tiers]` rankings and re-rank from the catalog.
   *
   * Carried on the shared opts so both front ends receive it and put it on the
   * one `InitState` they each build — a flag honoured by only one of them
   * would make `--yes` and the wizard write different configs.
   */
  reproposeTiers?: boolean;
  /**
   * Test seam for the LiteLLM install. The suite must not reach PyPI: 46
   * init tests were silently running `uv pip install` on any machine that
   * had uv, which made the suite's behaviour a function of `which uv`.
   */
  installLitellm?: (home: string) => Promise<void>;
  write?: (line: string) => void;
  detect?: Detector;
  /** Injected by tests so a suite never writes into the real log directory. */
  log?: InitLog;
  /**
   * Progress for the discovery step, which spawns a subprocess per harness and
   * can run for many seconds with nothing to show for it. A TUI host draws
   * this live; the CLI ignores it and keeps its existing summary lines.
   */
  onProbe?: (name: string, state: 'probing' | 'done', detail?: string) => void;
  /**
   * Who draws the interactive parts, when something other than a bare terminal
   * is drawing them.
   *
   * `sonata init` owns the screen by mounting its own Ink app and then, after
   * unmounting it, asking two plain questions through `src/tui.ts`. Inside the
   * unified TUI neither of those is available: a second Ink instance on one
   * stdout corrupts both silently, and the shell never unmounts — which it
   * cannot, because Ink *unrefs stdin* on unmount and a prompt waiting on a
   * keystroke after that is not work node knows about, so the process exits 0
   * mid-prompt with no error. That is the documented "sonata init never saves
   * the config" bug, and hosting init without this seam would recreate it.
   *
   * So the host supplies both, and everything else — discover, validate, plan,
   * apply, and the order they run in — is untouched. The alternative was a
   * second implementation of the init pipeline inside the TUI, which is how
   * `tiersCollapse` came to be rebuilt at three call sites with one of them
   * wrong.
   */
  host?: InitHost;
}

/** The interactive surfaces `cmdInit` needs, when the TUI shell is drawing them. */
export interface InitHost {
  /** Draw the wizard and resolve with what the user chose. */
  runTui: (data: WizardData, log: (line: string) => void) => Promise<TuiResult>;
  /** Ask a yes/no question. Carries its own copy of what it is asking about. */
  confirm: (question: string, initial: boolean) => Promise<boolean>;
}

export function parseCredentialSourceFlags(values: string[]): Record<string, CredentialSource> {
  const out: Record<string, CredentialSource> = {};
  for (const value of values) {
    const parts = value.split('=');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error(`sonata init: --credential-source expects <gateway>=<source>, got "${value}"`);
    }
    const [gateway, source] = parts;
    if (!CREDENTIAL_SOURCES.includes(source as CredentialSource)) {
      throw new Error(
        `sonata init: --credential-source "${value}" names unknown source "${source}". ` +
        `Known: ${CREDENTIAL_SOURCES.join(', ')}`,
      );
    }
    out[gateway] = source as CredentialSource;
  }
  return out;
}

export interface InitResult {
  problems: Problem[];
  models: string[];
  roles: string[];
  scope: HookScope | 'skip';
  routing: 'project' | 'global' | 'skip';
  hookChanged: boolean;
  agentsWritten: string[];
  configPath: string;
  pruned: string[];
  cancelled?: boolean;
}

export interface NativeCandidate {
  key: string;
  gateway: string;
  id: string;
  contextWindow: number;
  baseUrl: string;
  auth: NativeGatewayAuth;
  harness?: string;
  harnessId?: string;
  wireFormat?: NativeGatewayWireFormat;
}

/**
 * Native candidates from detected refs, deduplicated by (provider, id).
 *
 * `oauthProviders` maps a provider to the OAuth kind its credential actually
 * is — a subscription login rather than a key. Such a provider must not be
 * written with a base URL: its token is refused by the metered endpoint and
 * reaches only the provider's own backend, which LiteLLM addresses itself.
 */
export function nativeCandidatesFrom(
  refs: ModelRef[],
  providerBaseUrls: Record<string, string>,
  oauthProviders: ReadonlyMap<string, NativeGatewayAuth> = new Map(),
): NativeCandidate[] {
  const seen = new Set<string>();
  return refs
    .filter((r) => {
      // An oauth provider needs no discovered URL — LiteLLM supplies it.
      if (providerBaseUrls[r.provider] === undefined && !oauthProviders.has(r.provider)) return false;
      // Copilot, acme and anthropic all serve Claude models, but the router
      // sends this prefix to Anthropic, so parseConfig refuses such an entry.
      // Offering one would let init write a config it cannot read back.
      const key = r.ref.replace(/\//g, '-');
      if (isAnthropicRoutedName(key) || isAnthropicRoutedName(r.id ?? r.ref)) return false;
      const dedup = `${r.provider}/${r.id}`;
      if (seen.has(dedup)) return false;
      seen.add(dedup);
      return true;
    })
    .map((r) => {
      const auth: NativeGatewayAuth = oauthProviders.get(r.provider) ?? 'api-key';
      const key = r.ref.replace(/\//g, '-');
      const id = r.id ?? r.ref;
      return {
        key,
        gateway: r.provider,
        id,
        contextWindow: 128000,
        baseUrl: isOauthGatewayAuth(auth)
          ? oauthGatewayBaseUrl(auth)
          : providerBaseUrls[r.provider],
        auth,
        harness: r.harness,
        harnessId: r.harness === 'codex' ? id : r.ref,
      };
    });
}

/**
 * Which detected providers authenticate by OAuth rather than a key, judged by
 * reading the credential rather than by provider name.
 *
 * Naming alone would be wrong in both directions: opencode's `openai` provider
 * holds a ChatGPT subscription on this machine but a real API key on another,
 * and marking it by name would either write a metered base URL a subscription
 * cannot use, or refuse a base URL a real key needs.
 */
export function oauthProvidersFor(
  refs: ModelRef[],
  home: string,
  deps: {
    chatGpt?: (home: string) => unknown;
    opencodeChatGpt?: (home: string) => unknown;
    copilot?: (home: string) => unknown;
  } = {},
): Map<string, NativeGatewayAuth> {
  const chatGpt = deps.chatGpt ?? readChatGptOAuth;
  const opencodeChatGpt = deps.opencodeChatGpt ?? readOpencodeChatGptOAuth;
  const copilot = deps.copilot ?? readCopilotToken;

  const out = new Map<string, NativeGatewayAuth>();

  // codex's own provider, when `codex login` used a ChatGPT account.
  if (chatGpt(home) !== null) {
    for (const ref of refs) {
      if (ref.harness === 'codex') out.set(ref.provider, 'codex-oauth');
    }
  }
  // opencode serves the same subscription under `openai`.
  if (opencodeChatGpt(home) !== null) {
    if (refs.some((ref) => ref.provider === 'openai')) out.set('openai', 'codex-oauth');
  }
  if (copilot(home) !== null) {
    if (refs.some((ref) => ref.provider === 'github-copilot')) {
      out.set('github-copilot', 'copilot-oauth');
    }
  }
  return out;
}

/**
 * The gateway names behind a set of candidates, for `normalizeModelName`.
 *
 * A model key is `<gateway>-<id>`, so without the gateway names the id cannot
 * be recovered from the key, and the model misses the catalog it should have
 * matched — landing on `default` (capable, not cheap) and dropping out of the
 * simple tier.
 */
/**
 * The model keys served by an avoided gateway.
 *
 * `avoid_gateways` names gateways, but ranking sorts model keys, so the two
 * are resolved through the candidate set rather than by matching key prefixes
 * — a key only looks like `<gateway>-<id>`, and inferring the gateway back out
 * of it is exactly the guess `normalizeModelName` needs configured providers
 * to avoid.
 */
export function avoidedKeysOf(
  models: ReadonlyMap<string, NativeCandidate>,
  avoidGateways: readonly string[],
): Set<string> {
  const avoid = new Set(avoidGateways);
  return new Set([...models.values()].filter((c) => avoid.has(c.gateway)).map((c) => c.key));
}

export function gatewayNamesOf(models: ReadonlyMap<string, NativeCandidate>): string[] {
  return [...new Set([...models.values()].map((candidate) => candidate.gateway))];
}

/**
 * Each model key as the position of its gateway in the user's ranking.
 *
 * `gateway_order` names gateways, but ranking sorts model keys, exactly as
 * `avoid_gateways` does — so the two resolve through the candidate map the
 * same way. Keys whose gateway is not listed are omitted rather than given a
 * tail position: the ranking treats an absent key as "no preference" (two
 * absent keys compare equal), and inventing a number here would demote an
 * unranked gateway the user simply did not mention.
 */
export function gatewayRankOf(
  models: ReadonlyMap<string, NativeCandidate>,
  gatewayOrder: readonly string[],
): Map<string, number> {
  const rank = new Map<string, number>();
  for (const [key, candidate] of models) {
    const position = gatewayOrder.indexOf(candidate.gateway);
    if (position >= 0) rank.set(key, position);
  }
  return rank;
}

export function nativeLabel(c: NativeCandidate): string {
  return `${c.gateway}/${c.id}`;
}

/**
 * Per-role model assignments after the selected model set has changed.
 *
 * The saved assignment is a **default for models that are still selected** —
 * never an override of the selection. Treating it as an override is what made
 * `sonata init --models <new>` report the new model in its summary and then
 * write the old ones: a role already present in the config kept its saved list
 * and the selection was discarded in full.
 *
 * So, per role: keep what was assigned and is still selected, and add whatever
 * is newly selected, because "I just added codex" means codex should be usable.
 * A role left with nothing gets the whole selection rather than an empty list,
 * which would generate no agent for it at all.
 */
export function reconcilePerRoleModels(
  saved: Record<string, string[]> | undefined,
  savedKeys: readonly string[],
  chosen: readonly string[],
  roles: readonly string[],
): Record<string, string[]> {
  const selected = new Set(chosen);
  const added = chosen.filter((key) => !savedKeys.includes(key));
  const out: Record<string, string[]> = {};
  for (const role of roles) {
    const kept = (saved?.[role] ?? []).filter((key) => selected.has(key));
    const merged = [...kept, ...added.filter((key) => !kept.includes(key))];
    out[role] = merged.length > 0 ? merged : [...chosen];
  }
  return out;
}

/**
 * Filters a saved tier list down to keys still valid this run — currently
 * selected as native, or preserved as a harness-only fallback — falling back
 * to a fresh proposal when nothing survives. Reusing a saved list verbatim
 * after a model was deselected would write a [tiers] entry `cmdSync` then
 * rejects as referencing a model with no matching [models] entry.
 *
 * A newly-added model is inserted at the rank `fallback` (the fresh
 * capability-per-dollar proposal) gives it **relative to the models already
 * kept**, not appended after them unconditionally. Always appending is what
 * made adding a model to an existing config invisible to ranking: a model
 * `proposeTiers` would put first landed last — tried only after every
 * existing candidate had failed, which defeats the point of adding a
 * stronger or cheaper one. This still never reorders `kept` itself, so a
 * hand-tuned ranking survives untouched; only where the new arrival goes is
 * computed. A model `fallback` has no opinion on (e.g. harness-only, absent
 * from the catalog) still falls back to the end.
 *
 * A saved list also absorbs **new effort variants of models it already
 * holds**, which `added` cannot express. When the `<key>@<effort>` grammar
 * shipped, every model gained `@low`/`@max`/etc. candidates: new *candidate
 * keys*, but not new *models*, so nothing re-selected them and nothing merged
 * them. A list written before that feature could therefore never gain them.
 * Measured on a real machine config 2026-09-17 — `simple` and `complex`
 * predated the grammar and held 11 and 12 entries over 5 and 6 models, while
 * `normal`, added later and so seeded from a fresh proposal, held 44 over 12.
 * `complex` has no cost cap and should be the *largest* list; it was the
 * smallest.
 *
 * This deliberately cannot resurrect a model removed from a tier on purpose.
 * A variant qualifies only when its bare key is already in `kept`, so removing
 * a model removes its levels with it — and deleting a model from a tier is how
 * "not for this tier" is expressed today.
 */
export function reconcileTierList(
  saved: string[] | undefined,
  validKeys: ReadonlySet<string>,
  fallback: string[],
  added: readonly string[] = [],
): string[] {
  const kept = (saved ?? []).filter((key) => validKeys.has(key));
  if (kept.length === 0) return fallback;
  const keptModels = new Set(kept.map((key) => splitCandidate(key).key));
  // Drawn from `fallback` so each variant lands at its proposal rank like any
  // other arrival, rather than behind candidates it beats.
  const variants = fallback.filter((key) => (
    validKeys.has(key)
    && !kept.includes(key)
    && !added.includes(key)
    && keptModels.has(splitCandidate(key).key)
  ));
  const extra = [...added.filter((key) => validKeys.has(key) && !kept.includes(key)), ...variants];
  if (extra.length === 0) return kept;
  const rank = new Map(fallback.map((key, i) => [key, i]));
  const rankOf = (key: string): number => rank.get(key) ?? Infinity;
  const result = [...kept];
  for (const key of extra) {
    const keyRank = rankOf(key);
    const insertAt = result.findIndex((existing) => rankOf(existing) > keyRank);
    result.splice(insertAt === -1 ? result.length : insertAt, 0, key);
  }
  return result;
}

export function deriveInitState(
  config: SonataConfig,
  configScope: ConfigScope,
  offered: ProviderSummary[],
): InitState {
  const nativeModels = config.native?.models ?? {};
  const unifiedModels = config.unifiedModels;
  const modelKeys = [...new Set([...Object.keys(nativeModels), ...Object.keys(unifiedModels)])]
    .filter((key) => (unifiedModels[key]?.gateway ?? nativeModels[key]?.gateway) !== undefined);
  if (modelKeys.length === 0) return { configScope };

  const gateways = [...new Set(modelKeys.map((key) =>
    unifiedModels[key]?.gateway ?? nativeModels[key]?.gateway,
  ).filter((gateway): gateway is string => gateway !== undefined))];
  const providerKeys: string[] = [];
  const harnesses: string[] = [];
  for (const gateway of gateways) {
    const matches = offered.filter((provider) => provider.provider === gateway);
    // A bare gateway name in sonata.toml doesn't record which harness's
    // discovery produced it. Exactly one matching harness is unambiguous and
    // gets credited below. More than one *distinct* harness sharing the same
    // provider name (e.g. opencode and pi both separately cataloging
    // opencode.ai's public "opencode-go" gateway — verified live) is just as
    // unattributable as no match at all: crediting every one of them
    // pre-selects a harness the user never actually chose, with no way to
    // make it stick unticked. Treat both cases the same way.
    const distinctHarnesses = new Set(matches.map((provider) => provider.harness));
    if (matches.length === 0 || distinctHarnesses.size > 1) {
      providerKeys.push(`config/${gateway}`);
      continue;
    }
    for (const provider of matches) {
      if (!providerKeys.includes(provider.key)) providerKeys.push(provider.key);
      if ((provider.harness as string) !== 'config' && !harnesses.includes(provider.harness)) {
        harnesses.push(provider.harness);
      }
    }
  }

  return {
    configScope,
    harnesses,
    providerKeys,
    nativeKeys: modelKeys,
    // `undefined`, not `[]`, when the config carries no role configuration at
    // all (a valid native-only unified config with no [tiers] and no legacy
    // generate table). `config.native.generate` is always an object once
    // `[native]` exists at all — parsed as `{}` when there's no
    // `[generate.native]` — so a plain `!== undefined` check would call that
    // "configured", same bug in a different table. A syntactically present
    // but empty `[tiers]` block, by contrast, IS explicit configuration
    // (parseConfig accepts it without error) and must still produce `[]`,
    // not fall through to the default: `config.tiers !== undefined` alone
    // (not a non-empty check) preserves that distinction. Downstream,
    // `d.roles ?? [...KNOWN_ROLES]` only falls through to the default role
    // set on nullish, so an explicit `[]` here was read as "zero roles
    // selected" and made scripted `sonata init --yes` throw "no roles
    // selected" for the genuinely-unconfigured shape.
    roles: config.tiers !== undefined || Object.keys(config.native?.generate ?? {}).length > 0
      ? Object.keys(config.tiers ?? config.native?.generate ?? {})
      : undefined,
    tiers: config.tiers
      ? Object.fromEntries(Object.entries(config.tiers).map(([role, lists]) => [role, { simple: [...lists.simple], complex: [...lists.complex] }]))
      : undefined,
    perRoleModels: Object.fromEntries(
      Object.entries(config.tiers ?? config.native?.generate ?? {}).map(([role, models]) => [
        role,
        config.tiers
          ? [...new Set([...models.simple, ...models.complex].map((candidate) => splitCandidate(candidate).key))]
          : [...models],
      ]),
    ),
    credentialSources: Object.fromEntries(
      Object.entries(config.native?.gateways ?? {})
        .filter(([, gateway]) => gateway.credentialSource !== undefined)
        .map(([gateway, config]) => [gateway, config.credentialSource!]),
    ),
  };
}

/** NativeCandidates for every model in the config, from the config's own data. */
export function configNativeCandidates(config: SonataConfig): NativeCandidate[] {
  const gateways = config.native?.gateways ?? {};
  const unified = Object.entries(config.unifiedModels)
    .filter(([, model]) => model.gateway !== undefined && model.id !== undefined)
    .flatMap(([key, model]) => {
      const gateway = model.gateway!;
      const gatewayConfig = gateways[gateway];
      if (gatewayConfig === undefined) return [];
      return [{
        key, gateway, id: model.id!,
        contextWindow: model.contextWindow ?? 128000,
        baseUrl: gatewayConfig.baseUrl, auth: gatewayConfig.auth,
        ...(gatewayConfig.wireFormat !== undefined ? { wireFormat: gatewayConfig.wireFormat } : {}),
        ...(model.harness !== undefined ? { harness: model.harness, harnessId: model.harnessId } : {}),
      }];
    });
  if (config.native === undefined) return unified;
  // `config.native.models` is NOT always genuine legacy data: `parseConfig`
  // projects every unified model into it whenever `[tiers]` is present ("Tier
  // configs are the unified format. Keep a native projection so the router
  // and older consumers can use the same gateway/model data" — config.ts),
  // so a tiered config's `native.models` is a harness-stripped mirror of
  // `unifiedModels`, not independent authored data. Treating it as an
  // independent legacy source there would make every tiered config's own
  // projection of a model shadow that same model's richer unified entry —
  // losing its harness/harnessId fields on every re-init. Only an UNTIERED
  // config (`config.tiers === undefined`) can carry a genuinely distinct,
  // hand-authored `[native.models]` table.
  if (config.tiers !== undefined) return unified;
  // A transitional, untiered config can carry a gateway-backed `[models]`
  // entry AND a separate `[native.models]` entry under a different key at
  // the same time — any non-empty `unified` here used to be treated as proof
  // the legacy table was empty, so the legacy-only key was silently dropped
  // from the candidate list even though `deriveInitState` still names it
  // (scripted init then rejects it as unavailable, and the interactive path
  // can't resolve it through `nativeByKey` either). Merge the two sets.
  const legacy = Object.entries(config.native.models).flatMap(([key, model]) => {
    const gateway = config.native!.gateways[model.gateway];
    if (gateway === undefined) return [];
    return [{
      key, gateway: model.gateway, id: model.id,
      contextWindow: model.contextWindow,
      baseUrl: gateway.baseUrl, auth: gateway.auth,
      ...(gateway.wireFormat !== undefined ? { wireFormat: gateway.wireFormat } : {}),
    }];
  });
  // On a same-key collision, legacy wins — not unified. `litellmConfig`
  // (native/litellm.ts) builds its model list from `native.models` first,
  // unconditionally, and skips a unified entry sharing that key; letting
  // unified win here instead would make `sonata init` silently change which
  // upstream a key denotes relative to what's actually being served. This is
  // safe here specifically because `config.tiers === undefined` rules out
  // the projection case above — every entry in `native.models` at this point
  // really was authored under `[native.models]`.
  const legacyKeys = new Set(legacy.map((candidate) => candidate.key));
  return [...legacy, ...unified.filter((candidate) => !legacyKeys.has(candidate.key))];
}

/**
 * Pre-tick from existing `[native.models]` in the config.
 */
export function preTickedNative(configText: string, candidates: NativeCandidate[]): Set<string> {
  try {
    const config = parseConfig(configText);
    const existing = config.tiers
      ? config.unifiedModels
      : config.native?.models ?? {};
    const ticked = new Set<string>();
    for (const c of candidates) {
      if (existing[c.key]) ticked.add(c.key);
    }
    return ticked;
  } catch {
    return new Set();
  }
}

/**
 * Emit the unified model registry, tier lists, native gateway definitions,
 * and runtime defaults.
 */
export function previousAskedStep(asked: boolean[], from: number): number {
  for (let k = from - 1; k >= 0; k--) if (asked[k]) return k;
  return from;
}

/**
 * Keys claimed more than once.
 */
export function duplicateKeys(keys: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const k of keys) {
    if (seen.has(k)) dupes.add(k);
    seen.add(k);
  }
  return [...dupes].sort();
}
