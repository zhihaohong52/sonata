import type { NativeGatewayAuth, NativeGatewayConfig, SonataConfig } from '../config.js';

/**
 * Which LiteLLM provider a gateway speaks, and what that implies about how
 * sonata reaches it.
 *
 * LiteLLM picks its wire format from the prefix on `litellm_params.model` (its
 * `custom_llm_provider`), so this is the single decision that determines
 * whether a request arrives at a vendor's native API or at a compatibility
 * shim. A shim is where vendor-specific state has nowhere to live — Gemini's
 * `thought_signature` is the worked example, and losing it is what let a
 * permanently-400ing model absorb its whole tier (roadmap item 13).
 */
export type LitellmProvider = 'openai' | 'anthropic' | 'gemini' | 'deepseek' | 'mistral' | 'groq' | 'openrouter';

export const LITELLM_PROVIDERS: readonly LitellmProvider[] =
  ['openai', 'anthropic', 'gemini', 'deepseek', 'mistral', 'groq', 'openrouter'];

/**
 * Gateways whose dialect is known.
 *
 * Only entries whose endpoint has been exercised belong here. This table
 * doubles as a lookup, so a wrong prefix is worse than a missing one: it
 * produces a confident request in the wrong dialect, which fails later and
 * further away than an unclassified gateway would.
 */
export const PROVIDER_FOR_GATEWAY: Record<string, LitellmProvider> = {
  google: 'gemini',
  deepseek: 'deepseek',
  mistral: 'mistral',
  groq: 'groq',
  anthropic: 'anthropic',
  // A known vendor with a first-class LiteLLM provider, so it must not reach
  // the `openai` fallback below. Falling through cost real accounting:
  // measured 2026-09-18, `openrouter-z-ai-glm-5.3-flash` recorded 0 prompt
  // tokens on 77 of 77 *completed* streams, while OpenRouter's own API returns
  // `prompt_tokens` for that model in a plain stream with no flag set — so the
  // count is lost in the generic OpenAI-compat translation and the request is
  // priced on output alone. At this traffic's ~240:1 prompt:output ratio that
  // understates spend by about two orders of magnitude, and `[budget]` counts
  // priced spend, so the cap cannot see it either.
  openrouter: 'openrouter',
};

/** `openai` is the fallback for the unknown, never the default for a known vendor. */
export function providerForBaseUrl(gateway: string): LitellmProvider {
  return PROVIDER_FOR_GATEWAY[gateway] ?? 'openai';
}

/**
 * The header opencode.ai routes a conversation by.
 *
 * OpenCode Go answers a request without one with 400 `MissingSessionID`
 * ("Request is missing x-opencode-session and cannot be routed efficiently").
 * Measured 2026-09-26 against `opencode.ai/zen/go/v1`: the identical body
 * answered 200 once the header was set. Claude Code's own session header is
 * accepted in its place, but LiteLLM drops every client header it is not told
 * to forward, so on the native path the upstream saw neither.
 */
export const OPENCODE_SESSION_HEADER = 'x-opencode-session';

/**
 * Whether a gateway's upstream needs `OPENCODE_SESSION_HEADER` forwarded.
 *
 * Keyed by host, not by gateway name: a user may call an opencode.ai gateway
 * anything, and the requirement belongs to the endpoint.
 */
export function requiresSessionHeader(baseUrl: string | undefined): boolean {
  if (baseUrl === undefined) return false;
  try {
    return new URL(baseUrl).hostname === 'opencode.ai';
  } catch {
    return false;
  }
}


/**
 * How sonata reaches a gateway.
 *
 * `direct` means sonata's own router forwards to the gateway with no LiteLLM
 * in the path at all: it already receives Anthropic on `/v1/messages`, already
 * knows the base URL, and already holds the key, so when the upstream also
 * speaks Anthropic there is nothing left to translate.
 */
export type Transport = 'direct' | 'litellm' | 'anthropic';

/**
 * Derived from provider + auth, never configured separately.
 *
 * A separate `transport` key could disagree with `provider`, and two keys that
 * can disagree is the shape of the item-14 scope bug — a writer and a cleaner
 * defaulted differently and subagent ids leaked forever. One source of truth
 * cannot contradict itself.
 */
export function transportFor(gw: NativeGatewayConfig, gateway: string): Transport {
  // An OAuth gateway's dialect is fixed by its auth: chatgpt needs
  // `mode: responses`, copilot needs a token exchange first. Neither is a
  // plain Anthropic endpoint sonata could talk to unaided.
  if (gw.auth !== 'api-key') return 'litellm';
  const provider = gw.provider ?? gw.wireFormat ?? providerForBaseUrl(gateway);
  return provider === 'anthropic' ? 'direct' : 'litellm';
}

/**
 * Whether ANY model this config can actually route needs LiteLLM.
 *
 * When false, `serve` starts no LiteLLM child, and the Python prerequisite
 * disappears rather than being managed — which is a better answer to "let
 * strangers in" than owning the dependency is.
 *
 * Reachability is every `[models]` entry and every legacy `[native.models]`
 * one, NOT just tier membership. An earlier version scoped this to `[tiers]`,
 * reasoning that an unused `[models]` entry should not drag in a Python
 * requirement — but such an entry is not unused: a request naming a bare model
 * key never calls `resolveTier` at all and is forwarded to LiteLLM like any
 * other, and a config still on `[native.models]` has no tiers to be reachable
 * from in the first place. Both cases would have started no child and answered
 * every request with a 502 from an upstream that was never launched. A gateway
 * declared with no models against it still costs nothing.
 */
export function litellmRequired(config: SonataConfig): boolean {
  const gateways = config.native?.gateways ?? {};
  const names = new Set<string>();
  for (const model of Object.values(config.unifiedModels)) {
    if (model.gateway !== undefined) names.add(model.gateway);
  }
  for (const model of Object.values(config.native?.models ?? {})) names.add(model.gateway);
  for (const name of names) {
    const gw = gateways[name];
    if (gw !== undefined && transportFor(gw, name) === 'litellm') return true;
  }
  return false;
}


/** Gateways sharing one endpoint, and the endpoint they share. */
export interface SharedBaseUrl { url: string; gateways: string[] }

/** A base URL compared as an endpoint: trailing slashes, scheme and host case ignored. */
function endpointOf(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  try {
    const url = new URL(trimmed);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}${url.search}`;
  } catch {
    return trimmed;
  }
}

/**
 * Key-authenticated gateways that share one endpoint.
 *
 * Two names on one endpoint are almost always one account imported twice, and
 * nothing said so. Measured on a real machine: opencode.json defined a
 * provider NAMED `opencode` on the Go URL, detection mapped it onto the
 * `opencode` gateway, and `opencode` and `opencode-go` then served the same
 * models under two names — duplicate candidates in every tier, duplicate
 * agents, split cooldowns. OAuth gateways are skipped: their URL is implied by
 * their auth, and one credential offered twice is already deduplicated.
 *
 * Advisory only — two gateways on one endpoint with different keys is a
 * legitimate setup, so this is reported, never refused.
 */
export function sharedBaseUrls(
  gateways: Iterable<readonly [string, { baseUrl?: string; auth?: NativeGatewayAuth }]>,
): SharedBaseUrl[] {
  const byEndpoint = new Map<string, string[]>();
  for (const [name, gateway] of gateways) {
    if (gateway.baseUrl === undefined || gateway.baseUrl.trim() === '') continue;
    // Anything but a key is OAuth. Not `isOauthGatewayAuth`: config.ts imports
    // this module's values, so a value import back would be a cycle.
    if (gateway.auth !== undefined && gateway.auth !== 'api-key') continue;
    const endpoint = endpointOf(gateway.baseUrl);
    const names = byEndpoint.get(endpoint) ?? [];
    if (!names.includes(name)) names.push(name);
    byEndpoint.set(endpoint, names);
  }
  return [...byEndpoint]
    .filter(([, names]) => names.length > 1)
    .map(([url, names]) => ({ url, gateways: [...names].sort() }));
}

/** One sentence naming the gateways, the endpoint, and the likely cause. */
export function sharedBaseUrlWarning(group: SharedBaseUrl): string {
  return `gateways ${group.gateways.join(', ')} share base_url ${group.url} — probably one account under two names, `
    + 'so every model on it is a duplicate candidate and agent; remove one, or point each at its own endpoint';
}
