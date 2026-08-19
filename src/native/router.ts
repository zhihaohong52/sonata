import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface RouterDeps {
  fetch: typeof fetch;
  anthropicBase?: string;
  litellmBase: string;
  litellmKey: string;
  log?: (line: string) => void;
  health?: boolean;
}

export interface RouterRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Buffer;
}

export interface RouterResponse {
  status: number;
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array> | Buffer;
}

const HOP_BY_HOP_HEADERS = new Set([
  'content-encoding',
  'transfer-encoding',
  'content-length',
  'connection',
]);

function targetUrl(base: string, url: string): string {
  return `${base.replace(/\/$/, '')}/${url.replace(/^\//, '')}`;
}

function requestHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !['host', 'content-length'].includes(name.toLowerCase())),
  );
}

function responseHeaders(headers: Headers): Record<string, string> {
  return Object.fromEntries(
    [...headers.entries()].filter(([name]) => !HOP_BY_HOP_HEADERS.has(name.toLowerCase())),
  );
}

async function* responseBody(body: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

function isClaudeRequest(body: Buffer): boolean {
  try {
    return JSON.parse(body.toString()).model?.startsWith('claude-') === true;
  } catch {
    return true;
  }
}

export async function routeRequest(req: RouterRequest, deps: RouterDeps): Promise<RouterResponse> {
  const anthropic = isClaudeRequest(req.body);
  const headers = requestHeaders(req.headers);
  const upstream = anthropic ? 'anthropic' : 'litellm';

  if (!anthropic) {
    for (const name of Object.keys(headers)) {
      if (name.toLowerCase() === 'authorization' || name.toLowerCase() === 'x-api-key') delete headers[name];
    }
    headers.authorization = `Bearer ${deps.litellmKey}`;
  }

  deps.log?.(`${req.method} ${req.url} -> ${upstream}`);

  try {
    const response = await deps.fetch(
      targetUrl(anthropic ? (deps.anthropicBase ?? 'https://api.anthropic.com') : deps.litellmBase, req.url),
      { method: req.method, headers, body: req.body.length > 0 ? req.body as unknown as BodyInit : undefined },
    );
    return {
      status: response.status,
      headers: responseHeaders(response.headers),
      body: response.body === null ? Buffer.alloc(0) : responseBody(response.body),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 502,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ error: { type: 'router_error', message } })),
    };
  }
}

function incomingHeaders(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return headers;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function respond(res: ServerResponse, routed: RouterResponse): Promise<void> {
  res.writeHead(routed.status, routed.headers);
  if (Buffer.isBuffer(routed.body)) {
    res.end(routed.body);
    return;
  }
  for await (const chunk of routed.body) res.write(chunk);
  res.end();
}

export function createRouterServer(deps: RouterDeps): Server {
  return createServer(async (req, res) => {
    try {
      if (deps.health && new URL(req.url ?? '/', 'http://localhost').pathname === '/__sonata_health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', sonata: true }));
        return;
      }
      await respond(res, await routeRequest({
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: incomingHeaders(req),
        body: await readBody(req),
      }, deps));
    } catch {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'router_error', message: 'failed to route request' } }));
    }
  });
}
