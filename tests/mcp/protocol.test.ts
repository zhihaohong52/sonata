import { describe, it, expect, vi } from 'vitest';
import { handle, type ServerHandlers } from '../../src/mcp/protocol.js';

const ECHO_TOOL = {
  name: 'echo',
  description: 'Echo the text argument back',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
};

function handlers(overrides: Partial<ServerHandlers> = {}): ServerHandlers {
  return {
    tools: [ECHO_TOOL],
    callTool: async (name, args) =>
      name === 'echo' ? String(args.text) : `unhandled ${name}`,
    ...overrides,
  };
}

describe('handle — request framing', () => {
  it('answers a well-formed request, echoing back its id', async () => {
    const res = await handle({ jsonrpc: '2.0', id: 7, method: 'initialize' }, handlers());
    expect(res?.id).toBe(7);
    expect(res?.jsonrpc).toBe('2.0');
  });

  it('rejects non-object input with Invalid Request', async () => {
    for (const bad of [null, 'text', 42, true, ['a', 'b'], undefined]) {
      const res = await handle(bad, handlers());
      expect(res).toMatchObject({ error: { code: -32600 } });
    }
  });

  it('rejects a request with the wrong jsonrpc version', async () => {
    const res = await handle({ jsonrpc: '1.0', id: 1, method: 'initialize' }, handlers());
    expect(res).toMatchObject({ error: { code: -32600 } });
  });

  it('rejects a request with no method', async () => {
    const res = await handle({ jsonrpc: '2.0', id: 1 }, handlers());
    expect(res).toMatchObject({ error: { code: -32600 } });
  });

  it('rejects a JSON-RPC batch, which MCP never uses', async () => {
    const res = await handle(
      [{ jsonrpc: '2.0', id: 1, method: 'initialize' }],
      handlers(),
    );
    expect(res).toMatchObject({ error: { code: -32600 } });
  });

  it('treats a request without an id as a notification and does not reply', async () => {
    const res = await handle({ jsonrpc: '2.0', method: 'initialize' }, handlers());
    expect(res).toBeNull();
  });
});

describe('handle — MCP methods', () => {
  it('initialize answers with protocol version, capabilities and server info', async () => {
    const res = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, handlers());
    expect(res).toMatchObject({
      id: 1,
      result: {
        protocolVersion: expect.any(String),
        capabilities: { tools: {} },
        serverInfo: { name: 'sonata', version: expect.any(String) },
      },
    });
  });

  it('tools/list returns the registered ToolDefs', async () => {
    const res = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, handlers());
    expect(res).toMatchObject({ id: 1, result: { tools: [ECHO_TOOL] } });
  });

  it('tools/call invokes the handler with the tool arguments', async () => {
    const call = vi.fn(async () => 'hi');
    const res = await handle(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' } } },
      handlers({ callTool: call }),
    );
    expect(call).toHaveBeenCalledWith('echo', { text: 'hi' });
    expect(res).toMatchObject({
      id: 1,
      result: { content: [{ type: 'text', text: 'hi' }] },
    });
  });

  it('tools/call defaults missing arguments to an empty object', async () => {
    const call = vi.fn(async () => 'ok');
    await handle(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo' } },
      handlers({ callTool: call }),
    );
    expect(call).toHaveBeenCalledWith('echo', {});
  });

  it('tools/call with an unknown tool name is Invalid params', async () => {
    const res = await handle(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nope' } },
      handlers(),
    );
    expect(res).toMatchObject({ error: { code: -32602 } });
  });

  it('tools/call with no name is Invalid params', async () => {
    const res = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call' }, handlers());
    expect(res).toMatchObject({ error: { code: -32602 } });
  });

  it('an unknown method is Method not found', async () => {
    const res = await handle({ jsonrpc: '2.0', id: 1, method: 'nope/nope' }, handlers());
    expect(res).toMatchObject({ error: { code: -32601 } });
  });

  it('a throwing handler becomes an Internal error with its message', async () => {
    const res = await handle(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: {} } },
      handlers({ callTool: async () => { throw new Error('boom'); } }),
    );
    expect(res).toMatchObject({ error: { code: -32603, message: 'boom' } });
  });

  it('does not invoke callTool for notifications or unknown methods', async () => {
    const call = vi.fn(async () => 'ok');
    const hs = handlers({ callTool: call });
    await handle({ jsonrpc: '2.0', method: 'initialize' }, hs);
    await handle({ jsonrpc: '2.0', id: 2, method: 'nope/nope' }, hs);
    expect(call).not.toHaveBeenCalled();
  });
});
