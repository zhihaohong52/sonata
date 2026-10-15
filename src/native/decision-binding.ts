import { gatewayHostBound, readTrustBindings, type HostBinding } from './host-bindings.js';
import { decisionGatewayFor } from './auto-route.js';

/**
 * Whether a decision URL's host may receive the decision key and the task
 * text. TypeSafe and OpenRouter are their own well-known hosts: `decisionGatewayFor`
 * matches them exactly, and only over https. Any other URL is a self-hosted
 * decision server, bound by `sonata auth trust auto-route <host>` or by a URL
 * typed in init.
 */
export function decisionHostBinding(baseUrl: string, home: string): HostBinding {
  const gateway = decisionGatewayFor(baseUrl);
  if (gateway === 'typesafe' || gateway === 'openrouter') {
    try {
      if (new URL(baseUrl).protocol === 'https:') return { bound: true };
      return { bound: false, host: new URL(baseUrl).hostname.toLowerCase() };
    } catch {
      return { bound: false, host: baseUrl };
    }
  }
  return gatewayHostBound('auto-route', baseUrl, { trusted: readTrustBindings(home)['auto-route'] ?? [] });
}

/**
 * Why an `[auto_route]` decision is skipped for an unbound host: named with
 * the config that set the URL, and the advice not to trust a URL the user did
 * not set.
 */
export function decisionUnboundMessage(baseUrl: string, host: string, configFile: string): string {
  return `[auto_route] base_url ${baseUrl} (set in ${configFile}): its host "${host}" is not bound to the decision key, ` +
    'so the decision is skipped and the task text is not sent — the fallback tier is used. ' +
    `If you did not choose this URL, remove it from that file — do not trust it. If you did, run \`sonata auth trust auto-route ${host}\` to allow it`;
}
