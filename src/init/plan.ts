import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { InitEnvironment } from './discover.js';
import type { InitState } from '../tui-ink/types.js';
import type { NativeCandidate } from '../commands/init.js';
import type { CredentialSource } from '../config.js';
import type { NativeGatewayAuth } from '../config.js';
import { loadAaCatalog, proposeTiers } from '../catalog.js';
import { nativeTomlFor } from './toml.js';
import { reconcilePerRoleModels, reconcileTierList, gatewayNamesOf, avoidedKeysOf } from '../commands/init.js';
import { byokCandidateKey } from '../native/models.js';
import { WELL_KNOWN_PROVIDER_URLS } from '../detect.js';
import { configPathFor, agentsDirFor } from '../commands/init.js';
import { resolveKeyFromSource, keyReport } from '../native/credentials.js';
import { credentialDir, credentialFileFor } from '../native/oauth-login.js';
import { readChatGptOAuth } from '../native/codex-auth.js';
import { GLOBAL_CONFIG_RELATIVE } from '../config.js';
import { isOauthGatewayAuth } from '../config.js';

/** A resolvable bearer key for this gateway from this source. */
export interface CredentialProbe {
  /** A resolvable bearer key for this gateway from this source. */
  hasKey(gateway: string, source: CredentialSource): boolean;
  /** A device-login credential file written by sonata for this gateway. */
  hasOauthCredential(gateway: string, auth: NativeGatewayAuth): boolean;
  /** Automatic precedence result, as `keyReport` computes it. */
  autoSource(gateway: string): string | null;
  /** Whether opencode's GitHub token can mint a Copilot key. */
  copilotUsable: boolean;
}

export interface InitPlan {
  configScope: 'project' | 'global';
  configPath: string;
  configToml: string;
  keysToStore: Array<{ gateway: string; key: string }>;
  hook: { scope: 'project' | 'global' | 'skip'; settingsPath?: string; allowListScope?: 'project' | 'global' | 'skip' };
  skillPath: string;
  routing: 'project' | 'global' | 'skip';
  syncCwd: string;
  agentsDir: string;
  chosenNative: NativeCandidate[];
  roles: string[];
  nativeKeys: string[];
  notices: string[];
  summary: string[];
}

export function plan(
  env: InitEnvironment,
  state: InitState,
  credentials: CredentialProbe,
  opts: Pick<{ cwd: string; home: string; packageRoot: string }, 'cwd' | 'home' | 'packageRoot'>,
): InitPlan {
  const configScope = state.configScope ?? 'project';
  const configPathResolved = configPathFor(configScope, opts.cwd, opts.home);

  // Get the config for this scope to read existing avoidGateways and run settings
  const configForScope = env.configsByScope[configScope];
  const avoidGateways = configForScope?.avoidGateways ?? [];

  // ---- migratedModels (the block duplicated in both branches of init.ts) ----
  // parseConfig always builds unifiedModels from the raw [models] table
  // (migrated or not), so this is complete regardless of whether the
  // existing config was legacy and just migrated in place above, or was
  // already in the unified shape — no need to re-run the migration here.
  const migratedModels: Record<string, { harness?: string; harnessId?: string }> = {};
  if (configForScope?.unifiedModels !== undefined) {
    for (const [key, model] of Object.entries(configForScope.unifiedModels)) {
      if (model.harness !== undefined && model.gateway === undefined) {
        migratedModels[key] = { harness: model.harness, harnessId: model.harnessId };
      }
    }
  }

  const nativeKeys = state.nativeKeys ?? [];
  const roles = state.roles ?? [];

  // Build nativeByKey from all available candidates
  const nativeByKey = new Map<string, NativeCandidate>();
  for (const candidate of env.allNativeCandidates) {
    nativeByKey.set(candidate.key, candidate);
  }

  // Add custom providers to the URL map so their models can be minted
  const customProviders = state.customProviders ?? [];
  const providerBaseUrls = new Map(Object.entries(env.providerBaseUrls ?? {}));
  for (const provider of customProviders) {
    if (!providerBaseUrls.has(provider.name)) {
      providerBaseUrls.set(provider.name, provider.url);
    }
  }

  // Add live candidates from state.liveModels (models from gateway's own /models endpoint)
  const liveModels = state.liveModels ?? {};
  for (const [gateway, ids] of Object.entries(liveModels)) {
    const baseUrl = env.providerBaseUrls[gateway];
    if (baseUrl === undefined) continue;
    const auth = env.gatewayAuth.get(gateway) ?? 'api-key';
    if (isOauthGatewayAuth(auth)) continue;
    for (const id of ids) {
      const key = byokCandidateKey(gateway, id);
      if (nativeByKey.has(key)) continue;
      nativeByKey.set(key, { key, gateway, id, contextWindow: 128000, baseUrl, auth: 'api-key' });
    }
  }

  // Handle BYOK providers and custom providers that may have been converted to api-key auth.
  // A gateway that was originally OAuth (from env.gatewayAuth) but now has a BYOK key
  // gets switched to api-key auth with the well-known base URL.
  const byokKeys = state.byokKeys ?? {};
  for (const gateway of Object.keys(byokKeys)) {
    for (const [key, candidate] of nativeByKey) {
      if (candidate.gateway !== gateway || candidate.auth === 'api-key') continue;
      // When switching from OAuth to api-key, we MUST use the well-known provider URL,
      // not any URL from the original config (which would be the OAuth endpoint).
      const baseUrl = WELL_KNOWN_PROVIDER_URLS[gateway];
      if (baseUrl === undefined) continue;
      nativeByKey.set(key, { ...candidate, baseUrl, auth: 'api-key' });
    }
  }

  // Add BYOK candidates from state.byokModels
  const byokModels = state.byokModels ?? {};
  const customWireFormats = state.customWireFormats ?? {};
  for (const [gateway, ids] of Object.entries(byokModels)) {
    const baseUrl = providerBaseUrls.get(gateway) ?? WELL_KNOWN_PROVIDER_URLS[gateway];
    if (baseUrl === undefined) continue;
    const wireFormat = customWireFormats[gateway];
    for (const id of ids) {
      const key = byokCandidateKey(gateway, id);
      nativeByKey.set(key, {
        key, gateway, id, contextWindow: 128000, baseUrl, auth: 'api-key',
        ...(wireFormat !== undefined ? { wireFormat } : {}),
      });
    }
  }

  const chosenNative = nativeKeys.map((k) => nativeByKey.get(k)).filter((k): k is NativeCandidate => k !== undefined);

  // ---- tiers block (duplicated in both branches of init.ts) ----
  // The saved tier comes from the wizard's own state when the user re-ranked
  // the tiers in the current run, and from the existing config otherwise —
  // not the user's input combined with the catalog proposal, which is what
  // `proposeTiers` would give a fresh run.
  const savedNativeKeys = configForScope?.unifiedModels
    ? Object.keys(configForScope.unifiedModels).filter((key) => configForScope.unifiedModels[key].gateway !== undefined)
    : [];
  const validTierKeys = new Set([...nativeKeys, ...Object.keys(migratedModels)]);
  const catalog = loadAaCatalog(opts.home);
  const addedKeys = nativeKeys.filter((key) => !savedNativeKeys.includes(key));
  const tiers = Object.fromEntries(roles.map((role) => {
    const proposal = proposeTiers(nativeKeys, catalog, gatewayNamesOf(nativeByKey), avoidedKeysOf(nativeByKey, avoidGateways));
    const saved = state.tiers?.[role] ?? configForScope?.tiers?.[role];
    return [role, {
      simple: reconcileTierList(saved?.simple, validTierKeys, proposal.simple, addedKeys),
      complex: reconcileTierList(saved?.complex, validTierKeys, proposal.complex, addedKeys),
    }];
  }));

  // ---- nativeRoleModels ----
  const nativeRoleModels = Object.fromEntries(
    Object.entries(reconcilePerRoleModels(configForScope?.native?.generate ?? {}, savedNativeKeys, nativeKeys, roles))
      .map(([role, keys]) => [
        role,
        keys.map((k) => nativeByKey.get(k)).filter((k): k is NativeCandidate => k !== undefined),
      ]),
  );

  // ---- configToml ----
  const configToml = nativeTomlFor(nativeRoleModels, state.credentialSources ?? {}, tiers, migratedModels, chosenNative, configForScope?.run, avoidGateways);

  // ---- notices (key check) ----
  const notices: string[] = [];
  const gateways = [...new Set(chosenNative.map((c) => c.gateway))];
  const gatewayAuths = new Map(chosenNative.map((c) => [c.gateway, c.auth]));
  const autoSources = new Map(keyReport(gateways, opts.home).map((r) => [r.gateway, r.source]));

  for (const gateway of gateways) {
    const source = state.credentialSources?.[gateway];
    const auth = gatewayAuths.get(gateway);

    if (auth === 'api-key' && (source === 'sonata' || source === 'opencode')) {
      const found = credentials.hasKey(gateway, source);
      notices.push(found
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
        ? credentials.hasOauthCredential(gateway, auth)
        : auth === 'copilot-oauth'
          ? credentials.copilotUsable
          : readChatGptOAuth(opts.home, source) !== null;

      const repair = source === 'sonata'
        ? `run \`sonata auth login ${gateway}\``
        : source === 'codex'
          ? 'log in with `codex login`'
          : auth === 'copilot-oauth'
            ? 'log into opencode with a GitHub Copilot account'
            : 'log into opencode with a ChatGPT account';

      notices.push(found
        ? `  ✓ ${gateway}: credential from ${source}`
        : `  ! ${gateway}: no credential from ${source} — ${repair}`);
      continue;
    }

    const auto = autoSources.get(gateway) ?? null;
    notices.push(auto
      ? `  ✓ ${gateway}: key from ${auto}`
      : `  ! ${gateway}: no key — run \`sonata auth add ${gateway}\``);
  }

  // ---- summary ----
  const totalAgents = Object.values(nativeRoleModels).reduce((n, m) => n + m.length, 0);
  const summary: string[] = [
    '  Summary',
    `    models  ${chosenNative.map((c) => `${c.gateway}/${c.id}`).join(', ')}`,
    `    roles   ${roles.join(', ')}`,
    `    agents  ${totalAgents} files in .claude/agents/`,
    `    hook    ${state.hookScope === 'skip' ? 'not installed' : `${state.hookScope} settings.json`}`,
    `    routing ${state.routing === 'skip' ? 'not configured' : `sonata route auto${state.routing === 'global' ? ' --global' : ''}`}`,
    `    config  ${configPathResolved}`,
    '',
  ];

  // ---- hook ----
  // The hook scope comes from state.hookScope if set, otherwise we need to compute it
  // For the plan, we just use what the state says, the actual hook logic is done during write
  const hookScope = state.hookScope ?? 'project';
  // The allow-list must be touched even when the hook itself is skipped, so an
  // upgrade from the MCP-based release still replaces the old `mcp__sonata__*`
  // tool entries. `existingHookScope` says where the old hook lived, when any.
  const allowListScope = hookScope !== 'skip' ? hookScope : env.existingHookScope;
  const hook: InitPlan['hook'] = { scope: hookScope, allowListScope };

  // ---- skillPath ----
  const skillBaseDir = configScope === 'global' ? opts.home : opts.cwd;
  const skillPath = join(skillBaseDir, '.claude', 'skills', 'sonata-loop', 'SKILL.md');

  // ---- syncCwd ----
  const syncCwd = configScope === 'global' ? dirname(join(opts.home, GLOBAL_CONFIG_RELATIVE)) : opts.cwd;

  // ---- agentsDir ----
  const agentsDir = agentsDirFor(configScope, opts.cwd, opts.home);

  // ---- routing ----
  const routing = state.routing ?? 'project';

  return {
    configScope,
    configPath: configPathResolved,
    configToml,
    keysToStore: Object.entries(state.byokKeys ?? {}).map(([gateway, key]) => ({ gateway, key })),
    hook,
    skillPath,
    routing,
    syncCwd,
    agentsDir,
    chosenNative,
    roles,
    nativeKeys,
    notices,
    summary,
  };
}

/** Production `CredentialProbe`, backed by the key store and the filesystem. */
export function fsCredentialProbe(home: string, copilotUsable: boolean): CredentialProbe {
  return {
    hasKey(gateway: string, source: CredentialSource): boolean {
      if (source === 'sonata' || source === 'opencode') {
        return resolveKeyFromSource(gateway, home, source) !== undefined;
      }
      // 'codex' source: check if ChatGPT OAuth credential exists
      return readChatGptOAuth(home, 'codex') !== null;
    },
    hasOauthCredential(gateway: string, auth: NativeGatewayAuth): boolean {
      const dir = credentialDir(home, gateway);
      const file = credentialFileFor(auth);
      return existsSync(join(dir, file));
    },
    autoSource(gateway: string): string | null {
      const reports = keyReport([gateway], home);
      return reports[0]?.source ?? null;
    },
    copilotUsable,
  };
}