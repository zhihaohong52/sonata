import { describe, expect, it } from 'vitest';

import { clearCooldowns, routeRequest, TIER_COOLDOWN_MS, type RouterDeps } from '../../src/native/router.js';
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

  it('recovers a text tool call, rewrites stop_reason, and records it', async () => {
    clearCooldowns();
    const rows: LedgerRow[] = [];
    const res = await routeRequest(withTools('sonata-code-simple'), deps(rows, () => sse(stream('Go ' + CALL))));
    const out = await drain(res.body);
    expect(out).toContain('"type":"tool_use"');
    expect(out).toContain('"stop_reason":"tool_use"');
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
});
