import { describe, expect, it, beforeEach } from 'vitest';
import { routeRequest, flattenSystemBlocks, requestedModel, withModel, clearCooldowns, TIER_CAPABILITY_400_THRESHOLD } from '../../src/native/router.js';

function fakeFetch(record: any[]) {
  return async (url: string, init: any) => {
    record.push({ url, headers: init.headers });
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

const base = { litellmBase: 'http://lite', litellmKey: 'sk-local', anthropicBase: 'https://api.anthropic.com' };

describe('routeRequest', () => {
  it('routes a claude- model to anthropic with client headers forwarded', async () => {
    const rec: any[] = [];
    await routeRequest(
      { method: 'POST', url: '/v1/messages', headers: { authorization: 'Bearer usr', 'x-api-key': 'k' },
        body: Buffer.from(JSON.stringify({ model: 'claude-sonnet-5' })) },
      { ...base, fetch: fakeFetch(rec) },
    );
    expect(rec[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(rec[0].headers.authorization).toBe('Bearer usr');
  });

  it('routes a foreign model to litellm with the local key', async () => {
    const rec: any[] = [];
    await routeRequest(
      { method: 'POST', url: '/v1/messages', headers: { authorization: 'Bearer usr', 'x-api-key': 'k' },
        body: Buffer.from(JSON.stringify({ model: 'deepseek-v4-flash' })) },
      { ...base, fetch: fakeFetch(rec) },
    );
    expect(rec[0].url).toBe('http://lite/v1/messages');
    expect(rec[0].headers.authorization).toBe('Bearer sk-local');
    expect(rec[0].headers['x-api-key']).toBeUndefined();
  });

  it('passes a bodyless request through to anthropic', async () => {
    const rec: any[] = [];
    await routeRequest(
      { method: 'GET', url: '/v1/models', headers: {}, body: Buffer.alloc(0) },
      { ...base, fetch: fakeFetch(rec) },
    );
    expect(rec[0].url).toBe('https://api.anthropic.com/v1/models');
  });

  it('returns 502 with a typed body when the upstream throws', async () => {
    const res = await routeRequest(
      { method: 'POST', url: '/v1/messages', headers: {}, body: Buffer.from('{"model":"deepseek-v4-flash"}') },
      { ...base, fetch: async () => { throw new Error('down'); } },
    );
    expect(res.status).toBe(502);
    expect(JSON.parse((res.body as Buffer).toString()).error.type).toBe('router_error');
  });

  it('waits for litellmReady before forwarding to litellm', async () => {
    // A respawned litellm child is not listening yet for a brief window;
    // without this gate a request landing there gets connection-refused
    // instead of the answer it would have gotten moments later.
    const rec: any[] = [];
    let released: () => void = () => {};
    const ready = new Promise<void>((resolve) => { released = resolve; });
    let readyAwaited = false;

    const pending = routeRequest(
      { method: 'POST', url: '/v1/messages', headers: {}, body: Buffer.from('{"model":"deepseek-v4-flash"}') },
      { ...base, fetch: fakeFetch(rec), litellmReady: async () => { readyAwaited = true; await ready; } },
    );

    await Promise.resolve();
    expect(rec.length).toBe(0);
    released();
    await pending;
    expect(readyAwaited).toBe(true);
    expect(rec.length).toBe(1);
  });
});

describe('tier alias routing', () => {
  const ROUTES = {
    role: 'code', tier: 'simple',
    routes: [
      { key: 'flash', native: { gateway: 'g', id: 'flash-1' } },
      { key: 'luna', native: { gateway: 'g', id: 'luna-1' } },
      { key: 'harness-only', harness: { harness: 'opencode', id: 'x/y' } },
    ],
  };
  const req = (model: string) => ({
    method: 'POST', url: '/v1/messages',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ model, messages: [] })),
  });

  beforeEach(() => clearCooldowns());

  it('rewrites the model to the first native candidate and forwards to litellm', async () => {
    const seen: string[] = [];
    const res = await routeRequest(req('sonata-code-simple'), {
      fetch: (async (_url: string, init: RequestInit) => {
        seen.push((JSON.parse(init.body as string) as { model: string }).model);
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch,
      litellmBase: 'http://litellm', litellmKey: 'k',
      resolveTier: () => ROUTES,
    });
    expect(res.status).toBe(200);
    expect(seen).toEqual(['flash']);
  });

  it('falls back to the next candidate on 5xx and cools the failure down', async () => {
    const seen: string[] = [];
    const deps = {
      fetch: (async (_url: string, init: RequestInit) => {
        const model = (JSON.parse(init.body as string) as { model: string }).model;
        seen.push(model);
        return new Response('{}', { status: model === 'flash' ? 503 : 200 });
      }) as unknown as typeof fetch,
      litellmBase: 'http://litellm', litellmKey: 'k',
      resolveTier: () => ROUTES,
    };
    expect((await routeRequest(req('sonata-code-simple'), deps)).status).toBe(200);
    expect(seen).toEqual(['flash', 'luna']);
    // second request inside the cooldown skips flash entirely
    await routeRequest(req('sonata-code-simple'), deps);
    expect(seen).toEqual(['flash', 'luna', 'luna']);
  });

  // ── Defect A: a repeating capability 400 must cool the candidate down ──
  //
  // `google-gemini-3.7-flash` rejects every multi-turn tool-use request with
  // "Function call is missing a thought_signature in functionCall parts".
  // 400 was not a cooldown trigger, so such a model became an ABSORBING state:
  // permanently first among non-cooling candidates, killing every agent that
  // reached it. Measured live 2026-08-30 — four consecutive requests went to
  // the same broken model and retrying could never have recovered.
  const THOUGHT_SIG_400 = JSON.stringify({
    error: { message: 'Function call is missing a thought_signature in functionCall parts' },
  });

  const bodyText = async (body: AsyncIterable<Uint8Array> | Buffer): Promise<string> => {
    if (Buffer.isBuffer(body)) return body.toString();
    const chunks: Buffer[] = [];
    for await (const c of body) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks).toString();
  };

  it('returns a one-off capability 400 to the caller, body intact', async () => {
    // Below the threshold the 400 is the caller's answer, and they must be able
    // to READ it — the fingerprinting path buffers the body to inspect it, so a
    // naive implementation hands back an already-drained stream and the user
    // sees an empty error.
    const seen: string[] = [];
    const res = await routeRequest(req('sonata-code-simple'), {
      fetch: (async (_url: string, init: RequestInit) => {
        seen.push((JSON.parse(init.body as string) as { model: string }).model);
        return new Response(THOUGHT_SIG_400, { status: 400 });
      }) as unknown as typeof fetch,
      litellmBase: 'http://litellm', litellmKey: 'k',
      resolveTier: () => ROUTES,
    });
    expect(res.status).toBe(400);
    expect(await bodyText(res.body)).toBe(THOUGHT_SIG_400);
    expect(seen).toEqual(['flash']);
  });

  it('returns a 400 the fingerprint does not match, and never counts it', async () => {
    // The counter must separate "this request was malformed" from "this
    // candidate cannot serve requests of this shape". A bare count of 400s
    // would cool a healthy candidate whenever a caller sends a bad request.
    const other = JSON.stringify({ error: { message: 'messages: text content blocks must be non-empty' } });
    const seen: string[] = [];
    const deps = {
      fetch: (async (_url: string, init: RequestInit) => {
        seen.push((JSON.parse(init.body as string) as { model: string }).model);
        return new Response(other, { status: 400 });
      }) as unknown as typeof fetch,
      litellmBase: 'http://litellm', litellmKey: 'k',
      resolveTier: () => ROUTES,
    };
    for (let i = 0; i < TIER_CAPABILITY_400_THRESHOLD + 2; i++) {
      const res = await routeRequest(req('sonata-code-simple'), deps);
      expect(res.status).toBe(400);
      expect(await bodyText(res.body)).toBe(other);
    }
    // every request still went to flash — no cooldown was ever recorded
    expect(new Set(seen)).toEqual(new Set(['flash']));
  });

  it('cools the candidate and falls through once the same capability 400 repeats', async () => {
    const seen: string[] = [];
    const deps = {
      fetch: (async (_url: string, init: RequestInit) => {
        const model = (JSON.parse(init.body as string) as { model: string }).model;
        seen.push(model);
        return model === 'flash'
          ? new Response(THOUGHT_SIG_400, { status: 400 })
          : new Response('{}', { status: 200 });
      }) as unknown as typeof fetch,
      litellmBase: 'http://litellm', litellmKey: 'k',
      resolveTier: () => ROUTES,
    };
    // Below the threshold the 400 is returned as the answer.
    for (let i = 0; i < TIER_CAPABILITY_400_THRESHOLD - 1; i++) {
      expect((await routeRequest(req('sonata-code-simple'), deps)).status).toBe(400);
    }
    // At the threshold the candidate is cooled and the next one serves.
    expect((await routeRequest(req('sonata-code-simple'), deps)).status).toBe(200);
    expect(seen[seen.length - 1]).toBe('luna');
    // And it stays cooled: a later request skips flash entirely.
    seen.length = 0;
    expect((await routeRequest(req('sonata-code-simple'), deps)).status).toBe(200);
    expect(seen).toEqual(['luna']);
  });

  it('resets the count when the candidate serves a request successfully', async () => {
    // A model that intermittently 400s must not accumulate toward a cooldown
    // across unrelated successes — otherwise a healthy candidate is eventually
    // cooled by noise spread over hours.
    let fail = true;
    const deps = {
      fetch: (async (_url: string, init: RequestInit) => {
        const model = (JSON.parse(init.body as string) as { model: string }).model;
        if (model !== 'flash') return new Response('{}', { status: 200 });
        return fail
          ? new Response(THOUGHT_SIG_400, { status: 400 })
          : new Response('{}', { status: 200 });
      }) as unknown as typeof fetch,
      litellmBase: 'http://litellm', litellmKey: 'k',
      resolveTier: () => ROUTES,
    };
    for (let i = 0; i < TIER_CAPABILITY_400_THRESHOLD - 1; i++) {
      expect((await routeRequest(req('sonata-code-simple'), deps)).status).toBe(400);
    }
    fail = false;
    expect((await routeRequest(req('sonata-code-simple'), deps)).status).toBe(200);
    fail = true;
    // The count restarted, so this is again below the threshold: a 400, not a
    // fallthrough to luna.
    expect((await routeRequest(req('sonata-code-simple'), deps)).status).toBe(400);
  });

  it('falls back when fetch throws (connect error)', async () => {
    const seen: string[] = [];
    const res = await routeRequest(req('sonata-code-simple'), {
      fetch: (async (_url: string, init: RequestInit) => {
        const model = (JSON.parse(init.body as string) as { model: string }).model;
        seen.push(model);
        if (model === 'flash') throw new Error('ECONNREFUSED');
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch,
      litellmBase: 'http://litellm', litellmKey: 'k',
      resolveTier: () => ROUTES,
    });
    expect(res.status).toBe(200);
    expect(seen).toEqual(['flash', 'luna']);
  });

  it('returns 529 naming the CLI fallback when every native route fails', async () => {
    const res = await routeRequest(req('sonata-code-simple'), {
      fetch: (async () => new Response('{}', { status: 503 })) as unknown as typeof fetch,
      litellmBase: 'http://litellm', litellmKey: 'k',
      resolveTier: () => ROUTES,
    });
    expect(res.status).toBe(529);
    const body = JSON.parse((res.body as Buffer).toString());
    // Anthropic-compatible clients (Claude Code included) only surface the
    // error.error.message inside this exact envelope — a flat body silently
    // discards the fallback command this is meant to hand back.
    expect(body).toMatchObject({ type: 'error', error: { type: 'overloaded_error' } });
    expect(body.error.message).toContain('sonata dispatch --tier code-simple');
    // `sonata dispatch` rejects an invocation with neither positional task
    // text nor --task-file — the bare command above is not executable as
    // shown, so the message must not read as a copy-pasteable fix on its own.
    expect(body.error.message).toContain('--task-file');
  });

  it('forwards a sonata- model the config does not resolve to the ordinary path', async () => {
    // A `sonata-` prefix alone is not a tier alias: unless resolveTier returns
    // a rank for the name, the model must fall through to the ordinary
    // litellm/anthropic path rather than being answered 400. A native model
    // key could legitimately begin `sonata-`.
    const rec: any[] = [];
    const res = await routeRequest(req('sonata-nope-simple'), {
      fetch: fakeFetch(rec),
      litellmBase: 'http://litellm', litellmKey: 'k',
      resolveTier: () => undefined,
    });
    expect(res.status).toBe(200);
    expect(rec[0].url).toBe('http://litellm/v1/messages');
  });

  it('4xx from upstream is returned, not retried — our bug, not their outage', async () => {
    const seen: string[] = [];
    const res = await routeRequest(req('sonata-code-simple'), {
      fetch: (async (_url: string, init: RequestInit) => {
        seen.push((JSON.parse(init.body as string) as { model: string }).model);
        return new Response('bad request', { status: 400 });
      }) as unknown as typeof fetch,
      litellmBase: 'http://litellm', litellmKey: 'k',
      resolveTier: () => ROUTES,
    });
    expect(res.status).toBe(400);
    expect(seen).toEqual(['flash']);
  });

  it('429 (rate-limited) falls back to the next candidate, not returned as-is', async () => {
    const seen: string[] = [];
    const res = await routeRequest(req('sonata-code-simple'), {
      fetch: (async (_url: string, init: RequestInit) => {
        const model = (JSON.parse(init.body as string) as { model: string }).model;
        seen.push(model);
        return new Response('rate limited', { status: model === 'flash' ? 429 : 200 });
      }) as unknown as typeof fetch,
      litellmBase: 'http://litellm', litellmKey: 'k',
      resolveTier: () => ROUTES,
    });
    expect(res.status).toBe(200);
    expect(seen).toEqual(['flash', 'luna']);
  });

  it('401 (candidate auth failure) falls back to the next candidate and cools the failure down', async () => {
    const seen: string[] = [];
    const deps = {
      fetch: (async (_url: string, init: RequestInit) => {
        const model = (JSON.parse(init.body as string) as { model: string }).model;
        seen.push(model);
        return new Response('unauthorized', { status: model === 'flash' ? 401 : 200 });
      }) as unknown as typeof fetch,
      litellmBase: 'http://litellm', litellmKey: 'k',
      resolveTier: () => ROUTES,
    };
    expect((await routeRequest(req('sonata-code-simple'), deps)).status).toBe(200);
    expect(seen).toEqual(['flash', 'luna']);
    // second request inside the cooldown skips flash entirely, same as a 5xx/429
    await routeRequest(req('sonata-code-simple'), deps);
    expect(seen).toEqual(['flash', 'luna', 'luna']);
  });

  it('403 (candidate auth failure) falls back to the next candidate, not returned as-is', async () => {
    const seen: string[] = [];
    const res = await routeRequest(req('sonata-code-simple'), {
      fetch: (async (_url: string, init: RequestInit) => {
        const model = (JSON.parse(init.body as string) as { model: string }).model;
        seen.push(model);
        return new Response('forbidden', { status: model === 'flash' ? 403 : 200 });
      }) as unknown as typeof fetch,
      litellmBase: 'http://litellm', litellmKey: 'k',
      resolveTier: () => ROUTES,
    });
    expect(res.status).toBe(200);
    expect(seen).toEqual(['flash', 'luna']);
  });

  it('logs the resolution step', async () => {
    const lines: string[] = [];
    await routeRequest(req('sonata-code-simple'), {
      fetch: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
      litellmBase: 'http://litellm', litellmKey: 'k',
      resolveTier: () => ROUTES,
      log: (l) => lines.push(l),
    });
    expect(lines.some((l) => l.includes('model=sonata-code-simple -> flash -> litellm'))).toBe(true);
  });

  // ── Direct transport: an Anthropic-native gateway is reached with no
  // LiteLLM in the path at all. ──
  const DIRECT_ROUTES = {
    role: 'code', tier: 'simple',
    routes: [
      { key: 'direct-1', native: {
        gateway: 'g', id: 'model-1', transport: 'direct' as const, baseUrl: 'https://gw.example/v1',
      } },
    ],
  };

  it('sends a direct-transport candidate straight to the gateway, never touching litellm', async () => {
    let seenUrl = '';
    const res = await routeRequest(req('sonata-code-simple'), {
      fetch: (async (url: string) => { seenUrl = url; return new Response('{}', { status: 200 }); }) as unknown as typeof fetch,
      litellmBase: 'http://litellm', litellmKey: 'k',
      gatewayKeys: { g: 'GATEWAY-KEY' },
      resolveTier: () => DIRECT_ROUTES,
    });
    expect(res.status).toBe(200);
    expect(seenUrl).toBe('https://gw.example/v1/messages');
  });

  it('injects the gateway key and never forwards the caller credential', async () => {
    let seenAuth: string | undefined;
    const res = await routeRequest(
      {
        method: 'POST', url: '/v1/messages',
        headers: { 'content-type': 'application/json', authorization: 'Bearer CALLER-SECRET' },
        body: Buffer.from(JSON.stringify({ model: 'sonata-code-simple', messages: [] })),
      },
      {
        fetch: (async (_url: string, init: RequestInit) => {
          seenAuth = (init.headers as Record<string, string>).authorization;
          return new Response('{}', { status: 200 });
        }) as unknown as typeof fetch,
        litellmBase: 'http://litellm', litellmKey: 'k',
        gatewayKeys: { g: 'GATEWAY-KEY' },
        resolveTier: () => DIRECT_ROUTES,
      },
    );
    expect(res.status).toBe(200);
    expect(seenAuth).toBe('Bearer GATEWAY-KEY');
    expect(seenAuth).not.toBe('Bearer CALLER-SECRET');
  });

  it('passes a system block array with cache_control through intact, unflattened', async () => {
    let seenBody = '';
    const res = await routeRequest(
      {
        method: 'POST', url: '/v1/messages',
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({
          model: 'sonata-code-simple',
          system: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }],
          messages: [],
        })),
      },
      {
        fetch: (async (_url: string, init: RequestInit) => {
          seenBody = init.body as string;
          return new Response('{}', { status: 200 });
        }) as unknown as typeof fetch,
        litellmBase: 'http://litellm', litellmKey: 'k',
        gatewayKeys: { g: 'GATEWAY-KEY' },
        resolveTier: () => DIRECT_ROUTES,
      },
    );
    expect(res.status).toBe(200);
    const sent = JSON.parse(seenBody);
    expect(sent.system).toEqual([{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }]);
  });

  it('rewrites only the model field, to the gateway\'s own id — not the sonata key', async () => {
    let sentModel = '';
    await routeRequest(req('sonata-code-simple'), {
      fetch: (async (_url: string, init: RequestInit) => {
        sentModel = (JSON.parse(init.body as string) as { model: string }).model;
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch,
      litellmBase: 'http://litellm', litellmKey: 'k',
      gatewayKeys: { g: 'GATEWAY-KEY' },
      resolveTier: () => DIRECT_ROUTES,
    });
    expect(sentModel).toBe('model-1');
  });

  it('never rewrites assistant content blocks on the direct path', async () => {
    // `redacted_thinking` carries opaque vendor state that the upstream
    // requires echoed back byte-identical; any rewriting silently breaks the
    // next turn.
    const assistant = [
      { type: 'redacted_thinking', data: 'OPAQUE-VENDOR-STATE-DO-NOT-TOUCH' },
      { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'Paris' } },
    ];
    let sent = '';
    await routeRequest(
      {
        method: 'POST', url: '/v1/messages', headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({
          model: 'sonata-code-simple',
          messages: [{ role: 'assistant', content: assistant }],
        })),
      },
      {
        fetch: (async (_u: string, init: RequestInit) => { sent = init.body as string; return new Response('{}', { status: 200 }); }) as unknown as typeof fetch,
        litellmBase: 'http://litellm', litellmKey: 'k',
        gatewayKeys: { g: 'GATEWAY-KEY' },
        resolveTier: () => DIRECT_ROUTES,
      },
    );
    expect(JSON.parse(sent).messages[0].content).toEqual(assistant);
  });

  it('never rewrites assistant content blocks on the litellm path either', async () => {
    // The constraint is global, but this is the path that could plausibly
    // break it: `flattenSystemBlocks` runs here, so any future widening of
    // "flatten what Claude Code sends" from `system` to `messages` would
    // silently destroy `redacted_thinking` — opaque vendor state (measured:
    // Gemini's thought_signature through an aggregator) the upstream requires
    // echoed back byte-identical.
    const assistant = [
      { type: 'redacted_thinking', data: 'OPAQUE-VENDOR-STATE-DO-NOT-TOUCH' },
      { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'Paris' } },
    ];
    let sent = '';
    await routeRequest(
      {
        method: 'POST', url: '/v1/messages', headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({
          model: 'sonata-code-simple',
          system: [{ type: 'text', text: 'flatten me' }],
          messages: [{ role: 'assistant', content: assistant }],
        })),
      },
      {
        fetch: (async (_u: string, init: RequestInit) => {
          sent = init.body as string;
          return new Response('{}', { status: 200 });
        }) as unknown as typeof fetch,
        litellmBase: 'http://litellm', litellmKey: 'k',
        resolveTier: () => ROUTES,
      },
    );
    const body = JSON.parse(sent) as { system: unknown; messages: { content: unknown }[] };
    expect(body.messages[0].content).toEqual(assistant);
    // …while `system` IS flattened here. Asserting both is what makes the line
    // above a real distinction rather than "this path touches nothing".
    expect(body.system).toBe('flatten me');
  });

  it('falls back from a failed direct candidate to a litellm candidate, and vice versa', async () => {
    const mixedRoutes = {
      role: 'code', tier: 'simple',
      routes: [
        { key: 'direct-1', native: {
          gateway: 'g', id: 'model-1', transport: 'direct' as const, baseUrl: 'https://gw.example/v1',
        } },
        { key: 'flash', native: { gateway: 'lg', id: 'flash-1' } },
      ],
    };
    const seenUrls: string[] = [];
    const res = await routeRequest(req('sonata-code-simple'), {
      fetch: (async (url: string) => {
        seenUrls.push(url);
        return new Response('{}', { status: url.startsWith('https://gw.example') ? 503 : 200 });
      }) as unknown as typeof fetch,
      litellmBase: 'http://litellm', litellmKey: 'k',
      gatewayKeys: { g: 'GATEWAY-KEY' },
      resolveTier: () => mixedRoutes,
    });
    expect(res.status).toBe(200);
    expect(seenUrls).toEqual(['https://gw.example/v1/messages', 'http://litellm/v1/messages']);
  });
});

describe('withModel', () => {
  it('rewrites only the model field', () => {
    const out = JSON.parse(withModel(Buffer.from('{"model":"a","x":1}'), 'b').toString());
    expect(out).toEqual({ model: 'b', x: 1 });
  });
});

describe('flattenSystemBlocks', () => {
  const parse = (b: Buffer) => JSON.parse(b.toString());

  it('joins text blocks into one string', () => {
    // Claude Code always sends `system` as an array. LiteLLM converts a string
    // system prompt to a `developer` message the Codex backend accepts, but
    // leaves block arrays as role `system`, which it refuses outright with
    // {"detail":"System messages are not allowed"} — a 400 naming neither the
    // field nor the shape.
    const body = Buffer.from(JSON.stringify({
      model: 'gpt-5.6-terra',
      system: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }],
      messages: [{ role: 'user', content: 'hi' }],
    }));
    expect(parse(flattenSystemBlocks(body)).system).toBe('first\n\nsecond');
  });

  it('preserves every other field', () => {
    const body = Buffer.from(JSON.stringify({
      model: 'm', max_tokens: 32, stream: true,
      system: [{ type: 'text', text: 'x' }],
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'Read' }],
    }));
    const out = parse(flattenSystemBlocks(body));
    expect(out).toMatchObject({ model: 'm', max_tokens: 32, stream: true, tools: [{ name: 'Read' }] });
    expect(out.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('drops cache_control with the block wrapper', () => {
    const body = Buffer.from(JSON.stringify({
      system: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }],
    }));
    expect(parse(flattenSystemBlocks(body)).system).toBe('x');
  });

  it('leaves a string system prompt alone', () => {
    const body = Buffer.from(JSON.stringify({ system: 'already a string' }));
    expect(flattenSystemBlocks(body).equals(body)).toBe(true);
  });

  it('leaves an empty array alone, which the backend already accepts', () => {
    const body = Buffer.from(JSON.stringify({ system: [] }));
    expect(flattenSystemBlocks(body).equals(body)).toBe(true);
  });

  it('leaves a body with no system field alone', () => {
    const body = Buffer.from(JSON.stringify({ model: 'm', messages: [] }));
    expect(flattenSystemBlocks(body).equals(body)).toBe(true);
  });

  it('leaves a non-JSON body alone', () => {
    const body = Buffer.from('not json at all');
    expect(flattenSystemBlocks(body).equals(body)).toBe(true);
  });

  it('leaves the body alone when a block is not text', () => {
    // An image block has no string form. Dropping it would silently change the
    // prompt, so the request goes as-is and fails loudly instead.
    const body = Buffer.from(JSON.stringify({
      system: [{ type: 'text', text: 'x' }, { type: 'image', source: {} }],
    }));
    expect(flattenSystemBlocks(body).equals(body)).toBe(true);
  });

  it('accepts bare strings in the array', () => {
    const body = Buffer.from(JSON.stringify({ system: ['a', 'b'] }));
    expect(parse(flattenSystemBlocks(body)).system).toBe('a\n\nb');
  });
});

describe('routeRequest — system blocks', () => {
  const seen: string[] = [];
  const capture: typeof fetch = (async (_url: string, init: RequestInit) => {
    seen.push(Buffer.from(init.body as Uint8Array).toString());
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;

  const deps = { fetch: capture, litellmBase: 'http://litellm', litellmKey: 'k' };
  const request = (model: string) => ({
    method: 'POST',
    url: '/v1/messages',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({
      model,
      system: [{ type: 'text', text: 'flatten me' }],
      messages: [{ role: 'user', content: 'hi' }],
    })),
  });

  it('flattens on the foreign path', async () => {
    seen.length = 0;
    await routeRequest(request('gpt-5.6-terra'), deps);
    expect(JSON.parse(seen[0]).system).toBe('flatten me');
  });

  it('leaves an Anthropic request byte-identical', async () => {
    // Anthropic understands its own block arrays; rewriting them would be a
    // change with no upside and a real risk to prompt caching.
    seen.length = 0;
    const req = request('claude-sonnet-4');
    await routeRequest(req, { ...deps, anthropicBase: 'http://anthropic' });
    expect(seen[0]).toBe(req.body.toString());
  });
});

describe('requestedModel', () => {
  it('reads the model from a JSON body', () => {
    expect(requestedModel(Buffer.from(JSON.stringify({ model: 'gpt-5.6-terra' })))).toBe('gpt-5.6-terra');
  });

  it('is undefined for a non-JSON or model-less body', () => {
    expect(requestedModel(Buffer.from('not json'))).toBeUndefined();
    expect(requestedModel(Buffer.from(JSON.stringify({ messages: [] })))).toBeUndefined();
  });
});

describe('routeRequest — logging', () => {
  const ok: typeof fetch = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;

  const logFor = async (model: string): Promise<string> => {
    const lines: string[] = [];
    await routeRequest({
      method: 'POST',
      url: '/v1/messages',
      headers: {},
      body: Buffer.from(JSON.stringify({ model, messages: [] })),
    }, {
      fetch: ok,
      litellmBase: 'http://litellm',
      anthropicBase: 'http://anthropic',
      litellmKey: 'k',
      log: (line) => lines.push(line),
    });
    return lines.join('\n');
  };

  it('records the model and the upstream that served it', async () => {
    // The routing decision is otherwise invisible: litellm's access log has the
    // path and status but not the model, so "did this agent really run on the
    // foreign model?" could only be answered by inference.
    expect(await logFor('gpt-5.6-terra')).toBe('POST /v1/messages model=gpt-5.6-terra -> litellm');
  });

  it('names anthropic for a claude- model', async () => {
    expect(await logFor('claude-sonnet-4')).toBe('POST /v1/messages model=claude-sonnet-4 -> anthropic');
  });
});

describe('routeRequest — 529 rewrite for empty Codex completions', () => {
  const emptyOutputBody = JSON.stringify({
    error: { message: 'Unknown items in responses API response: []' },
  });

  const make529Fetch = (): typeof fetch =>
    (async () => new Response(emptyOutputBody, { status: 500 })) as unknown as typeof fetch;

  it('rewrites 500 with empty-output message to 529 for non-claude models', async () => {
    const result = await routeRequest({
      method: 'POST',
      url: '/v1/messages',
      headers: {},
      body: Buffer.from(JSON.stringify({ model: 'gpt-5.6-luna', messages: [] })),
    }, {
      fetch: make529Fetch(),
      litellmBase: 'http://litellm',
      anthropicBase: 'http://anthropic',
      litellmKey: 'k',
    });
    expect(result.status).toBe(529);
    const body = Buffer.isBuffer(result.body) ? result.body : Buffer.concat(
      await (async () => { const chunks: Buffer[] = []; for await (const c of result.body as AsyncIterable<Buffer>) chunks.push(c); return chunks; })()
    );
    const parsed = JSON.parse(body.toString());
    expect(parsed.type).toBe('error');
    expect(parsed.error.type).toBe('overloaded_error');
  });

  it('does not rewrite 500 for claude models (goes to anthropic, not litellm)', async () => {
    // Claude requests go to Anthropic directly; a 500 there is a real error.
    const result = await routeRequest({
      method: 'POST',
      url: '/v1/messages',
      headers: {},
      body: Buffer.from(JSON.stringify({ model: 'claude-sonnet-5', messages: [] })),
    }, {
      fetch: make529Fetch(),
      litellmBase: 'http://litellm',
      anthropicBase: 'http://anthropic',
      litellmKey: 'k',
    });
    expect(result.status).toBe(500);
  });

  it('does not rewrite 500 whose body does not match the empty-output pattern', async () => {
    const otherFetch = (async () => new Response('{"error":"something else"}', { status: 500 })) as unknown as typeof fetch;
    const result = await routeRequest({
      method: 'POST',
      url: '/v1/messages',
      headers: {},
      body: Buffer.from(JSON.stringify({ model: 'gpt-5.6-luna', messages: [] })),
    }, {
      fetch: otherFetch,
      litellmBase: 'http://litellm',
      anthropicBase: 'http://anthropic',
      litellmKey: 'k',
    });
    expect(result.status).toBe(500);
  });

  it('logs the rewrite with the model name', async () => {
    const lines: string[] = [];
    await routeRequest({
      method: 'POST',
      url: '/v1/messages',
      headers: {},
      body: Buffer.from(JSON.stringify({ model: 'gpt-5.6-luna', messages: [] })),
    }, {
      fetch: make529Fetch(),
      litellmBase: 'http://litellm',
      anthropicBase: 'http://anthropic',
      litellmKey: 'k',
      log: (l) => lines.push(l),
    });
    expect(lines.some(l => l.includes('529') && l.includes('gpt-5.6-luna'))).toBe(true);
  });
});
