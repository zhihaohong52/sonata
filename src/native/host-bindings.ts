import { readFileSync } from 'node:fs';

import type { NativeConfig } from '../config.js';
import { WELL_KNOWN_PROVIDER_URLS } from '../detect.js';
import { resolveKeys, writeFileAtomic } from './credentials.js';
import { withSessionLockSync } from '../filelock.js';
import { readOnce } from './read-snapshot.js';

/**
 * Which hosts a stored key may be sent to, per gateway name.
 *
 * A stored key is looked up by gateway NAME, but the `base_url` it is sent
 * to comes from whichever tenant's config names that gateway — including a
 * cloned repo's project config pointing the name at an attacker's host. So a
 * key is sent only to a host bound to its gateway name. A host is bound when
 * any of these holds:
 *
 * (a) it is the host in `WELL_KNOWN_PROVIDER_URLS` for that gateway name;
 * (b) the user confirmed it with `sonata auth trust <gateway> <host>`;
 * (c) it is the host of the machine config's own gateway of that name (the
 *     machine config is trusted; project configs are not);
 * (d) `sonata auth add` or `sonata init` recorded it while storing a key for
 *     a gateway whose URL the user chose — which lands in the same trust
 *     file as (b).
 *
 * Hostnames compare lowercased and exactly — never suffix-matched — and only
 * https URLs can be bound at all.
 */

export function trustedHostsPath(home: string): string {
  return `${home}/.config/sonata/trusted-hosts.json`;
}

export type TrustBindings = Record<string, string[]>;

/**
 * The user-confirmed bindings. Tolerant like every other credential read: an
 * absent or corrupt file means no extra trust (fail closed), never a throw
 * on the request path.
 */
export function readTrustBindings(home: string): TrustBindings {
  let value: unknown;
  try {
    value = JSON.parse(readOnce(trustedHostsPath(home)).toString('utf8'));
  } catch {
    return {};
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: TrustBindings = {};
  for (const [gateway, hosts] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(hosts)) continue;
    const clean = [...new Set(
      hosts.filter((h): h is string => typeof h === 'string').map((h) => h.toLowerCase()).filter((h) => h !== ''),
    )];
    if (clean.length > 0) out[gateway] = clean;
  }
  return out;
}

/**
 * The key the upgrade-seed marker is stored under in the trust file. A string
 * value, so the request path's reader (which keeps only array values) ignores
 * it. Reserved: no gateway may be named this, since its hosts would collide.
 */
export const TRUST_SEED_MARKER = 'seeded';

/** The trust file as a writer sees it: the bindings, and the upgrade-seed marker if written. */
interface TrustFile {
  bindings: TrustBindings;
  seeded?: string;
}

/**
 * The trust file for a writer. Strict, unlike the request path's reader: a
 * corrupt file is refused, naming the path, rather than read as empty and then
 * overwritten — which would silently drop every confirmed binding. Absent is
 * no bindings yet.
 */
function readTrustFileForWrite(home: string): TrustFile {
  const path = trustedHostsPath(home);
  let text: string;
  try {
    // Read fresh, never from a read snapshot: a writer must see the file as it is.
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { bindings: {} };
    throw new Error(`cannot update the host trust file ${path}: ${(error as Error).message}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON (refusing to rewrite it — fix or remove it, then retry)`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} does not hold a JSON object (refusing to rewrite it — fix or remove it, then retry)`);
  }
  const file: TrustFile = { bindings: {} };
  for (const [gateway, hosts] of Object.entries(value as Record<string, unknown>)) {
    if (gateway === TRUST_SEED_MARKER) {
      if (typeof hosts === 'string') file.seeded = hosts;
      continue;
    }
    if (!Array.isArray(hosts)) continue;
    file.bindings[gateway] = [...new Set(hosts.filter((h): h is string => typeof h === 'string').map((h) => h.toLowerCase()))];
  }
  return file;
}

function writeTrustFile(home: string, file: TrustFile): void {
  const out: Record<string, string | string[]> = { ...file.bindings };
  if (file.seeded !== undefined) out[TRUST_SEED_MARKER] = file.seeded;
  writeFileAtomic(trustedHostsPath(home), `${JSON.stringify(out, null, 2)}\n`);
}

function refuseReservedGateway(gateway: string): void {
  if (gateway === TRUST_SEED_MARKER) {
    throw new Error(`sonata auth trust: "${TRUST_SEED_MARKER}" is reserved for the upgrade's trust record — name the gateway differently`);
  }
}

/**
 * A bare host (with an optional port) or a full URL, normalized to the
 * lowercase `host` a trust entry is compared by: the hostname, plus a
 * non-default port. `URL` drops the scheme's default port, so `:443` and no
 * port are the same host.
 */
export function normalizeTrustHost(input: string): string {
  const text = input.trim();
  if (text === '') throw new Error('sonata auth trust: expected a host, got an empty string');
  let parsed: URL;
  try {
    parsed = new URL(text.includes('://') ? text : `https://${text}`);
  } catch {
    throw new Error(`sonata auth trust: "${input}" is not a host or URL`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`sonata auth trust: only https hosts can be trusted, got "${input}"`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error(`sonata auth trust: "${input}" must be a bare host, without credentials`);
  }
  const host = parsed.host.toLowerCase();
  if (host === '') throw new Error(`sonata auth trust: "${input}" is not a host or URL`);
  return host;
}

/** A URL's `host` (hostname and any non-default port), lowercased, or undefined unless https. */
function urlHost(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return undefined;
    const host = parsed.host.toLowerCase();
    return host === '' ? undefined : host;
  } catch {
    return undefined;
  }
}

export interface HostBindingContext {
  /** Hosts the user confirmed for this gateway (`auth trust` / `auth add` / init). */
  trusted?: string[];
  /**
   * The machine config's own gateways, keyed by name: only the entry under
   * this gateway's own name trusts its host. Passed as the whole map (not
   * one URL) so a caller cannot accidentally bind another name's host.
   */
  machineGateways?: Record<string, { baseUrl: string }>;
}

/** Whether one lowercase hostname may receive this gateway's key. */
export function hostBoundToGateway(gateway: string, host: string, ctx: HostBindingContext): boolean {
  const wellKnown = urlHost(WELL_KNOWN_PROVIDER_URLS[gateway]);
  if (wellKnown !== undefined && wellKnown === host) return true;
  if ((ctx.trusted ?? []).includes(host)) return true;
  const machine = urlHost(ctx.machineGateways?.[gateway]?.baseUrl);
  if (machine !== undefined && machine === host) return true;
  return false;
}

export type HostBinding = { bound: true } | { bound: false; host: string };

/** Whether this gateway's `base_url` host may receive its key. */
export function gatewayHostBound(
  gateway: string,
  baseUrl: string,
  ctx: HostBindingContext,
): HostBinding {
  let host: string;
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'https:' || parsed.hostname === '') {
      return { bound: false, host: parsed.hostname !== '' ? parsed.host.toLowerCase() : baseUrl };
    }
    host = parsed.host.toLowerCase();
  } catch {
    return { bound: false, host: baseUrl };
  }
  return hostBoundToGateway(gateway, host, ctx) ? { bound: true } : { bound: false, host };
}

/**
 * Why a key is withheld from one host, naming the config that set the URL.
 * The user is told to remove a URL they did not choose rather than trust it:
 * a project config is the usual place a hostile one comes from.
 */
export function unboundMessage(gateway: string, host: string, configPath: string): string {
  return `gateway "${gateway}": its key is not served to "${host}" — the URL is set in ${configPath}, ` +
    'and that host is not bound to this gateway. If you did not choose this URL, remove it from that file — ' +
    `do not trust it. If you did, run \`sonata auth trust ${gateway} ${host}\` to allow it`;
}

/**
 * Every gateway name in one tenant's `gateways` whose `base_url` host may not
 * receive its key, with the message serve records as its credential failure.
 * Session and OAuth gateways hold no sendable key and are unaffected.
 *
 * Serve runs this over every tenant's gateways, not the merge: the merge
 * keeps one `base_url` per name, and the tenant whose URL survived could be
 * bound while another's is not. A gateway with no stored key gets no failure
 * here either: withholding means omitting an env entry, and with no key there
 * is nothing to omit — the caller passes the names a key would actually flow
 * for (`keysPresent`).
 */
export function unboundKeyHosts(
  tenantGateways: NativeConfig['gateways'],
  machineGateways: NativeConfig['gateways'],
  keysPresent: Set<string>,
  home: string,
  configPath: string,
): Map<string, string> {
  const trust = readTrustBindings(home);
  const out = new Map<string, string>();
  for (const [name, gateway] of Object.entries(tenantGateways)) {
    if ((gateway.auth ?? 'api-key') !== 'api-key') continue;
    // No stored key under this name or any name sharing it: nothing would
    // flow, so no failure — the gateway resolves keyless exactly as before.
    if (!keysPresent.has(name)) continue;
    const binding = gatewayHostBound(name, gateway.baseUrl, { trusted: trust[name] ?? [], machineGateways });
    if (!binding.bound) out.set(name, unboundMessage(name, binding.host, configPath));
  }
  return out;
}

/**
 * For each gateway whose stored key a model refresh would send to its
 * `base_url`, the reason it may not be sent — keyed by gateway, present only
 * when the host is unbound. A URL the user typed in this run is bound: the
 * refresh asks the URL they chose. Serve's message, so the wizard and the
 * router say the same thing.
 */
export function refreshHostReasons(input: {
  /** The URL each gateway's refresh would ask, by gateway. */
  gatewayUrls: Record<string, string>;
  /** The stored key each gateway would be asked with. */
  keys: Record<string, string>;
  /** Gateways whose URL the user typed in this wizard run. */
  typed: ReadonlySet<string>;
  trusted: TrustBindings;
  machineGateways: Record<string, { baseUrl: string }>;
  /** The config file the URLs came from, named in the reason. */
  configFile: string;
}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [gateway, url] of Object.entries(input.gatewayUrls)) {
    if (input.keys[gateway] === undefined || input.typed.has(gateway)) continue;
    const binding = gatewayHostBound(gateway, url, {
      trusted: input.trusted[gateway] ?? [],
      machineGateways: input.machineGateways,
    });
    if (!binding.bound) out[gateway] = unboundMessage(gateway, binding.host, input.configFile);
  }
  return out;
}

/**
 * Record a user-confirmed (gateway, host) binding. Idempotent. The read and
 * the write happen under the file's lock, so two `auth add`/`trust`/`init`
 * runs cannot each drop the other's binding.
 */
export function addTrustBinding(home: string, gateway: string, host: string): void {
  refuseReservedGateway(gateway);
  withSessionLockSync(trustedHostsPath(home), () => {
    const file = readTrustFileForWrite(home);
    const hosts = file.bindings[gateway] ?? [];
    if (!hosts.includes(host)) {
      file.bindings[gateway] = [...hosts, host];
      writeTrustFile(home, file);
    }
  });
}

/** Remove one binding. Refuses when there is nothing to remove. */
export function removeTrustBinding(home: string, gateway: string, host: string): void {
  withSessionLockSync(trustedHostsPath(home), () => {
    const file = readTrustFileForWrite(home);
    const hosts = file.bindings[gateway];
    if (hosts === undefined || !hosts.includes(host)) {
      throw new Error(`sonata auth untrust: no trusted host "${host}" for gateway "${gateway}"`);
    }
    const rest = hosts.filter((h) => h !== host);
    if (rest.length === 0) delete file.bindings[gateway];
    else file.bindings[gateway] = rest;
    writeTrustFile(home, file);
  });
}

/**
 * The one-time seed an upgrade makes. Before this, a stored key went to
 * whatever host a config named, and an existing user's configs already name
 * the hosts they use. So the first run after the upgrade binds, once, every
 * https api-key gateway in those configs that has a stored or opencode-sourced
 * key, to its URL's host. The marker records that it ran: a config first seen
 * after it is never seeded. Returns one line per binding it wrote.
 *
 * Runs under the trust file's lock. A corrupt file throws, naming it, and
 * nothing is written — the marker is only ever written with the seed.
 */
export function seedUpgradeTrust(
  home: string,
  version: string,
  configs: readonly { configPath: string; gateways: NativeConfig['gateways'] }[],
): string[] {
  return withSessionLockSync(trustedHostsPath(home), () => {
    const file = readTrustFileForWrite(home);
    if (file.seeded !== undefined) return [];
    const candidates: Array<{ gateway: string; host: string; configPath: string }> = [];
    for (const { configPath, gateways } of configs) {
      for (const [gateway, settings] of Object.entries(gateways)) {
        if ((settings.auth ?? 'api-key') !== 'api-key') continue;
        const host = urlHost(settings.baseUrl);
        if (host !== undefined) candidates.push({ gateway, host, configPath });
      }
    }
    const withKey = new Set(resolveKeys([...new Set(candidates.map((c) => c.gateway))], home).map((hit) => hit.gateway));
    const lines: string[] = [];
    for (const { gateway, host, configPath } of candidates) {
      if (!withKey.has(gateway) || gateway === TRUST_SEED_MARKER) continue;
      const hosts = file.bindings[gateway] ?? [];
      if (hosts.includes(host)) continue;
      file.bindings[gateway] = [...hosts, host];
      lines.push(`trusted ${host} for gateway "${gateway}" (from ${configPath}) — run \`sonata auth untrust ${gateway} ${host}\` to remove it`);
    }
    file.seeded = version;
    writeTrustFile(home, file);
    return lines;
  });
}

/** Read the trust file without the snapshot cache, for tests. */
export function readTrustBindingsFile(home: string): TrustBindings {
  return JSON.parse(readFileSync(trustedHostsPath(home), 'utf8')) as TrustBindings;
}
