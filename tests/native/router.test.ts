import { describe, expect, it, beforeEach } from 'vitest';
import { routeRequest, flattenSystemBlocks, sanitizeToolSchemas, usesUnicodePropertyEscape, demoteSystemTurns, requestedModel, withModel, clearCooldowns, TIER_CAPABILITY_400_THRESHOLD, createRouterServer, litellmModelName, DEFAULT_TENANT } from '../../src/native/router.js';
import { TenantError, SONATA_PROJECT_HEADER } from '../../src/native/tenants.js';

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
    expect(seen).toEqual(['default/flash']);
  });

  it('falls back to the next candidate on 5xx and cools the failure down', async () => {
    const seen: string[] = [];
    const deps = {
      fetch: (async (_url: string, init: RequestInit) => {
        const model = (JSON.parse(init.body as string) as { model: string }).model;
        seen.push(model);
        return new Response('{}', { status: model === 'default/flash' ? 503 : 200 });
      }) as unknown as typeof fetch,
      litellmBase: 'http://litellm', litellmKey: 'k',
      resolveTier: () => ROUTES,
    };
    expect((await routeRequest(req('sonata-code-simple'), deps)).status).toBe(200);
    expect(seen).toEqual(['default/flash', 'default/luna']);
    // second request inside the cooldown skips flash entirely
    await routeRequest(req('sonata-code-simple'), deps);
    expect(seen).toEqual(['default/flash', 'default/luna', 'default/luna']);
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
    expect(seen).toEqual(['default/flash']);
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
    expect(new Set(seen)).toEqual(new Set(['default/flash']));
  });

  it('fingerprints the Codex backend refusing a system message', async () => {
    // `flattenSystemBlocks` plus the codex-oauth model's
    // `supports_system_message: false` were both meant to keep requests off
    // this path, and both were verified present in the running daemon when a
    // `code-complex` subagent still died with `Received Model Group=
    // gpt-5.6-terra` and this body on 2026-09-03. Until the remaining hole is
    // found the failure has to be survivable: cooled and fallen through, so
    // the tier's later candidates get a turn and an exhausted tier ends at the
    // 529 that names `sonata dispatch` — where a bare 400 killed the subagent
    // outright, naming neither cause nor remedy.
    const CODEX_SYSTEM_400 = JSON.stringify({
      error: {
        message: 'litellm.BadRequestError: ChatgptException - {"detail":"System messages are not allowed"}',
      },
    });
    const seen: string[] = [];
    const deps = {
      fetch: (async (_url: string, init: RequestInit) => {
        const model = (JSON.parse(init.body as string) as { model: string }).model;
        seen.push(model);
        return model === 'default/flash'
          ? new Response(CODEX_SYSTEM_400, { status: 400 })
          : new Response('{}', { status: 200 });
      }) as unknown as typeof fetch,
      litellmBase: 'http://litellm', litellmKey: 'k',
      resolveTier: () => ROUTES,
    };
    for (let i = 0; i < TIER_CAPABILITY_400_THRESHOLD - 1; i++) {
      expect((await routeRequest(req('sonata-code-simple'), deps)).status).toBe(400);
    }
    expect((await routeRequest(req('sonata-code-simple'), deps)).status).toBe(200);
    expect(seen[seen.length - 1]).toBe('default/luna');
  });

  it('cools the candidate and falls through once the same capability 400 repeats', async () => {
    const seen: string[] = [];
    const deps = {
      fetch: (async (_url: string, init: RequestInit) => {
        const model = (JSON.parse(init.body as string) as { model: string }).model;
        seen.push(model);
        return model === 'default/flash'
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
    expect(seen[seen.length - 1]).toBe('default/luna');
    // And it stays cooled: a later request skips flash entirely.
    seen.length = 0;
    expect((await routeRequest(req('sonata-code-simple'), deps)).status).toBe(200);
    expect(seen).toEqual(['default/luna']);
  });

  it('resets the count when the candidate serves a request successfully', async () => {
    // A model that intermittently 400s must not accumulate toward a cooldown
    // across unrelated successes — otherwise a healthy candidate is eventually
    // cooled by noise spread over hours.
    let fail = true;
    const deps = {
      fetch: (async (_url: string, init: RequestInit) => {
        const model = (JSON.parse(init.body as string) as { model: string }).model;
        if (model !== 'default/flash') return new Response('{}', { status: 200 });
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
        if (model === 'default/flash') throw new Error('ECONNREFUSED');
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch,
      litellmBase: 'http://litellm', litellmKey: 'k',
      resolveTier: () => ROUTES,
    });
    expect(res.status).toBe(200);
    expect(seen).toEqual(['default/flash', 'default/luna']);
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
    expect(seen).toEqual(['default/flash']);
  });

  it('429 (rate-limited) falls back to the next candidate, not returned as-is', async () => {
    const seen: string[] = [];
    const res = await routeRequest(req('sonata-code-simple'), {
      fetch: (async (_url: string, init: RequestInit) => {
        const model = (JSON.parse(init.body as string) as { model: string }).model;
        seen.push(model);
        return new Response('rate limited', { status: model === 'default/flash' ? 429 : 200 });
      }) as unknown as typeof fetch,
      litellmBase: 'http://litellm', litellmKey: 'k',
      resolveTier: () => ROUTES,
    });
    expect(res.status).toBe(200);
    expect(seen).toEqual(['default/flash', 'default/luna']);
  });

  it('401 (candidate auth failure) falls back to the next candidate and cools the failure down', async () => {
    const seen: string[] = [];
    const deps = {
      fetch: (async (_url: string, init: RequestInit) => {
        const model = (JSON.parse(init.body as string) as { model: string }).model;
        seen.push(model);
        return new Response('unauthorized', { status: model === 'default/flash' ? 401 : 200 });
      }) as unknown as typeof fetch,
      litellmBase: 'http://litellm', litellmKey: 'k',
      resolveTier: () => ROUTES,
    };
    expect((await routeRequest(req('sonata-code-simple'), deps)).status).toBe(200);
    expect(seen).toEqual(['default/flash', 'default/luna']);
    // second request inside the cooldown skips flash entirely, same as a 5xx/429
    await routeRequest(req('sonata-code-simple'), deps);
    expect(seen).toEqual(['default/flash', 'default/luna', 'default/luna']);
  });

  it('403 (candidate auth failure) falls back to the next candidate, not returned as-is', async () => {
    const seen: string[] = [];
    const res = await routeRequest(req('sonata-code-simple'), {
      fetch: (async (_url: string, init: RequestInit) => {
        const model = (JSON.parse(init.body as string) as { model: string }).model;
        seen.push(model);
        return new Response('forbidden', { status: model === 'default/flash' ? 403 : 200 });
      }) as unknown as typeof fetch,
      litellmBase: 'http://litellm', litellmKey: 'k',
      resolveTier: () => ROUTES,
    });
    expect(res.status).toBe(200);
    expect(seen).toEqual(['default/flash', 'default/luna']);
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
      gatewayKeys: () => ({ g: 'GATEWAY-KEY' }),
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
        gatewayKeys: () => ({ g: 'GATEWAY-KEY' }),
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
        gatewayKeys: () => ({ g: 'GATEWAY-KEY' }),
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
      gatewayKeys: () => ({ g: 'GATEWAY-KEY' }),
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
        gatewayKeys: () => ({ g: 'GATEWAY-KEY' }),
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
      gatewayKeys: () => ({ g: 'GATEWAY-KEY' }),
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

// Claude Code's Artifact tool, verbatim: its `field` parameter's pattern uses
// Unicode property classes. Python's `re` has no `\p{..}`, and jsonschema's
// `format: regex` check on OpenAI-style endpoints runs on Python's `re`, so
// Azure answered a `code-simple` dispatch with 400 `'…' is not a 'regex'`
// (tools[1].parameters) and LiteLLM killed the run (measured 2026-09-09).
const ARTIFACT_FIELD_PATTERN = '^(?!__.*__$)[^\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}"\\\\./[\\]]{1,200}$';

function toolsBody(model: string): Buffer {
  return Buffer.from(JSON.stringify({
    model,
    messages: [{ role: 'user', content: 'hi' }],
    tools: [
      { name: 'Read', input_schema: { type: 'object', properties: { file_path: { type: 'string' } } } },
      {
        name: 'Artifact',
        input_schema: {
          type: 'object',
          properties: {
            field: { type: 'string', pattern: ARTIFACT_FIELD_PATTERN },
            asset_id: { type: 'string', pattern: '^[0-9a-f]{32}$' },
            writes: { type: 'array', items: { type: 'object', properties: { doc_id: { type: 'string', pattern: '^[^\\p{Cc}]+$' } } } },
          },
        },
      },
    ],
  }));
}

describe('usesUnicodePropertyEscape', () => {
  it('matches \\p{..} and \\P{..}', () => {
    expect(usesUnicodePropertyEscape(ARTIFACT_FIELD_PATTERN)).toBe(true);
    expect(usesUnicodePropertyEscape('^\\P{L}+$')).toBe(true);
  });
  it('does not match an escaped backslash followed by p', () => {
    // `\\p` is a literal backslash then `p`, which Python's re accepts.
    expect(usesUnicodePropertyEscape('^\\\\p$')).toBe(false);
    expect(usesUnicodePropertyEscape('^[0-9a-f]{32}$')).toBe(false);
    expect(usesUnicodePropertyEscape('^(?!\\.\\.?(?:\\/|$))[A-Za-z0-9_\\-.~:@+]{1,200}$')).toBe(false);
  });
});

describe('sanitizeToolSchemas', () => {
  const parse = (b: Buffer) => JSON.parse(b.toString());

  it('drops only the patterns Python re cannot parse, wherever they sit in the schema', () => {
    const out = parse(sanitizeToolSchemas(toolsBody('gpt-5.6-terra')));
    const artifact = out.tools[1].input_schema.properties;
    expect(artifact.field).toEqual({ type: 'string' });
    expect(artifact.asset_id).toEqual({ type: 'string', pattern: '^[0-9a-f]{32}$' });
    expect(artifact.writes.items.properties.doc_id).toEqual({ type: 'string' });
    // Untouched tool, untouched everything else.
    expect(out.tools[0]).toEqual(parse(toolsBody('x')).tools[0]);
    expect(out.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('returns the body byte-identical when nothing needs stripping', () => {
    const body = Buffer.from(JSON.stringify({
      model: 'm',
      tools: [{ name: 'Read', input_schema: { type: 'object', properties: { p: { type: 'string', pattern: '^[a-z]+$' } } } }],
    }));
    expect(sanitizeToolSchemas(body).equals(body)).toBe(true);
  });

  it('leaves a property that happens to be named "pattern" alone', () => {
    // `pattern` as a *property name* is an object under `properties`, not a
    // regex; only a string-valued `pattern` keyword is a regex.
    const body = Buffer.from(JSON.stringify({
      model: 'm',
      tools: [{ name: 't', input_schema: { type: 'object', properties: { pattern: { type: 'string' } } } }],
    }));
    expect(sanitizeToolSchemas(body).equals(body)).toBe(true);
  });

  it('leaves a non-JSON body, and a body with no tools, alone', () => {
    const raw = Buffer.from('not json');
    expect(sanitizeToolSchemas(raw).equals(raw)).toBe(true);
    const none = Buffer.from(JSON.stringify({ model: 'm', messages: [] }));
    expect(sanitizeToolSchemas(none).equals(none)).toBe(true);
  });
});

describe('routeRequest — tool schemas', () => {
  const seen: string[] = [];
  const capture: typeof fetch = (async (_url: string, init: RequestInit) => {
    seen.push(Buffer.from(init.body as Uint8Array).toString());
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const deps = { fetch: capture, litellmBase: 'http://litellm', litellmKey: 'k' };
  const request = (model: string) => ({
    method: 'POST', url: '/v1/messages', headers: { 'content-type': 'application/json' }, body: toolsBody(model),
  });

  it('strips Unicode-property patterns on the litellm path', async () => {
    seen.length = 0;
    await routeRequest(request('gpt-5.6-terra'), deps);
    const tools = JSON.parse(seen[0]).tools;
    expect(tools[1].input_schema.properties.field).toEqual({ type: 'string' });
    expect(tools[1].input_schema.properties.asset_id.pattern).toBe('^[0-9a-f]{32}$');
  });

  it('strips them on the tier path too', async () => {
    seen.length = 0;
    clearCooldowns();
    await routeRequest(request('sonata-code-simple'), {
      ...deps,
      resolveTier: () => ({ role: 'code', tier: 'simple', routes: [{ key: 'terra', native: { gateway: 'g', id: 'gpt-5.6-terra' } }] }),
    });
    expect(JSON.parse(seen[0]).tools[1].input_schema.properties.field).toEqual({ type: 'string' });
  });

  it('leaves an Anthropic request byte-identical', async () => {
    seen.length = 0;
    const req = request('claude-sonnet-4');
    await routeRequest(req, { ...deps, anthropicBase: 'http://anthropic' });
    expect(seen[0]).toBe(req.body.toString());
  });
});

// Captured 2026-09-09 from Claude Code 2.1.266 (`claude -p`, and a subagent
// dispatch): `messages` carried a `role: "system"` turn after the user turn.
// LiteLLM's Anthropic adapter forwards it as a system-role chat message, the
// chat→responses bridge emits it as a system input item, and the Codex backend
// answers `{"detail":"System messages are not allowed"}` — the hole that
// survived `flattenSystemBlocks` + `supports_system_message: false`, since
// neither looks at `messages`.
describe('demoteSystemTurns', () => {
  const parse = (b: Buffer) => JSON.parse(b.toString());
  const body = (messages: unknown[]) => Buffer.from(JSON.stringify({ model: 'm', messages }));

  it('turns a mid-conversation system turn into a user turn, keeping its content and position', () => {
    const out = parse(demoteSystemTurns(body([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'system', content: [{ type: 'text', text: 'reminder', cache_control: { type: 'ephemeral' } }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'system', content: 'plain string reminder' },
    ])));
    expect(out.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'user', 'assistant', 'user']);
    expect(out.messages[1].content).toEqual([{ type: 'text', text: 'reminder', cache_control: { type: 'ephemeral' } }]);
    expect(out.messages[3].content).toBe('plain string reminder');
  });

  it('returns the body byte-identical when no turn is a system turn', () => {
    const b = body([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }]);
    expect(demoteSystemTurns(b).equals(b)).toBe(true);
  });

  it('leaves a non-JSON body, and one with no messages array, alone', () => {
    const raw = Buffer.from('nope');
    expect(demoteSystemTurns(raw).equals(raw)).toBe(true);
    const none = Buffer.from(JSON.stringify({ model: 'm' }));
    expect(demoteSystemTurns(none).equals(none)).toBe(true);
  });
});

describe('routeRequest — system turns', () => {
  const seen: string[] = [];
  const capture: typeof fetch = (async (_url: string, init: RequestInit) => {
    seen.push(Buffer.from(init.body as Uint8Array).toString());
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const deps = { fetch: capture, litellmBase: 'http://litellm', litellmKey: 'k' };
  const request = (model: string) => ({
    method: 'POST', url: '/v1/messages', headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({
      model,
      system: [{ type: 'text', text: 'sys' }],
      messages: [{ role: 'user', content: 'hi' }, { role: 'system', content: [{ type: 'text', text: 'turn' }] }],
    })),
  });

  it('demotes on the litellm path, and on the tier path', async () => {
    seen.length = 0;
    await routeRequest(request('gpt-5.6-terra'), deps);
    expect(JSON.parse(seen[0]).messages.map((m: { role: string }) => m.role)).toEqual(['user', 'user']);
    clearCooldowns();
    await routeRequest(request('sonata-code-simple'), {
      ...deps,
      resolveTier: () => ({ role: 'code', tier: 'simple', routes: [{ key: 'terra', native: { gateway: 'g', id: 'gpt-5.6-terra' } }] }),
    });
    expect(JSON.parse(seen[1]).messages.map((m: { role: string }) => m.role)).toEqual(['user', 'user']);
  });

  it('leaves an Anthropic request byte-identical — Anthropic accepts its own system turns', async () => {
    seen.length = 0;
    const req = request('claude-sonnet-5');
    await routeRequest(req, { ...deps, anthropicBase: 'http://anthropic' });
    expect(seen[0]).toBe(req.body.toString());
  });
});

describe('routeRequest — tenants', () => {
  const seen: { url: string; model: string; headers: Record<string, string> }[] = [];
  const capture: typeof fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(Buffer.from(init.body as Uint8Array).toString()) as { model: string };
    seen.push({ url, model: body.model, headers: init.headers as Record<string, string> });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const tenantA = { id: 'aaaaaaaaaaaa', project: '/p/a', configPath: '/p/a/sonata.toml' };
  const tenantB = { id: 'bbbbbbbbbbbb', project: '/p/b', configPath: '/p/b/sonata.toml' };
  const routesFor = (t: { id: string }) => ({
    role: 'code', tier: 'simple',
    routes: [{ key: 'flash', native: { gateway: 'g', id: t.id === 'aaaaaaaaaaaa' ? 'deepseek' : 'gemini' } }],
  });
  const deps = {
    fetch: capture, litellmBase: 'http://litellm', litellmKey: 'k',
    resolveTenant: (hint: { project?: string; session?: string }) => {
      if (hint.project === '/p/a' || hint.session === 'sa') return tenantA;
      if (hint.project === '/p/b') return tenantB;
      if (hint.project === '/none') throw new TenantError('No sonata.toml found for /none');
      return DEFAULT_TENANT;
    },
    resolveTier: (_alias: string, t: { id: string }) => routesFor(t),
  };
  const req = (headers: Record<string, string>, model = 'sonata-code-simple') => ({
    method: 'POST', url: '/v1/messages',
    headers: { 'content-type': 'application/json', ...headers },
    body: Buffer.from(JSON.stringify({ model, messages: [] })),
  });
  beforeEach(() => { seen.length = 0; clearCooldowns(); });

  it('resolves by the project header first and namespaces the litellm model', async () => {
    await routeRequest(req({ [SONATA_PROJECT_HEADER]: '/p/a', 'x-claude-code-session-id': 'zz' }), deps);
    expect(seen[0].model).toBe('aaaaaaaaaaaa/flash');
  });
  it('falls back to the session, then to the default tenant', async () => {
    await routeRequest(req({ 'x-claude-code-session-id': 'sa' }), deps);
    expect(seen[0].model).toBe('aaaaaaaaaaaa/flash');
    await routeRequest(req({}), deps);
    expect(seen[1].model).toBe('default/flash');
  });
  it('strips the project header before forwarding, on the litellm and anthropic paths', async () => {
    await routeRequest(req({ [SONATA_PROJECT_HEADER]: '/p/a' }), deps);
    expect(Object.keys(seen[0].headers).map((h) => h.toLowerCase())).not.toContain(SONATA_PROJECT_HEADER);
    await routeRequest(req({ [SONATA_PROJECT_HEADER]: '/p/a' }, 'claude-sonnet-5'), { ...deps, anthropicBase: 'http://anthropic' });
    expect(Object.keys(seen[1].headers).map((h) => h.toLowerCase())).not.toContain(SONATA_PROJECT_HEADER);
  });
  it('strips the project header on the direct transport too', async () => {
    // The spec says every path. `forwardDirect` builds its own header set, so
    // this is a separate code path from the litellm/anthropic one above.
    await routeRequest(req({ [SONATA_PROJECT_HEADER]: '/p/a' }), {
      ...deps,
      resolveTier: () => ({
        role: 'code', tier: 'simple',
        routes: [{ key: 'flash', native: { gateway: 'g', id: 'direct-model', transport: 'direct' as const, baseUrl: 'http://direct/v1' } }],
      }),
      gatewayKeys: () => ({ g: 'secret' }),
    });
    expect(seen[0].url).toBe('http://direct/v1/messages');
    expect(Object.keys(seen[0].headers).map((h) => h.toLowerCase())).not.toContain(SONATA_PROJECT_HEADER);
  });
  it('answers a TenantError with a 400 naming the message, and records nothing', async () => {
    const rows: unknown[] = [];
    const res = await routeRequest(req({ [SONATA_PROJECT_HEADER]: '/none' }), { ...deps, recordUsage: (r) => rows.push(r) });
    expect(res.status).toBe(400);
    expect(Buffer.from(res.body as Buffer).toString()).toContain('No sonata.toml found for /none');
    expect(rows).toEqual([]);
  });
  it('cools one tenant\'s candidate without touching the other\'s', async () => {
    const failing: typeof fetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(Buffer.from(init.body as Uint8Array).toString()) as { model: string };
      seen.push({ url: '', model: body.model, headers: {} });
      return new Response('{}', { status: body.model.startsWith('aaaa') ? 503 : 200 });
    }) as unknown as typeof fetch;
    await routeRequest(req({ [SONATA_PROJECT_HEADER]: '/p/a' }), { ...deps, fetch: failing });
    await routeRequest(req({ [SONATA_PROJECT_HEADER]: '/p/b' }), { ...deps, fetch: failing });
    expect(seen.map((s) => s.model)).toEqual(['aaaaaaaaaaaa/flash', 'bbbbbbbbbbbb/flash']);
  });
  it('writes the project and the tenant id onto the ledger row', async () => {
    const rows: { project?: string; tenant?: string }[] = [];
    const response = await routeRequest(req({ [SONATA_PROJECT_HEADER]: '/p/a' }), { ...deps, recordUsage: (r) => rows.push(r) });
    for await (const _chunk of response.body as AsyncIterable<Buffer>) { /* Complete the streamed response to emit usage. */ }
    expect(rows[0].project).toBe('/p/a');
    // The budget sums on this, never on the cwd string: one repository entered
    // under two spellings is one tenant but two `project` values.
    expect(rows[0].tenant).toBe('aaaaaaaaaaaa');
  });
  it('namespaces a bare --model key request too', async () => {
    await routeRequest(req({ [SONATA_PROJECT_HEADER]: '/p/b' }, 'flash'), deps);
    expect(seen[0].model).toBe('bbbbbbbbbbbb/flash');
  });
  it('refuses on the tenant\'s own cap, naming its file', async () => {
    const res = await routeRequest(req({ [SONATA_PROJECT_HEADER]: '/p/a' }), {
      ...deps,
      budget: (t) => [{ dailyUsd: 1, spentUsd: 1, configPath: `${t.configPath}` }],
    });
    expect(res.status).toBe(429);
    expect(Buffer.from(res.body as Buffer).toString()).toContain('/p/a/sonata.toml');
  });
  it('returns an unrecorded 502 for an unavailable LiteLLM bare-key request', async () => {
    const rows: unknown[] = [];
    const res = await routeRequest(req({}, 'flash'), {
      ...deps,
      litellmUnavailable: () => 'LiteLLM is missing — run `sonata litellm install`',
      recordUsage: (row) => rows.push(row),
    });
    expect(res.status).toBe(502);
    expect(Buffer.from(res.body as Buffer).toString()).toContain('sonata litellm install');
    if (!Buffer.isBuffer(res.body)) for await (const _chunk of res.body) { /* Drain streaming bodies before checking accounting. */ }
    expect(rows).toEqual([]);
  });
  it('returns an unrecorded 502 for unavailable tier LiteLLM without cooling the candidate', async () => {
    let unavailable: string | undefined = 'LiteLLM is missing — run `sonata litellm install`';
    const rows: unknown[] = [];
    const res = await routeRequest(req({}), {
      ...deps,
      litellmUnavailable: () => unavailable,
      recordUsage: (row) => rows.push(row),
    });
    expect(res.status).toBe(502);
    expect(Buffer.from(res.body as Buffer).toString()).toContain('sonata litellm install');
    if (!Buffer.isBuffer(res.body)) for await (const _chunk of res.body) { /* Drain streaming bodies before checking accounting. */ }
    expect(rows).toEqual([]);

    unavailable = undefined;
    await routeRequest(req({}), { ...deps, litellmUnavailable: () => unavailable });
    expect(seen.map((request) => request.model)).toEqual(['default/flash']);
  });
  it('reads LiteLLM availability once before tier forwarding', async () => {
    let calls = 0;
    const availability = () => ++calls === 1 ? undefined : 'LiteLLM is missing — run `sonata litellm install`';
    const first = await routeRequest(req({}), { ...deps, litellmUnavailable: availability });
    expect(first.status).toBe(200);
    expect(seen.map((request) => request.model)).toEqual(['default/flash']);

    await routeRequest(req({}), { ...deps, litellmUnavailable: () => undefined });
    expect(seen.map((request) => request.model)).toEqual(['default/flash', 'default/flash']);
  });
  it('litellmModelName is <id>/<key>', () => {
    expect(litellmModelName({ id: 'x' }, 'flash')).toBe('x/flash');
  });
});

describe('createRouterServer — health', () => {
  it('reports multiTenant and the known tenants, never a configPath', async () => {
    const server = createRouterServer({
      fetch, litellmBase: 'http://litellm', litellmKey: 'k', health: true, instanceId: 'i',
      tenants: () => [{ id: 'aaaaaaaaaaaa', configPath: '/p/a/sonata.toml' }],
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const body = await (await fetch(`http://127.0.0.1:${port}/__sonata_health`)).json() as Record<string, unknown>;
      expect(body).toMatchObject({ sonata: true, multiTenant: true, instanceId: 'i', tenants: [{ id: 'aaaaaaaaaaaa', configPath: '/p/a/sonata.toml' }] });
      expect(body).not.toHaveProperty('configPath');
    } finally {
      server.close();
    }
  });
});

describe('routeTierRequest — an unavailable litellm must not mask a real attempt', () => {
  // A mixed tier: one direct candidate that genuinely fails, one litellm
  // candidate skipped because the venv is unhealthy. Answering 502 "run sonata
  // litellm install" would misdiagnose the direct gateway's own 503 — and,
  // returning before `withUsageRecording`, would drop the ledger row for a
  // request the router really did forward.
  const req = (model: string) => ({
    method: 'POST', url: '/v1/messages',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ model, messages: [] })),
  });
  const MIXED = {
    role: 'code', tier: 'simple',
    routes: [
      { key: 'direct-one', native: { gateway: 'anth', id: 'm-1', transport: 'direct' as const, baseUrl: 'http://gw.example' } },
      { key: 'litellm-one', native: { gateway: 'acme', id: 'm-2' } },
    ],
  };

  beforeEach(() => clearCooldowns());

  it('returns 529 with a ledger row when a direct candidate actually failed', async () => {
    const rows: { attempts: { key: string; status: number }[] }[] = [];
    const res = await routeRequest(req('sonata-code-simple'), {
      fetch: (async () => new Response('{}', { status: 503 })) as unknown as typeof fetch,
      litellmBase: 'http://litellm', litellmKey: 'k',
      gatewayKeys: () => ({ anth: 'KEY' }),
      resolveTier: () => MIXED,
      litellmUnavailable: () => 'LiteLLM is missing — run `sonata litellm install`',
      recordUsage: (r) => rows.push(r as never),
    });
    expect(res.status).toBe(529);
    expect(rows).toHaveLength(1);
    expect(rows[0].attempts).toEqual([{ key: 'direct-one', status: 503 }]);
  });

  it('still returns the unrecorded 502 when nothing was attempted at all', async () => {
    const rows: unknown[] = [];
    const res = await routeRequest(req('sonata-code-simple'), {
      fetch: (async () => { throw new Error('must not forward'); }) as unknown as typeof fetch,
      litellmBase: 'http://litellm', litellmKey: 'k',
      resolveTier: () => ({ role: 'code', tier: 'simple', routes: [{ key: 'litellm-one', native: { gateway: 'acme', id: 'm-2' } }] }),
      litellmUnavailable: () => 'LiteLLM is missing — run `sonata litellm install`',
      recordUsage: (r) => rows.push(r),
    });
    expect(res.status).toBe(502);
    expect(Buffer.from(res.body as Buffer).toString()).toContain('sonata litellm install');
    expect(rows).toEqual([]);
  });
});
