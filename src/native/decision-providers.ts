/**
 * Where `[auto_route]`'s tier question can be asked: the hosted decision
 * providers sonata knows by name, and the user's own configured gateways that
 * serve decision models.
 *
 * A provider is added by appending to `DECISION_PROVIDERS` — its host, the key
 * name its credential is filed under, and the model to ask when no listed
 * model is JevBench-scored. Everything that maps a decision URL to a key
 * (`decisionGatewayFor`), a binding (`decisionHostBinding`) or a default model
 * (`defaultDecisionModel`) reads this table, so a new row needs no other edit.
 *
 * A configured gateway is matched by host: a gateway's key is only ever sent
 * to the host it belongs to, and the router already enforces that host's
 * binding for the gateway's own traffic — the decision call reuses the rule.
 */
import {
  DEFAULT_DECISION_BASE_URL, OPENROUTER_DEFAULT_DECISION_MODEL, TYPESAFE_DEFAULT_DECISION_MODEL,
  type NativeGatewayConfig,
} from '../config.js';

export interface DecisionProvider {
  /** The key-store name its credential is filed under — also the choice's id. */
  gateway: string;
  label: string;
  /** The Jev base URL: `${baseUrl}/v1/systemone` and `${baseUrl}/v1/models`. */
  baseUrl: string;
  /**
   * Where its key is read: `sonata` for a decision-only name, never another
   * harness's store; `provider` for a provider gateway that also serves
   * decisions, looked up as any gateway key is.
   */
  keyStore: 'sonata' | 'provider';
  /** Asked when no listed model is scored. Absent sends no `model`. */
  defaultModel?: string;
}

export const DECISION_PROVIDERS: readonly DecisionProvider[] = [
  {
    gateway: 'typesafe',
    label: 'TypeSafe',
    baseUrl: DEFAULT_DECISION_BASE_URL,
    keyStore: 'sonata',
    // TypeSafe answers 422 without a model and lists only aliases.
    defaultModel: TYPESAFE_DEFAULT_DECISION_MODEL,
  },
  {
    gateway: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api',
    keyStore: 'provider',
    defaultModel: OPENROUTER_DEFAULT_DECISION_MODEL,
  },
];

/** The key-store name shared by every self-hosted decision server. */
export const SELF_HOSTED_DECISION_GATEWAY = 'auto-route';

/** `host` with its port, lower-cased; `undefined` for an unparseable URL. */
function hostOf(url: string): string | undefined {
  try { return new URL(url).host.toLowerCase() || undefined; } catch { return undefined; }
}

/**
 * The named provider a URL is — by `host`, port included: the well-known host
 * is that host on its default port only, so `https://api.typesafe.ai:8443` is
 * a different server and takes no TypeSafe key.
 */
export function decisionProviderFor(baseUrl: string): DecisionProvider | undefined {
  const host = hostOf(baseUrl);
  return host === undefined ? undefined : DECISION_PROVIDERS.find((p) => hostOf(p.baseUrl) === host);
}

/** A configured gateway's Jev base URL: its `base_url` without a trailing `/v1`. */
export function decisionBaseUrlForGateway(gatewayBaseUrl: string): string {
  return gatewayBaseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
}

export type DecisionGatewayMap = Readonly<Record<string, Pick<NativeGatewayConfig, 'baseUrl'> & { auth?: NativeGatewayConfig['auth'] }>>;

/**
 * The configured gateway whose key a decision URL takes: the one api-key
 * gateway on the same host. Two on one host is ambiguous, and a guessed key
 * is a key sent where nobody chose to send it — so neither is picked. A named
 * provider's host is never a configured gateway's: its own row decides.
 */
export function configuredDecisionGateway(baseUrl: string, gateways: DecisionGatewayMap | undefined): string | undefined {
  if (gateways === undefined || decisionProviderFor(baseUrl) !== undefined) return undefined;
  const host = hostOf(baseUrl);
  if (host === undefined) return undefined;
  const matches = Object.entries(gateways)
    .filter(([, gw]) => (gw.auth ?? 'api-key') === 'api-key' && hostOf(gw.baseUrl) === host)
    .map(([name]) => name);
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * The configured api-key gateways that could serve decisions, each with the
 * Jev base URL it would be asked at. Whether one actually does is for its
 * `/v1/models` listing to say (`parseModelListing` counts only decision
 * models); a named provider's host is left to its own row.
 */
export function decisionGatewayCandidates(gateways: DecisionGatewayMap | undefined): Array<{ gateway: string; baseUrl: string }> {
  if (gateways === undefined) return [];
  return Object.entries(gateways)
    .filter(([, gw]) => (gw.auth ?? 'api-key') === 'api-key')
    .map(([gateway, gw]) => ({ gateway, baseUrl: decisionBaseUrlForGateway(gw.baseUrl) }))
    .filter(({ baseUrl }) => decisionProviderFor(baseUrl) === undefined
      && configuredDecisionGateway(baseUrl, gateways) !== undefined);
}

/**
 * The decision model `[auto_route]` pins after this run: the model screen's
 * answer when it was shown (`null` is "chosen automatically"), else the saved
 * pin — kept only for an unchanged URL, since a pinned model belongs to the
 * URL that serves it. One rule for the write, the confirm line and the summary.
 */
export function autoRoutePin(
  answer: { baseUrl: string; model?: string | null },
  savedBaseUrl: string | undefined,
  savedModel: string | undefined,
): string | undefined {
  if (answer.model !== undefined) return answer.model ?? undefined;
  return savedModel !== undefined && savedBaseUrl === answer.baseUrl ? savedModel : undefined;
}
