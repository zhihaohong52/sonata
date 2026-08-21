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
    const result = await fetchModels('https://api.example.com/v1', 'sk-test', {
      fetch: json({ data: [{ id: 'gpt-5.6-luna', object: 'model' }, { id: 'gpt-5.6-terra' }] }),
    });
    expect(result).toEqual({ outcome: 'ok', models: [{ id: 'gpt-5.6-luna' }, { id: 'gpt-5.6-terra' }] });
  });

  it('carries a display name when the provider sends one', async () => {
    const result = await fetchModels('https://api.example.com/v1', 'sk-test', {
      fetch: json({ data: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }] }),
    });
    expect(result).toEqual({ outcome: 'ok', models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }] });
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

  it('skips entries with no usable id', async () => {
    const result = await fetchModels('https://api.example.com/v1', 'sk-test', {
      fetch: json({ data: [{ id: 'good' }, { id: '' }, { id: 42 }, {}, null] }),
    });
    expect(result).toEqual({ outcome: 'ok', models: [{ id: 'good' }] });
  });

  it('deduplicates repeated ids', async () => {
    const result = await fetchModels('https://api.example.com/v1', 'sk-test', {
      fetch: json({ data: [{ id: 'a' }, { id: 'a' }, { id: 'b' }] }),
    });
    expect(result).toEqual({ outcome: 'ok', models: [{ id: 'a' }, { id: 'b' }] });
  });

  // A rejected key is the one failure whose fix is a different key, so it is
  // the one failure with its own outcome. The rest lead to the same place.
  it('reports a 401 as unauthorized', async () => {
    expect(await fetchModels('https://api.example.com/v1', 'bad', {
      fetch: json({ error: { message: 'invalid api key' } }, 401),
    })).toEqual({ outcome: 'unauthorized', status: 401 });
  });

  it('reports a 403 as unauthorized', async () => {
    expect(await fetchModels('https://api.example.com/v1', 'bad', {
      fetch: json({ error: { message: 'forbidden' } }, 403),
    })).toEqual({ outcome: 'unauthorized', status: 403 });
  });

  it('does NOT report a 404 as unauthorized', async () => {
    // A provider with no /models endpoint has nothing wrong with its key, and
    // re-prompting there misdiagnoses in the opposite direction from the bug
    // this distinction exists to fix.
    const html = (async () => new Response('<html>not found</html>', { status: 404 })) as unknown as typeof fetch;
    expect(await fetchModels('https://api.example.com/v1', 'sk-test', { fetch: html }))
      .toEqual({ outcome: 'unreadable' });
  });

  it('does not report a 429 as unauthorized', async () => {
    expect(await fetchModels('https://api.example.com/v1', 'sk-test', {
      fetch: json({ error: 'slow down' }, 429),
    })).toEqual({ outcome: 'unreadable' });
  });

  it('reports a network error as unreachable', async () => {
    const offline = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    expect(await fetchModels('https://api.example.com/v1', 'sk-test', { fetch: offline }))
      .toEqual({ outcome: 'unreachable' });
  });

  it('reports a 200 whose body is not JSON as unreachable', async () => {
    const notJson = (async () => new Response('<html>hi</html>', { status: 200 })) as unknown as typeof fetch;
    expect(await fetchModels('https://api.example.com/v1', 'sk-test', { fetch: notJson }))
      .toEqual({ outcome: 'unreachable' });
  });

  it('reports a payload with no data array as unreadable', async () => {
    expect(await fetchModels('https://api.example.com/v1', 'sk-test', {
      fetch: json({ models: ['a', 'b'] }),
    })).toEqual({ outcome: 'unreadable' });
  });

  it('never throws', async () => {
    const hostile = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    await expect(fetchModels('https://api.example.com/v1', 'k', { fetch: hostile })).resolves.toBeDefined();
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
