import type { InitEnvironment } from './discover.js';
import type { InitState } from '../tui-ink/types.js';
import { KNOWN_ROLES } from '../config.js';
import type { Problem } from '../detect.js';
import type { NativeCandidate } from '../commands/init.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isOauthGatewayAuth } from '../config.js';
import { credentialDir, credentialFileFor } from '../native/oauth-login.js';
import { byokProviderKey } from '../tui-ink/app-state.js';

export interface ValidateOptions {
  /** Full map of native candidates including BYOK and live refresh additions. */
  nativeByKey?: Map<string, NativeCandidate>;
}

export function validate(env: InitEnvironment, state: InitState, opts?: ValidateOptions): Problem[] {
  const problems: Problem[] = [];

  const configScope = state.configScope ?? 'project';
  const providerKeys = state.providerKeys ?? [];
  const nativeKeys = state.nativeKeys ?? [];
  const roles = state.roles ?? [...KNOWN_ROLES];
  const credentialSources = state.credentialSources ?? {};
  const stateRouting = state.routing;

  // Providers the user added this run via the wizard's "Add custom provider"
  // screen. Such a provider cannot be in `env.offered` (it is computed once at
  // startup, before the screen exists), so the unknown-provider check must
  // skip its byok/<name> key.
  const customProviderNames = new Set((state.customProviders ?? []).map((p) => p.name));
  const customProviderKeys = new Set(
    [...customProviderNames].map((name) => byokProviderKey(name)),
  );

  // Resolve native candidates for the selected providers
  const selectedProviders = new Set(providerKeys.map((k) => k.split('/')[1] ?? k));
  const inScopeNative = env.allNativeCandidates.filter((c) => selectedProviders.has(c.gateway));
  const inScopeNativeByKey = opts?.nativeByKey ?? new Map(inScopeNative.map((c) => [c.key, c]));

  // 1. unknownProviders — no harness offers this provider
  // Skip keys for providers the user added through the wizard this run: those
  // are typed in through "Add a custom provider" and never appear in the
  // pre-computed `env.offered` list.
  const unknownProviders = providerKeys.filter(
    (k) => !customProviderKeys.has(k) && !env.offered.some((p) => p.key === k),
  );
  if (unknownProviders.length > 0) {
    problems.push({
      severity: 'error',
      message:
        `sonata init: no harness offers ${unknownProviders.join(', ')}. ` +
        `Available: ${env.offered.map((p) => p.key).join(', ')}`,
    });
  }

  // 2. BYOK missing-key check — needs home, which we don't have; the --yes
  // branch keeps its own copy with full context.

  // 3. Unknown model check
  const unknown = nativeKeys.filter((k) => !inScopeNativeByKey.has(k));
  if (unknown.length > 0) {
    problems.push({
      severity: 'error',
      message:
        `sonata init: the selected providers do not offer ${unknown.join(', ')}. ` +
        `Available: ${[...inScopeNativeByKey.keys()].join(', ')}`,
    });
  }

  // 4. No models selected
  if (nativeKeys.length === 0) {
    problems.push({
      severity: 'error',
      message: 'sonata init: no models selected — nothing to generate.',
    });
  }

  // 5. --credential-source naming an unselected gateway
  const chosenNative = nativeKeys.map((k) => inScopeNativeByKey.get(k)).filter((k): k is NativeCandidate => k !== undefined);
  const nativeGateways = new Map(chosenNative.map((candidate) => [candidate.gateway, candidate]));
  for (const gateway of Object.keys(credentialSources)) {
    if (nativeGateways.has(gateway)) continue;
    problems.push({
      severity: 'error',
      message:
        `sonata init: --credential-source names gateway "${gateway}", which is not among the selected models. ` +
        `Known gateways: ${[...nativeGateways.keys()].join(', ') || '(none)'}`,
    });
  }

  // 6. Unknown role(s)
  const badRoles = roles.filter((r) => !KNOWN_ROLES.includes(r as never));
  if (badRoles.length > 0) {
    problems.push({
      severity: 'error',
      message: `sonata init: unknown role(s) ${badRoles.join(', ')}`,
    });
  }

  // 7. No roles selected
  if (roles.length === 0) {
    problems.push({
      severity: 'error',
      message: 'sonata init: no roles selected — nothing to generate.',
    });
  }

  // 8. Credential-source/auth block (codex on api-key, codex on copilot-oauth)
  const gatewayAuths = new Map(chosenNative.map((candidate) => [candidate.gateway, candidate.auth]));
  for (const [gateway, source] of Object.entries(credentialSources)) {
    const auth = gatewayAuths.get(gateway);
    if (source === 'codex' && auth === 'api-key') {
      problems.push({
        severity: 'error',
        message:
          `sonata init: gateway "${gateway}" is auth = "api-key", so it cannot take its credential from codex — ` +
          'that is a subscription, not a key.',
      });
    }
    if (source === 'codex' && auth === 'copilot-oauth') {
      problems.push({
        severity: 'error',
        message:
          `sonata init: gateway "${gateway}" is copilot-oauth, so it cannot take its credential from codex — ` +
          'Copilot logins come only from opencode.',
      });
    }
    // The sonata-source OAuth credential check needs home to check the
    // filesystem; the --yes branch keeps its own copy.
  }

  // 9. --routing global with project-scoped config
  if (stateRouting === 'global' && configScope === 'project') {
    problems.push({
      severity: 'error',
      message:
        'sonata init: --routing global routes every project through the machine config ' +
        '(~/.config/sonata/sonata.toml), but this config was written to the project ' +
        '(./sonata.toml) — the two would silently disagree. Use --config-scope global ' +
        'together with --routing global, or keep --routing project.',
    });
  }

  // 10. Shadowing sonata.toml check
  if (
    env.cwd !== undefined &&
    env.home !== undefined &&
    configScope === 'global' &&
    stateRouting !== 'global' &&
    stateRouting !== 'skip' &&
    existsSync(join(env.cwd, 'sonata.toml'))
  ) {
    problems.push({
      severity: 'error',
      message:
        'sonata init: this repository has its own sonata.toml, which would shadow the ' +
        'global config just written when routing is project-scoped — the generated global ' +
        "agents would resolve against this project's local config instead. Use --routing " +
        "global, or remove/rename this project's own sonata.toml.",
    });
  }

  return problems;
}
