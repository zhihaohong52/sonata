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
