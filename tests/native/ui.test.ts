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
      { method: 'GET', url: '/__sonata/api/usage', headers: { host: 'evil.example.com' } },
      deps,
    );
    expect(res?.status).toBe(403);
  });

  it('accepts each loopback host with the router port', () => {
    for (const host of ['localhost:4100', '127.0.0.1:4100', '[::1]:4100']) {
      const res = handleUiRequest(
        { method: 'GET', url: '/__sonata/api/usage', headers: { host } },
        deps,
      );
      expect(res?.status).toBe(200);
    }
  });

  it('accepts bare loopback hosts only on the default HTTP port', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      const res = handleUiRequest(
        { method: 'GET', url: '/__sonata/api/usage', headers: { host } },
        { ...deps, port: 80 },
      );
      expect(res?.status).toBe(200);
    }
  });

  it('rejects a loopback host with the wrong or malformed port', () => {
    for (const host of ['localhost:9999', 'localhost:bad', 'localhost:4100:extra', '[::1]garbage']) {
      const res = handleUiRequest(
        { method: 'GET', url: '/__sonata/api/usage', headers: { host } },
        deps,
      );
      expect(res?.status).toBe(403);
    }
  });

  it('refuses HEAD because the UI only accepts GET', () => {
    const res = handleUiRequest({ method: 'HEAD', url: '/__sonata/api/usage', headers: host }, deps);
    expect(res?.status).toBe(405);
    expect(body(res!).error).toMatch(/GET/);
  });

  it('never sends a CORS header', () => {
    const res = handleUiRequest({ method: 'GET', url: '/__sonata/api/usage', headers: host }, deps);
    const names = Object.keys(res!.headers).map((n) => n.toLowerCase());
    expect(names).not.toContain('access-control-allow-origin');
  });

  it('refuses an unknown dimension with a 400 naming the valid ones, not a generic 500', () => {
    const res = handleUiRequest(
      { method: 'GET', url: '/__sonata/api/usage?by=wheelbarrow', headers: host },
      deps,
    );
    expect(res?.status).toBe(400);
    const parsed = body(res!);
    for (const dimension of ['model', 'role', 'tier', 'effort', 'gateway', 'session', 'project']) {
      expect(parsed.error).toContain(dimension);
    }
    // Self-authored: the caller's own input is never echoed back.
    expect(JSON.stringify(parsed)).not.toContain('wheelbarrow');
  });

  it('sends nosniff on a JSON response', () => {
    const res = handleUiRequest({ method: 'GET', url: '/__sonata/api/usage', headers: host }, deps);
    expect(res!.headers['x-content-type-options']).toBe('nosniff');
  });

  it('404s an unknown path under the prefix', () => {
    const res = handleUiRequest({ method: 'GET', url: '/__sonata/api/nope', headers: host }, deps);
    expect(res?.status).toBe(404);
  });

  it('returns a JSON error rather than throwing, so the Anthropic catch-all is never reached', () => {
    const res = handleUiRequest(
      { method: 'GET', url: '/__sonata/api/usage', headers: host },
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
