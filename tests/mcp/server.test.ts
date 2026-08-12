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
});
