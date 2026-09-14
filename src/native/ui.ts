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
import { parseFilters, usagePayload } from './ui-usage.js';
import { sessionRows } from './ui-sessions.js';
import { runRows } from './ui-runs.js';
import { runDetail, sessionDetail } from './ui-detail.js';

/**
 * Trailing slash is load-bearing: `/__sonata_health` is the pre-existing
 * health route and must NOT be captured by this prefix.
 */
export const UI_PREFIX = '/__sonata/';

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
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
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
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
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

export function handleUiRequest(
  req: { method: string; url: string; headers: Record<string, string> },
  deps: UiDeps,
): RouterResponse | undefined {
  let path: string;
  let query: URLSearchParams;
  try {
    const parsed = new URL(req.url, 'http://localhost');
    path = parsed.pathname;
    query = parsed.searchParams;
  } catch {
    return undefined; // not ours to answer; let the proxy deal with it
  }
  if (path !== '/__sonata' && !path.startsWith(UI_PREFIX)) return undefined;

  if (!isLoopbackHost(req.headers.host, deps.port)) {
    return jsonResponse(403, { error: 'sonata UI is loopback-only' });
  }
  // Never fall through: a non-GET reaching routeRequest would be forwarded
  // upstream as though it were an API call.
  if (req.method !== 'GET') {
    return jsonResponse(405, { error: 'the sonata UI is read-only; use GET' });
  }

  try {
    return route(path, query, deps);
  } catch {
    // The server's catch-all answers in Anthropic's error shape, which is
    // right for a proxied request and confusing for a fetch from the page.
    // The thrown message is not echoed: it can carry local paths.
    return jsonResponse(500, { error: 'sonata UI: request failed' });
  }
}

function route(path: string, query: URLSearchParams, deps: UiDeps): RouterResponse {
  const rest = path === '/__sonata' ? '' : path.slice(UI_PREFIX.length);
  if (rest === '' || rest === 'index.html') return pageResponse();
  if (rest.startsWith('api/session/')) {
    const id = decodeURIComponent(rest.slice('api/session/'.length));
    if (id === '') return jsonResponse(404, { error: 'sonata UI: no session id' });
    return jsonResponse(200, sessionDetail(deps, id, query));
  }
  if (rest.startsWith('api/run/')) {
    const id = decodeURIComponent(rest.slice('api/run/'.length));
    const detail = runDetail(deps, id, query.get('project') ?? undefined);
    if (detail === undefined) return jsonResponse(404, { error: `sonata UI: no run ${id}` });
    return jsonResponse(200, detail);
  }
  switch (rest) {
    case 'api/ping':
      return jsonResponse(200, { ok: true, port: deps.port, now: (deps.now ?? Date.now)() });
    case 'api/usage': {
      const { report, by, filters } = usagePayload(deps, query);
      return jsonResponse(200, { by, filters, report });
    }
    case 'api/sessions': {
      const filters = parseFilters(query, (deps.now ?? Date.now)());
      const rows = [...sessionRows(deps, filters), ...runRows(deps, filters)].sort(
        (a, b) => (Date.parse(b.started ?? '') || 0) - (Date.parse(a.started ?? '') || 0),
      );
      return jsonResponse(200, { filters, rows });
    }
    default:
      return jsonResponse(404, { error: `sonata UI: no such path ${rest}` });
  }
}
