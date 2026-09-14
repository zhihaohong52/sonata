import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { handleUiRequest, uiAssetPath } from '../../src/native/ui.js';

const deps = { home: '/tmp/nowhere', port: 4100 };
const host = { host: 'localhost:4100' };

describe('the page', () => {
  it('is present on disk where the server will look for it', () => {
    expect(existsSync(uiAssetPath())).toBe(true);
  });

  it('is served as HTML at the root of the prefix', () => {
    const res = handleUiRequest({ method: 'GET', url: '/__sonata/', headers: host }, deps);
    expect(res?.status).toBe(200);
    expect(res!.headers['content-type']).toMatch(/text\/html/);
    expect((res!.body as Buffer).toString()).toContain('<!doctype html>');
  });

  it('is served without the trailing slash too', () => {
    expect(handleUiRequest({ method: 'GET', url: '/__sonata', headers: host }, deps)?.status).toBe(200);
  });

  it('sends no CORS header with the page either', () => {
    const res = handleUiRequest({ method: 'GET', url: '/__sonata/', headers: host }, deps);
    const names = Object.keys(res!.headers).map((n) => n.toLowerCase());
    expect(names).not.toContain('access-control-allow-origin');
  });

  it('inserts ledger and transcript content as text, never as HTML', () => {
    // The page renders model-authored content. Any use of innerHTML on fetched
    // data is how that becomes script execution.
    const html = readFileSync(uiAssetPath(), 'utf8');
    expect(html).not.toMatch(/\.innerHTML\s*=/);
    expect(html).not.toMatch(/insertAdjacentHTML/);
  });

  it('is listed in package.json files so it reaches the tarball', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    expect(manifest.files).toContain('ui');
  });
});
