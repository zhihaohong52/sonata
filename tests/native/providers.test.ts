import { describe, it, expect } from 'vitest';
import { providerForBaseUrl, PROVIDER_FOR_GATEWAY } from '../../src/native/providers.js';

describe('providerForBaseUrl', () => {
  it('gives a known vendor its native provider', () => {
    expect(providerForBaseUrl('google')).toBe('gemini');
    expect(providerForBaseUrl('deepseek')).toBe('deepseek');
  });

  it('falls back to openai for an endpoint nobody has classified', () => {
    // `openai` is the default for the UNKNOWN, not for known vendors: an
    // OpenAI-compatible shim is the safest guess when we know nothing, and the
    // worst guess when we do.
    expect(providerForBaseUrl('my-corp-proxy')).toBe('openai');
  });

  it('only names providers LiteLLM actually has', () => {
    const known = new Set(['openai', 'anthropic', 'gemini', 'deepseek', 'mistral', 'groq']);
    for (const p of Object.values(PROVIDER_FOR_GATEWAY)) expect(known).toContain(p);
  });
});
