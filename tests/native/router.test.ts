import { describe, expect, it, beforeEach } from 'vitest';
import { routeRequest, flattenSystemBlocks, sanitizeToolSchemas, usesUnicodePropertyEscape, demoteSystemTurns, requestedModel, withModel, clearCooldowns, TIER_CAPABILITY_400_THRESHOLD, TIER_COOLDOWN_MS, conversationKey, stripForeignThinking, withEffort, STICKY_TTL_MS, createRouterServer, litellmModelName, DEFAULT_TENANT } from '../../src/native/router.js';
import { TenantError, SONATA_PROJECT_HEADER } from '../../src/native/tenants.js';
import { SONATA_TOKEN_HEADER } from '../../src/native/router-token.js';

/**
 * What a recorded call keeps: the URL, and the headers the router chose.
 *
 * Headers are normalised to a plain record because `HeadersInit` is a union
 * (a `Headers`, a pair array, or a record) that cannot be indexed, while every
 * assertion here asks about one header by name. Normalising once in the
 * fixture keeps the assertions readable and independent of which shape the
 * router happens to pass.
 */
interface FetchCall { url: string; headers: Record<string, string> }

/**
 * A `fetch` stand-in typed as the real one.
 *
 * `RouterDeps.fetch` is `typeof fetch`, so the fixture has to satisfy that
 * signature rather than the narrower one a given test happens to use — the
 * router may call it with a `Request` or a `URL`, and a fixture typed
 * `(url: string, init: any)` both hides that and accepts anything.
 */
function fakeFetch(record: FetchCall[]): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    record.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers)) });
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

const base = { litellmBase: 'http://lite', litellmKey: 'sk-local', anthropicBase: 'https://api.anthropic.com' };

describe('routeRequest', () => {
  it('routes a claude- model to anthropic with client headers forwarded', async () => {
    const rec: FetchCall[] = [];
    await routeRequest(
      { method: 'POST', url: '/v1/messages', headers: { authorization: 'Bearer usr', 'x-api-key': 'k' },
        body: Buffer.from(JSON.stringify({ model: 'claude-sonnet-5' })) },
      { ...base, fetch: fakeFetch(rec) },
    );
    expect(rec[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(rec[0].headers.authorization).toBe('Bearer usr');
  });

  it('routes a foreign model to litellm with the local key', async () => {
    const rec: FetchCall[] = [];
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
    const rec: FetchCall[] = [];
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
    const rec: FetchCall[] = [];
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
    const rec: FetchCall[] = [];
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

// ── withEffort ──
//
// The catalog ranks a model at a stated level; the router must dispatch it at
// that level or the ranking describes a different model. LiteLLM translates
// Claude Code's `thinking: {type: "adaptive"}` into `reasoning_effort: medium`
// when both are present, so an explicit level has to REPLACE the thinking
// block rather than sit beside it.
describe('withEffort', () => {
  const parse = (b: Buffer) => JSON.parse(b.toString());

  it('sets reasoning_effort and removes thinking and output_config.effort', () => {
    const body = Buffer.from(JSON.stringify({
      model: 'm', thinking: { type: 'adaptive' }, output_config: { effort: 'medium', other: 1 }, messages: [],
    }));
    expect(parse(withEffort(body, 'xhigh'))).toEqual({
      model: 'm', reasoning_effort: 'xhigh', output_config: { other: 1 }, messages: [],
    });
  });

  it('drops an output_config left empty rather than sending {}', () => {
    const body = Buffer.from(JSON.stringify({ model: 'm', output_config: { effort: 'low' } }));
    expect(parse(withEffort(body, 'high'))).toEqual({ model: 'm', reasoning_effort: 'high' });
  });

  it('returns the identical buffer for a bare candidate', () => {
    const body = Buffer.from('{"model":"m","thinking":{"type":"adaptive"}}');
    expect(withEffort(body, undefined)).toBe(body);
  });

  it('returns the identical buffer when the body does not parse', () => {
    const body = Buffer.from('not json');
    expect(withEffort(body, 'low')).toBe(body);
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
    // These cases are about resolution, not authorisation; the hint is
    // authorised so the header path under test is actually reached.
    projectHintToken: 'test-token',
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
    headers: { 'content-type': 'application/json', [SONATA_TOKEN_HEADER]: 'test-token', ...headers },
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
      // No `ui` dep here, so the capability is false: a caller must be able to
      // tell a router that serves the UI from one that does not, rather than
      // printing a URL that 404s.
      expect(body.ui).toBe(false);
    } finally {
      server.close();
    }
  });

  it('reports not-ready while eager LiteLLM startup is still pending', async () => {
    const server = createRouterServer({
      fetch, litellmBase: 'http://litellm', litellmKey: 'k', health: true,
      healthReady: () => false,
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/__sonata_health`);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ sonata: true, ready: false });
    } finally {
      server.close();
    }
  });

  it('reports ui: true when the UI is mounted', async () => {
    const server = createRouterServer({
      fetch, litellmBase: 'http://litellm', litellmKey: 'k', health: true,
      ui: { home: '/tmp/nowhere', port: 4100 },
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const body = await (await fetch(`http://127.0.0.1:${port}/__sonata_health`)).json() as Record<string, unknown>;
      expect(body.ui).toBe(true);
      // The health route still wins over the UI prefix test.
      expect(body.sonata).toBe(true);
    } finally {
      server.close();
    }
  });

  it('serves the page at / and leaves a POST / to the proxy', async () => {
    let proxied = 0;
    // The bound port is only known after `listen`, and the Host check needs it
    // -- the same reason `sonata serve` writes it back into its own UiDeps.
    const ui = { home: '/tmp/nowhere', port: 0 };
    const server = createRouterServer({
      fetch: (async () => { proxied += 1; return new Response('{}', { status: 200 }); }) as unknown as typeof fetch,
      litellmBase: 'http://litellm', litellmKey: 'k', health: true, ui,
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    ui.port = port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/text\/html/);
      expect(await res.text()).toContain('<!doctype html>');
      expect(proxied).toBe(0);

      // The regression that matters: a bare POST / is a proxied request.
      const post = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: '{}' });
      await post.text();
      expect(proxied).toBe(1);
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

describe('routeRequest — the project hint is authorised, not merely trusted', () => {
  // The router authenticates nobody on loopback. `x-sonata-project` chooses
  // which config — and so which gateways, endpoints and stored credentials —
  // serve a request, so an unauthorised caller must not get its pick.
  const seen: string[] = [];
  const capture: typeof fetch = (async (_url: string, init: RequestInit) => {
    seen.push((JSON.parse(Buffer.from(init.body as Uint8Array).toString()) as { model: string }).model);
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;

  const MINE = { id: 'mine', project: '/p/mine', configPath: '/p/mine/sonata.toml' };
  const THEIRS = { id: 'theirs', project: '/p/theirs', configPath: '/p/theirs/sonata.toml' };
  const deps = {
    fetch: capture, litellmBase: 'http://litellm', litellmKey: 'k',
    projectHintToken: 'sekret',
    resolveTenant: (hint: { project?: string; session?: string }) =>
      (hint.project === '/p/theirs' ? THEIRS : MINE),
    resolveTier: () => ({ role: 'code', tier: 'simple', routes: [{ key: 'flash', native: { gateway: 'g', id: 'f-1' } }] }),
  };
  const req = (headers: Record<string, string>) => ({
    method: 'POST', url: '/v1/messages',
    headers: { 'content-type': 'application/json', ...headers },
    body: Buffer.from(JSON.stringify({ model: 'sonata-code-simple', messages: [] })),
  });

  beforeEach(() => { seen.length = 0; clearCooldowns(); });

  it('honours the hint when the token matches', async () => {
    await routeRequest(req({ [SONATA_PROJECT_HEADER]: '/p/theirs', [SONATA_TOKEN_HEADER]: 'sekret' }), deps);
    expect(seen).toEqual(['theirs/flash']);
  });

  it('ignores the hint when the token is absent, wrong, or empty', async () => {
    for (const headers of [
      { [SONATA_PROJECT_HEADER]: '/p/theirs' },
      { [SONATA_PROJECT_HEADER]: '/p/theirs', [SONATA_TOKEN_HEADER]: 'guessed' },
      { [SONATA_PROJECT_HEADER]: '/p/theirs', [SONATA_TOKEN_HEADER]: '' },
    ]) {
      seen.length = 0;
      clearCooldowns();
      const res = await routeRequest(req(headers), deps);
      // Served, not refused: an unauthorised caller falls back to the ordinary
      // session/machine resolution, exactly as a request with no hint would.
      expect(res.status).toBe(200);
      expect(seen).toEqual(['mine/flash']);
    }
  });

  it('ignores the hint when the router itself holds no token', async () => {
    await routeRequest(
      req({ [SONATA_PROJECT_HEADER]: '/p/theirs', [SONATA_TOKEN_HEADER]: 'sekret' }),
      { ...deps, projectHintToken: undefined },
    );
    expect(seen).toEqual(['mine/flash']);
  });

  it('says so in the log rather than silently downgrading', async () => {
    const lines: string[] = [];
    await routeRequest(req({ [SONATA_PROJECT_HEADER]: '/p/theirs' }), { ...deps, log: (l) => lines.push(l) });
    expect(lines.join('\n')).toContain(SONATA_PROJECT_HEADER);
  });

  it('strips the token from every forwarded request', async () => {
    const headersSeen: Record<string, string>[] = [];
    const spy: typeof fetch = (async (_u: string, init: RequestInit) => {
      headersSeen.push(init.headers as Record<string, string>);
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    await routeRequest(req({ [SONATA_PROJECT_HEADER]: '/p/mine', [SONATA_TOKEN_HEADER]: 'sekret' }), { ...deps, fetch: spy });
    await routeRequest(
      { ...req({ [SONATA_TOKEN_HEADER]: 'sekret' }), body: Buffer.from(JSON.stringify({ model: 'claude-sonnet-5', messages: [] })) },
      { ...deps, fetch: spy, anthropicBase: 'http://anthropic' },
    );
    for (const h of headersSeen) {
      expect(Object.keys(h).map((k) => k.toLowerCase())).not.toContain(SONATA_TOKEN_HEADER);
    }
  });
});

// ── A conversation must keep its model, and survive losing it ──
//
// Ranked fallback picks a candidate per request, which is right for one
// request and wrong for a conversation: a transcript carrying one model's
// extended-thinking blocks handed to another is rejected outright with
// "The content[].thinking in the thinking mode must be passed back to the
// API" — a 400 that kills a multi-turn agent mid-task and reads as a defect
// in its own work. Observed twice on 2026-09-13 (issue #30).
describe('conversation stickiness', () => {
  const ROUTES = {
    role: 'code', tier: 'simple',
    routes: [
      { key: 'flash', native: { gateway: 'g', id: 'flash-1' } },
      { key: 'luna', native: { gateway: 'g', id: 'luna-1' } },
    ],
  };

  const THINKING = { type: 'thinking', thinking: 'step one', signature: 'sig-abc' };

  /** Turn `n` of one conversation: messages[0] is invariant as turns append. */
  const turn = (n: number, opener = 'implement the parser') => ({
    method: 'POST', url: '/v1/messages',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({
      model: 'sonata-code-simple',
      messages: [
        { role: 'user', content: opener },
        ...Array.from({ length: n - 1 }, () => (
          { role: 'assistant', content: [THINKING, { type: 'text', text: 'ok' }] }
        )),
      ],
    })),
  });

  beforeEach(() => clearCooldowns());

  const harness = () => {
    const seen: string[] = [];
    const bodies: any[] = [];
    const state = { flashFails: true, clock: 1_000 };
    const deps = {
      fetch: (async (_url: string, init: RequestInit) => {
        const payload = JSON.parse(init.body as string) as { model: string };
        seen.push(payload.model);
        bodies.push(payload);
        return new Response('{}', { status: payload.model === 'default/flash' && state.flashFails ? 503 : 200 });
      }) as unknown as typeof fetch,
      litellmBase: 'http://litellm', litellmKey: 'k',
      resolveTier: () => ROUTES,
      now: () => state.clock,
    };
    return { seen, bodies, state, deps };
  };

  it('keeps a conversation on the candidate that served it after the ranked leader recovers', async () => {
    const { seen, state, deps } = harness();

    // Turn 1: the leader fails, so luna serves — and is remembered.
    await routeRequest(turn(1), deps);
    expect(seen).toEqual(['default/flash', 'default/luna']);

    // flash recovers and its cooldown lapses, so rank order would pick it again.
    state.flashFails = false;
    state.clock += TIER_COOLDOWN_MS + 1;

    // Turn 2 of the SAME conversation still goes to luna.
    await routeRequest(turn(2), deps);
    expect(seen.slice(2)).toEqual(['default/luna']);

    // A different conversation is unaffected and gets the ranked leader.
    await routeRequest(turn(1, 'write the docs'), deps);
    expect(seen.slice(3)).toEqual(['default/flash']);
  });

  it('is a preference, not a pin: a cooling sticky candidate still falls through', async () => {
    const { seen, state, deps } = harness();
    state.flashFails = false;

    await routeRequest(turn(1), deps);
    expect(seen).toEqual(['default/flash']);

    // The pinned candidate now fails; the tier must still fall through to luna
    // rather than dying on the model the conversation happens to prefer.
    state.flashFails = true;
    await routeRequest(turn(2), deps);
    expect(seen.slice(1)).toEqual(['default/flash', 'default/luna']);
  });

  it("drops the previous model's thinking blocks when a conversation changes hands", async () => {
    const { seen, bodies, state, deps } = harness();
    state.flashFails = false;

    await routeRequest(turn(1), deps);
    // Turn 2 carries flash's thinking blocks; flash then fails, so luna takes over.
    state.flashFails = true;
    await routeRequest(turn(3), deps);

    expect(seen).toEqual(['default/flash', 'default/flash', 'default/luna']);
    const served = bodies.at(-1)!;
    const types = served.messages.flatMap((m: any) => Array.isArray(m.content) ? m.content.map((b: any) => b.type) : []);
    expect(types).not.toContain('thinking');
    // The conversation's actual content survives — only the other model's
    // internal reasoning is gone.
    expect(types).toContain('text');
    expect(served.messages[0]).toEqual({ role: 'user', content: 'implement the parser' });
  });

  it('leaves the body untouched while a conversation stays on its candidate', async () => {
    const { bodies, state, deps } = harness();
    state.flashFails = false;

    await routeRequest(turn(1), deps);
    await routeRequest(turn(3), deps);

    const types = bodies.at(-1)!.messages.flatMap((m: any) => Array.isArray(m.content) ? m.content.map((b: any) => b.type) : []);
    expect(types).toContain('thinking');
  });

  // CodeRabbit #32: a pinned candidate that 400s was preferred again on every
  // retry until the 2h TTL. An UNRECOGNISED 400 never earns the capability
  // cooldown, so nothing else broke the loop either.
  it('stops preferring a candidate that hands back a 400', async () => {
    const seen: string[] = [];
    const state = { flash400: false };
    const deps = {
      fetch: (async (_url: string, init: RequestInit) => {
        const model = (JSON.parse(init.body as string) as { model: string }).model;
        seen.push(model);
        return model === 'default/flash' && state.flash400
          ? new Response(JSON.stringify({ error: { message: 'some client error' } }), { status: 400 })
          : new Response('{}', { status: 200 });
      }) as unknown as typeof fetch,
      litellmBase: 'http://litellm', litellmKey: 'k',
      resolveTier: () => ROUTES,
    };

    // flash serves and is pinned.
    await routeRequest(turn(1), deps);
    expect(seen).toEqual(['default/flash']);

    // It now 400s. The 400 is returned to the caller (not a recognised
    // capability failure), so nothing cools it down.
    state.flash400 = true;
    expect((await routeRequest(turn(2), deps)).status).toBe(400);
    expect(seen.slice(1)).toEqual(['default/flash']);

    // The retry must NOT prefer it again. Rank order puts flash first anyway,
    // so it is tried, 400s, and the tier falls through — the point is that the
    // pin is no longer forcing it ahead of a healthy candidate.
    await routeRequest(turn(2), deps);
    expect(seen.slice(2)).toEqual(['default/flash']);
  });

  // The reason the pin is DEMOTED rather than deleted: the record of whose
  // thinking blocks the transcript carries has to outlive the preference, or
  // the next candidate receives them and 400s on exactly the bug this fixes.
  it('still strips the demoted model\'s thinking blocks when another candidate takes over', async () => {
    const seen: string[] = [];
    const bodies: any[] = [];
    // phase 1: flash is down, so luna serves and is pinned.
    // phase 2: luna 400s, demoting the pin.
    // phase 3: flash is healthy and leads on rank order again.
    const state = { phase: 1, clock: 1_000 };
    const deps = {
      fetch: (async (_url: string, init: RequestInit) => {
        const payload = JSON.parse(init.body as string) as { model: string };
        seen.push(payload.model);
        bodies.push(payload);
        const flash = payload.model === 'default/flash';
        if (state.phase === 1) return new Response('{}', { status: flash ? 503 : 200 });
        if (state.phase === 2 && !flash) {
          return new Response(JSON.stringify({ error: { message: 'client error' } }), { status: 400 });
        }
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch,
      litellmBase: 'http://litellm', litellmKey: 'k',
      resolveTier: () => ROUTES,
      now: () => state.clock,
    };

    await routeRequest(turn(1), deps);
    expect(seen).toEqual(['default/flash', 'default/luna']);

    // Luna is now preferred over the ranked leader, and 400s.
    state.phase = 2;
    expect((await routeRequest(turn(3), deps)).status).toBe(400);
    expect(seen.slice(2)).toEqual(['default/luna']);

    // Retried: the preference is gone, so flash leads on rank again — and it
    // must still receive the transcript with luna's thinking blocks removed.
    // Past flash's 503 cooldown, well short of the sticky TTL that would erase
    // the memory of luna having served.
    state.phase = 3;
    state.clock += TIER_COOLDOWN_MS + 1;
    await routeRequest(turn(3), deps);
    const served = bodies.at(-1)!;
    expect(served.model).toBe('default/flash');
    const types = served.messages.flatMap((m: any) => Array.isArray(m.content) ? m.content.map((b: any) => b.type) : []);
    expect(types).not.toContain('thinking');
    expect(types).toContain('text');
  });

  it('forgets a conversation that has been idle past the TTL', async () => {
    const { seen, state, deps } = harness();

    await routeRequest(turn(1), deps);
    expect(seen).toEqual(['default/flash', 'default/luna']);

    state.flashFails = false;
    state.clock += STICKY_TTL_MS + 1;

    // The pin has aged out, so rank order applies again.
    await routeRequest(turn(2), deps);
    expect(seen.slice(2)).toEqual(['default/flash']);
  });
});

// ── Effort-level candidates ──
//
// A `[tiers]` candidate may pin a level (`luna@xhigh`). The router is the
// layer that knows a request's level, so it is where the level is injected,
// and the ledger row names it for the same reason it names the candidate.
describe('effort-level candidates', () => {
  const ROUTES = {
    role: 'code', tier: 'complex',
    routes: [
      { key: 'luna', effort: 'xhigh' as const, native: { gateway: 'g', id: 'luna-1' } },
      { key: 'luna', effort: 'high' as const, native: { gateway: 'g', id: 'luna-1' } },
      { key: 'flash', native: { gateway: 'g', id: 'flash-1' } },
    ],
  };
  const DIRECT = {
    role: 'code', tier: 'complex',
    routes: [{ key: 'orr', effort: 'low' as const, native: {
      gateway: 'g', id: 'or-1', transport: 'direct' as const, baseUrl: 'https://gw.example/v1',
    } }],
  };
  const request = (model = 'sonata-code-complex') => ({
    method: 'POST', url: '/v1/messages',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({
      model,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      messages: [{ role: 'user', content: 'go' }],
    })),
  });

  beforeEach(() => clearCooldowns());

  const harness = (routes: typeof ROUTES | typeof DIRECT, failing: string[] = []) => {
    const bodies: any[] = [];
    const logs: string[] = [];
    const rows: any[] = [];
    const clock = { now: 1_000 };
    const deps = {
      fetch: (async (_url: string, init: RequestInit) => {
        const payload = JSON.parse(init.body as string);
        bodies.push(payload);
        return new Response('{"ok":true}', {
          status: failing.includes(payload.model) ? 503 : 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch,
      litellmBase: 'http://litellm', litellmKey: 'k',
      gatewayKeys: () => ({ g: 'GATEWAY-KEY' }),
      resolveTier: () => routes,
      recordUsage: (row: any) => rows.push(row),
      log: (line: string) => logs.push(line),
      now: () => clock.now,
    };
    return { bodies, logs, rows, clock, deps };
  };
  /** A streamed response records its row only once the body is consumed. */
  const drain = async (res: { body: AsyncIterable<Uint8Array> | Buffer }) => {
    if (Buffer.isBuffer(res.body)) return;
    for await (const _chunk of res.body) { /* consume */ }
  };

  it('sends reasoning_effort and drops thinking on the litellm path', async () => {
    const { bodies, deps } = harness(ROUTES);
    await routeRequest(request(), deps);
    expect(bodies[0]).toMatchObject({ model: 'default/luna', reasoning_effort: 'xhigh' });
    expect(bodies[0].thinking).toBeUndefined();
    expect(bodies[0].output_config).toBeUndefined();
  });

  it('sends reasoning_effort on the direct path too, leaving the rest of the body alone', async () => {
    const { bodies, deps } = harness(DIRECT);
    const req = request();
    await routeRequest(req, deps);
    const { thinking: _t, output_config: _o, ...original } = JSON.parse(req.body.toString());
    expect(bodies[0]).toEqual({ ...original, model: 'or-1', reasoning_effort: 'low' });
  });

  it('leaves a bare candidate\'s body exactly as before', async () => {
    const { bodies, deps } = harness(ROUTES, ['default/luna']);
    await routeRequest(request(), deps);
    // luna@xhigh failed, luna@high is the same model (skipped by cooldown),
    // so flash — bare — served, with the request untouched.
    const served = bodies[bodies.length - 1];
    expect(served.model).toBe('default/flash');
    expect(served.reasoning_effort).toBeUndefined();
    expect(served.thinking).toEqual({ type: 'adaptive' });
    expect(served.output_config).toEqual({ effort: 'medium' });
  });

  it('cools the MODEL after a variant fails, so the next level of the same model is skipped', async () => {
    const { bodies, deps } = harness(ROUTES, ['default/luna']);
    await routeRequest(request(), deps);
    // One attempt at luna (xhigh), then straight to flash: luna@high was not retried.
    expect(bodies.map((b) => [b.model, b.reasoning_effort])).toEqual([
      ['default/luna', 'xhigh'],
      ['default/flash', undefined],
    ]);
  });

  it('names the variant in the log line', async () => {
    const { logs, deps } = harness(ROUTES);
    await routeRequest(request(), deps);
    expect(logs).toContain('POST /v1/messages model=sonata-code-complex -> luna@xhigh -> litellm');
  });

  it('records the effort on the ledger row', async () => {
    const { rows, deps } = harness(ROUTES);
    await drain(await routeRequest(request(), deps));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: 'luna', effort: 'xhigh' });
  });

  it('leaves the ledger row\'s effort absent for a bare candidate', async () => {
    const { rows, deps } = harness(ROUTES, ['default/luna']);
    await drain(await routeRequest(request(), deps));
    expect(rows[0].key).toBe('flash');
    expect('effort' in rows[0]).toBe(false);
  });

  // `sonata dispatch --model <key>@<effort>` on a native-only key runs the
  // claude harness, whose `--model` names a bare sonata key to the router.
  // The router accepts the same grammar there, so the harness lane can honour
  // a level without a second wire format.
  it('accepts <key>@<effort> as a bare model name', async () => {
    const { bodies, rows, deps } = harness(ROUTES);
    await drain(await routeRequest(request('flash@low'), deps));
    expect(bodies[0]).toMatchObject({ model: 'default/flash', reasoning_effort: 'low' });
    expect(bodies[0].thinking).toBeUndefined();
    expect(rows[0]).toMatchObject({ alias: 'flash', effort: 'low' });
  });

  it('refuses an unknown level on a bare model name with a 400 naming the levels', async () => {
    const { bodies, deps } = harness(ROUTES);
    const res = await routeRequest(request('flash@bogus'), deps);
    expect(res.status).toBe(400);
    expect(JSON.parse((res.body as Buffer).toString()).error.message)
      .toContain('unknown effort level "bogus"');
    expect(bodies).toHaveLength(0);
  });
});

describe('conversationKey', () => {
  const body = (messages: unknown[]) => Buffer.from(JSON.stringify({ model: 'm', messages }));
  const opener = { role: 'user', content: 'hello' };

  it('is stable as turns are appended', () => {
    const one = conversationKey(body([opener]), 't', 'sonata-code-simple');
    const many = conversationKey(body([opener, { role: 'assistant', content: 'hi' }, { role: 'user', content: 'more' }]), 't', 'sonata-code-simple');
    expect(one).toBeDefined();
    expect(many).toBe(one);
  });

  it('separates two roles that open with the same message, and two tenants', () => {
    const a = conversationKey(body([opener]), 't', 'sonata-code-simple');
    expect(conversationKey(body([opener]), 't', 'sonata-review-simple')).not.toBe(a);
    expect(conversationKey(body([opener]), 'other', 'sonata-code-simple')).not.toBe(a);
  });

  it('is undefined for a body with no messages, so stickiness simply does not apply', () => {
    expect(conversationKey(body([]), 't', 'a')).toBeUndefined();
    expect(conversationKey(Buffer.from('not json'), 't', 'a')).toBeUndefined();
  });
});

describe('stripForeignThinking', () => {
  const roundTrip = (payload: unknown) => JSON.parse(stripForeignThinking(Buffer.from(JSON.stringify(payload))).toString());

  it('drops thinking and redacted_thinking but keeps text and tool_use', () => {
    const out = roundTrip({
      messages: [{
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'x', signature: 's' },
          { type: 'redacted_thinking', data: 'opaque' },
          { type: 'text', text: 'answer' },
          { type: 'tool_use', id: 'tu', name: 'Read', input: {} },
        ],
      }],
    });
    expect(out.messages[0].content.map((b: any) => b.type)).toEqual(['text', 'tool_use']);
  });

  it('leaves user messages alone even if they carry a thinking-shaped block', () => {
    const payload = { messages: [{ role: 'user', content: [{ type: 'thinking', thinking: 'quoted' }] }] };
    expect(roundTrip(payload)).toEqual(payload);
  });

  it('drops an assistant turn left with no content rather than sending an empty array', () => {
    // An empty content array is itself a 400, and a turn that was nothing but
    // thinking carried nothing the next model can act on.
    const out = roundTrip({
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'only this' }] },
      ],
    });
    expect(out.messages).toEqual([{ role: 'user', content: 'go' }]);
  });

  it('returns the identical buffer when there is nothing to strip', () => {
    const body = Buffer.from(JSON.stringify({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'a' }] }] }));
    expect(stripForeignThinking(body)).toBe(body);
  });

  it('passes a body it cannot parse straight through', () => {
    const body = Buffer.from('not json');
    expect(stripForeignThinking(body)).toBe(body);
  });
});

describe('the UI does not disturb the proxy', () => {
  it('routes API requests through the proxy and handles UI writes locally', async () => {
    const rec: FetchCall[] = [];
    const ui = { home: '/tmp/nowhere', port: 0 };
    const server = createRouterServer({
      ...base,
      fetch: fakeFetch(rec) as typeof fetch,
      ui,
    });
    await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve));
    const port = (server.address() as { port: number }).port;
    ui.port = port;
    try {
      const proxied = await fetch(`http://localhost:${port}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-sonnet-5' }),
      });
      expect(proxied.status).toBe(200);
      expect(rec[0].url).toBe('https://api.anthropic.com/v1/messages');

      const uiWrite = await fetch(`http://localhost:${port}/__sonata/api/usage`, { method: 'POST' });
      expect(uiWrite.status).toBe(405);
      expect(rec).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
