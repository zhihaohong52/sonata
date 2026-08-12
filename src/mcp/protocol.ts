export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const SERVER_NAME = 'sonata';
export const SERVER_VERSION = '0.0.1';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: number | string | null; result: unknown }
  | { jsonrpc: '2.0'; id: number | string | null; error: JsonRpcError };

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ServerHandlers {
  tools: ToolDef[];
  callTool(name: string, args: Record<string, unknown>): string | Promise<string>;
}

export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

function isRequest(value: unknown): value is JsonRpcRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const req = value as Record<string, unknown>;
  return req.jsonrpc === '2.0' && typeof req.method === 'string';
}

function result(id: number | string | null, value: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result: value };
}

function error(id: number | string | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function callTool(
  id: number | string,
  params: unknown,
  handlers: ServerHandlers,
): Promise<JsonRpcResponse> {
  const p = (params ?? {}) as { name?: unknown; arguments?: unknown };
  const name = p.name;
  const args =
    p.arguments && typeof p.arguments === 'object' && !Array.isArray(p.arguments)
      ? (p.arguments as Record<string, unknown>)
      : {};
  if (typeof name !== 'string' || !handlers.tools.some((t) => t.name === name)) {
    return error(id, ErrorCode.InvalidParams, `Unknown tool: ${String(name)}`);
  }
  const text = await handlers.callTool(name, args);
  return result(id, { content: [{ type: 'text', text }] });
}

export async function handle(
  input: unknown,
  handlers: ServerHandlers,
): Promise<JsonRpcResponse | null> {
  if (!isRequest(input)) {
    return error(null, ErrorCode.InvalidRequest, 'Invalid Request');
  }
  const { id, method, params } = input;
  if (id === undefined || id === null) {
    return null;
  }
  try {
    switch (method) {
      case 'initialize':
        return result(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        });
      case 'tools/list':
        return result(id, { tools: handlers.tools });
      case 'tools/call':
        return await callTool(id, params, handlers);
      default:
        return error(id, ErrorCode.MethodNotFound, `Method not found: ${method}`);
    }
  } catch (err) {
    return error(
      id,
      ErrorCode.InternalError,
      err instanceof Error ? err.message : String(err),
    );
  }
}
