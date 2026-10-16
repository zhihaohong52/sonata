import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { keyReport, removeSonataKey, writeSonataKey } from '../native/credentials.js';
import {
  addTrustBinding,
  gatewayHostBound,
  type HostBinding,
  isLoopbackHostname,
  normalizeTrustHost,
  readTrustBindings,
  removeTrustBinding,
  unboundMessage,
} from '../native/host-bindings.js';
import { configPath, GLOBAL_CONFIG_RELATIVE, isOauthGatewayAuth, loadConfig, parseConfig } from '../config.js';
import { seedTrustBeforeKeyWrite } from '../native/trust-seed.js';
import { canonicalConfigPath } from '../native/tenants.js';
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
export function cmdAuthAdd(opts: { home: string; gateway: string; key: string; cwd?: string }): void {
  // The upgrade's seed first: see `seedTrustBeforeKeyWrite`.
  seedTrustBeforeKeyWrite(opts.home);
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
  if (canonicalConfigPath(file) === canonicalConfigPath(machineFile)) {
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
  return unboundMessage(gateway, binding.host, file, binding.insecure);
}

export function cmdAuthRemove(opts: { home: string; gateway: string }): void {
  removeSonataKey(opts.home, opts.gateway);
}

/**
 * Confirm that this gateway's key may be sent to `host`. Recorded in the
 * 0600 trust file beside keys.json; idempotent.
 *
 * Trust is the user's decision, never the model's: the gateway and host usually
 * come from a config the user has not read, so this runs only in an interactive
 * terminal and only after the user types `y`. `baseUrl` is the URL the config in
 * effect gives this gateway; a plain-http non-loopback URL on this host can never
 * be bound, so trusting it is refused rather than pretended.
 */
export async function cmdAuthTrust(opts: {
  home: string;
  gateway: string;
  host: string;
  baseUrl?: string;
  /** Whether stdin and stdout are a terminal. */
  interactive: boolean;
  /** Asks the user; resolves to their answer. Only called when `interactive`. */
  ask: (question: string) => Promise<string>;
}): Promise<{ text: string }> {
  const host = normalizeTrustHost(opts.host);
  if (!opts.interactive) {
    throw new Error(
      'sonata auth trust needs an interactive terminal to confirm the host: run it yourself in a terminal, ' +
      'not through a script or an agent.',
    );
  }
  const hostname = new URL(`https://${host}`).hostname;
  if (opts.baseUrl !== undefined) {
    try {
      const url = new URL(opts.baseUrl);
      if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname) && url.host.toLowerCase() === host) {
        throw new Error(
          `sonata auth trust: gateway "${opts.gateway}" is configured with the plain-http URL ${opts.baseUrl}. ` +
          'A key is sent only over https (plain http is accepted only for a loopback host), so trusting this host would not change anything. ' +
          `Change the base_url to https://${host}/... first.`,
        );
      }
    } catch (error) {
      if ((error as Error).message.startsWith('sonata auth trust:')) throw error;
    }
  }
  const answer = (await opts.ask(
    `Trust host "${host}" for gateway "${opts.gateway}"?\n` +
    `  The key stored for "${opts.gateway}" will be sent to https://${host} whenever a config names that host.\n` +
    '  Only continue if you chose this host yourself, not because a project config or an agent named it.\n' +
    'Type y to confirm [y/N]: ',
  )).trim().toLowerCase();
  if (answer !== 'y' && answer !== 'yes') throw new Error('sonata auth trust: not confirmed — nothing was changed.');
  // The upgrade's seed first: a trust written before it would make the seed read
  // the file as already decided and skip every other pre-existing gateway.
  seedTrustBeforeKeyWrite(opts.home);
  addTrustBinding(opts.home, opts.gateway, host);
  const httpsNote = isLoopbackHostname(hostname) ? '' : ' (https only: a plain-http URL on this host still gets no key)';
  return { text: `${opts.gateway}: key may now be sent to ${host}${httpsNote}` };
}

export function cmdAuthUntrust(opts: { home: string; gateway: string; host: string }): { text: string } {
  const host = normalizeTrustHost(opts.host);
  seedTrustBeforeKeyWrite(opts.home);
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
): HostBinding | undefined {
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
