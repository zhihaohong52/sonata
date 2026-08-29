/**
 * Environment discovery for `sonata init`.
 *
 * Lifted verbatim from `runInit` — detection printing, `configsByScope` loading
 * with its legacy migration, `configuredGateways`, `providerBaseUrls`, the
 * copilot probe, `oauthProviders`, `gatewayAuth`, `allNativeCandidates`,
 * `byokProviders`, `dedupeOauthProviders`, the no-harness warning, and the
 * `existingHookScope` computation. Every comment is kept intact; they record
 * real bugs.
 *
 * `discover` reports problems; it does not decide what to do about them. The
 * blocking-problems early return stays in `runInit`, reading `env.problems`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  configPath, GLOBAL_CONFIG_RELATIVE, parseConfig,
  isOauthGatewayAuth, type SonataConfig, type NativeGatewayAuth,
} from '../config.js';
import { readChatGptOAuth, readOpencodeChatGptOAuth } from '../native/codex-auth.js';
import { readCopilotToken, copilotTokenCanExchange } from '../native/copilot-auth.js';
import type { ModelRef } from '../types.js';
import {
  detectTmux, detectHarnesses, offerableProviders, WELL_KNOWN_PROVIDER_URLS,
  type Problem, type HarnessStatus, type DetectEnv, type ProviderSummary,
} from '../detect.js';
import {
  settingsPath, readSettings, hookInstalled, hookCommand, type HookScope,
} from '../settings.js';
import { migrateLegacyConfig } from '../normalize.js';
import { wellKnownProviders } from '../native/models.js';
import { byokProviderKey } from '../tui-ink/app-state.js';
import { oauthProvidersFor, nativeCandidatesFrom, configNativeCandidates, gatewayNamesOf, avoidedKeysOf, dedupeOauthProviders, type NativeCandidate, configPathFor, defaultDetector, OPENCODE_RANGE } from '../commands/init.js';
import type { Detector, ConfigScope, Detection, InitOptions } from '../commands/init.js';

export interface InitEnvironment {
  tmux: Detection['tmux'];
  harnesses: Detection['harnesses'];
  problems: Problem[];
  offered: ProviderSummary[];
  allNativeCandidates: NativeCandidate[];
  providerBaseUrls: Record<string, string>;
  gatewayAuth: Map<string, NativeGatewayAuth>;
  oauthProviders: Map<string, NativeGatewayAuth>;
  byokProviders: Array<{ name: string; url: string }>;
  configsByScope: Partial<Record<ConfigScope, SonataConfig>>;
  existingHookScope: HookScope | undefined;
  copilotUsable: boolean;
}

export async function discover(
  opts: Pick<InitOptions, 'cwd' | 'home' | 'packageRoot' | 'detect'>,
  out: (line: string) => void,
): Promise<InitEnvironment> {
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
  let offered: ProviderSummary[] = offerableProviders(allRefs, authed);

  const configsByScope: Partial<Record<ConfigScope, SonataConfig>> = {};
  for (const scope of ['project', 'global'] as const) {
    const path = configPathFor(scope, opts.cwd, opts.home);
    if (!existsSync(path)) continue;
    try {
      const parsed = parseConfig(readFileSync(path, 'utf8'));
      if (parsed.tiers === undefined && (Object.keys(parsed.generate.roles).length > 0 || Object.keys(parsed.native?.generate ?? {}).length > 0)) {
        const migrated = migrateLegacyConfig(parsed);
        configsByScope[scope] = {
          ...parsed,
          unifiedModels: migrated.models,
          tiers: migrated.tiers,
          native: parsed.native === undefined ? undefined : {
            ...parsed.native,
            generate: Object.fromEntries(Object.entries(migrated.tiers).map(([role, lists]) => [
              role, [...new Set([...lists.simple, ...lists.complex])],
            ])),
          },
        };
      } else {
        configsByScope[scope] = parsed;
      }
    } catch (err) {
      out(`  ! could not read ${path}; init is starting from defaults: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const configuredGateways = new Map<string, number>();
  for (const config of Object.values(configsByScope)) {
    for (const model of Object.values(config?.native?.models ?? {})) {
      configuredGateways.set(model.gateway, (configuredGateways.get(model.gateway) ?? 0) + 1);
    }
    // A native-only unified [models] entry names its gateway here too — an
    // untiered config with no legacy [native.models] table at all otherwise
    // never gets its gateway a synthetic `config/<gateway>` provider, so
    // `deriveInitState`'s own providerKeys (computed from both tables)
    // names a provider `offered` never actually has, and scripted
    // `sonata init --yes` rejects it as unknown before role selection is
    // even reached.
    for (const model of Object.values(config?.unifiedModels ?? {})) {
      if (model.gateway === undefined) continue;
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
  // A gateway a harness no longer discovers (removed from opencode, say) but
  // that is still configured in sonata.toml has no live-detected base URL, so
  // re-authenticating it through the wizard could never fetch a fresh model
  // list — only the models already persisted from whenever it was first
  // imported. Fall back to the config's own base_url so it can.
  for (const config of Object.values(configsByScope)) {
    for (const [gateway, gatewayConfig] of Object.entries(config?.native?.gateways ?? {})) {
      if (!providerBaseUrls[gateway] && gatewayConfig.baseUrl !== undefined) {
        providerBaseUrls[gateway] = gatewayConfig.baseUrl;
      }
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

  // Applied after the BYOK block so a hidden provider is not re-offered as a
  // BYOK row: that filter skips any name already in `offered`, which it still
  // is at this point.
  offered = dedupeOauthProviders(offered, oauthProviders);

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

  // ---- hook scope -------------------------------------------------------
  const command = hookCommand(opts.packageRoot);
  const alreadyGlobal = hookInstalled(readSettings(settingsPath('global', opts.cwd, opts.home)), command);
  const alreadyProject = hookInstalled(readSettings(settingsPath('project', opts.cwd, opts.home)), command);

  // Where an already-installed hook actually lives — kept separate from
  // `scope` so an upgrade (hook present, but its settings file still carries
  // the pre-dispatch-CLI MCP tool names) still gets its allow-list checked
  // below, even though `scope` itself becomes 'skip' for "no new hook to ask
  // about".
  const existingHookScope: HookScope | undefined = alreadyGlobal ? 'global' : alreadyProject ? 'project' : undefined;

  return {
    tmux,
    harnesses,
    problems,
    offered,
    allNativeCandidates,
    providerBaseUrls,
    gatewayAuth,
    oauthProviders,
    byokProviders,
    configsByScope,
    existingHookScope,
    copilotUsable,
  };
}

// Re-export types and values needed by callers
export type { InitOptions, ConfigScope, Detection, Detector } from '../commands/init.js';
export { defaultDetector, OPENCODE_RANGE } from '../commands/init.js';