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
 * How much recent output a single progress notification carries.
 *
 * MCP has no notion of history: the client renders the latest progress
 * message and replaces the one before it. Sonata has always sent every line —
 * one notification each — so the whole transcript crossed the wire and all but
 * its last line was overwritten before anyone could read it. Sending a rolling
 * window instead makes the message that survives *be* the recent history.
 *
 * This assumes the client renders the newlines. If one flattens them the
 * window is *worse* than the single line it replaced — the newest line sits at
 * the end, so a flattened or width-clipped blob buries the very line the user
 * is waiting on. Measure before assuming; per-line emission is the fallback.
 */
export const MAX_PROGRESS_LINES = 20;
export const MAX_PROGRESS_CHARS = 2_000;

/** The tail of `lines` that fits both budgets, oldest first. */
export function progressWindow(
  lines: string[],
  maxLines = MAX_PROGRESS_LINES,
  maxChars = MAX_PROGRESS_CHARS,
): string[] {
  const window = lines.slice(-maxLines);
  // Drop from the oldest end: the newest line is the one the user is waiting
  // to see, so it is the last thing that may be sacrificed.
  while (window.length > 1 && window.join('\n').length > maxChars) window.shift();
  if (window.length === 1 && window[0].length > maxChars) {
    // One line longer than the whole budget. Keep its head — a harness prints
    // what it is doing first and its arguments after.
    return [window[0].slice(0, maxChars)];
  }
  return window;
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
    let recent: string[] = [];
    const onLines = typeof token === 'string' || typeof token === 'number'
      ? (lines: string[]) => {
        // One notification per batch, not per line: each carries the window
        // rather than a single line, so the message left on screen is the
        // recent transcript instead of whichever line happened to be last.
        recent = progressWindow([...recent, ...lines]);
        write(JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/progress',
          params: { progressToken: token, progress: ++progress, message: recent.join('\n') },
        }));
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
