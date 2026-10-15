import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { keyReport, removeSonataKey, writeSonataKey } from '../native/credentials.js';
import {
  addTrustBinding,
  gatewayHostBound,
  normalizeTrustHost,
  readTrustBindings,
  removeTrustBinding,
} from '../native/host-bindings.js';
import { configPath, GLOBAL_CONFIG_RELATIVE, isOauthGatewayAuth, loadConfig, parseConfig } from '../config.js';
import { credentialDir, loginGateway } from '../native/oauth-login.js';

export function cmdAuthList(opts: { home: string; gateways: string[] }): { text: string } {
  const text = keyReport(opts.gateways, opts.home)
    .map(({ gateway, source }) => `${gateway}: ${source === null ? 'no key' : `key from ${source}`}`)
    .join('\n');
  return { text };
}

/**
 * Stores the key and binds nothing. The gateway's URL is read from a config,
 * and a project config is one a cloned repo can carry: trusting it here would
 * bind a repo's host to the user's key for good. A well-known host needs no
 * binding, and any other is named by `unboundConfigUrlNotice`.
 */
export function cmdAuthAdd(opts: { home: string; gateway: string; key: string }): void {
  writeSonataKey(opts.home, opts.gateway, opts.key);
}

/**
 * What `sonata auth add` says when the gateway's URL, as the config in effect
 * names it, is on a host nobody bound: the config that set it, the command
 * that would trust it, and the advice not to trust a URL the user did not set.
 */
export function unboundConfigUrlNotice(home: string, cwd: string, gateway: string): string | undefined {
  const file = configPath(cwd, home);
  if (file === null) return undefined;
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig(cwd, home);
  } catch {
    return undefined;
  }
  const baseUrl = config.native?.gateways[gateway]?.baseUrl;
  if (baseUrl === undefined) return undefined;
  let machineGateways: Record<string, { baseUrl: string }> = {};
  const machineFile = join(home, GLOBAL_CONFIG_RELATIVE);
  if (file === machineFile) {
    machineGateways = config.native?.gateways ?? {};
  } else if (existsSync(machineFile)) {
    try {
      machineGateways = parseConfig(readFileSync(machineFile, 'utf8')).native?.gateways ?? {};
    } catch {
      // An unreadable machine config binds nothing beyond the well-known hosts.
    }
  }
  const binding = gatewayTrustFor(home, gateway, baseUrl, machineGateways);
  if (binding === undefined || binding.bound) return undefined;
  return `gateway "${gateway}": its URL is set in ${file}, and host "${binding.host}" is not bound to this gateway — ` +
    `serve withholds the key until you run \`sonata auth trust ${gateway} ${binding.host}\`. ` +
    'If you did not choose this URL, remove it from that file — do not trust it.';
}

export function cmdAuthRemove(opts: { home: string; gateway: string }): void {
  removeSonataKey(opts.home, opts.gateway);
}

/**
 * Confirm that this gateway's key may be sent to `host`. Recorded in the
 * 0600 trust file beside keys.json; idempotent.
 */
export function cmdAuthTrust(opts: { home: string; gateway: string; host: string }): { text: string } {
  const host = normalizeTrustHost(opts.host);
  addTrustBinding(opts.home, opts.gateway, host);
  return { text: `${opts.gateway}: key may now be sent to ${host}` };
}

export function cmdAuthUntrust(opts: { home: string; gateway: string; host: string }): { text: string } {
  const host = normalizeTrustHost(opts.host);
  removeTrustBinding(opts.home, opts.gateway, host);
  return { text: `${opts.gateway}: key is no longer sent to ${host}` };
}

/** The user-confirmed hosts for the config's api-key gateways, for `list`. */
export function cmdAuthTrustList(opts: { home: string; gateways: string[] }): { text: string } {
  const bindings = readTrustBindings(opts.home);
  const lines: string[] = [];
  for (const gateway of opts.gateways) {
    const hosts = bindings[gateway] ?? [];
    lines.push(`${gateway}: ${hosts.length === 0 ? 'no trusted hosts' : hosts.sort().join(', ')}`);
  }
  return { text: lines.join('\n') };
}

/** Whether this config's gateway URL may receive its key — `gatewayHostBound` over this config. */
export function gatewayTrustFor(
  home: string,
  gateway: string,
  baseUrl: string | undefined,
  machineGateways: Record<string, { baseUrl: string }> | undefined,
): { bound: true } | { bound: false; host: string } | undefined {
  if (baseUrl === undefined) return undefined;
  return gatewayHostBound(gateway, baseUrl, {
    trusted: readTrustBindings(home)[gateway] ?? [],
    machineGateways,
  });
}

export async function cmdAuthLogin(opts: {
  home: string;
  cwd: string;
  gateway: string;
  out: (line: string) => void;
  interpreter?: string;
}): Promise<void> {
  const config = loadConfig(opts.cwd, opts.home);
  const gateways = config.native?.gateways ?? {};
  const gateway = gateways[opts.gateway];
  if (!gateway) {
    throw new Error(
      `sonata auth login: no native gateway "${opts.gateway}". ` +
      `Configured: ${Object.keys(gateways).join(', ') || '(none)'}`,
    );
  }
  if (gateway.auth === 'session') {
    throw new Error(
      `sonata auth login: gateway "${opts.gateway}" is auth = "session" — ` +
      `it uses the Claude Code session's own credential; there is nothing to log in to.`,
    );
  }
  if (!isOauthGatewayAuth(gateway.auth)) {
    throw new Error(
      `sonata auth login: gateway "${opts.gateway}" is auth = "api-key" — ` +
      `store a key instead: sonata auth add ${opts.gateway}`,
    );
  }

  opts.out(`Logging in to ${opts.gateway}. A code appears below; enter it in your browser.`);
  const result = await loginGateway({
    home: opts.home,
    gateway: opts.gateway,
    auth: gateway.auth,
    progress: { line: opts.out },
    interpreter: opts.interpreter,
  });
  if (!result.ok) throw new Error(`sonata auth login: ${result.problem}`);

  opts.out(`Logged in. Credential stored in ${credentialDir(opts.home, opts.gateway)}`);
  opts.out(`Record it in sonata.toml under [native.gateways.${opts.gateway}]: credential_source = "sonata"`);
}
