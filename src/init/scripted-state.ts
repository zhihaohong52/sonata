/**
 * The `--yes` (non-interactive) branch of `sonata init`.
 *
 * Lifted verbatim from `runInit` — the config-scope resolution, the
 * `providerKeys`/`nativeKeys`/`roles` derivation from flags and the existing
 * config, the BYOK candidate registration, the post-`validate` BYOK
 * missing-key and unknown-model checks, and the `stateForPlan` shaping. Every
 * comment is kept intact; they record real bugs.
 *
 * The return shape is the same `InitState` the wizard produces, so the shared
 * post-branch code (OAuth check, `plan()`, confirm gate, `apply()`) needs no
 * knowledge of which front end ran.
 *
 * `nativeByKey` is passed in (not built here) so the candidate map lives
 * exactly where it always has — in `runInit` — and the front ends never
 * disagree about which models a user has surfaced.
 */
import { existsSync, readFileSync } from 'node:fs';
import { KNOWN_ROLES } from '../config.js';
import { byokCandidateKey } from '../native/models.js';
import { resolveKeys } from '../native/credentials.js';
import { byokProviderName } from '../tui-ink/app-state.js';
import {
  preTickedNative, deriveInitState, configPathFor, parseCredentialSourceFlags,
  type NativeCandidate, type InitOptions,
} from '../commands/init.js';
import { validate } from './validate.js';
import type { InitState } from '../tui-ink/types.js';
import type { InitEnvironment } from './discover.js';

export function scriptedState(
  env: InitEnvironment,
  opts: InitOptions,
  nativeByKey: Map<string, NativeCandidate>,
): InitState {
  const byokUrls = new Map(env.byokProviders.map((provider) => [provider.name, provider.url]));

  const configScope = opts.configScope ?? 'project';
  const configPathResolved = configPathFor(configScope, opts.cwd, opts.home);
  const configText = existsSync(configPathResolved) ? readFileSync(configPathResolved, 'utf8') : '';
  const parsedConfig = env.configsByScope[configScope];
  const ticked = preTickedNative(configText, env.allNativeCandidates);
  const d = parsedConfig ? deriveInitState(parsedConfig, configScope, env.offered) : { configScope };
  const credentialSources = {
    ...d.credentialSources,
    ...parseCredentialSourceFlags(opts.credentialSource ?? []),
  };

  // BYOK is opt-in. The default is "everything on offer", and BYOK rows are
  // now on offer — so without this, a plain `--yes` with no --providers asks
  // for a key for all thirty well-known providers and refuses. Only an
  // explicit `--providers byok/x`, or a config that already names one,
  // engages BYOK here.
  const providerKeys = opts.providers ?? d.providerKeys
    ?? env.offered.filter((p) => p.harness !== 'byok').map((p) => p.key);

  // Scope native candidates to the selected providers.
  const selectedProviders = new Set(providerKeys.map((k) => k.split('/')[1] ?? k));
  let inScopeNative = env.allNativeCandidates.filter((c) => selectedProviders.has(c.gateway));

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
    addByokCandidates(nativeByKey, byokUrls, byokModels);
    inScopeNative = [
      ...inScopeNative,
      ...Object.values(byokModels).flat().length === 0 ? [] : byokSelected.flatMap((name) =>
        byokModels[name].map((id) => nativeByKey.get(byokCandidateKey(name, id))!)),
    ];
  }

  const nativeKeys = opts.models ?? d.nativeKeys
    ?? inScopeNative.filter((c) => ticked.has(c.key)).map((c) => c.key);
  const inScopeNativeByKey = new Map(inScopeNative.map((c) => [c.key, c]));

  const roles = opts.roles ?? d.roles ?? [...KNOWN_ROLES];

  // Build state for validation
  const state: InitState = {
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

  return {
    configScope,
    providerKeys,
    nativeKeys,
    roles,
    credentialSources,
    routing: opts.routing ?? 'project',
    hookScope: opts.scope ?? (env.existingHookScope ? 'skip' : 'project'),
    customProviders: undefined,
    byokModels,
    liveModels: {},
    customWireFormats: {},
    byokKeys: {},
    tiers: d.tiers,
  };
}

/**
 * Candidates for models a user named directly.
 *
 * These must join `nativeByKey` before `nativeKeys` is resolved through it,
 * or every BYOK key looks up `undefined` and is filtered out silently — a
 * scripted run that appears to work and writes an empty config.
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
