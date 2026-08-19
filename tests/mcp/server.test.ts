import { describe, it, expect } from 'vitest';
import { serveMcp, progressWindow } from '../../src/mcp/server.js';

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
        params: {
          progressToken: 'token-1',
          progress: 1,
          message: 'first harness line\nsecond harness line',
        } },
    ]);
  });

  it('carries the accumulated window, not just the newest batch', async () => {
    // A client renders the latest progress message and replaces the one before
    // it, so a message holding one line leaves one line on screen.
    const out: string[] = [];
    const wait = async (opts: any) => {
      opts.onLines?.(['line one']);
      opts.onLines?.(['line two']);
      return { id: opts.id, state: 'RUNNING' as const, lines: [] };
    };
    await serveMcp(lines(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'wait', arguments: { id: 'abc123' }, _meta: { progressToken: 't' } } }),
    ), (l) => out.push(l), { ...env, wait });

    const messages = out.map((l) => JSON.parse(l))
      .filter((m) => m.method === 'notifications/progress')
      .map((m) => m.params.message);
    expect(messages).toEqual(['line one', 'line one\nline two']);
  });

  it('starts each call with an empty window', async () => {
    const out: string[] = [];
    const wait = async (opts: any) => {
      opts.onLines?.([`line for ${opts.id}`]);
      return { id: opts.id, state: 'RUNNING' as const, lines: [] };
    };
    const call = (id: number, run: string) => JSON.stringify({
      jsonrpc: '2.0', id, method: 'tools/call',
      params: { name: 'wait', arguments: { id: run }, _meta: { progressToken: 't' } },
    });
    await serveMcp(lines(call(1, 'aaa'), call(2, 'bbb')), (l) => out.push(l), { ...env, wait });

    const messages = out.map((l) => JSON.parse(l))
      .filter((m) => m.method === 'notifications/progress')
      .map((m) => m.params.message);
    expect(messages).toEqual(['line for aaa', 'line for bbb']);
  });
});

describe('progressWindow', () => {
  it('keeps the newest lines when there are more than fit', () => {
    const lines = ['a', 'b', 'c', 'd'];
    expect(progressWindow(lines, 2)).toEqual(['c', 'd']);
  });

  it('drops from the oldest end to fit the character budget', () => {
    // The newest line is the one being waited on, so it is sacrificed last.
    expect(progressWindow(['aaaa', 'bbbb', 'cc'], 10, 8)).toEqual(['bbbb', 'cc']);
  });

  it('truncates a single line longer than the whole budget', () => {
    expect(progressWindow(['x'.repeat(50)], 10, 8)).toEqual(['x'.repeat(8)]);
  });

  it('returns nothing for no lines', () => {
    expect(progressWindow([])).toEqual([]);
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
