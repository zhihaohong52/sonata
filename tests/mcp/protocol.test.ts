import { describe, it, expect } from 'vitest';
import { handle, type ToolDef } from '../../src/mcp/protocol.js';

const tools: ToolDef[] = [
  { name: 'run', description: 'launch', inputSchema: { type: 'object', properties: {} } },
];
const deps = { tools, call: async (n: string) => `called ${n}` };

describe('handle', () => {
  it('answers initialize with the client\'s protocol version', async () => {
    const res = await handle(
      { jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18' } }, deps);
    expect(res!.result).toMatchObject({
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
    });
    expect((res!.result as any).serverInfo.name).toBe('sonata');
  });

  it('returns nothing for a notification', async () => {
    expect(await handle(
      { jsonrpc: '2.0', method: 'notifications/initialized' }, deps)).toBeNull();
  });

  it('lists the tools it was given', async () => {
    const res = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, deps);
    expect((res!.result as any).tools).toEqual(tools);
  });

  it('calls a tool and wraps the text', async () => {
    const res = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'run', arguments: {} } }, deps);
    expect((res!.result as any).content).toEqual([{ type: 'text', text: 'called run' }]);
    expect((res!.result as any).isError).toBeUndefined();
  });

  it('reports a throwing tool as isError rather than crashing', async () => {
    // This is the path that was invisible on 2026-08-12: a refused dispatch
    // must reach the wrapper as text it can relay.
    const res = await handle({ jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'run', arguments: {} } },
      { tools, call: async () => { throw new Error('unknown model "x"'); } });
    expect((res!.result as any).isError).toBe(true);
    expect((res!.result as any).content[0].text).toContain('unknown model');
  });

  it('rejects an unknown tool without throwing', async () => {
    const res = await handle({ jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'nope', arguments: {} } }, deps);
    expect((res!.result as any).isError).toBe(true);
  });

  it('returns method-not-found for an unknown method', async () => {
    const res = await handle({ jsonrpc: '2.0', id: 6, method: 'nope' }, deps);
    expect(res!.error!.code).toBe(-32601);
  });
});
