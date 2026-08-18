import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import { handle, type JsonRpcRequest } from './protocol.js';
import { TOOL_DEFS, callTool, type ToolEnv } from './tools.js';

/**
 * Records every incoming request verbatim when `SONATA_MCP_DEBUG` names a file.
 *
 * The client's own framing is otherwise invisible: sonata never sees whether
 * Claude Code supplies a `_meta.progressToken`, which is what decides whether
 * the server may push `notifications/progress` at all. Off unless the variable
 * is set, and it never touches stdout — anything written there is protocol.
 */
function debugLog(line: string): void {
  const path = process.env.SONATA_MCP_DEBUG;
  if (!path) return;
  try {
    appendFileSync(path, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Debug logging must never take the session's dispatch capability down.
  }
}

/**
 * The stdio loop. Input is injected so the whole server is testable without a
 * process, which is the same seam readKeys uses for stdin in tui.ts.
 */
export async function serveMcp(
  input: AsyncIterable<string>,
  write: (line: string) => void,
  env: ToolEnv,
): Promise<void> {
  for await (const raw of input) {
    const line = raw.trim();
    if (line.length === 0) continue;
    debugLog(line);

    let req: JsonRpcRequest;
    try {
      req = JSON.parse(line) as JsonRpcRequest;
    } catch {
      // Never die on bad input: the session loses dispatch entirely.
      write(JSON.stringify({
        jsonrpc: '2.0', id: null,
        error: { code: -32700, message: 'parse error' },
      }));
      continue;
    }

    // JSON.parse accepts `null`, `5`, `"x"` and `[1]`. Reading .id off any of
    // them threw, which killed the loop — and a dead server takes the
    // session's dispatch capability with it.
    if (typeof req !== 'object' || req === null || Array.isArray(req)) {
      write(JSON.stringify({
        jsonrpc: '2.0', id: null,
        error: { code: -32600, message: 'invalid request' },
      }));
      continue;
    }

    const token = req.method === 'tools/call'
      && req.params?._meta
      && typeof req.params._meta === 'object'
      ? (req.params._meta as Record<string, unknown>).progressToken
      : undefined;
    let progress = 0;
    const onLines = typeof token === 'string' || typeof token === 'number'
      ? (lines: string[]) => {
        for (const message of lines) {
          write(JSON.stringify({
            jsonrpc: '2.0',
            method: 'notifications/progress',
            params: { progressToken: token, progress: ++progress, message },
          }));
        }
      }
      : undefined;

    const res = await handle(req, {
      tools: TOOL_DEFS,
      call: (name, args, onLines) => callTool(name, args, env, onLines),
    }, onLines);
    if (res !== null) write(JSON.stringify(res));
  }
}

/** Wires the loop to the real stdio streams. */
export async function runMcpStdio(env: ToolEnv): Promise<void> {
  const rl = createInterface({ input: process.stdin });
  await serveMcp(rl, (l) => process.stdout.write(`${l}\n`), env);
}
