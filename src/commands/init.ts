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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  KNOWN_ROLES, configPath, GLOBAL_CONFIG_RELATIVE, parseConfig,
  isOauthGatewayAuth, oauthGatewayBaseUrl, isAnthropicRoutedName,
  CREDENTIAL_SOURCES, type SonataConfig, type NativeGatewayAuth, type NativeGatewayWireFormat, type CredentialSource,
} from '../config.js';
import { readChatGptOAuth, readOpencodeChatGptOAuth } from '../native/codex-auth.js';
import { credentialDir, credentialFileFor } from '../native/oauth-login.js';
import { readCopilotToken, copilotTokenCanExchange } from '../native/copilot-auth.js';
import type { ModelRef } from '../types.js';
import {
  detectTmux, detectHarnesses, offerableProviders, WELL_KNOWN_PROVIDER_URLS,
  type Problem, type HarnessStatus, type DetectEnv, type ProviderSummary,
} from '../detect.js';
import {
  settingsPath, readSettings, writeSettings, installHook, allowSonataTools,
  hookInstalled, hookCommand, type HookScope,
} from '../settings.js';
import { pruneAgents } from '../detect.js';
import { cmdSync } from './sync.js';
import { cmdRoute } from './route.js';
import { select, confirm, isInteractive, banner, CancelledError } from '../tui.js';
import { keyReport, resolveKeyFromSource, resolveKeys, writeSonataKey } from '../native/credentials.js';
import { byokCandidateKey, wellKnownProviders } from '../native/models.js';
import { loadAaCatalog, proposeTiers } from '../catalog.js';
import { migrateLegacyConfig } from '../normalize.js';
import { byokProviderKey, byokProviderName, type AvailableCredentials } from '../tui-ink/app-state.js';
import { runInitTui } from '../tui-ink/run.js';
import { openInitLog, type InitLog } from './init-log.js';
import { nativeTomlFor } from '../init/toml.js';
import { discover, type InitEnvironment } from '../init/discover.js';
import { validate } from '../init/validate.js';

export { nativeTomlFor } from '../init/toml.js';
import type { WizardData } from '../tui-ink/app.js';
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

  const blocking = env.problems.filter((p) => p.severity === 'error');
  if (blocking.length > 0) {
    for (const p of env.problems) out(renderProblem(p));
    out('');
    out('  Fix the errors above, then run `sonata init` again.');
    return {
      problems: env.problems, models: [], roles: [], scope: 'skip', routing: 'skip', hookChanged: false,
      agentsWritten: [], configPath: join(opts.cwd, 'sonata.toml'),
      pruned: [],
    };
  }
  for (const p of env.problems) out(renderProblem(p));

  // ---- the question sequence -------------------------------------------
  let configScope!: ConfigScope;
  let configPathResolved!: string;
  let configText!: string;
  let ticked!: Set<string>;
  let providerKeys!: string[];
  let inScopeNative!: NativeCandidate[];
  let nativeKeys!: string[];
  // Carried from whichever config this run is rewriting: the setting is the
  // user's, not something the wizard asks about, so it must survive untouched.
  // Read by scope rather than captured once, since the scope is only settled
  // after the wizard (or the flags) answer it.
  const avoidGatewaysFor = (scope: ConfigScope): string[] =>
    env.configsByScope[scope]?.avoidGateways ?? [];
  let chosenNative!: NativeCandidate[];
  let roles!: string[];
  let nativeRoleModels: Record<string, NativeCandidate[]> = {};
  let tiers: Record<string, { simple: string[]; complex: string[] }> = {};
  let credentialSources: Record<string, CredentialSource> = {};
  let migratedModels: Record<string, { harness?: string; harnessId?: string }> = {};
  /** BYOK keys typed in the wizard, written only after the confirm gate. */
  let byokKeys: Record<string, string> = {};
  const nativeByKey = new Map(env.allNativeCandidates.map((c) => [c.key, c]));
  const byokUrls = new Map(env.byokProviders.map((provider) => [provider.name, provider.url]));

  /**
   * Candidates for models a user named directly.
   *
   * These must join `nativeByKey` before `nativeKeys` is resolved through it,
   * or every BYOK key looks up `undefined` and is filtered out silently — a
   * wizard that appears to work and writes an empty config.
   */
  /**
   * Candidates for models only a gateway's own `/models` endpoint reported.
   *
   * The models step refreshes each gateway's list from the gateway itself, so
   * it can surface a model no harness catalogue lists. Such a model has no
   * `NativeCandidate`, and `nativeKeys` is resolved through `nativeByKey` — so
   * without this it is selected, kept in the tiers, and then silently dropped
   * from `[models]`, producing a config that names a model it never defines.
   * An existing candidate always wins: the harness one carries a `harness`
   * route this cannot know about.
   */
  const addLiveCandidates = (liveModels: Record<string, string[]>): void => {
    for (const [gateway, ids] of Object.entries(liveModels)) {
      const baseUrl = env.providerBaseUrls[gateway];
      if (baseUrl === undefined) continue;
      const auth = env.gatewayAuth.get(gateway) ?? 'api-key';
      // Only a key-authenticated gateway is ever refreshed, so this is a
      // guard rather than a case: an OAuth gateway's URL is LiteLLM's, and
      // writing it as an api-key entry would produce a route that 401s.
      if (isOauthGatewayAuth(auth)) continue;
      for (const id of ids) {
        const key = byokCandidateKey(gateway, id);
        if (nativeByKey.has(key)) continue;
        nativeByKey.set(key, { key, gateway, id, contextWindow: 128000, baseUrl, auth: 'api-key' });
      }
    }
  };

  const addByokCandidates = (
    byokModels: Record<string, string[]>,
    wireFormats: Record<string, 'anthropic'> = {},
  ): void => {
    for (const [gateway, ids] of Object.entries(byokModels)) {
      const baseUrl = byokUrls.get(gateway);
      if (baseUrl === undefined) continue;
      const wireFormat = wireFormats[gateway];
      for (const id of ids) {
        const key = byokCandidateKey(gateway, id);
        nativeByKey.set(key, {
          key, gateway, id, contextWindow: 128000, baseUrl, auth: 'api-key',
          ...(wireFormat !== undefined ? { wireFormat } : {}),
        });
      }
    }
  };

  if (interactive) {
    const existingConfigPath = configPath(opts.cwd, opts.home);
    const resolvedScope: ConfigScope = existingConfigPath === configPathFor('global', opts.cwd, opts.home)
      ? 'global' : 'project';
    const initialState = env.configsByScope[resolvedScope]
      ? deriveInitState(env.configsByScope[resolvedScope]!, resolvedScope, env.offered)
      : { configScope: resolvedScope };
    const initialStateByScope: Partial<Record<ConfigScope, InitState>> = {};
    for (const scope of ['project', 'global'] as const) {
      if (env.configsByScope[scope]) initialStateByScope[scope] = deriveInitState(env.configsByScope[scope]!, scope, env.offered);
    }

    const codexCredential = readChatGptOAuth(opts.home, 'codex');
    const opencodeCredential = readOpencodeChatGptOAuth(opts.home);
    const daysUntil = (expiresAt: number | undefined): number | null => expiresAt === undefined
      ? null
      : Math.floor((expiresAt * 1000 - Date.now()) / (24 * 60 * 60 * 1000));
    const data: WizardData = {
      home: opts.home,
      harnesses: env.harnesses.map((h) => ({ name: h.name, installed: h.installed })),
      providers: env.offered.map((p) => ({ key: p.key, harness: p.harness, provider: p.provider, count: p.count })),
      candidates: env.allNativeCandidates.map((c) => ({ key: c.key, gateway: c.gateway, id: c.id, label: nativeLabel(c) })),
      roles: [...KNOWN_ROLES],
      byokProviders: env.byokProviders,
      // Every offered gateway, not just the BYOK ones: the models step asks a
      // gateway what it serves rather than trusting a harness snapshot, and
      // that call has to authenticate. A gateway with no resolvable key simply
      // keeps its harness list.
      storedKeys: Object.fromEntries(
        resolveKeys(
          [...new Set([...env.byokProviders.map((provider) => provider.name), ...env.offered.map((p) => p.provider)])],
          opts.home,
        ).map((source) => [source.gateway, source.key]),
      ),
      credentialAvailability: credentialAvailabilityFor(
        env.offered,
        env.gatewayAuth,
        {
          codex: codexCredential === null ? null : { expiresInDays: daysUntil(codexCredential.expires_at) },
          opencode: opencodeCredential === null ? null : { expiresInDays: daysUntil(opencodeCredential.expires_at) },
          // Unlike the `oauthProviders` call above, this specifically reports
          // whether *opencode's* token is importable — so it stays gated on
          // exchangeability, not mere presence.
          copilot: env.copilotUsable ? { expiresInDays: null } : null,
        },
        (gateway) => resolveKeys([gateway], opts.home)[0] !== undefined,
      ),
      gatewayAuth: Object.fromEntries(env.gatewayAuth),
      gatewayBaseUrls: env.providerBaseUrls,
      avoidGateways: avoidGatewaysFor(resolvedScope),
      initialState,
      initialStateByScope,
    };
    log.line(`wizard: offering ${data.providers.length} providers, ${data.candidates.length} models`);
    const result = await runInitTui(data, (line) => log.line(line));
    // Keys are recorded as the gateways they belong to, never as their value.
    log.line(`wizard returned: cancelled=${result.cancelled} scope=${result.state.configScope} ` +
      `providers=[${result.state.providerKeys ?? []}] models=[${result.state.nativeKeys ?? []}] ` +
      `roles=[${result.state.roles ?? []}] keysEnteredFor=[${Object.keys(result.state.byokKeys ?? {})}]`);
    if (result.cancelled) {
      out('  Nothing written.');
      return {
        problems: env.problems, models: [], roles: [], scope: 'skip', routing: 'skip', hookChanged: false,
        agentsWritten: [], configPath: configPathFor(
          result.state.configScope ?? 'project', opts.cwd, opts.home),
        pruned: [], cancelled: true,
      };
    }

    // Map result.state to the variables the write path needs:
    configScope = result.state.configScope ?? 'project';
    configPathResolved = configPathFor(configScope, opts.cwd, opts.home);
    // parseConfig always builds unifiedModels from the raw [models] table
    // (migrated or not), so this is complete regardless of whether the
    // existing config was legacy and just migrated in place above, or was
    // already in the unified shape — no need to re-run the migration here.
    const existingForScope = env.configsByScope[configScope];
    if (existingForScope !== undefined) {
      migratedModels = Object.fromEntries(
        Object.entries(existingForScope.unifiedModels)
          .filter(([, model]) => model.harness !== undefined && model.gateway === undefined)
          .map(([key, model]) => [key, { harness: model.harness, harnessId: model.harnessId }]),
      );
    }
    // Custom providers added through the wizard: register their URL before
    // adding BYOK candidates so validate() can exclude them from the
    // unknown-providers check.
    for (const provider of result.state.customProviders ?? []) {
      byokUrls.set(provider.name, provider.url);
    }
    addByokCandidates(result.state.byokModels ?? {}, result.state.customWireFormats);
    addLiveCandidates(result.state.liveModels ?? {});
    byokKeys = result.state.byokKeys ?? {};
    for (const gateway of Object.keys(byokKeys)) {
      for (const [key, candidate] of nativeByKey) {
        if (candidate.gateway !== gateway || candidate.auth === 'api-key') continue;
        if (!Object.hasOwn(WELL_KNOWN_PROVIDER_URLS, gateway)) {
          throw new Error(`sonata init: no API base URL is known for ${gateway}; cannot use an API key.`);
        }
        const baseUrl = WELL_KNOWN_PROVIDER_URLS[gateway];
        nativeByKey.set(key, { ...candidate, baseUrl, auth: 'api-key' });
      }
    }
    credentialSources = result.state.credentialSources ?? {};
    nativeKeys = result.state.nativeKeys ?? [];
    roles = result.state.roles ?? [...KNOWN_ROLES];
    // Reconciled against the roles and models actually selected: the wizard's
    // per-role map starts from the existing config, so iterating *it* rather
    // than `roles` kept a role the user had just deselected.
    const savedNativeKeys = initialStateByScope[configScope]?.nativeKeys ?? [];
    {
      const validTierKeys = new Set([...nativeKeys, ...Object.keys(migratedModels)]);
      const catalog = loadAaCatalog(opts.home);
      const addedKeys = nativeKeys.filter((key) => !savedNativeKeys.includes(key));
      tiers = Object.fromEntries(roles.map((role) => {
        const proposal = proposeTiers(nativeKeys, catalog, gatewayNamesOf(nativeByKey), avoidedKeysOf(nativeByKey, avoidGatewaysFor(configScope)));
        const saved = result.state.tiers?.[role];
        return [role, {
          simple: reconcileTierList(saved?.simple, validTierKeys, proposal.simple, addedKeys),
          complex: reconcileTierList(saved?.complex, validTierKeys, proposal.complex, addedKeys),
        }];
      }));
    }
    chosenNative = nativeKeys.map((k) => nativeByKey.get(k)).filter((k): k is NativeCandidate => k !== undefined);
    nativeRoleModels = Object.fromEntries(
      Object.entries(reconcilePerRoleModels(result.state.perRoleModels, savedNativeKeys, nativeKeys, roles))
        .map(([role, keys]) => [
          role,
          keys.map((k) => nativeByKey.get(k)).filter((k): k is NativeCandidate => k !== undefined),
        ]),
    );

    // Validate interactive path state (after customProviders are registered
    // so the unknown-providers check skips them).
    const state: InitState = {
      configScope,
      providerKeys: result.state.providerKeys ?? [],
      nativeKeys,
      roles,
      credentialSources,
      routing: result.state.routing ?? 'project',
      customProviders: result.state.customProviders,
    };
    const problems = validate(env, state, { nativeByKey });
    if (problems.length > 0) throw new Error(problems[0].message);
  } else {
    // ---- flag-driven (non-interactive) path -----------------------------
    configScope = opts.configScope ?? 'project';
    configPathResolved = configPathFor(configScope, opts.cwd, opts.home);
    configText = existsSync(configPathResolved) ? readFileSync(configPathResolved, 'utf8') : '';
    // parseConfig always builds unifiedModels from the raw [models] table
    // (migrated or not), so this is complete regardless of whether the
    // existing config was legacy and just migrated in place above, or was
    // already in the unified shape — no need to re-run the migration here.
    const parsedConfig = env.configsByScope[configScope];
    if (parsedConfig !== undefined) {
      migratedModels = Object.fromEntries(
        Object.entries(parsedConfig.unifiedModels)
          .filter(([, model]) => model.harness !== undefined && model.gateway === undefined)
          .map(([key, model]) => [key, { harness: model.harness, harnessId: model.harnessId }]),
      );
    }
    ticked = preTickedNative(configText, env.allNativeCandidates);
    const d = parsedConfig ? deriveInitState(parsedConfig, configScope, env.offered) : { configScope };
    credentialSources = {
      ...d.credentialSources,
      ...parseCredentialSourceFlags(opts.credentialSource ?? []),
    };

    // BYOK is opt-in. The default is "everything on offer", and BYOK rows are
    // now on offer — so without this, a plain `--yes` with no --providers asks
    // for a key for all thirty well-known providers and refuses. Only an
    // explicit `--providers byok/x`, or a config that already names one,
    // engages BYOK here.
    providerKeys = opts.providers ?? d.providerKeys
      ?? env.offered.filter((p) => p.harness !== 'byok').map((p) => p.key);

    // Scope native candidates to the selected providers.
    const selectedProviders = new Set(providerKeys.map((k) => k.split('/')[1] ?? k));
    inScopeNative = env.allNativeCandidates.filter((c) => selectedProviders.has(c.gateway));

    // A BYOK provider has no local catalogue, so each --models entry is taken
    // as a raw model id. Validating it would mean a network call, and a scripted
    // path must not depend on one.
    const byokSelected = providerKeys
      .map(byokProviderName)
      .filter((name): name is string => name !== undefined);

    // Parse BYOK model ids from opts.models so we can add candidates to
    // nativeByKey BEFORE calling validate. This lets validate's unknown-model
    // check see the BYOK models. The missing-key check itself (which needs
    // home) stays after validate so the unknown-providers check runs first,
    // matching the original --yes branch order where unknown-providers was
    // checked before the BYOK missing-key throw.
    const byokModels: Record<string, string[]> = {};
    for (const name of byokSelected) {
      const prefix = `${name}-`;
      byokModels[name] = (opts.models ?? [])
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length));
    }
    if (byokSelected.length > 0) {
      addByokCandidates(byokModels);
      inScopeNative = [
        ...inScopeNative,
        ...Object.values(byokModels).flat().length === 0 ? [] : byokSelected.flatMap((name) =>
          byokModels[name].map((id) => nativeByKey.get(byokCandidateKey(name, id))!)),
      ];
    }

    nativeKeys = opts.models ?? d.nativeKeys ?? inScopeNative.filter((c) => ticked.has(c.key)).map((c) => c.key);
    const inScopeNativeByKey = new Map(inScopeNative.map((c) => [c.key, c]));
    chosenNative = nativeKeys.map((k) => inScopeNativeByKey.get(k)!);

    roles = opts.roles ?? d.roles ?? [...KNOWN_ROLES];

    // Build state for validation
    const state = {
      configScope,
      providerKeys,
      nativeKeys,
      roles,
      credentialSources,
      routing: opts.routing ?? 'project',
    };
    const problems = validate(env, state, { nativeByKey });
    if (problems.length > 0) throw new Error(problems[0].message);

    // BYOK missing-key check needs home — keep it here (after validation so unknown providers are caught first)
    if (byokSelected.length > 0) {
      const stored = new Set(resolveKeys(byokSelected, opts.home).map((source) => source.gateway));
      const missing = byokSelected.filter((name) => !stored.has(name));
      if (missing.length > 0) {
        throw new Error(
          `sonata init: no key for ${missing.join(', ')}. ` +
          `Store it first: ${missing.map((name) => `sonata auth add ${name}`).join('; ')}`,
        );
      }
    }

    // Unknown model check (needs inScopeNativeByKey which is built after BYOK candidates added)
    const unknown = nativeKeys.filter((k) => !inScopeNativeByKey.has(k));
    if (unknown.length > 0) {
      throw new Error(
        `sonata init: the selected providers do not offer ${unknown.join(', ')}. ` +
        `Available: ${[...inScopeNativeByKey.keys()].join(', ')}`,
      );
    }

    nativeRoleModels = Object.fromEntries(
      Object.entries(reconcilePerRoleModels(d.perRoleModels, d.nativeKeys ?? [], nativeKeys, roles))
        .map(([role, keys]) => [
          role,
          keys.map((k) => nativeByKey.get(k)).filter((k): k is NativeCandidate => k !== undefined),
        ]),
    );
    {
      const validTierKeys = new Set([...nativeKeys, ...Object.keys(migratedModels)]);
      const catalog = loadAaCatalog(opts.home);
      const addedKeys = nativeKeys.filter((key) => !(d.nativeKeys ?? []).includes(key));
      tiers = Object.fromEntries(roles.map((role) => {
        const proposal = proposeTiers(nativeKeys, catalog, gatewayNamesOf(nativeByKey), avoidedKeysOf(nativeByKey, avoidGatewaysFor(configScope)));
        const saved = d.tiers?.[role];
        return [role, {
          simple: reconcileTierList(saved?.simple, validTierKeys, proposal.simple, addedKeys),
          complex: reconcileTierList(saved?.complex, validTierKeys, proposal.complex, addedKeys),
        }];
      }));
    }
  }

  // A gateway pinned to credential_source = "sonata" with an OAuth auth type
  // needs a credential sonata itself minted (via `sonata auth login`), and the
  // --yes path cannot pause for a browser device login. Check this for both
  // paths here, since it depends on filesystem state.
  {
    const gatewayAuths = new Map(chosenNative.map((candidate) => [candidate.gateway, candidate.auth]));
    for (const [gateway, source] of Object.entries(credentialSources)) {
      const auth = gatewayAuths.get(gateway);
      if (source !== 'sonata' || auth === undefined || !isOauthGatewayAuth(auth)) continue;
      if (existsSync(join(credentialDir(opts.home, gateway), credentialFileFor(auth)))) continue;
      throw new Error(
        `sonata init: gateway "${gateway}" needs a credential. ` +
        `Log in first: sonata auth login ${gateway}`,
      );
    }
  }

  // ---- key check --------------------------------------------------------
  out('');
  const gateways = [...new Set(chosenNative.map((c) => c.gateway))];
  const gatewayAuths = new Map(chosenNative.map((c) => [c.gateway, c.auth]));
  const autoSources = new Map(keyReport(gateways, opts.home).map((r) => [r.gateway, r.source]));
  for (const gateway of gateways) {
    // A gateway with a recorded credentialSource is about to be written
    // pinned to that source — report on the source that will actually be
    // used, not whichever store `keyReport`'s automatic precedence happens
    // to find first.
    const source = credentialSources[gateway];
    const auth = gatewayAuths.get(gateway);
    if (auth === 'api-key' && (source === 'sonata' || source === 'opencode')) {
      const found = resolveKeyFromSource(gateway, opts.home, source) !== undefined;
      out(found
        ? `  ✓ ${gateway}: key from ${source}`
        : source === 'sonata'
          ? `  ! ${gateway}: no key from sonata — run \`sonata auth add ${gateway}\``
          : `  ! ${gateway}: no key from opencode — log into opencode itself, sonata does not manage its credentials`);
      continue;
    }
    if (auth !== undefined && isOauthGatewayAuth(auth) && source !== undefined) {
      // Bearer keys and device-login OAuth credentials live in different
      // stores per source, so presence and the repair hint both branch on
      // (source, auth) rather than reusing the api-key path above.
      // A stored GitHub token is not the same as a usable one: opencode's own
      // login requests only `read:user`, and GitHub then refuses the Copilot
      // exchange with a 403 — so presence alone would report a credential as
      // healthy that `sonata serve` cannot actually use. `copilotUsable` above
      // already answered this for the one token opencode can hold — reuse it
      // rather than probing GitHub a second time, which could also disagree
      // with the first probe on a flaky connection.
      const found = source === 'sonata'
        ? existsSync(join(credentialDir(opts.home, gateway), credentialFileFor(auth)))
        : auth === 'copilot-oauth'
          ? env.copilotUsable
          : readChatGptOAuth(opts.home, source) !== null;
      const repair = source === 'sonata'
        ? `run \`sonata auth login ${gateway}\``
        : source === 'codex'
          ? 'log in with `codex login`'
          : auth === 'copilot-oauth'
            ? 'log into opencode with a GitHub Copilot account'
            : 'log into opencode with a ChatGPT account';
      out(found
        ? `  ✓ ${gateway}: credential from ${source}`
        : `  ! ${gateway}: no credential from ${source} — ${repair}`);
      continue;
    }
    const auto = autoSources.get(gateway) ?? null;
    out(auto
      ? `  ✓ ${gateway}: key from ${auto}`
      : `  ! ${gateway}: no key — run \`sonata auth add ${gateway}\``);
  }

  // ---- hook scope -------------------------------------------------------
  const command = hookCommand(opts.packageRoot);
  const alreadyGlobal = hookInstalled(readSettings(settingsPath('global', opts.cwd, opts.home)), command);
  const alreadyProject = hookInstalled(readSettings(settingsPath('project', opts.cwd, opts.home)), command);

  // Where an already-installed hook actually lives — kept separate from
  // `scope` so an upgrade (hook present, but its settings file still carries
  // the pre-dispatch-CLI MCP tool names) still gets its allow-list checked
  // below, even though `scope` itself becomes 'skip' for "no new hook to ask
  // about".
  const existingHookScope: HookScope | undefined = env.existingHookScope;

  let scope: HookScope | 'skip';
  if (opts.scope) {
    scope = opts.scope;
  } else if (alreadyGlobal || alreadyProject) {
    out('');
    out(`  ✓ permission hook already installed (${alreadyGlobal ? 'global' : 'project'})`);
    scope = 'skip';
  } else if (interactive) {
    out('');
    log.line('prompting for hook scope');
    scope = await select<HookScope | 'skip'>('Install the permission hook', [
      { value: 'project', label: 'This project only', hint: 'no effect on your other repos' },
      { value: 'global', label: 'All projects', hint: 'adds ~40ms per Bash call everywhere' },
      { value: 'skip', label: 'Skip', hint: 'sonata assumes default mode' },
    ]);
  } else {
    scope = 'project';
  }

  // ---- loop skill and routing ------------------------------------------
  let routing: 'project' | 'global' | 'skip';
  if (opts.routing) {
    routing = opts.routing;
  } else if (interactive) {
    out('');
    log.line('prompting for tier-agent routing');
    routing = await select<'project' | 'global' | 'skip'>('Route tier agents through the native router', [
      { value: 'project', label: 'sonata route auto', hint: 'this project only' },
      ...(configScope === 'project' ? [] : [
        { value: 'global' as const, label: 'sonata route auto --global', hint: 'all projects' },
      ]),
      { value: 'skip', label: 'Skip', hint: 'doctor will warn for tier agents' },
    ]);
  } else {
    routing = 'project';
  }

  // ---- confirm ----------------------------------------------------------
  out('');
  out('  Summary');
  out(`    models  ${chosenNative.map(nativeLabel).join(', ')}`);
  out(`    roles   ${roles.join(', ')}`);
  const totalAgents = Object.values(nativeRoleModels).reduce((n, m) => n + m.length, 0);
  out(`    agents  ${totalAgents} files in .claude/agents/`);
  out(`    hook    ${scope === 'skip' ? 'not installed' : `${scope} settings.json`}`);
  out(`    routing ${routing === 'skip' ? 'not configured' : `sonata route auto${routing === 'global' ? ' --global' : ''}`}`);
  out(`    config  ${configPathResolved}`);
  out('');

  log.line(`hook scope resolved: ${scope}`);
  if (interactive) log.line('prompting for write confirmation');
  if (interactive && !(await confirm('Write these changes?', true))) {
    out('  Nothing written.');
    return {
      problems: env.problems, models: nativeKeys, roles, scope, routing, hookChanged: false,
      agentsWritten: [], configPath: configPathResolved, cancelled: true,
      pruned: [],
    };
  }

  // ---- write ------------------------------------------------------------
  // Keys typed in the wizard are stored here and nowhere earlier: a cancelled
  // run must leave no credential behind. The gateway is printed, never the key.
  for (const [gateway, key] of Object.entries(byokKeys)) {
    writeSonataKey(opts.home, gateway, key);
    out(`  ✓ stored the key for ${gateway}`);
  }

  mkdirSync(dirname(configPathResolved), { recursive: true });
  writeFileSync(configPathResolved, nativeTomlFor(nativeRoleModels, credentialSources, tiers, migratedModels, chosenNative, env.configsByScope[configScope]?.run, avoidGatewaysFor(configScope)));
  out(`  ✓ wrote ${configPathResolved}`);

  let hookChanged = false;
  // Refresh the allow-list at whichever scope the hook actually lives in —
  // scope !== 'skip' for a fresh install, or existingHookScope when it was
  // already there (an upgrade from the MCP-based release otherwise keeps
  // its old mcp__sonata__* entries forever, since "hook already installed"
  // used to mean skipping this whole block).
  const allowListScope = scope !== 'skip' ? scope : existingHookScope;
  if (allowListScope !== undefined) {
    const path = settingsPath(allowListScope, opts.cwd, opts.home);
    const withHook = scope !== 'skip'
      ? installHook(readSettings(path), command)
      : { settings: readSettings(path), changed: false };
    const withAllow = allowSonataTools(withHook.settings);
    if (withHook.changed || withAllow.changed) writeSettings(path, withAllow.settings);
    hookChanged = withHook.changed;
    if (scope !== 'skip') {
      out(withHook.changed ? `  ✓ installed hook in ${path}` : `  · hook already present in ${path}`);
    }
    out(withAllow.changed
      ? `  ✓ allow-listed the sonata tools in ${path}`
      : `  · sonata tools already allow-listed in ${path}`);
  }

  const skillBaseDir = configScope === 'global' ? opts.home : opts.cwd;
  const skillPath = join(skillBaseDir, '.claude', 'skills', 'sonata-loop', 'SKILL.md');
  mkdirSync(dirname(skillPath), { recursive: true });
  const packageSkill = join(opts.packageRoot, 'skills', 'loop', 'SKILL.md');
  const skillSource = existsSync(packageSkill)
    ? packageSkill
    : join(process.cwd(), 'skills', 'loop', 'SKILL.md');
  writeFileSync(skillPath, readFileSync(skillSource));
  out(`  ✓ installed loop skill in ${skillPath}`);

  if (routing !== 'skip') {
    await cmdRoute('auto', {
      cwd: opts.cwd,
      home: opts.home,
      packageRoot: opts.packageRoot,
      scope: routing,
    });
    out(`  ✓ configured sonata route auto${routing === 'global' ? ' --global' : ''}`);
  }

  const agentsDir = agentsDirFor(configScope, opts.cwd, opts.home);
  // cmdSync loads its own config via `loadConfig(cwd, home)` — passing the
  // invoking repo's cwd unconditionally would sync from THAT project's
  // sonata.toml even when writing --config-scope global, if the repo
  // happens to have its own config file too. Pointing cwd at the machine
  // config's own directory for the global case makes loadConfig resolve
  // the config just written above, not whatever the invoking directory has.
  const syncCwd = configScope === 'global' ? dirname(join(opts.home, GLOBAL_CONFIG_RELATIVE)) : opts.cwd;
  const sync = cmdSync({ cwd: syncCwd, home: opts.home, agentsDir });
  const agentsWritten = sync.written;
  out(`  ✓ generated ${agentsWritten.length} agents in ${agentsDir}`);


  if (sync.skipped.length > 0) {
    out('');
    out(`  ! ${sync.skipped.length} existing agent file(s) were NOT overwritten (not sonata-generated):`);
    for (const f of sync.skipped.slice(0, 5)) out(`      ${f}`);
    if (sync.skipped.length > 5) out(`      … and ${sync.skipped.length - 5} more`);
  }

  const stale = sync.stale;
  let pruned: string[] = [];
  if (stale.length > 0) {
    out('');
    out(`  ! ${stale.length} stale agent file(s) no longer in your config:`);
    for (const f of stale.slice(0, 5)) out(`      ${f}`);
    if (stale.length > 5) out(`      … and ${stale.length - 5} more`);
    const remove = opts.prune ?? (interactive && await confirm('Delete them?', true));
    if (remove) {
      pruned = pruneAgents(agentsDir, stale);
      out(`  ✓ removed ${pruned.length} stale agent file(s)`);
    } else {
      out('      ❯ delete them by hand, or re-run with --prune');
    }
  }

  out('');
  out('  Done. Run /reload-plugins to pick up the new agents.');
  out('  Native sessions: run `sonata code`, or `sonata route on` to route plain claude sessions.');
  out('');

  return {
    problems: env.problems, models: nativeKeys, roles, scope, routing, hookChanged, agentsWritten,
    configPath: configPathResolved, pruned,
  };
}

export function isCancellation(err: unknown): boolean {
  return err instanceof CancelledError;
}
