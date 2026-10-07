import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import { clearCooldowns, respond, routeRequest, TIER_COOLDOWN_MS, type RouterDeps } from '../../src/native/router.js';
import type { LedgerRow } from '../../src/ledger.js';

const DELTA = 'event: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":100,"output_tokens":7}}\n\n';

function sse(text: string, headers: Record<string, string> = {}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream', ...headers } });
}

/** A 200 of any content type, streamed the way an upstream would send it. */
function body200(text: string, contentType: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': contentType } });
}

/** A 200 JSON body streamed as the given chunks, with a pause between them when asked. */
function jsonChunks(chunks: string[], gapMs = 0): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const [i, chunk] of chunks.entries()) {
        if (i > 0 && gapMs > 0) await new Promise((resolve) => setTimeout(resolve, gapMs));
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } });
}

function deps(rows: LedgerRow[], response: () => Response): RouterDeps {
  return {
    fetch: (async () => response()) as unknown as typeof fetch,
    litellmBase: 'http://litellm.invalid',
    litellmKey: 'k',
    recordUsage: (row) => rows.push(row),
    resolveTier: (alias) => alias === 'sonata-code-simple'
      ? { role: 'code', tier: 'simple', routes: [{ key: 'flash', native: { gateway: 'acme', id: 'x' } }] }
      : undefined,
  };
}

async function drain(body: AsyncIterable<Uint8Array> | Buffer): Promise<string> {
  if (Buffer.isBuffer(body)) return body.toString();
  let out = '';
  for await (const chunk of body) out += new TextDecoder().decode(chunk);
  return out;
}

const req = (model: string) => ({
  method: 'POST',
  url: '/v1/messages',
  headers: { 'x-claude-code-session-id': 'sess-1' },
  body: Buffer.from(JSON.stringify({ model, messages: [] })),
});

describe('router usage recording', () => {
  it('records tokens from the stream tail without altering the body', async () => {
    clearCooldowns();
    const rows: LedgerRow[] = [];
    const res = await routeRequest(req('sonata-code-simple'), deps(rows, () => sse(DELTA, {
      'x-litellm-model-name': 'flash', 'x-litellm-call-id': 'call-1',
    })));
    expect(await drain(res.body)).toBe(DELTA);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      session: 'sess-1', alias: 'sonata-code-simple', role: 'code', tier: 'simple',
      key: 'flash', upstream: 'litellm', status: 200, complete: true,
      litellmModel: 'flash', callId: 'call-1',
    });
    expect(rows[0].tokens).toMatchObject({ input: 100, output: 7 });
  });

  it('records a row even when the stream carries no usage frame', async () => {
    clearCooldowns();
    const rows: LedgerRow[] = [];
    const res = await routeRequest(req('sonata-code-simple'), deps(rows, () => sse('event: ping\ndata: {}\n\n')));
    await drain(res.body);
    expect(rows[0].complete).toBe(false);
  });

  it('records partial usage as incomplete when the client abandons the stream', async () => {
    clearCooldowns();
    const rows: LedgerRow[] = [];
    const res = await routeRequest(req('sonata-code-simple'), deps(rows, () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(DELTA));
          controller.enqueue(new TextEncoder().encode('event: ping\ndata: {}\n\n'));
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }));
    const iterator = (res.body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next(); // Advances past the first yield, so its usage is observed.
    await iterator.return?.(undefined);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ complete: false, tokens: { input: 100, output: 7 } });
  });

  it('records partial usage when the upstream stream throws without swallowing it', async () => {
    clearCooldowns();
    const rows: LedgerRow[] = [];
    const upstreamError = new Error('upstream stream failed');
    const res = await routeRequest(req('sonata-code-simple'), deps(rows, () => {
      let pulls = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulls++ === 0) controller.enqueue(new TextEncoder().encode(DELTA));
          else controller.error(upstreamError);
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }));
    await expect(drain(res.body)).rejects.toThrow('upstream stream failed');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ complete: false, tokens: { input: 100, output: 7 } });
  });

  it('never lets a recorder throw reach the caller', async () => {
    clearCooldowns();
    const bad: RouterDeps = {
      ...deps([], () => sse(DELTA)),
      recordUsage: () => { throw new Error('ledger is on fire'); },
    };
    const res = await routeRequest(req('sonata-code-simple'), bad);
    await expect(drain(res.body)).resolves.toBe(DELTA);
  });

  it('records the failed candidates that preceded the one that answered', async () => {
    clearCooldowns();
    const rows: LedgerRow[] = [];
    let call = 0;
    const d: RouterDeps = {
      ...deps(rows, () => (call++ === 0 ? new Response('{}', { status: 500 }) : sse(DELTA))),
      resolveTier: () => ({
        role: 'code', tier: 'simple',
        routes: [
          { key: 'first', native: { gateway: 'acme', id: 'a' } },
          { key: 'second', native: { gateway: 'acme', id: 'b' } },
        ],
      }),
    };
    const res = await routeRequest(req('sonata-code-simple'), d);
    await drain(res.body);
    expect(rows[0].key).toBe('second');
    expect(rows[0].attempts).toEqual([{ key: 'first', status: 500 }]);
  });

  it('records key and gateway for a direct --model request so it can be priced', async () => {
    clearCooldowns();
    const rows: LedgerRow[] = [];
    const d = { ...deps(rows, () => sse(DELTA)), resolveGateway: (key: string) => key === 'flash' ? 'acme' : undefined };
    // A direct model request (not a tier alias) never passes through
    // `resolveTier`; its key is the model string itself and its gateway comes
    // from `resolveGateway`.
    const res = await routeRequest(req('flash'), d);
    await drain(res.body);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ alias: 'flash', key: 'flash', gateway: 'acme', role: undefined, tier: undefined });
  });

  it('records the anthropic path too', async () => {
    clearCooldowns();
    const rows: LedgerRow[] = [];
    const d = { ...deps(rows, () => sse(DELTA)), anthropicBase: 'https://anthropic.invalid' };
    const res = await routeRequest(req('claude-sonnet-5'), d);
    await drain(res.body);
    expect(rows[0]).toMatchObject({ upstream: 'anthropic', alias: 'claude-sonnet-5' });
  });

  it('records `ts` at request start, not at stream completion', async () => {
    clearCooldowns();
    const rows: LedgerRow[] = [];
    // `now` is called twice: once for `startedAt` at request start, once for
    // `endedAt` at emit. A request starting before midnight and completing
    // after it must keep the start timestamp, so its price window (and its
    // ledger day file) are the ones it started under.
    let clock = Date.parse('2026-08-27T23:59:00.000Z');
    const d = { ...deps(rows, () => sse(DELTA)), now: () => (clock += 1000) };
    const res = await routeRequest(req('sonata-code-simple'), d);
    await drain(res.body);
    expect(rows).toHaveLength(1);
    expect(rows[0].ts).toBe('2026-08-27T23:59:01.000Z');
    // Duration stays tied to completion: startedAt was 23:59:01, endedAt 23:59:02.
    expect(rows[0].ms).toBe(1000);
  });

  it('records a 529 when every candidate failed', async () => {
    clearCooldowns();
    const rows: LedgerRow[] = [];
    const d: RouterDeps = {
      ...deps(rows, () => new Response('{}', { status: 500 })),
      resolveTier: () => ({ role: 'code', tier: 'simple', routes: [{ key: 'only', native: { gateway: 'a', id: 'b' } }] }),
    };
    const res = await routeRequest(req('sonata-code-simple'), d);
    expect(res.status).toBe(529);
    expect(rows[0]).toMatchObject({ status: 529, complete: false });
    expect(rows[0].attempts).toEqual([{ key: 'only', status: 500 }]);
  });
});

describe('the usage recorder gets the config the request was routed under', () => {
  it('hands recordUsage the tenant config resolved at request start, not one read at stream end', async () => {
    const { parseConfig } = await import('../../src/config.js');
    const atStart = parseConfig('');
    const later = parseConfig('');
    let current = atStart;
    const seen: unknown[] = [];
    const res = await routeRequest(req('sonata-code-simple'), {
      ...deps([], () => sse(DELTA)),
      resolveTenant: () => ({ id: 't', configPath: '/p/sonata.toml', config: current }),
      recordUsage: (_row, config) => seen.push(config),
    });
    // The config on disk changes while the response is still streaming.
    current = later;
    await drain(res.body);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(atStart);
  });
});

describe('router — text-form tool calls', () => {
  const CALL = '<tool_call><function=Bash><parameter=command>ls</parameter></function></tool_call>';
  const UNPARSED = 'x <tool_call><function=Nope></function></tool_call>';
  const ev = (type: string, data: Record<string, unknown>): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const stream = (text: string): string => [
    ev('message_start', { message: { id: 'm', role: 'assistant', content: [] } }),
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }),
    ev('content_block_stop', { index: 0 }),
    ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 10, output_tokens: 5 } }),
    ev('message_stop', {}),
  ].join('');
  const withTools = (model: string) => ({
    ...req(model),
    body: Buffer.from(JSON.stringify({ model, messages: [], tools: [{ name: 'Bash', input_schema: { type: 'object', properties: { command: { type: 'string' } } } }] })),
  });

  it('cancels upstream when the client disconnects through the full wrapper chain', async () => {
    clearCooldowns();
    const rows: LedgerRow[] = [];
    let cancelled = false;
    const message = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    const firstChunk = [
      message('message_start', { message: { id: 'm', role: 'assistant', content: [] } }),
      message('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      message('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'hello' } }),
    ].join('');
    const d = deps(rows, () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(firstChunk)); },
      cancel() { cancelled = true; },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const request = {
      ...withTools('sonata-code-simple'),
      body: Buffer.from(JSON.stringify({
        model: 'sonata-code-simple', messages: [{ role: 'user', content: 'hello' }],
        tools: [{ name: 'Bash', input_schema: { type: 'object', properties: { command: { type: 'string' } } } }],
      })),
    };
    const routed = await routeRequest(request, d);
    const chunks: string[] = [];
    const res = Object.assign(new EventEmitter(), {
      destroyed: false, writableEnded: false,
      writeHead: () => undefined,
      write: (chunk: Uint8Array) => {
        chunks.push(Buffer.from(chunk).toString());
        res.destroyed = true;
        res.emit('close');
        return true;
      },
      end: () => undefined,
    });
    await respond(res as never, routed);
    const deadline = Date.now() + 2_000;
    while (rows.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(cancelled).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0].complete).toBe(false);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('hello');
  });

  it('recovers a text tool call, rewrites stop_reason, and records it', async () => {
    clearCooldowns();
    const rows: LedgerRow[] = [];
    const res = await routeRequest(withTools('sonata-code-simple'), deps(rows, () => sse(stream('Go ' + CALL))));
    const out = await drain(res.body);
    expect(out).toContain('"type":"tool_use"');
    expect(out).toContain('"stop_reason":"tool_use"');
    expect(rows[0].textToolCalls).toEqual({ recovered: 1, unparsed: 0 });
  });

  it('recovers a text call to a tool Claude Code defined inside messages, not in tools[]', async () => {
    clearCooldowns();
    const rows: LedgerRow[] = [];
    const inline = {
      ...req('sonata-code-simple'),
      body: Buffer.from(JSON.stringify({
        model: 'sonata-code-simple',
        tools: [{ name: 'Read', input_schema: { type: 'object' } }],
        messages: [
          { role: 'user', content: 'task' },
          { role: 'system', content: [{ type: 'tool_addition', tool: { type: 'tool_definition', definition: { name: 'Bash', input_schema: { type: 'object', properties: { command: { type: 'string' } } } } } }] },
        ],
      })),
    };
    const res = await routeRequest(inline, deps(rows, () => sse(stream(CALL))));
    const out = await drain(res.body);
    expect(out).toContain('"name":"Bash"');
    expect(rows[0].textToolCalls).toEqual({ recovered: 1, unparsed: 0 });
  });

  it('cools the candidate on an unparsed call so the next request takes the next one', async () => {
    clearCooldowns();
    const rows: LedgerRow[] = [];
    const seen: string[] = [];
    const twoModels: RouterDeps = {
      ...deps(rows, () => sse(stream('x <tool_call><function=Nope></function></tool_call>'))),
      fetch: (async (_url: string, init: { body: string }) => {
        seen.push(JSON.parse(init.body).model);
        return sse(stream('x <tool_call><function=Nope></function></tool_call>'));
      }) as unknown as typeof fetch,
      resolveTier: (alias) => alias === 'sonata-code-simple'
        ? { role: 'code', tier: 'simple', routes: [{ key: 'flash', native: { gateway: 'acme', id: 'x' } }, { key: 'pro', native: { gateway: 'acme', id: 'y' } }] }
        : undefined,
    };
    await drain((await routeRequest(withTools('sonata-code-simple'), twoModels)).body);
    await drain((await routeRequest(withTools('sonata-code-simple'), twoModels)).body);
    expect(rows[0].textToolCalls).toEqual({ recovered: 0, unparsed: 1 });
    expect(rows[0].key).toBe('flash');
    expect(rows[1].key).toBe('pro');
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  });

  it('does not cool the candidate on a recovered call so the next request takes the same one', async () => {
    clearCooldowns();
    const rows: LedgerRow[] = [];
    const seen: string[] = [];
    const twoModels: RouterDeps = {
      ...deps(rows, () => sse(stream('Go ' + CALL))),
      fetch: (async (_url: string, init: { body: string }) => {
        seen.push(JSON.parse(init.body).model);
        return sse(stream('Go ' + CALL));
      }) as unknown as typeof fetch,
      resolveTier: (alias) => alias === 'sonata-code-simple'
        ? { role: 'code', tier: 'simple', routes: [{ key: 'flash', native: { gateway: 'acme', id: 'x' } }, { key: 'pro', native: { gateway: 'acme', id: 'y' } }] }
        : undefined,
    };
    await drain((await routeRequest(withTools('sonata-code-simple'), twoModels)).body);
    await drain((await routeRequest(withTools('sonata-code-simple'), twoModels)).body);
    // A recovered call is a turn the model served: nothing is cooled, so both
    // requests stay on the first candidate and `pro` is never reached.
    expect(rows).toHaveLength(2);
    expect(rows[0].key).toBe('flash');
    expect(rows[1].key).toBe('flash');
    expect(rows[0].textToolCalls).toEqual({ recovered: 1, unparsed: 0 });
    expect(rows[1].textToolCalls).toEqual({ recovered: 1, unparsed: 0 });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
  });

  it('writes no textToolCalls field when nothing was found', async () => {
    clearCooldowns();
    const rows: LedgerRow[] = [];
    await drain((await routeRequest(withTools('sonata-code-simple'), deps(rows, () => sse(stream('plain'))))).body);
    expect('textToolCalls' in rows[0]).toBe(false);
  });

  it('does not re-pin a candidate whose tool call could not be recovered', async () => {
    clearCooldowns();
    let clock = 1_000_000;
    let plain = false;
    const rows: LedgerRow[] = [];
    const chat = (model: string) => ({
      ...req(model),
      body: Buffer.from(JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'hello' }],
        tools: [{ name: 'Bash', input_schema: { type: 'object', properties: { command: { type: 'string' } } } }],
      })),
    });
    const twoModels: RouterDeps = {
      ...deps(rows, () => sse(stream('plain'))),
      fetch: (async (_url: string, init: { body: string }) => {
        const model = String(JSON.parse(init.body).model);
        if (plain) return body200('fine', 'text/plain');
        return model.endsWith('/pro') ? new Response('boom', { status: 500 }) : sse(stream(UNPARSED));
      }) as unknown as typeof fetch,
      resolveTier: (alias) => alias === 'sonata-code-simple'
        ? { role: 'code', tier: 'simple', routes: [{ key: 'pro', native: { gateway: 'acme', id: 'y' } }, { key: 'flash', native: { gateway: 'acme', id: 'x' } }] }
        : undefined,
      now: () => clock,
    };
    // pro answers 500 and is skipped; flash serves the turn but writes a call
    // sonata cannot recover, so it is cooled rather than preferred.
    await drain((await routeRequest(chat('sonata-code-simple'), twoModels)).body);
    // Past the cooldown with the sticky entry still in place — clearCooldowns()
    // would clear that too, so the clock moves instead.
    clock += TIER_COOLDOWN_MS + 1;
    plain = true;
    await drain((await routeRequest(chat('sonata-code-simple'), twoModels)).body);
    expect(rows[0].key).toBe('flash');
    expect(rows[0].textToolCalls).toEqual({ recovered: 0, unparsed: 1 });
    expect(rows[1].key).toBe('pro');
  });

  it('passes a large non-streamed JSON reply through byte-identical', async () => {
    clearCooldowns();
    const rows: LedgerRow[] = [];
    const big = 'A'.repeat(1024 * 1024 + 64);
    const json = JSON.stringify({
      id: 'm', type: 'message', role: 'assistant', stop_reason: 'end_turn',
      content: [{ type: 'text', text: big }],
    });
    const res = await routeRequest(withTools('sonata-code-simple'), deps(rows, () => body200(json, 'application/json')));
    expect(await drain(res.body)).toBe(json);
  });

  it('passes a JSON body past the byte cap through byte-identical instead of rewriting it', async () => {
    clearCooldowns();
    const rows: LedgerRow[] = [];
    // Exactly 3000 bytes carrying the text-call fixture, in three chunks:
    // read whole it would be rewritten, past the cap it is the client's bytes
    // and nothing else.
    const doc = (pad: number) => JSON.stringify({
      id: 'm', type: 'message', role: 'assistant', stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Go ' + CALL + 'A'.repeat(pad) }],
    });
    let pad = 0;
    while (doc(pad).length < 3000) pad += 1;
    const json = doc(pad);
    expect(Buffer.byteLength(json)).toBe(3000);
    const chunks = [json.slice(0, 1000), json.slice(1000, 2000), json.slice(2000)];
    const res = await routeRequest(withTools('sonata-code-simple'), {
      ...deps(rows, () => jsonChunks(chunks)),
      textToolCallReadLimits: { maxBytes: 1024, idleMs: 10_000 },
    });
    expect(await drain(res.body)).toBe(json);
    expect('textToolCalls' in rows[0]).toBe(false);
  });

  it('passes a JSON body that stalls mid-flight through unchanged rather than holding the request', async () => {
    clearCooldowns();
    const rows: LedgerRow[] = [];
    const json = JSON.stringify({
      id: 'm', type: 'message', role: 'assistant', stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Go ' + CALL }],
    });
    const mid = Math.ceil(json.length / 2);
    // Chunk A, a 200 ms silence, then chunk B: the idle bound gives up trying
    // to rewrite, and both halves still reach the client from the same read.
    const res = await routeRequest(withTools('sonata-code-simple'), {
      ...deps(rows, () => jsonChunks([json.slice(0, mid), json.slice(mid)], 200)),
      textToolCallReadLimits: { maxBytes: 1024 * 1024, idleMs: 50 },
    });
    expect(await drain(res.body)).toBe(json);
  });

  it('leaves a non-JSON 200 body untouched and unbuffered', async () => {
    clearCooldowns();
    const rows: LedgerRow[] = [];
    const res = await routeRequest(withTools('sonata-code-simple'), deps(rows, () => body200('not json at all', 'text/plain')));
    expect(Buffer.isBuffer(res.body)).toBe(false);
    expect(await drain(res.body)).toBe('not json at all');
  });

  it('recovers a text tool call from a non-streamed JSON reply', async () => {
    clearCooldowns();
    const rows: LedgerRow[] = [];
    const json = JSON.stringify({
      id: 'm', type: 'message', role: 'assistant', stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Go ' + CALL }],
    });
    const res = await routeRequest(withTools('sonata-code-simple'), deps(rows, () => body200(json, 'application/json')));
    const out = await drain(res.body);
    expect(out).toContain('"type":"tool_use"');
    expect(out).toContain('"stop_reason":"tool_use"');
    expect(rows[0].textToolCalls).toEqual({ recovered: 1, unparsed: 0 });
  });

  it('recovers a text tool call on a bare --model key request too', async () => {
    clearCooldowns();
    const rows: LedgerRow[] = [];
    // `flash` is a config key, not a tier alias: `resolveTier` never sees it
    // and the request is forwarded to LiteLLM as itself.
    const d = {
      ...deps(rows, () => sse(stream('Go ' + CALL))),
      resolveGateway: (key: string) => (key === 'flash' ? 'acme' : undefined),
    };
    const res = await routeRequest(withTools('flash'), d);
    const out = await drain(res.body);
    expect(out).toContain('"type":"tool_use"');
    expect(out).toContain('"stop_reason":"tool_use"');
    expect(rows).toHaveLength(1);
    expect(rows[0].textToolCalls).toEqual({ recovered: 1, unparsed: 0 });
  });

  it('answers client-gone and records nothing when the client leaves mid-JSON', async () => {
    clearCooldowns();
    const rows: LedgerRow[] = [];
    const ac = new AbortController();
    const d = {
      ...deps(rows, () => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"id":"m","type":"message","content":['));
          },
          pull(controller) {
            // The client left first; the upstream notices on the next read
            // and fails the body it was still sending.
            ac.abort();
            controller.error(new Error('upstream stream failed'));
          },
        });
        return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    };
    const res = await routeRequest({ ...withTools('sonata-code-simple'), signal: ac.signal }, d);
    expect((res as { clientGone?: boolean }).clientGone).toBe(true);
    expect(res.status).toBe(499);
    expect(rows).toHaveLength(0);
  });

  it('leaves a direct-transport candidate byte-identical', async () => {
    clearCooldowns();
    const rows: LedgerRow[] = [];
    const upstream = stream('Go ' + CALL);
    const d: RouterDeps = {
      ...deps(rows, () => sse(upstream)),
      resolveTier: () => ({
        role: 'code', tier: 'simple',
        routes: [{
          key: 'direct-1',
          native: { gateway: 'g', id: 'model-1', transport: 'direct' as const, baseUrl: 'https://gw.example/v1' },
        }],
      }),
      gatewayKeys: () => ({ g: 'GATEWAY-KEY' }),
    };
    const res = await routeRequest(withTools('sonata-code-simple'), d);
    // Anthropic speaks tool_use itself: nothing on this path is recovered or
    // rewritten, and the bytes the gateway sent are the bytes the client gets.
    expect(await drain(res.body)).toBe(upstream);
    expect(rows).toHaveLength(1);
    expect('textToolCalls' in rows[0]).toBe(false);
  });
});
