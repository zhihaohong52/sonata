import { createInterface } from 'node:readline';
import { handle, type JsonRpcRequest } from './protocol.js';
import { TOOL_DEFS, callTool, type ToolEnv } from './tools.js';

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

    const res = await handle(req, {
      tools: TOOL_DEFS,
      call: (name, args) => callTool(name, args, env),
    });
    if (res !== null) write(JSON.stringify(res));
  }
}

/** Wires the loop to the real stdio streams. */
export async function runMcpStdio(env: ToolEnv): Promise<void> {
  const rl = createInterface({ input: process.stdin });
  await serveMcp(rl, (l) => process.stdout.write(`${l}\n`), env);
}
