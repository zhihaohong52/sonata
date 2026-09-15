/**
 * The router's local UI surface.
 *
 * Read-only, loopback-only, GET-only. Everything here renders data some other
 * module already computed -- see the spec's "Every number comes from a function
 * that already exists". Nothing in this file may sum a token or a dollar.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RouterResponse } from './router.js';
import { parseFilters, usagePayload, USAGE_DIMENSIONS } from './ui-usage.js';
import { sessionRows } from './ui-sessions.js';
import { runRows } from './ui-runs.js';
import { runDetail, sessionDetail } from './ui-detail.js';

/**
 * Trailing slash is load-bearing: `/__sonata_health` is the pre-existing
 * health route and must NOT be captured by this prefix.
 */
export const UI_PREFIX = '/__sonata/';

/**
 * A bare `GET /` serves the page too.
 *
 * Nothing Claude Code asks the router for touches `/` — its calls are all
 * `/v1/*` — so claiming this path costs no proxy behaviour, and before it was
 * claimed the request was forwarded to Anthropic and came back as Anthropic's
 * own 404. **Only a bare GET is claimed**: a `POST /` is left alone and still
 * reaches `routeRequest`, and every path that is neither `/` nor under
 * `/__sonata` is untouched.
 */
function claimsUrl(method: string, url: string): boolean {
  if (isRootPageRequest(method, url)) return true;
  // Prefix-exact, so `/__sonata_health` (the pre-existing health route) and any
  // other `/__sonataX` path still reach `routeRequest` exactly as before.
  return url === '/__sonata' || url.startsWith('/__sonata/') || url.startsWith('/__sonata?');
}

function isRootPageRequest(method: string, url: string): boolean {
  if (method !== 'GET') return false;
  return url === '/' || url.startsWith('/?') || url.startsWith('/#');
}

/**
 * `sonata` on PATH runs `dist/`, not `src/`, so this resolves relative to the
 * executing file and walks up to the package root -- the same reason
 * `sonata --version` reads the manifest beside its own executable.
 */
export function uiAssetPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'ui', 'index.html');
}

function pageResponse(): RouterResponse {
  return {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
    body: readFileSync(uiAssetPath()),
  };
}

export interface UiDeps {
  home: string;
  port: number;
  tenants?: () => { id: string; configPath: string | null }[];
  now?: () => number;
}

export function jsonResponse(status: number, value: unknown): RouterResponse {
  return {
    status,
    // Deliberately no access-control-allow-origin: without it a page the user
    // visits cannot read these endpoints cross-origin.
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      // These bodies echo caller-supplied path fragments; nosniff closes the
      // category rather than relying on the content type being honoured.
      'x-content-type-options': 'nosniff',
    },
    body: Buffer.from(JSON.stringify(value)),
  };
}

/**
 * Loopback origin is established by the bind (`listen(port, 'localhost')`).
 * What remains is DNS rebinding: a hostname resolving to 127.0.0.1 carries an
 * attacker's origin. The Host header is what tells the two apart.
 */
function isLoopbackHost(host: string | undefined, port: number): boolean {
  if (host === undefined || host === '') return false;
  const expectedPort = String(port);
  const accepted = [
    `localhost:${expectedPort}`,
    `127.0.0.1:${expectedPort}`,
    `[::1]:${expectedPort}`,
  ];
  if (port === 80) accepted.push('localhost', '127.0.0.1', '[::1]');
  return accepted.includes(host);
}

/**
 * The dispatch decision is **synchronous** and stays that way: a proxied
 * request pays two `startsWith` tests and returns, never a promise tick. Only
 * the UI branch is async, because reading the ledger and the run store off the
 * event loop is the whole point of this round.
 */
export function handleUiRequest(
  req: { method: string; url: string; headers: Record<string, string> },
  deps: UiDeps,
): Promise<RouterResponse> | undefined {
  // The proxy hot path (`/v1/messages`) runs through here for every request a
  // native agent makes: a substring test, not a URL parse, is what it pays.
  if (!claimsUrl(req.method, req.url)) return undefined;
  return handleUiRequestAsync(req, deps);
}

async function handleUiRequestAsync(
  req: { method: string; url: string; headers: Record<string, string> },
  deps: UiDeps,
): Promise<RouterResponse> {

  let path: string;
  let query: URLSearchParams;
  try {
    const parsed = new URL(req.url, 'http://localhost');
    path = parsed.pathname;
    query = parsed.searchParams;
  } catch {
    // The synchronous guard already claimed this request, so it cannot be
    // handed back to the proxy: a URL this module cannot parse is answered
    // here rather than forwarded upstream as an API call.
    return jsonResponse(400, { error: 'sonata UI: unparseable request url' });
  }
  if (path !== '/' && path !== '/__sonata' && !path.startsWith(UI_PREFIX)) {
    // `/index.html` and friends: claimed by neither guard, so they belong to
    // the proxy exactly as before.
    return jsonResponse(404, { error: 'sonata UI: no such path' });
  }

  if (!isLoopbackHost(req.headers.host, deps.port)) {
    return jsonResponse(403, { error: 'sonata UI is loopback-only' });
  }
  // Never fall through: a non-GET reaching routeRequest would be forwarded
  // upstream as though it were an API call.
  if (req.method !== 'GET') {
    return jsonResponse(405, { error: 'the sonata UI is read-only; use GET' });
  }

  try {
    return await route(path, query, deps);
  } catch {
    // The server's catch-all answers in Anthropic's error shape, which is
    // right for a proxied request and confusing for a fetch from the page.
    // The thrown message is not echoed: it can carry local paths.
    return jsonResponse(500, { error: 'sonata UI: request failed' });
  }
}

async function route(path: string, query: URLSearchParams, deps: UiDeps): Promise<RouterResponse> {
  if (path === '/') return pageResponse();
  const rest = path === '/__sonata' ? '' : path.slice(UI_PREFIX.length);
  if (rest === '' || rest === 'index.html') return pageResponse();
  if (rest.startsWith('api/session/')) {
    const id = decodeURIComponent(rest.slice('api/session/'.length));
    if (id === '') return jsonResponse(404, { error: 'sonata UI: no session id' });
    return jsonResponse(200, await sessionDetail(deps, id, query));
  }
  if (rest.startsWith('api/run/')) {
    const id = decodeURIComponent(rest.slice('api/run/'.length));
    const detail = await runDetail(deps, id, query.get('project') ?? undefined);
    if (detail === undefined) return jsonResponse(404, { error: `sonata UI: no run ${id}` });
    return jsonResponse(200, detail);
  }
  switch (rest) {
    case 'api/usage': {
      // A deliberate refusal must not arrive as the generic 500 the catch-all
      // produces. The message is self-authored: the caller's own input is never
      // echoed back into the body.
      const requested = query.get('by');
      if (requested !== null && requested !== '' && !(USAGE_DIMENSIONS as string[]).includes(requested)) {
        return jsonResponse(400, {
          error: `sonata UI: unknown dimension — use one of ${USAGE_DIMENSIONS.join(', ')}`,
          dimensions: USAGE_DIMENSIONS,
        });
      }
      const { report, by, filters } = await usagePayload(deps, query);
      return jsonResponse(200, { by, filters, report });
    }
    case 'api/sessions': {
      const filters = parseFilters(query, (deps.now ?? Date.now)());
      const runs = await runRows(deps, filters);
      const rows = [...await sessionRows(deps, filters), ...runs.rows].sort(
        (a, b) => (Date.parse(b.started ?? '') || 0) - (Date.parse(a.started ?? '') || 0),
      );
      // Said out loud, never left implicit: a silently short list reads as
      // "this is all of them", which is the same class of wrong as a 0 that
      // means unknown.
      return jsonResponse(200, {
        filters, rows,
        runsTruncated: runs.truncated,
        // Hitting the discovery cap omits whole projects' runs, which
        // `runsTruncated` cannot express: it reports only the row cap, so an
        // incomplete answer could report `false`. Same principle as
        // `usage: null` — an incomplete answer must say so.
        projectsTruncated: runs.discoveryTruncated,
      });
    }
    default:
      return jsonResponse(404, { error: `sonata UI: no such path ${rest}` });
  }
}
