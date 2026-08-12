/**
 * The MCP surface sonata needs, as a pure function.
 *
 * MCP is JSON-RPC 2.0 over newline-delimited stdio. Only four messages matter
 * here, so the protocol lives in one testable function and the transport is a
 * thin loop around it — the same split as parseKey/runList in tui.ts.
 */

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: object;
}

export interface Deps {
  tools: ToolDef[];
  call(name: string, args: Record<string, unknown>): Promise<string>;
}

/** Used only when a client omits its version; the real one is echoed back. */
const FALLBACK_PROTOCOL_VERSION = '2025-06-18';

export async function handle(
  req: JsonRpcRequest,
  deps: Deps,
): Promise<JsonRpcResponse | null> {
  // Notifications have no id and take no response.
  if (req.id === undefined) return null;
  const id = req.id;

  switch (req.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: (req.params?.protocolVersion as string) ?? FALLBACK_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'sonata', version: '0.0.1' },
        },
      };

    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: deps.tools } };

    case 'tools/call': {
      const name = req.params?.name as string;
      const args = (req.params?.arguments as Record<string, unknown>) ?? {};
      try {
        if (!deps.tools.some((t) => t.name === name)) {
          throw new Error(`unknown tool "${name}"`);
        }
        const text = await deps.call(name, args);
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } };
      } catch (err) {
        // A refused dispatch must reach the wrapper as text it can relay,
        // never as a dropped call it reports nothing about.
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: (err as Error).message }],
            isError: true,
          },
        };
      }
    }

    default:
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `method not found: ${req.method}` },
      };
  }
}
