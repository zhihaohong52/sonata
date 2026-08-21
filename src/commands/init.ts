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
  type SonataConfig, type NativeGatewayAuth,
} from '../config.js';
import { readChatGptOAuth, readOpencodeChatGptOAuth } from '../native/codex-auth.js';
import { readCopilotToken, copilotTokenCanExchange } from '../native/copilot-auth.js';
import type { ModelRef } from '../types.js';
import {
  detectTmux, detectHarnesses, offerableProviders,
  type Problem, type HarnessStatus, type DetectEnv, type ProviderSummary,
} from '../detect.js';
import {
  settingsPath, readSettings, writeSettings, installHook, allowSonataTools,
  hookInstalled, hookCommand, registerMcp, type HookScope, type Runner,
} from '../settings.js';
import { pruneAgents } from '../detect.js';
import { cmdSync } from './sync.js';
import { select, confirm, isInteractive, banner, CancelledError } from '../tui.js';
import { keyReport, resolveKeys, writeSonataKey } from '../native/credentials.js';
import { byokCandidateKey, wellKnownProviders } from '../native/models.js';
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
  /** Injected in tests so registration never shells out to the real binary. */
  mcpRunner?: Runner;
  prune?: boolean;
  write?: (line: string) => void;
  detect?: Detector;
  /** Injected by tests so a suite never writes into the real log directory. */
  log?: InitLog;
}

export interface InitResult {
  problems: Problem[];
  models: string[];
  roles: string[];
  scope: HookScope | 'skip';
  hookChanged: boolean;
  agentsWritten: string[];
  configPath: string;
  mcpChanged: boolean;
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
      // Copilot, vendorx and anthropic all serve Claude models, but the router
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
      return {
        key: r.ref.replace(/\//g, '-'),
        gateway: r.provider,
        id: r.id ?? r.ref,
        contextWindow: 128000,
        baseUrl: isOauthGatewayAuth(auth)
          ? oauthGatewayBaseUrl(auth)
          : providerBaseUrls[r.provider],
        auth,
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
  if (!config.native) return { configScope };

  const gateways = [...new Set(Object.values(config.native.models).map((model) => model.gateway))];
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
    nativeKeys: Object.keys(config.native.models),
    roles: Object.keys(config.native.generate),
    perRoleModels: Object.fromEntries(
      Object.entries(config.native.generate).map(([role, models]) => [role, [...models]]),
    ),
  };
}

/** NativeCandidates for every model in the config, from the config's own data. */
export function configNativeCandidates(config: SonataConfig): NativeCandidate[] {
  if (!config.native) return [];
  return Object.entries(config.native.models).map(([key, model]) => ({
    key,
    gateway: model.gateway,
    id: model.id,
    contextWindow: model.contextWindow,
    baseUrl: config.native!.gateways[model.gateway].baseUrl,
    auth: config.native!.gateways[model.gateway].auth,
  }));
}

/**
 * Pre-tick from existing `[native.models]` in the config.
 */
export function preTickedNative(configText: string, candidates: NativeCandidate[]): Set<string> {
  try {
    const config = parseConfig(configText);
    if (!config.native) return new Set();
    const existing = config.native.models;
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
 * Emit a native-only config: `[native.gateways]`, `[native.models]`,
 * `[generate.native]`, and `[run]`. No `[models]` or `[generate.roles]`.
 */
export function nativeTomlFor(
  roleModels: Record<string, NativeCandidate[]>,
): string {
  const allModels = new Map<string, NativeCandidate>();
  for (const cands of Object.values(roleModels)) {
    for (const c of cands) allModels.set(c.key, c);
  }

  const clashes = duplicateKeys([...allModels.keys()]);
  if (clashes.length > 0) {
    throw new Error(
      `sonata: ${clashes.join(', ')} would name two different models.`,
    );
  }

  const gateways = new Map<string, { baseUrl: string; auth: NativeGatewayAuth }>();
  for (const c of allModels.values()) gateways.set(c.gateway, { baseUrl: c.baseUrl, auth: c.auth });

  const lines: string[] = [];

  for (const [gateway, { baseUrl, auth }] of gateways) {
    lines.push(`[native.gateways.${tomlKey(gateway)}]`);
    // An OAuth gateway takes no base_url: the credential reaches only its own
    // provider's backend, and LiteLLM already knows that URL.
    if (isOauthGatewayAuth(auth)) lines.push(`auth = ${tomlKey(auth)}`);
    else lines.push(`base_url = ${tomlKey(baseUrl)}`);
    lines.push('');
  }

  for (const [key, c] of allModels) {
    lines.push(
      `[native.models.${tomlKey(key)}]`,
      `gateway = ${tomlKey(c.gateway)}`,
      `id = ${tomlKey(c.id)}`,
      `context_window = ${c.contextWindow}`,
      '',
    );
  }

  lines.push('[generate.native]');
  for (const [role, cands] of Object.entries(roleModels)) {
    lines.push(`${tomlKey(role)} = [${cands.map((c) => tomlKey(c.key)).join(', ')}]`);
  }
  lines.push('');

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
  // Copilot needs one extra question answered before it can be offered: whether
  // the stored GitHub token carries the `copilot` scope. opencode requests only
  // `read:user`, so the exchange 403s and LiteLLM drops the model — offering it
  // would write a config that fails at first use with an unrelated-looking
  // error. Fails closed, so an offline machine simply does not offer Copilot.
  const copilotToken = readCopilotToken(opts.home);
  const copilotUsable = copilotToken !== null
    && await copilotTokenCanExchange(copilotToken);
  if (copilotToken !== null && !copilotUsable) {
    out('  ! github-copilot: the stored token cannot mint a Copilot key ' +
        '(needs the `copilot` scope) — not offering its models');
  }

  const oauthProviders = oauthProvidersFor(allRefs, opts.home, {
    copilot: () => (copilotUsable ? copilotToken : null),
  });
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
      mcpChanged: false, pruned: [],
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
  const addByokCandidates = (byokModels: Record<string, string[]>): void => {
    for (const [gateway, ids] of Object.entries(byokModels)) {
      const baseUrl = byokUrls.get(gateway);
      if (baseUrl === undefined) continue;
      for (const id of ids) {
        const key = byokCandidateKey(gateway, id);
        nativeByKey.set(key, { key, gateway, id, contextWindow: 128000, baseUrl, auth: 'api-key' });
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
        oauthProviders,
        {
          codex: codexCredential === null ? null : { expiresInDays: daysUntil(codexCredential.expires_at) },
          opencode: opencodeCredential === null ? null : { expiresInDays: daysUntil(opencodeCredential.expires_at) },
          copilot: copilotToken === null ? null : { expiresInDays: null },
        },
        (gateway) => resolveKeys([gateway], opts.home)[0] !== undefined,
      ),
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
        mcpChanged: false, pruned: [], cancelled: true,
      };
    }

    // Map result.state to the variables the write path needs:
    configScope = result.state.configScope ?? 'project';
    configPathResolved = configPathFor(configScope, opts.cwd, opts.home);
    addByokCandidates(result.state.byokModels ?? {});
    byokKeys = result.state.byokKeys ?? {};
    nativeKeys = result.state.nativeKeys ?? [];
    roles = result.state.roles ?? [...KNOWN_ROLES];
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
  }

  // ---- key check --------------------------------------------------------
  out('');
  const gateways = [...new Set(chosenNative.map((c) => c.gateway))];
  for (const report of keyReport(gateways, opts.home)) {
    out(report.source
      ? `  ✓ ${report.gateway}: key from ${report.source}`
      : `  ! ${report.gateway}: no key — run \`sonata auth add ${report.gateway}\``);
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
      mcpChanged: false, pruned: [],
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
  writeFileSync(configPathResolved, nativeTomlFor(nativeRoleModels));
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

  const mcpScope = configScope === 'global' ? 'user' : 'project';
  const mcp = registerMcp(mcpScope, opts.cwd, opts.packageRoot, opts.mcpRunner);
  if (mcp.changed) {
    out(`  ✓ registered the sonata MCP server (${mcpScope} scope)`);
  } else if (mcp.ok) {
    out('  · MCP server already registered');
  } else {
    out('  ! could not register the MCP server — run this by hand:');
    out(`      ${mcp.command}`);
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
  out('  Done. Restart Claude Code so it picks up the agents and the MCP server.');
  out('');

  return {
    problems, models: nativeKeys, roles, scope, hookChanged, agentsWritten,
    configPath: configPathResolved, mcpChanged: mcp.changed, pruned,
  };
}

export function isCancellation(err: unknown): boolean {
  return err instanceof CancelledError;
}
