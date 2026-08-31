import type { NativeCandidate } from './helpers.js';
import type { CredentialSource } from '../config.js';
import type { NativeGatewayAuth, NativeGatewayWireFormat } from '../config.js';
import type { SonataConfig } from '../config.js';
import { isOauthGatewayAuth, oauthGatewayBaseUrl } from '../config.js';
import { proposeTiers } from '../catalog.js';
import { gatewayNamesOf, avoidedKeysOf, duplicateKeys } from './helpers.js';

const TOML_ESCAPES: Record<string, string> = {
  '\\': '\\\\', '"': '\\"', '\b': '\\b', '\t': '\\t',
  '\n': '\\n', '\f': '\\f', '\r': '\\r',
};

/**
 * A TOML basic string, used for every key and value this file writes.
 */
export function tomlKey(key: string): string {
  // eslint-disable-next-line no-control-regex
  const escaped = key.replace(/[\\"\x00-\x1f\x7f]/g, (ch) =>
    TOML_ESCAPES[ch] ?? `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `"${escaped}"`;
}

/**
 * Emit the unified model registry, tier lists, native gateway definitions,
 * and runtime defaults.
 */
export function nativeTomlFor(
  roleModels: Record<string, NativeCandidate[]>,
  credentialSources: Record<string, CredentialSource> = {},
  selectedTiers?: Record<string, { simple: string[]; complex: string[] }>,
  extraModels: Record<string, { harness?: string; harnessId?: string }> = {},
  allChosen: readonly NativeCandidate[] = [],
  existingRun?: SonataConfig['run'],
  avoidGateways: readonly string[] = [],
): string {
  const allModels = new Map<string, NativeCandidate>();
  for (const cands of Object.values(roleModels)) {
    for (const c of cands) allModels.set(c.key, c);
  }
  for (const c of allChosen) allModels.set(c.key, c);
  const tierLists = selectedTiers ?? Object.fromEntries(
    Object.entries(roleModels).map(([role, candidates]) => {
      const proposal = proposeTiers(
        candidates.map((candidate) => candidate.key),
        undefined,
        gatewayNamesOf(allModels),
        avoidedKeysOf(allModels, avoidGateways),
      );
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
  // Top-level keys must precede every table header: a bare key written after
  // one belongs to *that table*, so emitting this beside [tiers] silently made
  // it a field of the last [models."…"] entry and parseConfig never saw it.
  // Dropping it would also be the bug the setting exists to prevent — init
  // would re-propose the ordering the user avoided.
  if (avoidGateways.length > 0) {
    lines.push(`avoid_gateways = [${avoidGateways.map(tomlKey).join(', ')}]`, '');
  }

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
  for (const [key, model] of Object.entries(extraModels)) {
    if (allModels.has(key) || model.harness === undefined || model.harnessId === undefined) continue;
    lines.push(`[models.${tomlKey(key)}]`, `harness = ${tomlKey(model.harness)}`, `id = ${tomlKey(model.harnessId)}`, '');
  }

  for (const [role, lists] of Object.entries(tierLists)) {
    lines.push(`[tiers.${tomlKey(role)}]`, `simple = [${lists.simple.map(tomlKey).join(', ')}]`, `complex = [${lists.complex.map(tomlKey).join(', ')}]`, '');
  }

  lines.push(
    '[run]',
    `tail_window_seconds = ${existingRun?.tailWindowSeconds ?? 20}`,
    `stall_timeout_seconds = ${existingRun?.stallTimeoutSeconds ?? 120}`,
    `run_timeout_seconds = ${existingRun?.runTimeoutSeconds ?? 1800}`,
    `dispatch_window_seconds = ${existingRun?.dispatchWindowSeconds ?? 1500}`,
    '',
  );
  return lines.join('\n');
}
