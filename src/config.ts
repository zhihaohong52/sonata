import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';

export const KNOWN_HARNESSES = ['opencode', 'codex', 'pi', 'reasonix', 'claude'] as const;
export const KNOWN_ROLES = ['review', 'code', 'explore', 'plan'] as const;

/** Harnesses whose `--model` needs a provider segment; codex takes a bare id. */
const QUALIFIED_ID_HARNESSES: readonly string[] = ['opencode', 'pi', 'reasonix'];

/** Roles that must never write, whatever permission mode the session is in. */
export const READ_ONLY_ROLES = ['review', 'explore', 'plan'] as const;

export function isReadOnlyRole(role: string): boolean {
  return (READ_ONLY_ROLES as readonly string[]).includes(role);
}

export interface ModelConfig { harness: string; id: string }

export const TIER_NAMES = ['simple', 'complex'] as const;

/**
 * One model, however it is reached. `gateway` is the native route (default
 * execution path, through the router); `harness` is the fallback route the
 * dispatch CLI uses when every native route is down. At least one must be
 * present — parseConfig enforces it.
 */
export interface UnifiedModelConfig {
  gateway?: string;
  id?: string;
  contextWindow?: number;
  harness?: string;
  harnessId?: string;
}

export interface TierLists { simple: string[]; complex: string[] }

export interface TierRoute {
  key: string;
  native?: { gateway: string; id: string };
  harness?: { harness: string; id: string };
}

export interface NativeModelConfig { gateway: string; id: string; contextWindow: number }

/**
 * How a gateway authenticates.
 *
 * `api-key` is a bearer key from the credential store, sent to `base_url`.
 *
 * `codex-oauth` is a ChatGPT subscription credential written by `codex login`.
 * It is NOT an API key: the metered api.openai.com refuses it with
 * `insufficient_quota` *after* accepting the bearer and its scopes, because a
 * subscription is not API credit. It works only against the Codex backend, over
 * the Responses wire API, with streaming mandatory. LiteLLM's `chatgpt`
 * provider speaks all of that and refreshes the token itself, so sonata
 * supplies neither a base URL nor a key. See docs/codex-subscription.md.
 */
export type NativeGatewayAuth = 'api-key' | 'codex-oauth' | 'copilot-oauth';

export const NATIVE_GATEWAY_AUTHS: readonly NativeGatewayAuth[] = ['api-key', 'codex-oauth', 'copilot-oauth'];

export type NativeGatewayWireFormat = 'openai' | 'anthropic';

export const NATIVE_GATEWAY_WIRE_FORMATS: readonly NativeGatewayWireFormat[] = ['openai', 'anthropic'];

/**
 * Where a gateway's credential comes from. Absent means "resolve as today":
 * `resolveKeys`'s fixed precedence for keys, `readChatGptOAuth`'s for OAuth.
 * Recording it makes the choice survive a re-run of `sonata init`, which
 * otherwise re-sniffs and can silently answer differently.
 */
export type CredentialSource = 'sonata' | 'codex' | 'opencode';

export const CREDENTIAL_SOURCES: readonly CredentialSource[] = ['sonata', 'codex', 'opencode'];

/** Gateway auths whose credential is an OAuth login, not a stored bearer key. */
export const OAUTH_GATEWAY_AUTHS: readonly NativeGatewayAuth[] = ['codex-oauth', 'copilot-oauth'];

export function isOauthGatewayAuth(auth: NativeGatewayAuth): boolean {
  return OAUTH_GATEWAY_AUTHS.includes(auth);
}

/**
 * The prefix the router reserves for Anthropic.
 *
 * A native model whose key or id starts with it can never be reached, because
 * the router forwards that prefix upstream rather than to LiteLLM. Several
 * gateways legitimately serve Claude models — Copilot, acme, anthropic — so
 * this is a real limitation, not a theoretical one: `init` must not offer such
 * a model, or it writes a config that `parseConfig` then refuses to load.
 */
export const ANTHROPIC_ROUTED_PREFIX = 'claude-';

export function isAnthropicRoutedName(name: string): boolean {
  return name.startsWith(ANTHROPIC_ROUTED_PREFIX);
}

/** Where LiteLLM's `chatgpt` provider sends Codex traffic. */
export const CODEX_OAUTH_BASE_URL = 'https://chatgpt.com/backend-api/codex';

/** Where LiteLLM's `github_copilot` provider sends Copilot traffic. */
export const COPILOT_OAUTH_BASE_URL = 'https://api.githubcopilot.com';

/** The endpoint an OAuth gateway's provider addresses on its own. */
export function oauthGatewayBaseUrl(auth: NativeGatewayAuth): string {
  return auth === 'copilot-oauth' ? COPILOT_OAUTH_BASE_URL : CODEX_OAUTH_BASE_URL;
}

export interface NativeGatewayConfig {
  baseUrl: string;
  auth: NativeGatewayAuth;
  credentialSource?: CredentialSource;
  wireFormat?: NativeGatewayWireFormat;
}
export interface NativeConfig {
  models: Record<string, NativeModelConfig>;
  gateways: Record<string, NativeGatewayConfig>;
  ports: { router: number; litellm: number };
  generate: Record<string, string[]>;
}

export interface SonataConfig {
  models: Record<string, ModelConfig>;
  /**
   * Tier routing's unified registry. Legacy harness entries are mirrored here
   * so a migration can rank them without changing how old config is parsed.
   */
  unifiedModels: Record<string, UnifiedModelConfig>;
  tiers?: Record<string, TierLists>;
  generate: { roles: Record<string, string[]> };
  native?: NativeConfig;
  run: {
    tailWindowSeconds: number;
    stallTimeoutSeconds: number;
    runTimeoutSeconds: number;
    /**
     * How long `dispatch`/`wait` block before returning RUNNING.
     *
     * Claude Code aborts an MCP call that sends nothing for its idle window —
     * 30 minutes for stdio servers. Silence is already covered by
     * stallTimeoutSeconds; this bounds the opposite case, a productive run
     * that works for longer than the window and would otherwise be killed
     * mid-flight. Must stay below 1800.
     */
    dispatchWindowSeconds: number;
  };
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' ? v : fallback;
}

export function parseConfig(text: string): SonataConfig {
  const raw = parseToml(text) as Record<string, any>;

  const models: Record<string, ModelConfig> = {};
  const unifiedModels: Record<string, UnifiedModelConfig> = {};
  for (const [name, def] of Object.entries(raw.models ?? {})) {
    const d = def as Record<string, unknown>;
    // A gateway changes this into a unified model entry, whose `id` names the
    // native model rather than a harness provider/model ref. Branch before the
    // legacy check so a native id is never rejected as an OpenCode-style ref.
    if (typeof d.gateway === 'string') {
      if (typeof d.id !== 'string') {
        throw new Error(`sonata.toml: model "${name}" with gateway "${d.gateway}" needs string "id"`);
      }
      if (isAnthropicRoutedName(name) || isAnthropicRoutedName(d.id)) {
        throw new Error(
          `sonata.toml: model "${name}" cannot use the "${ANTHROPIC_ROUTED_PREFIX}" prefix because the router routes it to Anthropic.`,
        );
      }
      if (d.harness !== undefined && (typeof d.harness !== 'string' || !KNOWN_HARNESSES.includes(d.harness as any))) {
        throw new Error(
          `sonata.toml: model "${name}" has unknown harness "${String(d.harness)}". ` +
          `Known harnesses: ${KNOWN_HARNESSES.join(', ')}`,
        );
      }
      if (d.harness_id !== undefined && typeof d.harness_id !== 'string') {
        throw new Error(`sonata.toml: model "${name}" has non-string "harness_id"`);
      }
      if (d.context_window !== undefined && typeof d.context_window !== 'number') {
        throw new Error(`sonata.toml: model "${name}" has non-number "context_window"`);
      }
      const harnessId = typeof d.harness === 'string'
        ? (typeof d.harness_id === 'string' ? d.harness_id : `${d.gateway}/${d.id}`)
        : undefined;
      unifiedModels[name] = {
        gateway: d.gateway,
        id: d.id,
        contextWindow: d.context_window ?? 128000,
        ...(typeof d.harness === 'string' ? {
          harness: d.harness,
          harnessId,
        } : {}),
      };
      // A unified entry may also be used by the legacy generator. Keep the
      // harness projection populated when both routes are declared; otherwise
      // [generate.roles] would incorrectly report this valid entry as unknown.
      if (typeof d.harness === 'string') {
        models[name] = { harness: d.harness, id: harnessId! };
      }
      continue;
    }
    if (typeof d.harness !== 'string' || typeof d.id !== 'string') {
      throw new Error(`sonata.toml: model "${name}" needs string "harness" and "id"`);
    }
    if (!KNOWN_HARNESSES.includes(d.harness as any)) {
      throw new Error(
        `sonata.toml: model "${name}" has unknown harness "${d.harness}". ` +
        `Known harnesses: ${KNOWN_HARNESSES.join(', ')}`,
      );
    }
    // Opencode, pi and reasonix address models as provider/model; codex takes a
    // bare id, so this cannot be a global rule. Reasonix's provider segment is
    // the name of a `[providers]` entry in that machine's reasonix.toml, so the
    // same id can mean different things on two machines.
    if (QUALIFIED_ID_HARNESSES.includes(d.harness) && !d.id.includes('/')) {
      throw new Error(
        `sonata.toml: model "${name}" needs a provider — ${d.harness} takes ` +
        `ids in provider/model form, not "${d.id}". Re-run \`sonata init\` to ` +
        'choose a provider.',
      );
    }
    models[name] = { harness: d.harness, id: d.id };
    unifiedModels[name] = { harness: d.harness, harnessId: d.id };
  }

  let tiers: Record<string, TierLists> | undefined;
  if (raw.tiers !== undefined) {
    tiers = {};
    for (const [role, def] of Object.entries(raw.tiers as Record<string, unknown>)) {
      if (!KNOWN_ROLES.includes(role as any)) {
        throw new Error(
          `sonata.toml: tiers contains unknown role "${role}". ` +
          `Known roles: ${KNOWN_ROLES.join(', ')}`,
        );
      }
      const d = def as Record<string, unknown>;
      const simple = d.simple;
      const complex = d.complex;
      if (!Array.isArray(simple) || !simple.every((key) => typeof key === 'string') ||
          !Array.isArray(complex) || !complex.every((key) => typeof key === 'string')) {
        throw new Error(`sonata.toml: tiers.${role} needs string lists "simple" and "complex".`);
      }
      for (const [tier, keys] of [['simple', simple], ['complex', complex]] as const) {
        for (const key of keys) {
          if (isAnthropicRoutedName(key)) {
            throw new Error(
              `sonata.toml: tiers.${role}.${tier} model "${key}" cannot use the ` +
              `"${ANTHROPIC_ROUTED_PREFIX}" prefix because the router routes it to Anthropic.`,
            );
          }
          if (!unifiedModels[key]) {
            throw new Error(
              `sonata.toml: tiers.${role}.${tier} references unknown model "${key}". ` +
              `Define [models."${key}"] first.`,
            );
          }
        }
      }
      tiers[role] = { simple, complex };
    }
    // Tier lists own all routing choices. Keeping either legacy generator next
    // to them would generate two incompatible sets of agents from one config.
    if (raw.generate !== undefined || (raw.native as Record<string, unknown> | undefined)?.generate !== undefined) {
      throw new Error('sonata.toml: [tiers] replaces [generate.roles] and [generate.native] — run `sonata init` to migrate');
    }
  }

  const gen = (raw.generate ?? {}) as Record<string, unknown>;

  // TOML cannot express both `roles = [...]` and `[generate.roles]`, so the
  // old form is distinguishable exactly. Fail loudly rather than approximate:
  // a config read as something nobody intended is worse than one that errors.
  if (Array.isArray(gen.roles) || gen.models !== undefined) {
    throw new Error(
      'sonata.toml: [generate] now maps each role to its own models. Replace\n' +
      '    roles  = [...]\n    models = [...]\n' +
      'with, for example:\n' +
      '    [generate.roles]\n    code   = ["<model-key>"]\n    review = ["<model-key>"]\n' +
      'or re-run `sonata init`.',
    );
  }

  const roles: Record<string, string[]> = {};
  for (const [role, list] of Object.entries((gen.roles ?? {}) as Record<string, unknown>)) {
    if (!KNOWN_ROLES.includes(role as any)) {
      throw new Error(
        `sonata.toml: generate.roles contains unknown role "${role}". ` +
        `Known roles: ${KNOWN_ROLES.join(', ')}`,
      );
    }
    if (!Array.isArray(list)) {
      throw new Error(`sonata.toml: generate.roles.${role} must be a list of model keys.`);
    }
    for (const m of list) {
      if (!models[m as string]) {
        throw new Error(
          `sonata.toml: generate.roles.${role} references unknown model "${m}". ` +
          `Define [models."${m}"] first.`,
        );
      }
    }
    roles[role] = list as string[];
  }

  let native: NativeConfig | undefined;
  if (raw.native !== undefined) {
    const rawNative = raw.native as Record<string, unknown>;
    const gateways: Record<string, NativeGatewayConfig> = {};
    for (const [name, def] of Object.entries((rawNative.gateways ?? {}) as Record<string, unknown>)) {
      const d = def as Record<string, unknown>;
      const rawAuth = d.auth ?? 'api-key';
      if (typeof rawAuth !== 'string' || !NATIVE_GATEWAY_AUTHS.includes(rawAuth as NativeGatewayAuth)) {
        throw new Error(
          `sonata.toml: native gateway "${name}" has unknown auth "${String(rawAuth)}". ` +
          `Known: ${NATIVE_GATEWAY_AUTHS.join(', ')}`,
        );
      }
      const auth = rawAuth as NativeGatewayAuth;
      let credentialSource: CredentialSource | undefined;
      if (d.credential_source !== undefined) {
        const raw = d.credential_source;
        if (typeof raw !== 'string' || !CREDENTIAL_SOURCES.includes(raw as CredentialSource)) {
          throw new Error(
            `sonata.toml: native gateway "${name}" has unknown credential_source "${String(raw)}". ` +
            `Known: ${CREDENTIAL_SOURCES.join(', ')}`,
          );
        }
        credentialSource = raw as CredentialSource;
        // codex holds a ChatGPT subscription, never a bearer key. Sending it to
        // a metered endpoint passes auth and then fails for quota, which reads
        // as a missing key — see docs/codex-subscription.md. Die here instead.
        if (credentialSource === 'codex' && auth === 'api-key') {
          throw new Error(
            `sonata.toml: native gateway "${name}" is auth = "api-key", so it ` +
            'cannot take its credential from codex — that is a subscription, not a key.',
          );
        }
        // codex's read-through credential is a ChatGPT subscription; GitHub
        // Copilot has no such relationship to it. Accepting this combination
        // would silently fall back to opencode's Copilot login regardless of
        // what the config claims to import from.
        if (credentialSource === 'codex' && auth === 'copilot-oauth') {
          throw new Error(
            `sonata.toml: native gateway "${name}" is copilot-oauth, so it ` +
            'cannot take its credential from codex — Copilot logins come only from opencode.',
          );
        }
      }
      let wireFormat: NativeGatewayWireFormat | undefined;
      if (d.wire_format !== undefined) {
        const rawFormat = d.wire_format;
        if (typeof rawFormat !== 'string' || !NATIVE_GATEWAY_WIRE_FORMATS.includes(rawFormat as NativeGatewayWireFormat)) {
          throw new Error(
            `sonata.toml: native gateway "${name}" has unknown wire_format "${String(rawFormat)}". ` +
            `Known: ${NATIVE_GATEWAY_WIRE_FORMATS.join(', ')}`,
          );
        }
        // OAuth gateway wire formats are fixed by their auth provider.
        if (isOauthGatewayAuth(auth)) {
          throw new Error(
            `sonata.toml: native gateway "${name}" is ${auth}, so it cannot set wire_format — ` +
            'that credential\'s wire format is fixed by its auth kind. Remove wire_format.',
          );
        }
        wireFormat = rawFormat as NativeGatewayWireFormat;
      }
      // An OAuth gateway is addressed by LiteLLM's own provider, which knows the
      // URL; accepting one here would only let a config claim a base URL that is
      // never used — or worse, name the metered endpoint the credential cannot
      // reach, which authenticates and then fails for quota.
      if (isOauthGatewayAuth(auth)) {
        const implied = oauthGatewayBaseUrl(auth);
        if (d.base_url !== undefined && d.base_url !== implied) {
          throw new Error(
            `sonata.toml: native gateway "${name}" is ${auth}, so it cannot set base_url ` +
            `to "${String(d.base_url)}" — that credential only reaches ${implied}. ` +
            'Remove base_url.',
          );
        }
        gateways[name] = { baseUrl: implied, auth, credentialSource };
        continue;
      }
      if (typeof d.base_url !== 'string') {
        throw new Error(`sonata.toml: native gateway "${name}" needs string "base_url"`);
      }
      gateways[name] = { baseUrl: d.base_url, auth, credentialSource, wireFormat };
    }

    const nativeModels: Record<string, NativeModelConfig> = {};
    for (const [name, def] of Object.entries((rawNative.models ?? {}) as Record<string, unknown>)) {
      const d = def as Record<string, unknown>;
      if (typeof d.gateway !== 'string' || typeof d.id !== 'string' || typeof d.context_window !== 'number') {
        throw new Error(
          `sonata.toml: native model "${name}" needs string "gateway", string "id" and number "context_window"`,
        );
      }
      if (isAnthropicRoutedName(name) || isAnthropicRoutedName(d.id)) {
        throw new Error(
          `sonata.toml: native model "${name}" cannot use the "${ANTHROPIC_ROUTED_PREFIX}" prefix because the router routes it to Anthropic.`,
        );
      }
      if (!gateways[d.gateway]) {
        throw new Error(
          `sonata.toml: native model "${name}" references unknown gateway "${d.gateway}". ` +
          `Define [native.gateways."${d.gateway}"] first.`,
        );
      }
      nativeModels[name] = { gateway: d.gateway, id: d.id, contextWindow: d.context_window };
    }

    const nativeGenerate: Record<string, string[]> = {};
    for (const [role, list] of Object.entries((gen.native ?? {}) as Record<string, unknown>)) {
      if (!KNOWN_ROLES.includes(role as any)) {
        throw new Error(
          `sonata.toml: generate.native contains unknown role "${role}". ` +
          `Known roles: ${KNOWN_ROLES.join(', ')}`,
        );
      }
      if (!Array.isArray(list) || !list.every((model) => typeof model === 'string')) {
        throw new Error(`sonata.toml: generate.native.${role} must be a list of native model keys.`);
      }
      for (const model of list) {
        if (!nativeModels[model]) {
          throw new Error(
            `sonata.toml: generate.native.${role} references unknown native model "${model}". ` +
            `Define [native.models."${model}"] first.`,
          );
        }
      }
      nativeGenerate[role] = list;
    }

    const rawPorts = (rawNative.ports ?? {}) as Record<string, unknown>;
    native = {
      models: nativeModels,
      gateways,
      ports: {
        router: num(rawPorts.router, 4100),
        litellm: num(rawPorts.litellm, 4000),
      },
      generate: nativeGenerate,
    };
  }

  // Unlike [native.models], the unified [models] loop above runs before
  // [native.gateways] is parsed, so it cannot validate a gateway reference
  // there — do it now that `native` is built. Left unchecked, an unknown
  // gateway here reaches litellmModelEntry via the native projection below
  // and crashes on `gateways[gateway].auth` being undefined.
  for (const [name, model] of Object.entries(unifiedModels)) {
    if (model.gateway !== undefined && !native?.gateways[model.gateway]) {
      throw new Error(
        `sonata.toml: model "${name}" references unknown gateway "${model.gateway}". ` +
        `Define [native.gateways."${model.gateway}"] first.`,
      );
    }
  }

  // Tier configs are the unified format. Keep a native projection so the
  // router and older consumers can use the same gateway/model data while the
  // unified tier-aware consumers migrate.
  if (tiers !== undefined) {
    const projectedModels: Record<string, NativeModelConfig> = { ...(native?.models ?? {}) };
    for (const [key, model] of Object.entries(unifiedModels)) {
      if (model.gateway !== undefined && model.id !== undefined) {
        projectedModels[key] = {
          gateway: model.gateway,
          id: model.id,
          contextWindow: model.contextWindow ?? 128000,
        };
      }
    }
    const projectedGenerate: Record<string, string[]> = {};
    for (const [role, lists] of Object.entries(tiers)) {
      projectedGenerate[role] = [...new Set([...lists.simple, ...lists.complex])];
    }
    native = {
      models: projectedModels,
      gateways: native?.gateways ?? {},
      ports: native?.ports ?? { router: 4100, litellm: 4000 },
      generate: projectedGenerate,
    };
  }

  return {
    models,
    unifiedModels,
    tiers,
    generate: { roles },
    native,
    run: {
      tailWindowSeconds: num(raw.run?.tail_window_seconds, 20),
      stallTimeoutSeconds: num(raw.run?.stall_timeout_seconds, 120),
      runTimeoutSeconds: num(raw.run?.run_timeout_seconds, 1800),
      dispatchWindowSeconds: num(raw.run?.dispatch_window_seconds, 1500),
    },
  };
}

/**
 * Resolves a `sonata-<role>[-<tier>]` model alias to its ranked routes.
 * The collapsed form (`sonata-explore`) exists for roles whose two tier lists
 * are identical — sync generates a single agent for those, and its alias
 * omits the tier so the picker never shows a fake choice.
 */
export function resolveTierAlias(
  config: SonataConfig,
  alias: string,
): { role: string; tier: string; routes: TierRoute[] } | undefined {
  if (!alias.startsWith('sonata-') || config.tiers === undefined) return undefined;
  const rest = alias.slice('sonata-'.length);
  let role = rest;
  let tier: string = 'complex';
  for (const candidate of TIER_NAMES) {
    if (rest.endsWith(`-${candidate}`)) {
      role = rest.slice(0, -(candidate.length + 1));
      tier = candidate;
      break;
    }
  }
  const lists = config.tiers[role];
  if (lists === undefined) return undefined;
  // An unsuffixed alias is valid only when it cannot hide a tier choice. Use
  // ordered equality: both ranking and membership are part of the contract.
  const hasExplicitTier = rest !== role;
  if (!hasExplicitTier && (
    lists.simple.length !== lists.complex.length ||
    !lists.simple.every((key, index) => key === lists.complex[index])
  )) {
    return undefined;
  }
  const keys = tier === 'simple' ? lists.simple : lists.complex;
  const routes = keys.map((key): TierRoute => {
    const model = config.unifiedModels[key];
    return {
      key,
      native: model?.gateway !== undefined && model.id !== undefined
        ? { gateway: model.gateway, id: model.id }
        : undefined,
      harness: model?.harness !== undefined && model.harnessId !== undefined
        ? { harness: model.harness, id: model.harnessId }
        : undefined,
    };
  });
  return { role, tier, routes };
}

/** The harness route for one model key, for the dispatch CLI. */
export function harnessModelFor(
  config: SonataConfig,
  key: string,
): { harness: string; id: string } | undefined {
  const model = config.unifiedModels[key];
  return model?.harness !== undefined && model.harnessId !== undefined
    ? { harness: model.harness, id: model.harnessId }
    : undefined;
}

/** Where a machine-level config lives, relative to the home directory. */
export const GLOBAL_CONFIG_RELATIVE = join('.config', 'sonata', 'sonata.toml');

/**
 * The config file that will be used, or null if there is none.
 *
 * A project config wins outright — it is not merged with the machine one.
 * Exactly one file is ever in effect, so it is always possible to say which
 * file produced a run.
 */
export function configPath(cwd: string, home: string): string | null {
  const local = join(cwd, 'sonata.toml');
  if (existsSync(local)) return local;
  const global = join(home, GLOBAL_CONFIG_RELATIVE);
  if (existsSync(global)) return global;
  return null;
}

/**
 * `home` is optional so that callers which have not yet been threaded through
 * keep working; it is always injected in tests, which must never read the
 * real home directory.
 */
export function loadConfig(cwd: string, home: string = homedir()): SonataConfig {
  const path = configPath(cwd, home);
  if (path === null) {
    throw new Error(
      `No sonata.toml found. Looked in ${join(cwd, 'sonata.toml')} and ` +
      `${join(home, GLOBAL_CONFIG_RELATIVE)}. Run \`sonata init\` or create one.`,
    );
  }
  return parseConfig(readFileSync(path, 'utf8'));
}

/**
 * Every agent the config asks for.
 *
 * The single definition of what should exist. The roles × models product used
 * to be written out in `cmdSync`, again in `init`'s summary, and again as the
 * expected set for `staleAgents` — three copies that could disagree, and stale
 * agents caused three separate failures.
 */
export function generatedAgents(config: SonataConfig): { role: string; model: string }[] {
  const out: { role: string; model: string }[] = [];
  for (const [role, models] of Object.entries(config.generate.roles)) {
    for (const model of models) out.push({ role, model });
  }
  return out;
}

/** Every native agent the config asks for. */
export function generatedNativeAgents(config: SonataConfig): { role: string; model: string }[] {
  const out: { role: string; model: string }[] = [];
  for (const [role, models] of Object.entries(config.native?.generate ?? {})) {
    for (const model of models) out.push({ role, model });
  }
  return out;
}

/**
 * Every agent filename stem `sonata sync` writes, and therefore the exact set
 * that is not stale.
 *
 * A native model gets two files: `native-<role>-<model>` for a `sonata code`
 * session, and a `<role>-<model>` wrapper for dispatch through the claude
 * harness — unless a harness model already claims that name. `sync` and
 * `doctor` computed this separately and disagreed, so `sync` wrote a file that
 * `doctor` then reported as stale, on every run.
 */
export function expectedAgentNames(config: SonataConfig): string[] {
  if (config.tiers !== undefined) {
    const names: string[] = [];
    for (const [role, lists] of Object.entries(config.tiers)) {
      const collapsed = lists.simple.length === lists.complex.length &&
        lists.simple.every((model, index) => model === lists.complex[index]);
      if (collapsed) names.push(role);
      else names.push(...TIER_NAMES.map((tier) => `${role}-${tier}`));
    }
    return names;
  }
  const harness = generatedAgents(config);
  const native = generatedNativeAgents(config);
  const harnessNames = harness.map((a) => `${a.role}-${a.model}`);
  return [
    ...harnessNames,
    ...native.map((a) => `native-${a.role}-${a.model}`),
    ...native
      .map((a) => `${a.role}-${a.model}`)
      .filter((name) => !harnessNames.includes(name)),
  ];
}
