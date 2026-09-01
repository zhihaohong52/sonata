import type { NativeGatewayConfig, SonataConfig } from '../config.js';

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
export type LitellmProvider = 'openai' | 'anthropic' | 'gemini' | 'deepseek' | 'mistral' | 'groq';

export const LITELLM_PROVIDERS: readonly LitellmProvider[] =
  ['openai', 'anthropic', 'gemini', 'deepseek', 'mistral', 'groq'];

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
};

/** `openai` is the fallback for the unknown, never the default for a known vendor. */
export function providerForBaseUrl(gateway: string): LitellmProvider {
  return PROVIDER_FOR_GATEWAY[gateway] ?? 'openai';
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
 * Whether ANY model reachable from `[tiers]` needs LiteLLM.
 *
 * When false, `serve` starts no LiteLLM child, and the Python prerequisite
 * disappears rather than being managed — which is a better answer to "let
 * strangers in" than owning the dependency is. Scoped to tiers deliberately:
 * an unused `[models]` entry must not drag in a Python requirement for a
 * gateway nothing routes to.
 */
export function litellmRequired(config: SonataConfig): boolean {
  const gateways = config.native?.gateways ?? {};
  const keys = new Set(
    Object.values(config.tiers ?? {}).flatMap((t) => [...t.simple, ...t.complex]),
  );
  for (const key of keys) {
    const gateway = config.unifiedModels[key]?.gateway;
    if (gateway === undefined) continue;
    const gw = gateways[gateway];
    if (gw === undefined) continue;
    if (transportFor(gw, gateway) === 'litellm') return true;
  }
  return false;
}
