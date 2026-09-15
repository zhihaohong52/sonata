import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { handleUiRequest, uiAssetPath } from '../../src/native/ui.js';

const deps = { home: '/tmp/nowhere', port: 4100 };
const host = { host: 'localhost:4100' };

describe('the page', () => {
  it('is present on disk where the server will look for it', async () => {
    expect(existsSync(uiAssetPath())).toBe(true);
  });

  it('is served as HTML at the root of the prefix', async () => {
    const res = await handleUiRequest({ method: 'GET', url: '/__sonata/', headers: host }, deps);
    expect(res?.status).toBe(200);
    expect(res!.headers['content-type']).toMatch(/text\/html/);
    expect((res!.body as Buffer).toString()).toContain('<!doctype html>');
  });

  it('is served without the trailing slash too', async () => {
    expect((await handleUiRequest({ method: 'GET', url: '/__sonata', headers: host }, deps))?.status).toBe(200);
  });

  it('sends no CORS header with the page either', async () => {
    const res = await handleUiRequest({ method: 'GET', url: '/__sonata/', headers: host }, deps);
    const names = Object.keys(res!.headers).map((n) => n.toLowerCase());
    expect(names).not.toContain('access-control-allow-origin');
  });

  it('contains no HTML or code-injection sinks', async () => {
    // This is intentionally a static-only guard: fetched content is read from
    // the page source, while DOM render-path correctness uses textContent.
    const html = readFileSync(uiAssetPath(), 'utf8');
    const forbidden = ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function'];
    for (const identifier of forbidden) {
      expect(html, `found forbidden identifier: ${identifier}`).not.toContain(identifier);
    }
  });

  it('is listed in package.json files so it reaches the tarball', async () => {
    const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    expect(manifest.files).toContain('ui');
  });
});

describe('the page at /', () => {
  it('serves the page for a bare GET /', async () => {
    const res = await handleUiRequest({ method: 'GET', url: '/', headers: host }, deps);
    expect(res?.status).toBe(200);
    expect(res!.headers['content-type']).toMatch(/text\/html/);
    expect((res!.body as Buffer).toString()).toContain('<!doctype html>');
  });

  it('applies the same guards at / as under the prefix', async () => {
    const res = await handleUiRequest({ method: 'GET', url: '/', headers: { host: 'evil.example.com' } }, deps);
    expect(res?.status).toBe(403);
    const ok = await handleUiRequest({ method: 'GET', url: '/', headers: host }, deps);
    expect(ok!.headers['x-content-type-options']).toBe('nosniff');
    expect(Object.keys(ok!.headers).map((n) => n.toLowerCase())).not.toContain('access-control-allow-origin');
  });

  it('serves the page for GET /?x=1, which is the same page', async () => {
    expect((await handleUiRequest({ method: 'GET', url: '/?x=1', headers: host }, deps))?.status).toBe(200);
  });

  /**
   * The regression that matters: claiming `/` must not claim anything else.
   * A bare POST to `/` is a proxied request and has to reach `routeRequest`.
   */
  it('does NOT intercept a bare POST /', async () => {
    expect(await handleUiRequest({ method: 'POST', url: '/', headers: host }, deps)).toBeUndefined();
  });

  it.each(['/v1/messages', '/index.html', '/__sonata_health', '/__sonatafoo', '/favicon.ico'])(
    'leaves %s to the proxy untouched',
    async (url) => {
      for (const method of ['GET', 'POST']) {
        expect(await handleUiRequest({ method, url, headers: host }, deps)).toBeUndefined();
      }
    },
  );
});

describe('the page’s own behaviour, asserted statically', () => {
  const html = (): string => readFileSync(uiAssetPath(), 'utf8');

  it('opens a detail view from a real button, so it is keyboard operable', () => {
    // A <tr onclick> can be neither focused nor activated with Enter/Space.
    expect(html()).toContain("createElement('button')");
    expect(html()).toMatch(/open\.textContent = row\.id/);
  });

  it('queues a follow-up refresh so a filter change during a request is not dropped', () => {
    expect(html()).toContain('refreshQueued');
    expect(html()).toContain('function filtersChanged()');
  });

  it('surfaces project-discovery truncation beside the run-cap notice', () => {
    expect(html()).toContain('data.projectsTruncated');
  });
});
