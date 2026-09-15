import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('serve mounts the UI', () => {
  it('passes a ui dep to createRouterServer', () => {
    const src = readFileSync(new URL('../../src/commands/serve.ts', import.meta.url), 'utf8');
    const call = src.slice(src.indexOf('createRouterServer({'));
    // `uiDeps` rather than an inline object: the bound port is written back
    // into it after `listen`, which a literal could not carry.
    expect(call).toMatch(/ui:\s*uiDeps,/);
  });

  it('announces the UI url on startup', () => {
    const src = readFileSync(new URL('../../src/commands/serve.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/sonata UI/);
  });

  it('announces and serves the port actually bound, not the configured one', () => {
    const src = readFileSync(new URL('../../src/commands/serve.ts', import.meta.url), 'utf8');
    // A configured port of 0 binds an ephemeral one; a UiDeps still carrying 0
    // fails every Host check and the startup line reads `localhost:0`.
    expect(src).toMatch(/uiDeps\.port = typeof bound === 'object'/);
    expect(src).toMatch(/sonata UI: http:\/\/localhost:\$\{uiDeps\.port\}\//);
  });
});
