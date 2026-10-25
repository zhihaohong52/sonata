/**
 * `--auto-route` and `--auto-route-model`: the Auto-route step's answers for
 * the scripted (`--yes`) front end, as the same `InitState.autoRoute` the
 * wizard records — so `plan()` writes `[auto_route]` by one rule either way.
 *
 * No network: a model id is taken as given (a scripted path must not depend
 * on a `/v1/models` call, the rule BYOK model ids follow), and the decision
 * key is checked in the store, never asked for.
 */
import type { SonataConfig } from '../config.js';
import { checkBaseUrl } from '../native/base-url.js';
import { decisionGatewayFor, decisionKeyRequired } from '../native/auto-route.js';
import { DECISION_PROVIDERS, decisionGatewayCandidates, type DecisionGatewayMap } from '../native/decision-providers.js';
import type { InitState } from '../tui-ink/types.js';

export interface AutoRouteFlags {
  /** `off`, a named provider (`typesafe`, `openrouter`), a configured gateway's name, or a URL. */
  autoRoute?: string;
  /** A decision model id to pin, or `auto` to let sonata choose (drops a saved pin). */
  autoRouteModel?: string;
}

/**
 * The `autoRoute` answer the flags give, or `undefined` when neither was
 * passed (the saved table is kept). Throws a message naming the flag on
 * anything it cannot turn into a table.
 */
export function autoRouteFromFlags(
  flags: AutoRouteFlags,
  ctx: {
    /** The `[auto_route]` the config being written already holds. */
    saved: SonataConfig['autoRoute'];
    /** The api-key gateways this config will name, by name. */
    gateways: DecisionGatewayMap;
    /** The decision key a gateway name resolves to (`resolveDecisionKey`). */
    keyFor: (gateway: string) => string | undefined;
  },
): InitState['autoRoute'] {
  const { autoRoute: target, autoRouteModel: modelFlag } = flags;
  if (target === undefined && modelFlag === undefined) return undefined;

  if (target?.trim().toLowerCase() === 'off') {
    if (modelFlag !== undefined) throw new Error('sonata init: --auto-route-model cannot be used with --auto-route off');
    return null;
  }

  const baseUrl = target === undefined ? ctx.saved?.baseUrl : baseUrlForTarget(target.trim(), ctx.gateways);
  if (baseUrl === undefined) {
    throw new Error('sonata init: --auto-route-model needs a decision provider — pass --auto-route, or set [auto_route] first');
  }

  // A named provider refuses an unauthenticated call; without a key every
  // decision would fail open, which reads as working. Refused here, the way
  // a BYOK provider with no key is.
  const gateway = decisionGatewayFor(baseUrl, ctx.gateways);
  if (decisionKeyRequired(baseUrl) && ctx.keyFor(gateway) === undefined) {
    throw new Error(`sonata init: no key for ${gateway}, which ${baseUrl} requires. Store it first: sonata auth add ${gateway}`);
  }

  if (modelFlag === undefined) return { baseUrl };
  const model = modelFlag.trim();
  if (model === '') throw new Error('sonata init: --auto-route-model must name a model, or be "auto"');
  return { baseUrl, model: model.toLowerCase() === 'auto' ? null : model };
}

/** A named provider's URL, a configured gateway's decision URL, or the URL itself. */
function baseUrlForTarget(target: string, gateways: DecisionGatewayMap): string {
  const named = DECISION_PROVIDERS.find((p) => p.gateway === target.toLowerCase());
  if (named !== undefined) return named.baseUrl;
  const configured = decisionGatewayCandidates(gateways).find((c) => c.gateway === target);
  if (configured !== undefined) return configured.baseUrl;
  if (!target.includes('://')) {
    const known = [
      'off', ...DECISION_PROVIDERS.map((p) => p.gateway), ...decisionGatewayCandidates(gateways).map((c) => c.gateway),
    ];
    throw new Error(`sonata init: --auto-route "${target}" is not a provider, a configured gateway or a URL (known: ${known.join(', ')})`);
  }
  // The config parser's own check, so a URL accepted here loads.
  const check = checkBaseUrl(target);
  if (!('href' in check)) throw new Error(`sonata init: --auto-route URL is refused: ${check.problem}`);
  return check.href.replace(/\/+$/, '');
}
