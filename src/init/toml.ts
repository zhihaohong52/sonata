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

/**
 * Rewrite only the `[tiers]` tables of an existing config, byte-for-byte
 * everywhere else.
 *
 * `sonata agents` re-ranks a tier, and that makes it the second writer of
 * `sonata.toml`. The obvious route — round-trip the config back through
 * `nativeTomlFor` — is the one to avoid: that function rebuilds the file from
 * a reconstructed `NativeCandidate[]`, and anything the reconstruction cannot
 * recover is deleted on write. That is exactly the shape of the bug that
 * silently un-priced a gateway on every `sonata init`, and a *second* writer
 * carrying the same hazard doubles the number of places it can recur.
 *
 * So this edits text instead. Preservation is not a list of fields that must
 * be kept in step with `parseConfig` — it is the default, and the only thing
 * that can be lost is a `[tiers.*]` table, which is what the caller is
 * replacing. A table ends at the next line that opens one, which is the whole
 * of TOML's block structure as this file uses it; the replacement lands where
 * the first old table was, so a hand-ordered file keeps its shape.
 *
 * Two things stop the line scan from being naive about TOML. A multiline
 * string can *contain* a line that looks like a table header, so the scanner
 * tracks triple-quote state and reads nothing inside one as structure —
 * without that, a `[tiers.code]` sitting in a prose value starts a drop that
 * splices the replacement into the middle of the string. And a header may
 * quote the segment (`["tiers".code]`), which names the same table; missing it
 * would emit a second definition of it, and TOML refuses a redefined table.
 * Neither shape is one sonata writes, but this reads files people edit, and
 * both fail in a way that leaves the user unable to save at all.
 */
/**
 * The multiline-string delimiter this line leaves open, if any.
 *
 * Counting triple quotes was not enough: a comment such as
 * `# TOML uses """ for multiline strings` opened a string that never closed,
 * the scanner then read every real `[tiers.*]` header as content, and the new
 * block was appended alongside the old ones — which `parseConfig` rejects as a
 * redefined table, so the user simply could not save. A quoted value carrying
 * the same characters is that trap from the other direction.
 *
 * So the line is walked rather than counted: a `#` reached outside a string
 * ends it, single-line basic and literal strings are skipped whole (basic
 * strings honour backslash escapes, literal ones do not — TOML has none inside
 * single quotes), and only a triple quote met in value position toggles state.
 */
function openDelimiterAfter(line: string): '"""' | "'''" | undefined {
  let open: '"""' | "'''" | undefined;
  let i = 0;
  while (i < line.length) {
    if (open !== undefined) {
      if (line.startsWith(open, i)) { open = undefined; i += 3; } else i += 1;
      continue;
    }
    // A `#` reached in value position starts a comment: nothing after it is
    // structure, and nothing in it can open a string.
    if (line[i] === '#') return undefined;
    if (line.startsWith('"""', i)) { open = '"""'; i += 3; continue; }
    if (line.startsWith("'''", i)) { open = "'''"; i += 3; continue; }
    if (line[i] === '"') {
      i += 1;
      while (i < line.length && line[i] !== '"') i += line[i] === '\\' ? 2 : 1;
      i += 1;
      continue;
    }
    if (line[i] === "'") {
      const end = line.indexOf("'", i + 1);
      i = end === -1 ? line.length : end + 1;
      continue;
    }
    i += 1;
  }
  return open;
}

export function replaceTiersBlock(
  toml: string,
  tiers: Record<string, { simple: string[]; complex: string[] }>,
): string {
  const lines = toml.split('\n');
  const isHeader = (line: string): boolean => /^\s*\[/.test(line);
  // The segment may be bare or quoted; `["tiers".code]` names the same table.
  const isTierHeader = (line: string): boolean => /^\s*\[\s*(?:tiers|"tiers"|'tiers')\s*[.\]]/.test(line);

  const kept: string[] = [];
  let insertAt: number | undefined;
  let dropping = false;
  // The open multiline-string delimiter, while inside one. A line within a
  // string is content, never structure — it neither opens a table nor ends
  // the one being dropped.
  let inString: '\"\"\"' | "'''" | undefined;
  for (const line of lines) {
    if (inString !== undefined) {
      const closes = line.indexOf(inString);
      // Content after the closing delimiter is ordinary TOML again, so the
      // rest of the line is rescanned rather than assumed quiet.
      inString = closes === -1 ? inString : openDelimiterAfter(line.slice(closes + inString.length));
      if (!dropping) kept.push(line);
      else insertAt ??= kept.length;
      continue;
    }
    inString = openDelimiterAfter(line);
    if (isHeader(line)) dropping = isTierHeader(line);
    if (!dropping) {
      kept.push(line);
      continue;
    }
    // Remember where the first dropped table began, so the new block lands in
    // the same place rather than at the end of a file someone has ordered.
    insertAt ??= kept.length;
  }

  const block = Object.entries(tiers).flatMap(([role, lists]) => [
    `[tiers.${tomlKey(role)}]`,
    `simple = [${lists.simple.map(tomlKey).join(', ')}]`,
    `complex = [${lists.complex.map(tomlKey).join(', ')}]`,
    '',
  ]);

  if (insertAt === undefined) {
    // No `[tiers]` at all. Appending is the only safe placement: these are
    // table headers, so they cannot be inserted above one without capturing
    // that table's keys.
    const tail = kept.length > 0 && kept[kept.length - 1] !== '' ? [''] : [];
    return [...kept, ...tail, ...block].join('\n');
  }
  return [...kept.slice(0, insertAt), ...block, ...kept.slice(insertAt)].join('\n');
}
