import { keyReport, removeSonataKey, writeSonataKey } from '../native/credentials.js';
import {
  addTrustBinding,
  gatewayHostBound,
  normalizeTrustHost,
  readTrustBindings,
  removeTrustBinding,
} from '../native/host-bindings.js';
import { loadConfig, isOauthGatewayAuth } from '../config.js';
import { credentialDir, loginGateway } from '../native/oauth-login.js';

export function cmdAuthList(opts: { home: string; gateways: string[] }): { text: string } {
  const text = keyReport(opts.gateways, opts.home)
    .map(({ gateway, source }) => `${gateway}: ${source === null ? 'no key' : `key from ${source}`}`)
    .join('\n');
  return { text };
}

export function cmdAuthAdd(opts: { home: string; gateway: string; key: string; baseUrl?: string }): void {
  writeSonataKey(opts.home, opts.gateway, opts.key);
  if (opts.baseUrl !== undefined) {
    try {
      const parsed = new URL(opts.baseUrl);
      if (parsed.protocol === 'https:' && parsed.hostname !== '') {
        addTrustBinding(opts.home, opts.gateway, parsed.hostname.toLowerCase());
      }
    } catch {
      // A base_url that is not a URL binds nothing; doctor names it.
    }
  }
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
