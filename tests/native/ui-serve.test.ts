import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('serve mounts the UI', () => {
  it('passes a ui dep to createRouterServer', () => {
    const src = readFileSync(new URL('../../src/commands/serve.ts', import.meta.url), 'utf8');
    const call = src.slice(src.indexOf('createRouterServer({'));
    expect(call).toMatch(/ui:\s*\{/);
  });

  it('announces the UI url on startup', () => {
    const src = readFileSync(new URL('../../src/commands/serve.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/sonata UI/);
  });
});
