import { describe, expect, it } from 'vitest';
import { routeRequest, flattenSystemBlocks, requestedModel } from '../../src/native/router.js';

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
    expect(JSON.parse(body.toString()).type).toBe('overloaded_error');
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
