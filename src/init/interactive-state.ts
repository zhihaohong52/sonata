/**
 * The wizard branch of `sonata init`.
 *
 * Lifted verbatim from `runInit` — the `WizardData` construction, the
 * `runInitTui` call, `addByokCandidates`/`addLiveCandidates` registration, the
 * BYOK base-URL fixups, the validate call, and the final `stateForPlan`
 * shaping. Every comment is kept intact; they record real bugs.
 *
 * Returns the same `InitState` the scripted branch produces, plus a
 * `cancelled` flag so `runInit` can return the standard
 * cancelled-`InitResult` shape — that shape never lived inside the wizard
 * branch and stays in `runInit`/`cmdInit`.
 *
 * `nativeByKey` is built here, not passed in: this is the front end's own
 * candidate map for BYOK and live-candidate additions, and validate's call
 * below resolves candidates separately. `validate` runs twice — once here
 * to catch problems at the screen that produced them, and again in `runInit`
 * after the state is finalised. The duplicated check is the price of
 * surfacing the failure to the right place.
 */
import { readChatGptOAuth, readOpencodeChatGptOAuth } from '../native/codex-auth.js';
import {
  KNOWN_ROLES, configPath, isOauthGatewayAuth,
} from '../config.js';
import { WELL_KNOWN_PROVIDER_URLS } from '../detect.js';
import { resolveKeys } from '../native/credentials.js';
import { byokCandidateKey } from '../native/models.js';
import { credentialAvailabilityFor, nativeLabel, deriveInitState, configPathFor, type NativeCandidate } from '../commands/init.js';
import { runInitTui } from '../tui-ink/run.js';
import type { InitState } from '../tui-ink/types.js';
import type { WizardData } from '../tui-ink/app.js';
import type { ConfigScope } from '../tui-ink/types.js';
import type { InitEnvironment } from './discover.js';
import { validate } from './validate.js';
import type { InitLog } from '../commands/init-log.js';

export async function interactiveState(
  env: InitEnvironment,
  opts: {
    cwd: string;
    home: string;
    packageRoot: string;
    scope?: 'project' | 'global' | 'skip';
    routing?: 'project' | 'global' | 'skip';
  },
  log: InitLog,
): Promise<{ state: InitState; nativeByKey: Map<string, NativeCandidate>; cancelled: boolean }> {
  const byokUrls = new Map(env.byokProviders.map((provider) => [provider.name, provider.url]));
  const nativeByKey = new Map(env.allNativeCandidates.map((c) => [c.key, c]));
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
    avoidGateways: env.configsByScope[resolvedScope]?.avoidGateways ?? [],
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
    return { state: result.state, nativeByKey, cancelled: true };
  }

  // Map result.state to the variables the write path needs.
  const configScope = result.state.configScope ?? 'project';
  // Custom providers added through the wizard: register their URL before
  // adding BYOK candidates so validate() can exclude them from the
  // unknown-providers check.
  for (const provider of result.state.customProviders ?? []) {
    byokUrls.set(provider.name, provider.url);
  }
  addByokCandidates(nativeByKey, byokUrls, result.state.byokModels ?? {}, result.state.customWireFormats);
  addLiveCandidates(env, nativeByKey, result.state.liveModels ?? {});
  const byokKeys = result.state.byokKeys ?? {};
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
  const credentialSources = result.state.credentialSources ?? {};
  const nativeKeys = result.state.nativeKeys ?? [];
  const roles = result.state.roles ?? [...KNOWN_ROLES];

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

  // Build stateForPlan for interactive branch
  const stateForPlan: InitState = {
    configScope,
    providerKeys: result.state.providerKeys ?? [],
    nativeKeys,
    roles,
    credentialSources,
    routing: result.state.routing ?? 'project',
    hookScope: result.state.hookScope ?? 'project',
    customProviders: result.state.customProviders,
    byokModels: result.state.byokModels,
    liveModels: result.state.liveModels,
    customWireFormats: result.state.customWireFormats,
    byokKeys: result.state.byokKeys,
    tiers: result.state.tiers,
  };
  return { state: stateForPlan, nativeByKey, cancelled: false };
}

/**
 * Candidates for models a user named directly.
 *
 * These must join `nativeByKey` before `nativeKeys` is resolved through it,
 * or every BYOK key looks up `undefined` and is filtered out silently — a
 * wizard that appears to work and writes an empty config.
 */
function addByokCandidates(
  nativeByKey: Map<string, NativeCandidate>,
  byokUrls: Map<string, string>,
  byokModels: Record<string, string[]>,
  wireFormats: Record<string, 'anthropic'> = {},
): void {
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
}

/**
 * Candidates for models only a gateway's own `/models` endpoint reported.
 *
 * The models step refreshes each gateway's list from the gateway itself, so
 * it can surface a model the harness catalogue never listed. Such a model has no
 * `NativeCandidate`, and `nativeKeys` is resolved through `nativeByKey` — so
 * without this it is selected, kept in the tiers, and then silently dropped
 * from `[models]`, producing a config that names a model it never defines.
 * An existing candidate always wins: the harness one carries a `harness`
 * route this cannot know about.
 */
function addLiveCandidates(
  env: InitEnvironment,
  nativeByKey: Map<string, NativeCandidate>,
  liveModels: Record<string, string[]>,
): void {
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
}
