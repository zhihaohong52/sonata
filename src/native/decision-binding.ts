import { gatewayHostBound, readTrustBindings, trustCommand, type HostBinding } from './host-bindings.js';
import { decisionGatewayFor } from './auto-route.js';

/**
 * Whether a decision URL's host may receive the decision key. TypeSafe and
 * OpenRouter are their own well-known hosts: `decisionGatewayFor` matches them
 * exactly, and only over https. Any other URL is a self-hosted decision server,
 * bound by `sonata auth trust auto-route <host>` or by a URL typed in init; a
 * plain-http one only when its host is loopback.
 *
 * This is the binding that gates a stored key. Whether one is sent at all is
 * `decisionKeyBinding`'s question.
 */
export function decisionHostBinding(baseUrl: string, home: string, machineUrl?: string): HostBinding {
  const gateway = decisionGatewayFor(baseUrl);
  if (gateway === 'typesafe' || gateway === 'openrouter') {
    try {
      if (new URL(baseUrl).protocol === 'https:') return { bound: true };
      return { bound: false, host: new URL(baseUrl).hostname.toLowerCase(), insecure: true };
    } catch {
      return { bound: false, host: baseUrl };
    }
  }
  // The machine config's own [auto_route] URL is trusted by definition, as its
  // gateways are: the same rule (c) that binds a machine gateway's host.
  const machineGateways = machineUrl === undefined ? undefined : { 'auto-route': { baseUrl: machineUrl } };
  return gatewayHostBound('auto-route', baseUrl, {
    trusted: readTrustBindings(home)['auto-route'] ?? [],
    machineGateways,
  });
}

/**
 * Why an `[auto_route]` decision is skipped for an unbound host: named with
 * the config that set the URL, and the advice not to trust a URL the user did
 * not set.
 */
export function decisionUnboundMessage(
  baseUrl: string,
  host: string,
  configFile: string,
  opts: { insecure?: boolean; command?: boolean } = {},
): string {
  if (opts.insecure === true) {
    return `[auto_route] base_url ${baseUrl} (set in ${configFile}): if you did not choose this URL, remove it from ` +
      `${configFile}. If you did, it needs https: a decision key is sent only over https to a host that receives one ` +
      '(plain http is accepted only for a loopback host). Until then the decision is skipped, the key and the task text are not ' +
      'sent, and the fallback tier is used.';
  }
  const advice = opts.command === false
    ? 'If you did, the user can review it with `sonata doctor` in a terminal.'
    : `If you did, run \`${trustCommand('auto-route', host)}\` in a terminal to allow the decision key there.`;
  return `[auto_route] base_url ${baseUrl} (set in ${configFile}): if you did not choose this URL, remove it from ` +
    `${configFile} — do not trust it. ${advice} Until then host "${host}" is not bound: the decision is skipped, the key and the task text are not ` +
    'sent, and the fallback tier is used.';
}

/**
 * The binding a decision request needs before it may go to `baseUrl`, given
 * the stored key that would be sent with it — or `undefined` when no key would
 * be sent, since then there is no credential to protect and the request goes
 * as a keyless local server expects. A project config can already route a
 * whole conversation to any keyless host it names, so the task text alone is
 * not what this protects: the stored key is.
 */
export function decisionKeyBinding(
  baseUrl: string,
  key: string | undefined,
  home: string,
  machineUrl?: string,
): HostBinding | undefined {
  if (key === undefined) return undefined;
  return decisionHostBinding(baseUrl, home, machineUrl);
}
