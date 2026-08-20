import { describe, it, expect } from 'vitest';

import {
  byokCandidateKey, fetchModels, wellKnownProviders,
} from '../../src/native/models.js';

function json(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch;
}

describe('fetchModels', () => {
  it('parses an OpenAI /models response', async () => {
    const models = await fetchModels('https://api.example.com/v1', 'sk-test', {
      fetch: json({ data: [{ id: 'gpt-5.6-luna', object: 'model' }, { id: 'gpt-5.6-terra' }] }),
    });
    expect(models).toEqual([{ id: 'gpt-5.6-luna' }, { id: 'gpt-5.6-terra' }]);
  });

  it('carries a display name when the provider sends one', async () => {
    const models = await fetchModels('https://api.example.com/v1', 'sk-test', {
      fetch: json({ data: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }] }),
    });
    expect(models).toEqual([{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }]);
  });

  it('sends the key as a bearer to <base>/models', async () => {
    let seenUrl: string | undefined;
    let seenAuth: string | null | undefined;
    const spy = (async (url: string, init: RequestInit) => {
      seenUrl = url;
      seenAuth = new Headers(init.headers).get('authorization');
      return new Response(JSON.stringify({ data: [] }));
    }) as unknown as typeof fetch;

    await fetchModels('https://api.example.com/v1', 'sk-test', { fetch: spy });
    expect(seenUrl).toBe('https://api.example.com/v1/models');
    expect(seenAuth).toBe('Bearer sk-test');
  });

  it('does not double the slash when the base url has a trailing one', async () => {
    let seenUrl: string | undefined;
    const spy = (async (url: string) => {
      seenUrl = url;
      return new Response(JSON.stringify({ data: [] }));
    }) as unknown as typeof fetch;

    await fetchModels('https://api.example.com/v1/', 'sk-test', { fetch: spy });
    expect(seenUrl).toBe('https://api.example.com/v1/models');
  });

  // Every failure below is the same outcome for the caller: an empty list, and
  // the wizard falls back to typing ids by hand. None of them may throw — a
  // provider being unreachable is an ordinary case, not an error.
  it('returns [] on network error', async () => {
    const offline = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    expect(await fetchModels('https://api.example.com/v1', 'sk-test', { fetch: offline })).toEqual([]);
  });

  it('returns [] on a non-JSON response', async () => {
    const html = (async () => new Response('<html>not found</html>', { status: 404 })) as unknown as typeof fetch;
    expect(await fetchModels('https://api.example.com/v1', 'sk-test', { fetch: html })).toEqual([]);
  });

  it('returns [] on a 401, rather than reporting models that need another key', async () => {
    expect(await fetchModels('https://api.example.com/v1', 'bad', {
      fetch: json({ error: { message: 'invalid api key' } }, 401),
    })).toEqual([]);
  });

  it('returns [] when the payload has no data array', async () => {
    expect(await fetchModels('https://api.example.com/v1', 'sk-test', {
      fetch: json({ models: ['a', 'b'] }),
    })).toEqual([]);
  });

  it('skips entries with no usable id', async () => {
    const models = await fetchModels('https://api.example.com/v1', 'sk-test', {
      fetch: json({ data: [{ id: 'good' }, { id: '' }, { id: 42 }, {}, null] }),
    });
    expect(models).toEqual([{ id: 'good' }]);
  });

  it('deduplicates repeated ids', async () => {
    const models = await fetchModels('https://api.example.com/v1', 'sk-test', {
      fetch: json({ data: [{ id: 'a' }, { id: 'a' }, { id: 'b' }] }),
    });
    expect(models).toEqual([{ id: 'a' }, { id: 'b' }]);
  });
});

describe('wellKnownProviders', () => {
  const providers = wellKnownProviders();

  it('returns a non-empty list of named urls', () => {
    expect(providers.length).toBeGreaterThanOrEqual(30);
    expect(providers.every((provider) => provider.name !== '' && provider.url !== '')).toBe(true);
  });

  it('keeps the first name for a shared url', () => {
    // `openai`, `openai-codex` and `codex` all point at the same endpoint;
    // keep-last would surface this as `codex`.
    expect(providers.find((provider) => provider.url === 'https://api.openai.com/v1')?.name).toBe('openai');
    expect(providers.filter((provider) => provider.url === 'https://api.openai.com/v1')).toHaveLength(1);
  });

  it('keeps deep-infra and deepinfra apart — they are not aliases', () => {
    // They differ by a `/openai` suffix. Collapsing them by name similarity
    // would send one provider's traffic to the other's endpoint.
    expect(providers.find((provider) => provider.name === 'deep-infra')?.url)
      .toBe('https://api.deepinfra.com/v1');
    expect(providers.find((provider) => provider.name === 'deepinfra')?.url)
      .toBe('https://api.deepinfra.com/v1/openai');
  });

  it('does not offer anthropic', () => {
    // Every model it serves is `claude-*`, which the router reserves and
    // parseConfig refuses, so its catalogue filters to empty. A provider that
    // can offer nothing is worse than one that is absent.
    expect(providers.some((provider) => provider.name === 'anthropic')).toBe(false);
  });

  it('is sorted by name, so the picker order is stable', () => {
    const names = providers.map((provider) => provider.name);
    expect(names).toEqual([...names].sort());
  });
});

describe('byokCandidateKey', () => {
  it('joins the gateway and id', () => {
    expect(byokCandidateKey('deepseek', 'deepseek-v4-flash')).toBe('deepseek-deepseek-v4-flash');
  });

  it('flattens slashes, matching the harness-discovered key format', () => {
    expect(byokCandidateKey('openrouter', 'qwen/qwen4-max')).toBe('openrouter-qwen-qwen4-max');
  });
});
