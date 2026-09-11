import type { NativeCandidate } from './helpers.js';
import type { CredentialSource } from '../config.js';
import type { NativeGatewayAuth, NativeGatewayWireFormat } from '../config.js';
import type { SonataConfig, PriceConfig, Rates } from '../config.js';
import { isOauthGatewayAuth, oauthGatewayBaseUrl } from '../config.js';
import { proposeTiers } from '../catalog.js';
import { gatewayNamesOf, avoidedKeysOf, duplicateKeys } from './helpers.js';
import { CURRENT_SCHEMA_VERSION, SCHEMA_VERSION_KEY } from '../migrations.js';

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
/**
 * Emit a `[price]` sub-table under `parent`.
 *
 * Windows are emitted as an array of tables in declaration order, because the
 * first match wins at read time: reordering them would change which rate
 * applies. Rates are written only when present, so a partial table stays
 * partial rather than gaining zeros — `costOf` prices an absent dimension at
 * 0, so inventing one would turn "unknown" into "free".
 */
function priceLines(parent: string, price: PriceConfig): string[] {
  const rate = (p: Rates): string[] => [
    p.input === undefined ? undefined : `input = ${p.input}`,
    p.cachedInput === undefined ? undefined : `cached_input = ${p.cachedInput}`,
    p.cacheWrite === undefined ? undefined : `cache_write = ${p.cacheWrite}`,
    p.output === undefined ? undefined : `output = ${p.output}`,
  ].filter((l): l is string => l !== undefined);

  const own = rate(price);
  const windows = price.windows ?? [];
  if (own.length === 0 && windows.length === 0) return [];

  const lines = [`[${parent}.price]`, ...own, ''];
  for (const w of windows) {
    lines.push(`[[${parent}.price.windows]]`, `from = ${tomlKey(w.from)}`, `to = ${tomlKey(w.to)}`, ...rate(w), '');
  }
  return lines;
}

export function nativeTomlFor(
  roleModels: Record<string, NativeCandidate[]>,
  credentialSources: Record<string, CredentialSource> = {},
  selectedTiers?: Record<string, { simple: string[]; complex: string[] }>,
  extraModels: Record<string, { harness?: string; harnessId?: string }> = {},
  allChosen: readonly NativeCandidate[] = [],
  existingRun?: SonataConfig['run'],
  avoidGateways: readonly string[] = [],
  /**
   * The config being rewritten, read only for settings this writer would
   * otherwise destroy.
   *
   * `sonata init` is the sole writer of `sonata.toml`, so anything it does not
   * emit is deleted. `pricing_provider` and every `[price]` block were read by
   * `parseConfig` and written back by nobody, so each rewrite silently
   * un-priced the gateway — and unpriced volume is excluded from
   * `[budget] daily_usd`, so the cap stopped counting that spend as well.
   * Measured on a real config: one rewrite flipped a gateway from priced to
   * unpriced between two requests a minute apart. This is the same reason
   * `avoid_gateways` is written back.
   */
  existing?: Pick<SonataConfig, 'native' | 'unifiedModels'>,
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
  // Which shape this file is in. First, and above every table header, for the
  // same reason `avoid_gateways` has to be — see below. Writing it is what
  // lets a future sonata tell "old file" from "file this sonata wrote", so a
  // migration can run exactly once instead of being re-guessed from shape.
  lines.push(`${SCHEMA_VERSION_KEY} = ${CURRENT_SCHEMA_VERSION}`, '');
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
    // `provider` supersedes `wire_format`, so the wizard writes the current
    // key. Reading `wire_format` stays supported for configs already on disk;
    // continuing to WRITE it would mean every new config is born legacy.
    if (wireFormat === 'anthropic') lines.push(`provider = ${tomlKey(wireFormat)}`);
    const kept = existing?.native?.gateways?.[gateway];
    if (kept?.pricingProvider !== undefined && kept.pricingProvider.length > 0) {
      lines.push(`pricing_provider = [${kept.pricingProvider.map(tomlKey).join(', ')}]`);
    }
    lines.push('');
    // After the gateway's bare keys: a sub-table header ends the parent table,
    // so anything emitted below it would belong to `price` instead.
    if (kept?.price !== undefined) {
      lines.push(...priceLines(`native.gateways.${tomlKey(gateway)}`, kept.price));
    }
  }

  for (const [key, c] of allModels) {
    lines.push(`[models.${tomlKey(key)}]`, `gateway = ${tomlKey(c.gateway)}`, `id = ${tomlKey(c.id)}`, `context_window = ${c.contextWindow}`);
    if (c.harness !== undefined) {
      lines.push(`harness = ${tomlKey(c.harness)}`, `harness_id = ${tomlKey(c.harnessId ?? c.id)}`);
    }
    lines.push('');
    const keptPrice = existing?.unifiedModels?.[key]?.price;
    if (keptPrice !== undefined) lines.push(...priceLines(`models.${tomlKey(key)}`, keptPrice));
  }
  for (const [key, model] of Object.entries(extraModels)) {
    if (allModels.has(key) || model.harness === undefined || model.harnessId === undefined) continue;
    lines.push(`[models.${tomlKey(key)}]`, `harness = ${tomlKey(model.harness)}`, `id = ${tomlKey(model.harnessId)}`, '');
    // Harness-only models are emitted by this second loop, so preserving the
    // price in the native loop alone left the same deletion one block further
    // down. A harness-routed model is a `sonata dispatch` fallback candidate
    // whose rates are hand-written exactly like a native one's.
    const keptExtraPrice = existing?.unifiedModels?.[key]?.price;
    if (keptExtraPrice !== undefined) lines.push(...priceLines(`models.${tomlKey(key)}`, keptExtraPrice));
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
