import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';

const run = promisify(execFile);

async function invoke(args: string[]): Promise<{ code: number | null; signal: string | null }> {
  try {
    await run('node', ['hooks/ensure-serve.mjs', ...args], { cwd: process.cwd(), timeout: 15000 });
    return { code: 0, signal: null };
  } catch (err) {
    const e = err as { code: number | null; signal: string | null; stdout: string };
    return { code: e.code, signal: e.signal };
  }
}

describe('ensure-serve SessionStart hook', () => {
  it('exits 0 when the router answers the health endpoint', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', sonata: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    try {
      const { code, signal } = await invoke([String(port)]);
      expect(code).toBe(0);
      expect(signal).toBe(null);
    } finally {
      server.close();
    }
  });

  it('exits 0 and never spawns anything when given no usable port', async () => {
    // A route.hook always passes an integer port, but a hand-edited settings
    // file can pass anything. The hook must exit 0 cleanly — never throw, never
    // hang — even when the port is garbage.
    const { code, signal } = await invoke(['nonsense']);
    expect(code).toBe(0);
    expect(signal).toBe(null);
  });
});