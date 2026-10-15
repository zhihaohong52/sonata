import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import { activeTextToolCallCooldowns, clearCooldowns, createRouterServer, respond, routeRequest, TEXT_TOOL_CALL_COOLDOWN_MS, TIER_COOLDOWN_MS, type RouterDeps } from '../../src/native/router.js';
import { rewriteTextToolCallStream } from '../../src/native/text-tool-calls.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendRow, readRows } from '../../src/ledger.js';
import { spentTodayUsd } from '../../src/budget.js';
import { aggregate } from '../../src/commands/usage.js';
import { priceRow } from '../../src/commands/serve.js';
import { parseConfig } from '../../src/config.js';
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
  it('records session credential classification only, never credential material', async () => {
    clearCooldowns();
    const session = { gateway: 'claude', id: 'claude-opus-4-1', transport: 'direct' as const, baseUrl: 'https://api.anthropic.com/v1', auth: 'session' as const };
    const rows: LedgerRow[] = [];
    const sessionDeps: RouterDeps = {
      fetch: (async () => new Response(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 })) as typeof fetch,
      litellmBase: 'http://litellm.invalid', litellmKey: 'k', recordUsage: (row) => rows.push(row),
      resolveTier: () => ({ role: 'code', tier: 'simple', routes: [{ key: 'opus', native: session }] }),
    };
    await drain((await routeRequest({ ...req('sonata-code-simple'), headers: { authorization: 'Bearer sk-ant-oat01-SECRET' } }, sessionDeps)).body);
    expect(rows[0]).toMatchObject({ credential: 'subscription', gateway: 'claude', upstream: 'direct' });
    expect(JSON.stringify(rows[0])).not.toContain('SECRET');

    rows.length = 0;
    await drain((await routeRequest({ ...req('sonata-code-simple'), headers: { 'x-api-key': 'SECRET2' } }, sessionDeps)).body);
    expect(rows[0].credential).toBe('key');
    expect(JSON.stringify(rows[0])).not.toContain('SECRET2');

    rows.length = 0;
    await drain((await routeRequest(req('sonata-code-simple'), deps(rows, () => sse(DELTA)))).body);
    expect('credential' in rows[0]).toBe(false);
  });

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
    const d = {
      ...deps(rows, () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode(firstChunk)); },
        cancel() { cancelled = true; },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })),
      // 'hello' alone cannot rule a text tool call out, so the turn is held
      // until the upstream goes quiet: kept short here.
      textToolCallHoldLimits: { maxBytes: 1024 * 1024, idleMs: 50, maxMs: 60_000 },
    };
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

  it('captures the raw upstream stream, request and lookup tools when a call is not recovered', async () => {
    clearCooldowns();
    const { mkdtempSync, readdirSync, readFileSync, statSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = join(mkdtempSync(join(tmpdir(), 'sonata-textcalls-')), 'captures');
    const raw = stream(UNPARSED);
    const d = { ...deps([], () => sse(raw)), captureTextCallsDir: dir };
    // Twice back to back: each response gets its own file, neither overwritten.
    await drain((await routeRequest(withTools('sonata-code-simple'), d)).body);
    clearCooldowns();
    await drain((await routeRequest(withTools('sonata-code-simple'), d)).body);
    // Written after the stream ends, without holding it: wait for the files.
    const deadline = Date.now() + 2_000;
    // Complete, not merely present: the file exists a moment before its
    // contents are written, and reading it then failed under full-suite load.
    const written = () => {
      try {
        const names = readdirSync(dir);
        return names.length >= 2 && names.every((name) => { JSON.parse(readFileSync(join(dir, name), 'utf8')); return true; });
      } catch { return false; }
    };
    while (!written() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    const files = readdirSync(dir);
    expect(files).toHaveLength(2);
    expect(statSync(join(dir, files[0])).mode & 0o777).toBe(0o600);
    const doc = JSON.parse(readFileSync(join(dir, files[0]), 'utf8'));
    expect(doc.alias).toBe('sonata-code-simple');
    expect(doc.counts).toEqual({ recovered: 0, unparsed: 1 });
    expect(doc.recoveryToolNames).toEqual(['Bash']);
    expect(doc.upstream).toBe(raw);
    expect(doc.request.tools.map((t: { name: string }) => t.name)).toEqual(['Bash']);
  });

  it('captures nothing when every call was recovered, or no directory is set', async () => {
    clearCooldowns();
    const { mkdtempSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = join(mkdtempSync(join(tmpdir(), 'sonata-textcalls-')), 'captures');
    await drain((await routeRequest(withTools('sonata-code-simple'), { ...deps([], () => sse(stream(CALL))), captureTextCallsDir: dir })).body);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(existsSync(dir)).toBe(false);
    clearCooldowns();
    const rows: LedgerRow[] = [];
    await drain((await routeRequest(withTools('sonata-code-simple'), deps(rows, () => sse(stream(UNPARSED))))).body);
    expect(rows[0].textToolCalls).toEqual({ recovered: 0, unparsed: 1 });
  });

  /** Two candidates, `flash` first; each answers with what `answer` returns for its key. */
  const twoCandidates = (rows: LedgerRow[], answer: (key: 'flash' | 'pro') => Response, extra: Partial<RouterDeps> = {}) => {
    const seen: string[] = [];
    const d: RouterDeps = {
      ...deps(rows, () => sse(stream('plain'))),
      fetch: (async (_url: string, init: { body: string }) => {
        const model = String(JSON.parse(init.body).model);
        seen.push(model);
        return answer(model.endsWith('/pro') ? 'pro' : 'flash');
      }) as unknown as typeof fetch,
      resolveTier: (alias) => alias === 'sonata-code-simple'
        ? { role: 'code', tier: 'simple', routes: [{ key: 'flash', native: { gateway: 'acme', id: 'x' } }, { key: 'pro', native: { gateway: 'acme', id: 'y' } }] }
        : undefined,
      ...extra,
    };
    return { seen, d };
  };

  /** An SSE response sent as the given chunks, optionally left open after them. */
  const chunked = (chunks: string[], open = false, onCancel?: () => void): Response => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      if (!open) controller.close();
    },
    cancel() { onCancel?.(); },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });

  it('withdraws a streamed turn with an unrecoverable call and serves the next candidate', async () => {
    clearCooldowns();
    const rows: LedgerRow[] = [];
    const { seen, d } = twoCandidates(rows, (key) => sse(stream(key === 'flash' ? UNPARSED : 'from pro')));
    const out = await drain((await routeRequest(withTools('sonata-code-simple'), d)).body);
    // The client sees the second candidate's turn and nothing of the first.
    expect(out).toBe(stream('from pro'));
    expect(seen).toEqual(['default/flash', 'default/pro']);
    // One row served, one for the withdrawn turn's spend.
    expect(rows).toHaveLength(2);
    const served = rows.find((r) => r.withdrawn !== true)!;
    expect(served.key).toBe('pro');
    expect('textToolCalls' in served).toBe(false);
    expect(served.attempts).toEqual([{ key: 'flash', status: 200 }]);
    const withdrawn = rows.find((r) => r.withdrawn === true)!;
    expect(withdrawn).toMatchObject({
      key: 'flash', gateway: 'acme', status: 200, complete: true, attempts: [],
      textToolCalls: { recovered: 0, unparsed: 1 }, tokens: { input: 10, output: 5 },
    });
    // And the withdrawn candidate is cooling: the next request starts at pro.
    seen.length = 0;
    await drain((await routeRequest(withTools('sonata-code-simple'), d)).body);
    expect(seen).toEqual(['default/pro']);
  });

  it('withdraws a non-streamed reply with an unrecoverable call', async () => {
    clearCooldowns();
    const rows: LedgerRow[] = [];
    const message = (text: string) => JSON.stringify({
      id: 'm', type: 'message', role: 'assistant', content: [{ type: 'text', text }],
      stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 2 },
    });
    const { d } = twoCandidates(rows, (key) => body200(key === 'flash' ? message(UNPARSED) : message('from pro'), 'application/json'));
    const res = await routeRequest(withTools('sonata-code-simple'), d);
    expect(await drain(res.body)).toBe(message('from pro'));
    const served = rows.find((r) => r.withdrawn !== true)!;
    expect(served.key).toBe('pro');
    expect(served.attempts).toEqual([{ key: 'flash', status: 200 }]);
    expect(rows.find((r) => r.withdrawn === true)).toMatchObject({ key: 'flash', complete: true, tokens: { input: 3, output: 2 } });
  });

  it('serves the last withdrawn turn when no candidate serves instead', async () => {
    clearCooldowns();
    const rows: LedgerRow[] = [];
    const { seen, d } = twoCandidates(rows, () => sse(stream(UNPARSED)));
    const res = await routeRequest(withTools('sonata-code-simple'), d);
    expect(res.status).toBe(200);
    expect(await drain(res.body)).toContain('<tool_call>');
    expect(seen).toEqual(['default/flash', 'default/pro']);
    // The served row is the candidate whose turn was served, never also a
    // withdrawn row; the other turn is an attempt with a withdrawn row of its own.
    expect(rows).toHaveLength(2);
    const served = rows.find((r) => r.withdrawn !== true)!;
    expect(served.key).toBe('pro');
    expect(served.textToolCalls).toEqual({ recovered: 0, unparsed: 1 });
    expect(served.attempts).toEqual([{ key: 'flash', status: 200 }]);
    // Replayed as the stream it was, so its usage is still read.
    expect(served.tokens.output).toBe(5);
    expect(rows.filter((r) => r.withdrawn === true).map((r) => r.key)).toEqual(['flash']);
  });

  for (const [what, later] of [
    ['a 503', () => new Response('{"error":"down"}', { status: 503 })],
    ['a message-less 400', () => new Response('', { status: 400 })],
  ] as const) {
    it(`serves the withdrawn turn when the next candidate answers ${what}`, async () => {
      clearCooldowns();
      const rows: LedgerRow[] = [];
      const { seen, d } = twoCandidates(rows, (key) => key === 'flash' ? sse(stream(UNPARSED)) : later());
      const res = await routeRequest(withTools('sonata-code-simple'), d);
      expect(res.status).toBe(200);
      expect(await drain(res.body)).toContain('<tool_call>');
      expect(seen).toEqual(['default/flash', 'default/pro']);
      const served = rows.find((r) => r.withdrawn !== true)!;
      expect(served.key).toBe('flash');
      expect(served.attempts).toEqual([{ key: 'pro', status: later().status }]);
      expect(rows.some((r) => r.withdrawn === true)).toBe(false);
    });
  }

  it('neither withdraws nor cools a turn that only mentions the tag', async () => {
    clearCooldowns();
    const rows: LedgerRow[] = [];
    const mention = 'It writes `<tool_call>` markup, and <tool_call> alone is not a call.';
    const { seen, d } = twoCandidates(rows, () => sse(stream(mention)));
    const out = await drain((await routeRequest(withTools('sonata-code-simple'), d)).body);
    // The rewriter re-chunks text at each `<`, as it always has; the text itself is untouched.
    const deltas = out.split('\n\n').filter((e) => e.includes('text_delta'))
      .map((e) => JSON.parse(e.slice(e.indexOf('data:') + 5)).delta.text).join('');
    expect(deltas).toBe(mention);
    await drain((await routeRequest(withTools('sonata-code-simple'), d)).body);
    expect(seen).toEqual(['default/flash', 'default/flash']);
    expect(rows.every((r) => r.withdrawn === undefined && r.textToolCalls === undefined)).toBe(true);
  });

  it('prices a withdrawn turn and counts it toward the budget, but not as a served request', async () => {
    clearCooldowns();
    const home = mkdtempSync(join(tmpdir(), 'sonata-withdrawn-'));
    const config = parseConfig([
      '[models."flash"]', 'gateway = "acme"', 'id = "x"',
      '[models."flash".price]', 'input = 1', 'output = 2',
      '[native.gateways."acme"]', 'base_url = "https://example.invalid/v1"',
    ].join('\n'));
    const { d } = twoCandidates([], (key) => sse(stream(key === 'flash' ? UNPARSED : 'from pro')), {
      recordUsage: (row) => appendRow(home, priceRow(config, home, row)),
    });
    await drain((await routeRequest(withTools('sonata-code-simple'), d)).body);
    const deadline = Date.now() + 2_000;
    while (readRows(home, 0, Date.now() + 1).length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    const ledger = readRows(home, 0, Date.now() + 1);
    const withdrawn = ledger.find((r) => r.withdrawn === true)!;
    // 10 in at $1/M and 5 out at $2/M.
    expect(withdrawn.price).toMatchObject({ source: 'model', totalUsd: 0.00002 });
    expect(spentTodayUsd(home)).toBeCloseTo(0.00002, 10);
    const report = aggregate(ledger, 'model', {});
    expect(report.buckets.map((b) => [b.label, b.requests])).toEqual([['pro', 1]]);
    expect(report.withdrawn).toEqual({ turns: 1, costUsd: 0.00002, coveredUsd: 0, unpriced: 0 });
  });

  it('records a withdrawn turn whose usage never arrived as incomplete, with zero tokens', async () => {
    clearCooldowns();
    const rows: LedgerRow[] = [];
    const noUsage = [
      ev('message_start', { message: { id: 'm', role: 'assistant', content: [] } }),
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: UNPARSED } }),
      ev('content_block_stop', { index: 0 }),
      ev('message_stop', {}),
    ].join('');
    const { d } = twoCandidates(rows, (key) => sse(key === 'flash' ? noUsage : stream('from pro')));
    await drain((await routeRequest(withTools('sonata-code-simple'), d)).body);
    const withdrawn = rows.find((r) => r.withdrawn === true)!;
    expect(withdrawn.complete).toBe(false);
    expect(withdrawn.tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
    expect(withdrawn.price).toEqual({ source: 'none' });
  });

  it('passes a recovered call through the hold unchanged', async () => {
    clearCooldowns();
    const rows: LedgerRow[] = [];
    const { seen, d } = twoCandidates(rows, () => sse(stream('Go ' + CALL)));
    const out = await drain((await routeRequest(withTools('sonata-code-simple'), d)).body);
    const unheld = await drain(rewriteTextToolCallStream(
      (async function* () { yield new TextEncoder().encode(stream('Go ' + CALL)); })(),
      new Map([['Bash', { type: 'object', properties: { command: { type: 'string' } } }]]),
      () => undefined,
    ));
    const ids = (text: string) => text.replace(/toolu_[0-9a-f]+/g, 'toolu_X');
    expect(ids(out)).toBe(ids(unheld));
    expect(seen).toEqual(['default/flash']);
    expect(rows[0].textToolCalls).toEqual({ recovered: 1, unparsed: 0 });
  });

  it('serves and cools when prose had already streamed before the marker', async () => {
    clearCooldowns();
    const rows: LedgerRow[] = [];
    const prose = 'I will now look around the whole repository to find where this behaviour lives. ';
    const proseThenCall = [
      ev('message_start', { message: { id: 'm', role: 'assistant', content: [] } }),
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: prose } }),
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: UNPARSED } }),
      ev('content_block_stop', { index: 0 }),
      ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 10, output_tokens: 5 } }),
      ev('message_stop', {}),
    ];
    const { seen, d } = twoCandidates(rows, (key) => key === 'flash' ? chunked(proseThenCall) : sse(stream('from pro')));
    const out = await drain((await routeRequest(withTools('sonata-code-simple'), d)).body);
    // Past the probe, the prose went out; the turn could not be withdrawn.
    expect(out).toContain(prose);
    expect(out).toContain('<tool_call>');
    expect(rows[0].key).toBe('flash');
    expect(rows[0].textToolCalls).toEqual({ recovered: 0, unparsed: 1 });
    expect(seen).toEqual(['default/flash']);
    seen.length = 0;
    await drain((await routeRequest(withTools('sonata-code-simple'), d)).body);
    expect(seen).toEqual(['default/pro']);
  });

  it('finds a marker split across SSE chunks and deltas', async () => {
    clearCooldowns();
    const rows: LedgerRow[] = [];
    const frames = [
      ev('message_start', { message: { id: 'm', role: 'assistant', content: [] } }),
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok <to' } }),
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ol_call><function=Nope></function></tool_call>' } }),
      ev('content_block_stop', { index: 0 }),
      ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 10, output_tokens: 5 } }),
      ev('message_stop', {}),
    ].join('');
    // Cut mid-event, and through the marker's own delta.
    const cut = frames.indexOf('ol_call');
    const { seen, d } = twoCandidates(rows, (key) => key === 'flash'
      ? chunked([frames.slice(0, 40), frames.slice(40, cut), frames.slice(cut, cut + 7), frames.slice(cut + 7)])
      : sse(stream('from pro')));
    const out = await drain((await routeRequest(withTools('sonata-code-simple'), d)).body);
    expect(out).toBe(stream('from pro'));
    expect(seen).toEqual(['default/flash', 'default/pro']);
  });

  it('stops holding after the idle limit and streams as before', async () => {
    clearCooldowns();
    const rows: LedgerRow[] = [];
    let cancelled = false;
    const open = [
      ev('message_start', { message: { id: 'm', role: 'assistant', content: [] } }),
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '<tool_call><function=Bash>' } }),
    ];
    const { seen, d } = twoCandidates(rows, () => chunked(open, true, () => { cancelled = true; }), {
      textToolCallHoldLimits: { maxBytes: 1024 * 1024, idleMs: 50, maxMs: 60_000 },
    });
    const started = Date.now();
    const res = await routeRequest(withTools('sonata-code-simple'), d);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(res.status).toBe(200);
    expect(seen).toEqual(['default/flash']);
    const iterator = (res.body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(new TextDecoder().decode(first.value)).toContain('message_start');
    await iterator.return?.();
    (res.body as { cancel?: () => void }).cancel?.();
    expect(cancelled).toBe(true);
  });

  it('gives up a held turn the moment the client leaves, recording it as served and incomplete', async () => {
    clearCooldowns();
    const rows: LedgerRow[] = [];
    let cancelled = false;
    const open = [
      ev('message_start', { message: { id: 'm', role: 'assistant', content: [], usage: { input_tokens: 42, output_tokens: 1 } } }),
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'hi' } }),
    ];
    const { d } = twoCandidates(rows, () => chunked(open, true, () => { cancelled = true; }));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    const started = Date.now();
    const res = await routeRequest({ ...withTools('sonata-code-simple'), signal: controller.signal }, d);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(res.status).toBe(499);
    expect(cancelled).toBe(true);
    // The upstream answered and billed it: the row a disconnect mid-stream
    // gets, with the usage the held bytes carried.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: 'flash', status: 200, complete: false, attempts: [] });
    expect(rows[0].withdrawn).toBeUndefined();
    expect(rows[0].tokens.input).toBe(42);
  });

  it('stops holding past the byte limit and streams as before', async () => {
    clearCooldowns();
    const rows: LedgerRow[] = [];
    const { seen, d } = twoCandidates(rows, (key) => sse(stream(key === 'flash' ? UNPARSED : 'from pro')), {
      textToolCallHoldLimits: { maxBytes: 16, idleMs: 10_000, maxMs: 60_000 },
    });
    const out = await drain((await routeRequest(withTools('sonata-code-simple'), d)).body);
    expect(out).toContain('<tool_call>');
    expect(seen).toEqual(['default/flash']);
    expect(rows[0].key).toBe('flash');
    expect(rows[0].textToolCalls).toEqual({ recovered: 0, unparsed: 1 });
  });

  it('leaves a plain text reply byte-identical, streamed and not', async () => {
    clearCooldowns();
    const long = 'A plain answer with no tool call in it at all, long enough to pass the probe window easily.';
    for (const text of ['plain', long]) {
      const rows: LedgerRow[] = [];
      const raw = stream(text);
      const { d } = twoCandidates(rows, () => sse(raw));
      expect(await drain((await routeRequest(withTools('sonata-code-simple'), d)).body)).toBe(raw);
      const json = JSON.stringify({ id: 'm', type: 'message', role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' });
      const { d: jd } = twoCandidates(rows, () => body200(json, 'application/json'));
      expect(await drain((await routeRequest(withTools('sonata-code-simple'), jd)).body)).toBe(json);
    }
  });

  it('streams a thinking block without holding, as before', async () => {
    clearCooldowns();
    const rows: LedgerRow[] = [];
    const head = [
      ev('message_start', { message: { id: 'm', role: 'assistant', content: [] } }),
      ev('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }),
      ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } }),
    ];
    let cancelled = false;
    // Left open: a held stream would never return.
    const { d } = twoCandidates(rows, () => chunked(head, true, () => { cancelled = true; }));
    const res = await routeRequest(withTools('sonata-code-simple'), d);
    const iterator = (res.body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
    let out = '';
    while (!out.includes('thinking_delta')) out += new TextDecoder().decode((await iterator.next()).value);
    expect(out).toBe(head.join(''));
    (res.body as { cancel?: () => void }).cancel?.();
    expect(cancelled).toBe(true);
  });

  it('cools a model that keeps writing unrecoverable calls for much longer', async () => {
    clearCooldowns();
    let clock = 1_000_000;
    const rows: LedgerRow[] = [];
    const { seen, d } = twoCandidates(rows, (key) => sse(stream(key === 'flash' ? UNPARSED : 'from pro')), { now: () => clock });
    const ask = async () => { seen.length = 0; await drain((await routeRequest(withTools('sonata-code-simple'), d)).body); return [...seen]; };
    expect(await ask()).toEqual(['default/flash', 'default/pro']);
    expect(activeTextToolCallCooldowns(clock)).toEqual([]);
    clock += TIER_COOLDOWN_MS + 1;
    // The second within the window: escalated.
    expect(await ask()).toEqual(['default/flash', 'default/pro']);
    expect(activeTextToolCallCooldowns(clock)).toEqual([{
      tenant: 'default', model: 'flash', until: new Date(clock + TEXT_TOOL_CALL_COOLDOWN_MS).toISOString(),
      reason: expect.stringContaining('wrote tool calls as text that could not be recovered (2×'),
    }]);
    clock += TIER_COOLDOWN_MS + 1;
    expect(await ask()).toEqual(['default/pro']);
    clock += TEXT_TOOL_CALL_COOLDOWN_MS;
    expect(activeTextToolCallCooldowns(clock)).toEqual([]);
    expect(await ask()).toEqual(['default/flash', 'default/pro']);
  });

  it('resets the run of unrecoverable calls once the model serves a turn', async () => {
    clearCooldowns();
    let clock = 1_000_000;
    let broken = true;
    const rows: LedgerRow[] = [];
    const { seen, d } = twoCandidates(rows, (key) => sse(stream(key === 'flash' && broken ? UNPARSED : 'served')), { now: () => clock });
    const ask = async () => { seen.length = 0; await drain((await routeRequest(withTools('sonata-code-simple'), d)).body); return [...seen]; };
    await ask();
    clock += TIER_COOLDOWN_MS + 1;
    broken = false;
    expect(await ask()).toEqual(['default/flash']);
    clock += TIER_COOLDOWN_MS + 1;
    broken = true;
    await ask();
    // One strike since the served turn: the ordinary cooldown only.
    expect(activeTextToolCallCooldowns(clock)).toEqual([]);
    clock += TIER_COOLDOWN_MS + 1;
    expect(await ask()).toEqual(['default/flash', 'default/pro']);
  });

  it('reports the long cooldown on /__sonata_health', async () => {
    clearCooldowns();
    let clock = Date.now();
    const rows: LedgerRow[] = [];
    const { d } = twoCandidates(rows, (key) => sse(stream(key === 'flash' ? UNPARSED : 'from pro')), { now: () => clock });
    await drain((await routeRequest(withTools('sonata-code-simple'), d)).body);
    clock += TIER_COOLDOWN_MS + 1;
    await drain((await routeRequest(withTools('sonata-code-simple'), d)).body);
    const server = createRouterServer({ ...d, health: true });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as { port: number };
      const body = await (await fetch(`http://127.0.0.1:${port}/__sonata_health`)).json() as { cooldowns: { model: string; reason: string }[] };
      expect(body.cooldowns.map((c) => c.model)).toEqual(['flash']);
      expect(body.cooldowns[0].reason).toContain('no tool-call parser');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
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
