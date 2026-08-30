/**
 * `sonata init` — first-run onboarding and repair.
 *
 * Interactive by default; every choice also has a flag so the command works in
 * CI and scripts. Nothing is written until the user confirms the summary.
 *
 * The wizard writes the unified `[models]` registry plus `[tiers.<role>]`
 * ranked lists — discovered native candidates keep `gateway`/`id`, and
 * harness-discovered ones keep `harness`/`harness_id` (both, for a model
 * reachable either way). A config still written in the older
 * `[generate.roles]`/`[generate.native]` shape is migrated on load
 * (`migrateLegacyConfig`, `src/normalize.ts`) rather than left behind or
 * silently dropped.
 */
import { join } from 'node:path';
import {
  KNOWN_ROLES, GLOBAL_CONFIG_RELATIVE, parseConfig,
  isOauthGatewayAuth, oauthGatewayBaseUrl, isAnthropicRoutedName,
  CREDENTIAL_SOURCES, type SonataConfig, type NativeGatewayAuth, type NativeGatewayWireFormat, type CredentialSource,
} from '../config.js';
import { readChatGptOAuth, readOpencodeChatGptOAuth } from '../native/codex-auth.js';
import { readCopilotToken } from '../native/copilot-auth.js';
import type { ModelRef } from '../types.js';
import {
  detectTmux, detectHarnesses, offerableProviders, WELL_KNOWN_PROVIDER_URLS,
  type Problem, type HarnessStatus, type DetectEnv, type ProviderSummary,
} from '../detect.js';
import { type HookScope } from '../settings.js';
import { confirm, isInteractive, banner, CancelledError } from '../tui.js';
import { migrateLegacyConfig } from '../normalize.js';
import { type AvailableCredentials } from '../tui-ink/app-state.js';
import { openInitLog, type InitLog } from './init-log.js';
import { nativeTomlFor } from '../init/toml.js';
import { discover, type InitEnvironment } from '../init/discover.js';
import { interactiveState } from '../init/interactive-state.js';
import { scriptedState } from '../init/scripted-state.js';
import { plan, fsCredentialProbe } from '../init/plan.js';
import { apply } from '../init/apply.js';
import { validate } from '../init/validate.js';

export { nativeTomlFor } from '../init/toml.js';
import type { InitState } from '../tui-ink/types.js';

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
  /** Where the config and its agents are written. Defaults to `project`. */
  configScope?: ConfigScope;
  /** Repeatable gateway=source overrides for the scripted path. */
  credentialSource?: string[];
  prune?: boolean;
  write?: (line: string) => void;
  detect?: Detector;
  /** Injected by tests so a suite never writes into the real log directory. */
  log?: InitLog;
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

function renderProblem(p: Problem): string {
  const icon = p.severity === 'error' ? '✗' : p.severity === 'warn' ? '!' : 'ℹ';
  const fix = p.fix ? `\n      ❯ ${p.fix}` : '';
  return `  ${icon} ${p.message}${fix}`;
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
 */
export function reconcileTierList(
  saved: string[] | undefined,
  validKeys: ReadonlySet<string>,
  fallback: string[],
  added: readonly string[] = [],
): string[] {
  const kept = (saved ?? []).filter((key) => validKeys.has(key));
  if (kept.length === 0) return fallback;
  const extra = added.filter((key) => validKeys.has(key) && !kept.includes(key));
  return [...kept, ...extra];
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
        config.tiers ? [...new Set([...models.simple, ...models.complex])] : [...models],
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

export async function cmdInit(opts: InitOptions): Promise<InitResult> {
  const log = opts.log ?? openInitLog(opts.home);
  const print = opts.write ?? ((l: string) => console.log(l));
  // Everything the command says is teed to the log. The wizard owns the screen
  // — Ink repaints and the list prompts use the alternate buffer — so what is
  // on the terminal after a failed run is not what the run said.
  const out = (line: string): void => { print(line); log.line(line); };
  const interactive = !opts.yes && isInteractive();
  log.line(`cwd=${opts.cwd} home=${opts.home} interactive=${interactive} yes=${opts.yes ?? false}`);
  try {
    return await runInit(opts, out, log, interactive);
  } catch (error) {
    log.fail(error);
    throw error;
  }
}

async function runInit(
  opts: InitOptions,
  out: (line: string) => void,
  log: InitLog,
  interactive: boolean,
): Promise<InitResult> {
  out('');
  out(interactive ? banner() : '  sonata init');
  out('');

  // ---- discover ---------------------------------------------------------
  const env: InitEnvironment = await discover({
    cwd: opts.cwd,
    home: opts.home,
    packageRoot: opts.packageRoot,
    detect: opts.detect,
  }, out);

  if (env.problems.some((p) => p.severity === 'error')) {
    for (const p of env.problems) out(renderProblem(p));
    out('');
    out('  Fix the errors above, then run `sonata init` again.');
    return blockedResult(env.problems, opts);
  }
  for (const p of env.problems) out(renderProblem(p));

  // ---- choose -----------------------------------------------------------
  // The two front ends (`interactiveState`, `scriptedState`) live in
  // `src/init/`. Each one returns the same `InitState` shape plus a
  // candidate map covering BYOK and live additions the front end made — the
  // post-frontend `validate` step needs those additions to recognise the
  // user-selected models. The wizard additionally reports whether the user
  // cancelled.
  const chosen = interactive
    ? await interactiveState(env, opts, log)
    : { ...scriptedState(env, opts), cancelled: false };
  if (chosen.cancelled) {
    out('  Nothing written.');
    return cancelledResult(env.problems, chosen.state, opts);
  }

  // ---- validate ---------------------------------------------------------
  // Validation precedes planning: a plan built from an invalid state is a
  // plan nobody should see, and `validate` resolves its own candidates so it
  // has no dependency on `plan` having run. The front end's `nativeByKey`
  // is passed so BYOK and live-refresh candidates are visible to the
  // unknown-model check — they were added in the front end's own scope and
  // are not in `env.allNativeCandidates`.
  const problems = validate(env, chosen.state, { nativeByKey: chosen.nativeByKey });
  if (problems.length > 0) {
    if (!interactive) throw new Error(problems[0].message);
    for (const p of problems) out(renderProblem(p));
    return cancelledResult(env.problems, chosen.state, opts);
  }

  // ---- plan -------------------------------------------------------------
  const credentials = fsCredentialProbe(opts.home, env.copilotUsable);
  const initPlan = plan(env, chosen.state, credentials, opts);

  for (const line of initPlan.notices) out(line);
  out('');
  for (const line of initPlan.summary) out(line);
  out('');

  log.line(`hook scope resolved: ${initPlan.hook.scope}`);
  if (interactive) log.line('prompting for write confirmation');
  if (interactive && !(await confirm('Write these changes?', true))) {
    out('  Nothing written.');
    return cancelledResult(env.problems, chosen.state, opts);
  }

  // ---- apply ------------------------------------------------------------
  const applied = await apply(initPlan, opts, {
    out,
    prune: opts.prune ?? (interactive ? async () => confirm('Delete them?', true) : false),
  });

  out('');
  out('  Done. Run /reload-plugins to pick up the new agents.');
  out('  Native sessions: run `sonata code`, or `sonata route on` to route plain claude sessions.');
  out('');

  return {
    problems: env.problems, models: initPlan.nativeKeys, roles: initPlan.roles,
    scope: initPlan.hook.scope, routing: initPlan.routing,
    hookChanged: applied.hookChanged, agentsWritten: applied.agentsWritten,
    configPath: initPlan.configPath, pruned: applied.pruned,
  };
}

function blockedResult(problems: Problem[], opts: InitOptions): InitResult {
  return {
    problems, models: [], roles: [], scope: 'skip', routing: 'skip', hookChanged: false,
    agentsWritten: [], configPath: join(opts.cwd, 'sonata.toml'),
    pruned: [],
  };
}

function cancelledResult(problems: Problem[], state: InitState, opts: InitOptions): InitResult {
  return {
    problems, models: [], roles: [], scope: 'skip', routing: 'skip', hookChanged: false,
    agentsWritten: [], configPath: configPathFor(
      state.configScope ?? 'project', opts.cwd, opts.home),
    pruned: [], cancelled: true,
  };
}

export function isCancellation(err: unknown): boolean {
  return err instanceof CancelledError;
}
