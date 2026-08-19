import { describe, it, expect } from 'vitest';
import { serveMcp } from '../../src/mcp/server.js';

async function* lines(...ls: string[]) { for (const l of ls) yield l; }

describe('serveMcp', () => {
  const env = { cwd: '/repo', home: '/home', rolesDir: '/pkg/roles' };

  it('answers a handshake and lists tools', async () => {
    const out: string[] = [];
    await serveMcp(lines(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    ), (l) => out.push(l), env);

    expect(out).toHaveLength(2);
    expect(JSON.parse(out[1]).result.tools).toHaveLength(3);
  });

  it('survives malformed input and keeps serving', async () => {
    const out: string[] = [];
    await serveMcp(lines(
      'not json at all',
      JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
    ), (l) => out.push(l), env);

    expect(JSON.parse(out[0]).error.code).toBe(-32700);
    expect(JSON.parse(out[1]).result.tools).toHaveLength(3);
  });

  it('ignores blank lines', async () => {
    const out: string[] = [];
    await serveMcp(lines('', '   '), (l) => out.push(l), env);
    expect(out).toEqual([]);
  });

  it('emits progress notifications only for a supplied token', async () => {
    const out: string[] = [];
    const wait = async (opts: any) => {
      opts.onLines?.(['first harness line', 'second harness line']);
      return { id: opts.id, state: 'RUNNING' as const, lines: [] };
    };
    await serveMcp(lines(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'wait', arguments: { id: 'abc123' }, _meta: { progressToken: 'token-1' } } }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'wait', arguments: { id: 'abc123' } } }),
    ), (l) => out.push(l), { ...env, wait });

    const notifications = out.map((line) => JSON.parse(line)).filter((m) => m.method === 'notifications/progress');
    expect(notifications).toEqual([
      { jsonrpc: '2.0', method: 'notifications/progress',
        params: { progressToken: 'token-1', progress: 1, message: 'first harness line' } },
      { jsonrpc: '2.0', method: 'notifications/progress',
        params: { progressToken: 'token-1', progress: 2, message: 'second harness line' } },
    ]);
  });

});

describe('serveMcp — hostile input', () => {
  const env = { cwd: '/repo', home: '/home', rolesDir: '/pkg/roles' };

  it('survives valid JSON that is not a request object', async () => {
    // JSON.parse('null') succeeds, and reading .id off it threw — killing the
    // loop and taking the session's dispatch capability with it.
    const out: string[] = [];
    await serveMcp(lines('null', '5', '"x"', '[1]',
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })),
      (l) => out.push(l), env);
    expect(JSON.parse(out[out.length - 1]).result.tools).toHaveLength(3);
  });
});
