import { describe, expect, it } from 'vitest';

import { clearCooldowns, routeRequest, type RouterDeps } from '../../src/native/router.js';
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
      'x-litellm-model-group': 'flash', 'x-litellm-call-id': 'call-1',
    })));
    expect(await drain(res.body)).toBe(DELTA);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      session: 'sess-1', alias: 'sonata-code-simple', role: 'code', tier: 'simple',
      key: 'flash', upstream: 'litellm', status: 200, complete: true,
      callId: 'call-1',
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
