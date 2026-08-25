/**
 * `sonata init` — first-run onboarding and repair.
 *
 * Interactive by default; every choice also has a flag so the command works in
 * CI and scripts. Nothing is written until the user confirms the summary.
 *
 * The wizard writes native models only — foreign models running inside Claude
 * Code's own loop via a local routing proxy. The harness-based wrapper path
 * (`[models]`/`[generate.roles]`) is still supported by the config parser and
 * by `sonata sync`, but `init` does not generate or carry through those entries.
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
import { select, confirm, isInteractive, banner, CancelledError } from '../tui.js';
import { keyReport, resolveKeyFromSource, resolveKeys, writeSonataKey } from '../native/credentials.js';
import { byokCandidateKey, wellKnownProviders } from '../native/models.js';
import { loadAaCatalog, proposeTiers } from '../catalog.js';
import { byokProviderKey, byokProviderName, type AvailableCredentials } from '../tui-ink/app-state.js';
import { runInitTui } from '../tui-ink/run.js';
import { openInitLog, type InitLog } from './init-log.js';
import type { WizardData } from '../tui-ink/app.js';
import type { InitState } from '../tui-ink/types.js';

const OPENCODE_RANGE = '>=1.18.0 <2.0.0';

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

const TOML_ESCAPES: Record<string, string> = {
  '\\': '\\\\', '"': '\\"', '\b': '\\b', '\t': '\\t',
  '\n': '\\n', '\f': '\\f', '\r': '\\r',
};

/**
 * A TOML basic string, used for every key and value this file writes.
 */
function tomlKey(key: string): string {
  // eslint-disable-next-line no-control-regex
  const escaped = key.replace(/[\\"\u0000-\u001f\u007f]/g, (ch) =>
    TOML_ESCAPES[ch] ?? `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `"${escaped}"`;
}

/**
 * A native model candidate discovered from harness provider catalogues.
 */
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

export function deriveInitState(
  config: SonataConfig,
  configScope: ConfigScope,
  offered: ProviderSummary[],
): InitState {
  const nativeModels = config.native?.models ?? {};
  const unifiedModels = config.unifiedModels;
  const modelKeys = Object.keys(config.tiers ? unifiedModels : nativeModels);
  if (modelKeys.length === 0) return { configScope };

  const gateways = [...new Set(modelKeys.map((key) =>
    unifiedModels[key]?.gateway ?? nativeModels[key]?.gateway,
  ).filter((gateway): gateway is string => gateway !== undefined))];
  const providerKeys: string[] = [];
  const harnesses: string[] = [];
  for (const gateway of gateways) {
    const matches = offered.filter((provider) => provider.provider === gateway);
    if (matches.length === 0) {
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
    roles: Object.keys(config.tiers ?? config.native?.generate ?? {}),
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
  if (unified.length > 0 || config.native === undefined) return unified;
  return Object.entries(config.native.models).flatMap(([key, model]) => {
    const gateway = config.native!.gateways[model.gateway];
    if (gateway === undefined) return [];
    return [{
      key, gateway: model.gateway, id: model.id,
      contextWindow: model.contextWindow,
      baseUrl: gateway.baseUrl, auth: gateway.auth,
      ...(gateway.wireFormat !== undefined ? { wireFormat: gateway.wireFormat } : {}),
    }];
  });
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
export function nativeTomlFor(
  roleModels: Record<string, NativeCandidate[]>,
  credentialSources: Record<string, CredentialSource> = {},
  selectedTiers?: Record<string, { simple: string[]; complex: string[] }>,
): string {
  const allModels = new Map<string, NativeCandidate>();
  for (const cands of Object.values(roleModels)) {
    for (const c of cands) allModels.set(c.key, c);
  }
  const tierLists = selectedTiers ?? Object.fromEntries(
    Object.entries(roleModels).map(([role, candidates]) => {
      const proposal = proposeTiers(candidates.map((candidate) => candidate.key));
      return [role, proposal];
    }),
  );

  const clashes = duplicateKeys([...allModels.keys()]);
  if (clashes.length > 0) {
    throw new Error(
      `sonata: ${clashes.join(', ')} would name two different models.`,
    );
  }

  const gateways = new Map<string, { baseUrl: string; auth: NativeGatewayAuth; wireFormat?: NativeGatewayWireFormat }>();
  for (const c of allModels.values()) gateways.set(c.gateway, {
    baseUrl: c.baseUrl, auth: c.auth, wireFormat: c.wireFormat,
  });

  const lines: string[] = [];

  for (const [gateway, { baseUrl, auth, wireFormat }] of gateways) {
    lines.push(`[native.gateways.${tomlKey(gateway)}]`);
    // An OAuth gateway takes no base_url: the credential reaches only its own
    // provider's backend, and LiteLLM already knows that URL.
    if (isOauthGatewayAuth(auth)) lines.push(`auth = ${tomlKey(auth)}`);
    else lines.push(`base_url = ${tomlKey(baseUrl)}`);
    const source = credentialSources[gateway];
    if (source !== undefined) lines.push(`credential_source = ${tomlKey(source)}`);
    if (wireFormat === 'anthropic') lines.push(`wire_format = ${tomlKey(wireFormat)}`);
    lines.push('');
  }

  for (const [key, c] of allModels) {
    lines.push(`[models.${tomlKey(key)}]`, `gateway = ${tomlKey(c.gateway)}`, `id = ${tomlKey(c.id)}`, `context_window = ${c.contextWindow}`);
    if (c.harness !== undefined) {
      lines.push(`harness = ${tomlKey(c.harness)}`, `harness_id = ${tomlKey(c.harnessId ?? c.id)}`);
    }
    lines.push('');
  }

  for (const [role, lists] of Object.entries(tierLists)) {
    lines.push(`[tiers.${tomlKey(role)}]`, `simple = [${lists.simple.map(tomlKey).join(', ')}]`, `complex = [${lists.complex.map(tomlKey).join(', ')}]`, '');
  }

  lines.push(
    '[run]',
    'tail_window_seconds = 20',
    'stall_timeout_seconds = 120',
    'run_timeout_seconds = 1800',
    '',
  );
  return lines.join('\n');
}

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

  // ---- detect -----------------------------------------------------------
  const detect = opts.detect ?? defaultDetector;
  const { tmux, harnesses } = await detect({ home: opts.home, supportedVersions: OPENCODE_RANGE });
  const problems: Problem[] = [...tmux.problems, ...harnesses.flatMap((h) => h.problems)];

  out(tmux.installed ? `  ✓ tmux ${tmux.version}` : '  ✗ tmux not found');
  for (const h of harnesses) {
    out(h.installed
      ? `  ✓ ${h.name} ${h.version} · ${h.refs.length} models`
      : `  · ${h.name} not installed`);
  }
  out('');

  const allRefs = harnesses.flatMap((h) => h.refs);
  const authed = harnesses.flatMap((h) => h.authedProviders);
  const offered: ProviderSummary[] = offerableProviders(allRefs, authed);

  const configsByScope: Partial<Record<ConfigScope, SonataConfig>> = {};
  for (const scope of ['project', 'global'] as const) {
    const path = configPathFor(scope, opts.cwd, opts.home);
    if (!existsSync(path)) continue;
    try {
      configsByScope[scope] = parseConfig(readFileSync(path, 'utf8'));
    } catch (err) {
      out(`  ! could not read ${path}; init is starting from defaults: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const configuredGateways = new Map<string, number>();
  for (const config of Object.values(configsByScope)) {
    for (const model of Object.values(config?.native?.models ?? {})) {
      configuredGateways.set(model.gateway, (configuredGateways.get(model.gateway) ?? 0) + 1);
    }
  }
  for (const [gateway, count] of configuredGateways) {
    if (!offered.some((provider) => provider.provider === gateway)) {
      offered.push({ harness: 'config', provider: gateway, key: `config/${gateway}`, count });
    }
  }

  const providerBaseUrls: Record<string, string> = {};
  for (const h of harnesses) {
    for (const [k, v] of Object.entries(h.providerBaseUrls ?? {})) {
      if (!providerBaseUrls[k]) providerBaseUrls[k] = v;
    }
  }
  // A harness logged in with a subscription holds an OAuth credential, not an
  // API key. Writing such a provider with a metered base URL produces a gateway
  // that authenticates and is then refused for quota, which reads to the user as
  // a missing key. Record how each provider actually authenticates instead.
  // opencode's stored GitHub token usually cannot mint a Copilot key: opencode
  // requests only `read:user`, so the exchange 403s and LiteLLM drops the
  // model. That is a property of *opencode's specific credential*, not of the
  // github-copilot gateway itself — the gateway is always OAuth-authenticated,
  // and "Add provider" can still run its own device-flow login (which asks
  // for the `copilot` scope directly) independent of opencode's token. So
  // `copilotUsable` gates only whether opencode's token is offered for
  // *import* — it must not stop the gateway from being recognized as OAuth,
  // or the models opencode already lists for it would be filtered out of the
  // candidate set entirely (nativeCandidatesFrom drops any provider absent
  // from both providerBaseUrls and oauthProviders), leaving "Add provider"'s
  // fresh login with nothing to select afterward.
  const copilotToken = readCopilotToken(opts.home);
  const copilotUsable = copilotToken !== null
    && await copilotTokenCanExchange(copilotToken);
  if (copilotToken !== null && !copilotUsable) {
    out('  ! github-copilot: the stored opencode token cannot mint a Copilot key ' +
        '(needs the `copilot` scope) — not importable from opencode; use Add provider to log in directly');
  }

  const oauthProviders = oauthProvidersFor(allRefs, opts.home, {
    copilot: () => copilotToken,
  });
  const gatewayAuth = new Map<string, NativeGatewayAuth>();
  for (const config of Object.values(configsByScope)) {
    for (const [gateway, gatewayConfig] of Object.entries(config?.native?.gateways ?? {})) {
      gatewayAuth.set(gateway, gatewayConfig.auth);
    }
  }
  for (const [gateway, auth] of oauthProviders) gatewayAuth.set(gateway, auth);
  const detectedNativeCandidates = nativeCandidatesFrom(allRefs, providerBaseUrls, oauthProviders);
  const allNativeCandidates = [...new Map([
    ...detectedNativeCandidates.map((candidate) => [candidate.key, candidate] as const),
    ...Object.values(configsByScope).flatMap((config) => configNativeCandidates(config!)).map((candidate) => [candidate.key, candidate] as const),
  ]).values()];

  // Providers a user can name without any harness installed. Offered alongside
  // the discovered ones, minus any whose name a real provider already covers —
  // otherwise deepseek appears twice, once with a catalogue and once without.
  const byokProviders = wellKnownProviders()
    .filter((provider) => !offered.some((existing) => existing.provider === provider.name));
  for (const provider of byokProviders) {
    offered.push({
      harness: 'byok',
      provider: provider.name,
      key: byokProviderKey(provider.name),
      count: 0,
    });
  }

  // Having no harness is no longer fatal: BYOK is exactly that case, and the
  // wizard can reach a working config from it. It is still worth saying, so it
  // stays a problem — a warning, which does not stop the run.
  if (offered.every((provider) => provider.harness === 'byok')) {
    problems.push({
      severity: 'warn',
      message: 'no harness reported a usable model provider',
      fix: 'pick a provider below and enter its API key, or run `opencode auth login`',
    });
  }

  const blocking = problems.filter((p) => p.severity === 'error');
  if (blocking.length > 0) {
    for (const p of problems) out(renderProblem(p));
    out('');
    out('  Fix the errors above, then run `sonata init` again.');
    return {
      problems, models: [], roles: [], scope: 'skip', hookChanged: false,
      agentsWritten: [], configPath: join(opts.cwd, 'sonata.toml'),
      pruned: [],
    };
  }
  for (const p of problems) out(renderProblem(p));

  // ---- the question sequence -------------------------------------------
  let configScope!: ConfigScope;
  let configPathResolved!: string;
  let configText!: string;
  let ticked!: Set<string>;
  let providerKeys!: string[];
  let inScopeNative!: NativeCandidate[];
  let nativeKeys!: string[];
  let chosenNative!: NativeCandidate[];
  let roles!: string[];
  let nativeRoleModels: Record<string, NativeCandidate[]> = {};
  let tiers: Record<string, { simple: string[]; complex: string[] }> = {};
  let credentialSources: Record<string, CredentialSource> = {};
  /** BYOK keys typed in the wizard, written only after the confirm gate. */
  let byokKeys: Record<string, string> = {};
  const nativeByKey = new Map(allNativeCandidates.map((c) => [c.key, c]));
  const byokUrls = new Map(byokProviders.map((provider) => [provider.name, provider.url]));

  /**
   * Candidates for models a user named directly.
   *
   * These must join `nativeByKey` before `nativeKeys` is resolved through it,
   * or every BYOK key looks up `undefined` and is filtered out silently — a
   * wizard that appears to work and writes an empty config.
   */
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
    const initialState = configsByScope[resolvedScope]
      ? deriveInitState(configsByScope[resolvedScope]!, resolvedScope, offered)
      : { configScope: resolvedScope };
    const initialStateByScope: Partial<Record<ConfigScope, InitState>> = {};
    for (const scope of ['project', 'global'] as const) {
      if (configsByScope[scope]) initialStateByScope[scope] = deriveInitState(configsByScope[scope]!, scope, offered);
    }

    const codexCredential = readChatGptOAuth(opts.home, 'codex');
    const opencodeCredential = readOpencodeChatGptOAuth(opts.home);
    const daysUntil = (expiresAt: number | undefined): number | null => expiresAt === undefined
      ? null
      : Math.floor((expiresAt * 1000 - Date.now()) / (24 * 60 * 60 * 1000));
    const data: WizardData = {
      home: opts.home,
      harnesses: harnesses.map((h) => ({ name: h.name, installed: h.installed })),
      providers: offered.map((p) => ({ key: p.key, harness: p.harness, provider: p.provider, count: p.count })),
      candidates: allNativeCandidates.map((c) => ({ key: c.key, gateway: c.gateway, id: c.id, label: nativeLabel(c) })),
      roles: [...KNOWN_ROLES],
      byokProviders,
      storedKeys: Object.fromEntries(
        resolveKeys(byokProviders.map((provider) => provider.name), opts.home)
          .map((source) => [source.gateway, source.key]),
      ),
      credentialAvailability: credentialAvailabilityFor(
        offered,
        gatewayAuth,
        {
          codex: codexCredential === null ? null : { expiresInDays: daysUntil(codexCredential.expires_at) },
          opencode: opencodeCredential === null ? null : { expiresInDays: daysUntil(opencodeCredential.expires_at) },
          // Unlike the `oauthProviders` call above, this specifically reports
          // whether *opencode's* token is importable — so it stays gated on
          // exchangeability, not mere presence.
          copilot: copilotUsable ? { expiresInDays: null } : null,
        },
        (gateway) => resolveKeys([gateway], opts.home)[0] !== undefined,
      ),
      gatewayAuth: Object.fromEntries(gatewayAuth),
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
        problems, models: [], roles: [], scope: 'skip', hookChanged: false,
        agentsWritten: [], configPath: configPathFor(
          result.state.configScope ?? 'project', opts.cwd, opts.home),
        pruned: [], cancelled: true,
      };
    }

    // Map result.state to the variables the write path needs:
    configScope = result.state.configScope ?? 'project';
    configPathResolved = configPathFor(configScope, opts.cwd, opts.home);
    for (const provider of result.state.customProviders ?? []) {
      byokUrls.set(provider.name, provider.url);
    }
    addByokCandidates(result.state.byokModels ?? {}, result.state.customWireFormats);
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
    tiers = result.state.tiers ?? Object.fromEntries(roles.map((role) => [role, proposeTiers(nativeKeys, loadAaCatalog(opts.home))]));
    chosenNative = nativeKeys.map((k) => nativeByKey.get(k)).filter((k): k is NativeCandidate => k !== undefined);
    // Reconciled against the roles and models actually selected: the wizard's
    // per-role map starts from the existing config, so iterating *it* rather
    // than `roles` kept a role the user had just deselected.
    nativeRoleModels = Object.fromEntries(
      Object.entries(reconcilePerRoleModels(result.state.perRoleModels, nativeKeys, nativeKeys, roles))
        .map(([role, keys]) => [
          role,
          keys.map((k) => nativeByKey.get(k)).filter((k): k is NativeCandidate => k !== undefined),
        ]),
    );
  } else {
    // ---- flag-driven (non-interactive) path -----------------------------
    configScope = opts.configScope ?? 'project';
    configPathResolved = configPathFor(configScope, opts.cwd, opts.home);
    configText = existsSync(configPathResolved) ? readFileSync(configPathResolved, 'utf8') : '';
    const parsedConfig = configsByScope[configScope];
    ticked = preTickedNative(configText, allNativeCandidates);
    const d = parsedConfig ? deriveInitState(parsedConfig, configScope, offered) : { configScope };
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
      ?? offered.filter((p) => p.harness !== 'byok').map((p) => p.key);
    const unknownProviders = providerKeys.filter((k) => !offered.some((p) => p.key === k));
    if (unknownProviders.length > 0) {
      throw new Error(
        `sonata init: no harness offers ${unknownProviders.join(', ')}. ` +
        `Available: ${offered.map((p) => p.key).join(', ')}`,
      );
    }

    // Scope native candidates to the selected providers.
    const selectedProviders = new Set(providerKeys.map((k) => k.split('/')[1] ?? k));
    inScopeNative = allNativeCandidates.filter((c) => selectedProviders.has(c.gateway));

    // A BYOK provider has no local catalogue, so each --models entry is taken
    // as a raw model id. Validating it would mean a network call, and a scripted
    // path must not depend on one.
    const byokSelected = providerKeys
      .map(byokProviderName)
      .filter((name): name is string => name !== undefined);
    if (byokSelected.length > 0) {
      const stored = new Set(resolveKeys(byokSelected, opts.home).map((source) => source.gateway));
      const missing = byokSelected.filter((name) => !stored.has(name));
      if (missing.length > 0) {
        throw new Error(
          `sonata init: no key for ${missing.join(', ')}. ` +
          `Store it first: ${missing.map((name) => `sonata auth add ${name}`).join('; ')}`,
        );
      }
      const byokModels: Record<string, string[]> = {};
      for (const name of byokSelected) {
        const prefix = `${name}-`;
        byokModels[name] = (opts.models ?? [])
          .filter((key) => key.startsWith(prefix))
          .map((key) => key.slice(prefix.length));
      }
      addByokCandidates(byokModels);
      inScopeNative = [
        ...inScopeNative,
        ...Object.values(byokModels).flat().length === 0 ? [] : byokSelected.flatMap((name) =>
          byokModels[name].map((id) => nativeByKey.get(byokCandidateKey(name, id))!)),
      ];
    }

    nativeKeys = opts.models ?? d.nativeKeys ?? inScopeNative.filter((c) => ticked.has(c.key)).map((c) => c.key);
    const inScopeNativeByKey = new Map(inScopeNative.map((c) => [c.key, c]));
    const unknown = nativeKeys.filter((k) => !inScopeNativeByKey.has(k));
    if (unknown.length > 0) {
      throw new Error(
        `sonata init: the selected providers do not offer ${unknown.join(', ')}. ` +
        `Available: ${[...inScopeNativeByKey.keys()].join(', ')}`,
      );
    }
    if (nativeKeys.length === 0) {
      throw new Error('sonata init: no models selected — nothing to generate.');
    }
    chosenNative = nativeKeys.map((k) => inScopeNativeByKey.get(k)!);

    // --yes cannot pause for a browser-based device login. Require a credential
    // that sonata already minted before recording that source in the config.
    const nativeGateways = new Map(chosenNative.map((candidate) => [candidate.gateway, candidate]));
    for (const gateway of Object.keys(parseCredentialSourceFlags(opts.credentialSource ?? []))) {
      if (nativeGateways.has(gateway)) continue;
      throw new Error(
        `sonata init: --credential-source names gateway "${gateway}", which is not among the selected models. ` +
        `Known gateways: ${[...nativeGateways.keys()].join(', ') || '(none)'}`,
      );
    }
    roles = opts.roles ?? d.roles ?? [...KNOWN_ROLES];
    const badRoles = roles.filter((r) => !KNOWN_ROLES.includes(r as never));
    if (badRoles.length > 0) {
      throw new Error(`sonata init: unknown role(s) ${badRoles.join(', ')}`);
    }
    if (roles.length === 0) {
      throw new Error('sonata init: no roles selected — nothing to generate.');
    }

    nativeRoleModels = Object.fromEntries(
      Object.entries(reconcilePerRoleModels(d.perRoleModels, d.nativeKeys ?? [], nativeKeys, roles))
        .map(([role, keys]) => [
          role,
          keys.map((k) => nativeByKey.get(k)).filter((k): k is NativeCandidate => k !== undefined),
        ]),
    );
    tiers = Object.fromEntries(roles.map((role) => [
      role,
      d.tiers?.[role] ?? proposeTiers(nativeKeys, loadAaCatalog(opts.home)),
    ]));
  }

  // A codex-sourced credential applies to neither an api-key gateway (codex
  // holds a subscription, not a bearer key) nor a copilot-oauth gateway
  // (Copilot logins come only from opencode). The wizard's picker already
  // hides these combinations, but stale state or a picker regression could
  // still produce one, so this is checked for both paths rather than trusted
  // to the interactive UI alone.
  {
    const gatewayAuths = new Map(chosenNative.map((candidate) => [candidate.gateway, candidate.auth]));
    for (const [gateway, source] of Object.entries(credentialSources)) {
      const auth = gatewayAuths.get(gateway);
      if (source === 'codex' && auth === 'api-key') {
        throw new Error(
          `sonata init: gateway "${gateway}" is auth = "api-key", so it cannot take its credential from codex — ` +
          'that is a subscription, not a key.',
        );
      }
      if (source === 'codex' && auth === 'copilot-oauth') {
        throw new Error(
          `sonata init: gateway "${gateway}" is copilot-oauth, so it cannot take its credential from codex — ` +
          'Copilot logins come only from opencode.',
        );
      }
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
          ? copilotUsable
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

  // ---- confirm ----------------------------------------------------------
  out('');
  out('  Summary');
  out(`    models  ${chosenNative.map(nativeLabel).join(', ')}`);
  out(`    roles   ${roles.join(', ')}`);
  const totalAgents = Object.values(nativeRoleModels).reduce((n, m) => n + m.length, 0);
  out(`    agents  ${totalAgents} files in .claude/agents/`);
  out(`    hook    ${scope === 'skip' ? 'not installed' : `${scope} settings.json`}`);
  out(`    config  ${configPathResolved}`);
  out('');

  log.line(`hook scope resolved: ${scope}`);
  if (interactive) log.line('prompting for write confirmation');
  if (interactive && !(await confirm('Write these changes?', true))) {
    out('  Nothing written.');
    return {
      problems, models: nativeKeys, roles, scope, hookChanged: false,
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
  writeFileSync(configPathResolved, nativeTomlFor(nativeRoleModels, credentialSources, tiers));
  out(`  ✓ wrote ${configPathResolved}`);

  let hookChanged = false;
  if (scope !== 'skip') {
    const path = settingsPath(scope, opts.cwd, opts.home);
    const withHook = installHook(readSettings(path), command);
    const withAllow = allowSonataTools(withHook.settings);
    if (withHook.changed || withAllow.changed) writeSettings(path, withAllow.settings);
    hookChanged = withHook.changed;
    out(withHook.changed ? `  ✓ installed hook in ${path}` : `  · hook already present in ${path}`);
    out(withAllow.changed
      ? `  ✓ allow-listed the sonata tools in ${path}`
      : `  · sonata tools already allow-listed in ${path}`);
  }

  const agentsDir = agentsDirFor(configScope, opts.cwd, opts.home);
  const sync = cmdSync({ cwd: opts.cwd, home: opts.home, agentsDir });
  const agentsWritten = sync.written;
  out(`  ✓ generated ${agentsWritten.length} agents in ${agentsDir}`);


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
    problems, models: nativeKeys, roles, scope, hookChanged, agentsWritten,
    configPath: configPathResolved, pruned,
  };
}

export function isCancellation(err: unknown): boolean {
  return err instanceof CancelledError;
}
