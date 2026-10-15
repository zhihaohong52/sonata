import { readFileSync } from 'node:fs';

import type { NativeConfig } from '../config.js';
import { WELL_KNOWN_PROVIDER_URLS } from '../detect.js';
import { writeFileAtomic } from './credentials.js';
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

function writeTrustBindings(home: string, bindings: TrustBindings): void {
  writeFileAtomic(trustedHostsPath(home), `${JSON.stringify(bindings, null, 2)}\n`);
}

/** A bare hostname or a full URL, normalized to a lowercase hostname. */
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
  const host = parsed.hostname.toLowerCase();
  if (host === '') throw new Error(`sonata auth trust: "${input}" is not a host or URL`);
  return host;
}

function urlHostname(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return undefined;
    const host = parsed.hostname.toLowerCase();
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
  const wellKnown = urlHostname(WELL_KNOWN_PROVIDER_URLS[gateway]);
  if (wellKnown !== undefined && wellKnown === host) return true;
  if ((ctx.trusted ?? []).includes(host)) return true;
  const machine = urlHostname(ctx.machineGateways?.[gateway]?.baseUrl);
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
      return { bound: false, host: parsed.hostname !== '' ? parsed.hostname.toLowerCase() : baseUrl };
    }
    host = parsed.hostname.toLowerCase();
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
  gateways: NativeConfig['gateways'],
  machineGateways: NativeConfig['gateways'],
  keysPresent: Set<string>,
  home: string,
  configPath: string,
): Map<string, string> {
  const trust = readTrustBindings(home);
  const out = new Map<string, string>();
  for (const [name, gateway] of Object.entries(gateways)) {
    if ((gateway.auth ?? 'api-key') !== 'api-key') continue;
    // No stored key under this name or any name sharing it: nothing would
    // flow, so no failure — the gateway resolves keyless exactly as before.
    if (!keysPresent.has(name)) continue;
    const binding = gatewayHostBound(name, gateway.baseUrl, { trusted: trust[name] ?? [], machineGateways });
    if (!binding.bound) out.set(name, unboundMessage(name, binding.host, configPath));
  }
  return out;
}

/** Record a user-confirmed (gateway, host) binding. Idempotent. */
export function addTrustBinding(home: string, gateway: string, host: string): void {
  const bindings = readTrustBindings(home);
  const hosts = bindings[gateway] ?? [];
  if (!hosts.includes(host)) {
    bindings[gateway] = [...hosts, host];
    writeTrustBindings(home, bindings);
  }
}

/** Remove one binding. Refuses when there is nothing to remove. */
export function removeTrustBinding(home: string, gateway: string, host: string): void {
  const bindings = readTrustBindings(home);
  const hosts = bindings[gateway];
  if (hosts === undefined || !hosts.includes(host)) {
    throw new Error(`sonata auth untrust: no trusted host "${host}" for gateway "${gateway}"`);
  }
  const rest = hosts.filter((h) => h !== host);
  if (rest.length === 0) delete bindings[gateway];
  else bindings[gateway] = rest;
  writeTrustBindings(home, bindings);
}

/** Read the trust file without the snapshot cache, for tests. */
export function readTrustBindingsFile(home: string): TrustBindings {
  return JSON.parse(readFileSync(trustedHostsPath(home), 'utf8')) as TrustBindings;
}
