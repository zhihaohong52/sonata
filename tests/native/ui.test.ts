import { describe, expect, it } from 'vitest';
import { handleUiRequest, UI_PREFIX } from '../../src/native/ui.js';

const deps = { home: '/tmp/nowhere', port: 4100 };
const host = { host: 'localhost:4100' };

function body(res: { body: unknown }): any {
  return JSON.parse((res.body as Buffer).toString());
}

describe('handleUiRequest', () => {
  it('ignores a path outside the prefix so the proxy still sees it', () => {
    expect(handleUiRequest({ method: 'POST', url: '/v1/messages', headers: host }, deps)).toBeUndefined();
  });

  it('ignores the pre-existing health route', () => {
    expect(handleUiRequest({ method: 'GET', url: '/__sonata_health', headers: host }, deps)).toBeUndefined();
  });

  it('refuses a non-GET under the prefix rather than letting it reach the proxy', () => {
    const res = handleUiRequest({ method: 'POST', url: '/__sonata/api/usage', headers: host }, deps);
    expect(res?.status).toBe(405);
    expect(body(res!).error).toMatch(/GET/);
  });

  it('refuses a non-loopback Host, which is what closes DNS rebinding', () => {
    const res = handleUiRequest(
      { method: 'GET', url: '/__sonata/api/ping', headers: { host: 'evil.example.com' } },
      deps,
    );
    expect(res?.status).toBe(403);
  });

  it('accepts 127.0.0.1 as well as localhost', () => {
    const res = handleUiRequest(
      { method: 'GET', url: '/__sonata/api/ping', headers: { host: '127.0.0.1:4100' } },
      deps,
    );
    expect(res?.status).toBe(200);
  });

  it('never sends a CORS header', () => {
    const res = handleUiRequest({ method: 'GET', url: '/__sonata/api/ping', headers: host }, deps);
    const names = Object.keys(res!.headers).map((n) => n.toLowerCase());
    expect(names).not.toContain('access-control-allow-origin');
  });

  it('404s an unknown path under the prefix', () => {
    const res = handleUiRequest({ method: 'GET', url: '/__sonata/api/nope', headers: host }, deps);
    expect(res?.status).toBe(404);
  });

  it('returns a JSON error rather than throwing, so the Anthropic catch-all is never reached', () => {
    const res = handleUiRequest(
      { method: 'GET', url: '/__sonata/api/boom', headers: host },
      { ...deps, now: () => { throw new Error('kaboom'); } },
    );
    expect(res?.status).toBe(500);
    expect(body(res!).error).toBeTypeOf('string');
    expect(JSON.stringify(res)).not.toContain('kaboom');
  });
});

describe('UI_PREFIX', () => {
  it('ends in a slash so /__sonata_health cannot match it', () => {
    expect(UI_PREFIX).toBe('/__sonata/');
    expect('/__sonata_health'.startsWith(UI_PREFIX)).toBe(false);
  });
});
