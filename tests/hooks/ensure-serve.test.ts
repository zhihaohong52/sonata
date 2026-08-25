import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);

// The hook is invoked with a relative path in the original test, relying on
// the repo root as cwd. An identity-mismatch test needs a temp project cwd
// (so the hook resolves a known config from its own directory), so the script
// itself must be addressed absolutely.
const SCRIPT = join(process.cwd(), 'hooks', 'ensure-serve.mjs');

async function invoke(
  args: string[],
  cwd = process.cwd(),
): Promise<{ code: number | null; signal: string | null; stderr: string }> {
  try {
    await run('node', [SCRIPT, ...args], { cwd, timeout: 15000 });
    return { code: 0, signal: null, stderr: '' };
  } catch (err) {
    const e = err as { code: number | null; signal: string | null; stdout: string; stderr: string };
    return { code: e.code, signal: e.signal, stderr: e.stderr ?? '' };
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

  it('exits 1 when the router serves a different config than the session resolves', async () => {
    // The hook resolves the config a project-scoped session should route
    // through from its own cwd. Here a temp project sonata.toml makes that
    // deterministic (independent of the real homedir), and the router reports
    // a different configPath — a cross-project misroute that must fail loud.
    const cwd = mkdtempSync(join(tmpdir(), 'ensure-serve-cwd-'));
    writeFileSync(join(cwd, 'sonata.toml'), '');
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', sonata: true, configPath: '/some/other/project/sonata.toml' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    try {
      const { code, signal, stderr } = await invoke([String(port)], cwd);
      expect(code).toBe(1);
      expect(signal).toBe(null);
      expect(stderr).toContain('different sonata configuration');
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