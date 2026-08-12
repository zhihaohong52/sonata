import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { handle, type ToolDef, type JsonRpcRequest } from '../../src/mcp/protocol.js';

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

/**
 * The captured exchange, not an imagined one. Claude Code 2.1.228 opening a
 * project-scoped sonata server on 2026-08-12; every line is verbatim.
 */
describe('the captured handshake', () => {
  const lines = readFileSync(
    join(import.meta.dirname, '..', 'fixtures', 'mcp-handshake.jsonl'), 'utf8')
    .split('\n').filter((l) => l.trim().length > 0);

  const requests = () => lines.map((l) => JSON.parse(l) as JsonRpcRequest);

  it('replays with a well-formed response for every request', async () => {
    for (const req of requests()) {
      const res = await handle(req, deps);
      if (req.id === undefined) {
        // notifications/initialized carries no id and must draw no response.
        expect(res).toBeNull();
        continue;
      }
      expect(res).not.toBeNull();
      expect(res!.jsonrpc).toBe('2.0');
      expect(res!.id).toBe(req.id);
      expect(res!.error).toBeUndefined();
    }
  });

  it('answers the initialize whose id is 0', async () => {
    // The real client numbers from zero. `if (req.id)` would have dropped this
    // response and hung the session; only a capture shows it.
    const init = requests().find((r) => r.method === 'initialize')!;
    expect(init.id).toBe(0);
    expect(await handle(init, deps)).not.toBeNull();
  });

  it('echoes the protocol version the real client asked for', async () => {
    const init = requests().find((r) => r.method === 'initialize')!;
    expect(init.params!.protocolVersion).toBe('2025-11-25');
    const res = await handle(init, deps);
    expect((res!.result as any).protocolVersion).toBe('2025-11-25');
  });

  it('serves tools/list, the call that decides whether a wrapper has tools', async () => {
    const list = requests().find((r) => r.method === 'tools/list')!;
    const res = await handle(list, deps);
    expect((res!.result as any).tools).toEqual(tools);
  });
});
