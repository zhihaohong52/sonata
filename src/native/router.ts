import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface TierRoute {
  key: string;
  native?: { gateway: string; id: string };
  harness?: { harness: string; id: string };
}

export interface RouterDeps {
  fetch: typeof fetch;
  anthropicBase?: string;
  litellmBase: string;
  litellmKey: string;
  log?: (line: string) => void;
  health?: boolean;
  /** The resolved sonata.toml path this router instance is running with, reported on /__sonata_health so a caller can tell two same-port routers apart by which config actually started them. */
  configPath?: string;
  /** Resolves a `sonata-<role>-<tier>` alias to its ranked routes, or undefined if unknown. */
  resolveTier?: (alias: string) => { role: string; tier: string; routes: TierRoute[] } | undefined;
  now?: () => number;
  /**
   * Resolves once the current litellm child is confirmed healthy (or once
   * serve has given up waiting on it). A respawn after a crash otherwise
   * leaves a brief window where litellm is not listening yet; without this,
   * a request landing in that window gets a connection-refused 502 that
   * `routeTierRequest` cannot tell apart from a genuine model failure, and
   * cools the candidate down for `TIER_COOLDOWN_MS` even though it recovers
   * moments later. Awaited before every litellm-bound request; omitted by
   * callers (and tests) that have no respawn to gate.
   */
  litellmReady?: () => Promise<void>;
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

async function drainBody(body: AsyncIterable<Uint8Array> | Buffer): Promise<void> {
  if (Buffer.isBuffer(body)) return;
  try {
    for await (const _chunk of body) { /* discard */ }
  } catch { /* the body failing to drain is not itself an error */ }
}

/**
 * The model a request names, for logging which upstream served it.
 *
 * Without this the routing decision is invisible: LiteLLM's access log records
 * the path and status but not the model, so "did this agent really run on the
 * foreign model?" could only be answered by inference.
 */
export function requestedModel(body: Buffer): string | undefined {
  try {
    const model = (JSON.parse(body.toString()) as { model?: unknown }).model;
    return typeof model === 'string' ? model : undefined;
  } catch {
    return undefined;
  }
}

/** Rewrites only the `model` field of a JSON body; returns it unchanged if it does not parse. */
export function withModel(body: Buffer, model: string): Buffer {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body.toString()) as Record<string, unknown>;
  } catch {
    return body;
  }
  return Buffer.from(JSON.stringify({ ...payload, model }));
}

export const TIER_COOLDOWN_MS = 60_000;

/** Module-level so a cooling-down key stays cool across requests. Test seam: `clearCooldowns()`. */
const cooldowns = new Map<string, number>();

export function clearCooldowns(): void {
  cooldowns.clear();
}

/**
 * An Anthropic-shaped error body: `{"type":"error","error":{"type":...,
 * "message":...}}`. An Anthropic-compatible client (Claude Code included)
 * expects this exact envelope on every path — a flat `{type, message}` or a
 * bare `{error: {...}}` with no top-level `type: "error"` is silently
 * discarded, surfacing a generic error instead of the actual message (in
 * particular, the fallback command a tier's 529 names to activate harness
 * dispatch).
 */
function anthropicErrorBody(type: string, message: string): Buffer {
  return Buffer.from(JSON.stringify({ type: 'error', error: { type, message } }));
}

function isClaudeRequest(body: Buffer): boolean {
  try {
    return JSON.parse(body.toString()).model?.startsWith('claude-') === true;
  } catch {
    return true;
  }
}

/**
 * Flattens an Anthropic `system` block array into a single string.
 *
 * Claude Code always sends `system` as an array of text blocks. LiteLLM turns a
 * *string* system prompt into a `developer` message, which the Codex backend
 * accepts, but leaves block arrays as role `system` — and that backend answers
 * `{"detail":"System messages are not allowed"}`, a 400 naming neither the
 * field nor the shape. Probed directly: a string system prompt succeeds, the
 * identical text as a one-element array fails.
 *
 * So the array is joined here, before LiteLLM sees it. The text is unchanged
 * and its order preserved; only the shape differs, and the string form is the
 * one both sides agree on. `cache_control` is dropped with the blocks, which
 * costs prompt caching on this path — the alternative is a request that cannot
 * be sent at all.
 *
 * Returns the body untouched unless it is JSON with a non-empty `system` array:
 * an empty array is already accepted, and a non-JSON body is not ours to parse.
 */
export function flattenSystemBlocks(body: Buffer): Buffer {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body.toString()) as Record<string, unknown>;
  } catch {
    return body;
  }
  const system = payload.system;
  if (!Array.isArray(system) || system.length === 0) return body;

  const text = system
    .map((block) => {
      if (typeof block === 'string') return block;
      const { type, text: blockText } = (block ?? {}) as { type?: unknown; text?: unknown };
      // Only text blocks carry a prompt. Anything else (an image, a shape added
      // later) has no string form, so leaving the body alone is safer than
      // silently dropping content.
      return type === 'text' && typeof blockText === 'string' ? blockText : null;
    })
    .filter((part): part is string => part !== null);

  if (text.length !== system.length) return body;
  return Buffer.from(JSON.stringify({ ...payload, system: text.join('\n\n') }));
}

/**
 * Forwards an already-litellm-shaped request (auth swapped, system flattened,
 * model rewritten if this is a tier candidate) and applies the 500->529
 * empty-completion rewrite. Shared by the plain litellm path and the tier
 * fallback loop so the two forwarding paths cannot drift apart.
 */
async function forwardToLitellm(
  body: Buffer,
  headers: Record<string, string>,
  req: RouterRequest,
  deps: RouterDeps,
): Promise<RouterResponse> {
  try {
    await deps.litellmReady?.();
    const response = await deps.fetch(
      targetUrl(deps.litellmBase, req.url),
      { method: req.method, headers, body: body.length > 0 ? body as unknown as BodyInit : undefined },
    );
    // LiteLLM returns 500 when ChatGPT's Codex endpoint yields output:[]. That
    // usually means the upstream was overloaded and returned an empty completion
    // rather than a real error. Re-emitting it as 529 (overloaded) lets Claude
    // Code treat it as a retriable backpressure signal rather than a hard fault.
    if (response.status === 500) {
      const responseBodyBuf = response.body === null
        ? Buffer.alloc(0)
        : Buffer.concat(await async function() { const chunks: Buffer[] = []; for await (const c of responseBody(response.body!)) chunks.push(Buffer.from(c)); return chunks; }());
      const text = responseBodyBuf.toString();
      if (text.includes('Unknown items in responses API response')) {
        const msg = 'upstream returned empty completion (overloaded) — retry';
        deps.log?.(`router: 500 from litellm rewritten to 529 (${requestedModel(body) ?? '?'}): empty output`);
        return {
          status: 529,
          headers: { 'content-type': 'application/json' },
          body: anthropicErrorBody('overloaded_error', msg),
        };
      }
      return {
        status: response.status,
        headers: responseHeaders(response.headers),
        body: responseBodyBuf,
      };
    }
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
      body: anthropicErrorBody('router_error', message),
    };
  }
}

function litellmHeaders(headers: Record<string, string>, litellmKey: string): Record<string, string> {
  const out = { ...headers };
  for (const name of Object.keys(out)) {
    if (name.toLowerCase() === 'authorization' || name.toLowerCase() === 'x-api-key') delete out[name];
  }
  out.authorization = `Bearer ${litellmKey}`;
  return out;
}

/**
 * Tries each native-routed candidate for a `sonata-<role>-<tier>` alias in
 * rank order, skipping any inside its post-failure cooldown window. The first
 * response that is neither ≥500, 429, nor a candidate-specific auth failure
 * (401/403) goes to the client — retry is inherently pre-first-byte, so this
 * never interferes with an in-progress stream.
 */
async function routeTierRequest(req: RouterRequest, deps: RouterDeps, alias: string): Promise<RouterResponse> {
  const resolved = deps.resolveTier?.(alias);
  if (resolved === undefined) {
    return {
      status: 400,
      headers: { 'content-type': 'application/json' },
      body: anthropicErrorBody(
        'invalid_request_error',
        `unknown sonata tier alias "${alias}" — run \`sonata sync\` and check [tiers] in sonata.toml`,
      ),
    };
  }

  const now = deps.now ?? Date.now;
  const headers = litellmHeaders(requestHeaders(req.headers), deps.litellmKey);
  const flattened = flattenSystemBlocks(req.body);
  const candidates = resolved.routes.filter((route) => route.native !== undefined);

  for (const route of candidates) {
    const until = cooldowns.get(route.key);
    if (until !== undefined && until > now()) continue;

    const body = withModel(flattened, route.key);
    const response = await forwardToLitellm(body, headers, { ...req, body }, deps);
    // 429 is treated as a failure alongside 5xx (not as one of "our" 4xx
    // mistakes to return as-is): it's the upstream saying it's overloaded,
    // exactly the transient case ranked fallback exists for. 401/403 are also
    // retried — they are credential failures specific to THIS candidate's
    // gateway (an expired or rejected key), so a later candidate on a
    // different gateway with a working credential is worth trying, and they
    // must not take down every tier that ranks the affected gateway first.
    // Every other 4xx (e.g. 400) means the request itself was wrong, which
    // retrying can't fix.
    if (response.status >= 500 || response.status === 429 || response.status === 401 || response.status === 403) {
      await drainBody(response.body);
      cooldowns.set(route.key, now() + TIER_COOLDOWN_MS);
      deps.log?.(`router: ${route.key} failed (${response.status}), trying next`);
      continue;
    }
    deps.log?.(`${req.method} ${req.url} model=${alias} -> ${route.key} -> litellm`);
    return response;
  }

  const label = `${resolved.role}-${resolved.tier}`;
  deps.log?.(`router: all native routes for ${label} failed`);
  return {
    status: 529,
    headers: { 'content-type': 'application/json' },
    body: anthropicErrorBody(
      'overloaded_error',
      `all native routes for ${label} failed; fall back with: ` +
      `sonata dispatch --tier ${label} --task-file <path> (or trailing task text) — ` +
      'dispatch requires one of those; the router has no task text of its own to supply',
    ),
  };
}

export async function routeRequest(req: RouterRequest, deps: RouterDeps): Promise<RouterResponse> {
  const alias = requestedModel(req.body);
  if (alias !== undefined && alias.startsWith('sonata-')) {
    return routeTierRequest(req, deps, alias);
  }

  const anthropic = isClaudeRequest(req.body);
  const headers = requestHeaders(req.headers);
  const upstream = anthropic ? 'anthropic' : 'litellm';
  // Anthropic understands its own block arrays; only the foreign path needs the
  // string form, so the request Anthropic receives stays byte-identical.
  const body = anthropic ? req.body : flattenSystemBlocks(req.body);

  deps.log?.(`${req.method} ${req.url} model=${requestedModel(req.body) ?? '?'} -> ${upstream}`);

  if (!anthropic) {
    return forwardToLitellm(body, litellmHeaders(headers, deps.litellmKey), req, deps);
  }

  try {
    const response = await deps.fetch(
      targetUrl(deps.anthropicBase ?? 'https://api.anthropic.com', req.url),
      { method: req.method, headers, body: body.length > 0 ? body as unknown as BodyInit : undefined },
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
      body: anthropicErrorBody('router_error', message),
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
        res.end(JSON.stringify({ status: 'ok', sonata: true, configPath: deps.configPath ?? null }));
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
      res.end(anthropicErrorBody('router_error', 'failed to route request'));
    }
  });
}
