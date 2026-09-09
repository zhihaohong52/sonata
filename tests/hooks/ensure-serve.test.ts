import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';

const run = promisify(execFile);

// Address the hook absolutely so tests can invoke it from temporary projects.
const SCRIPT = join(process.cwd(), 'hooks', 'ensure-serve.mjs');

async function invoke(
  args: string[],
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ code: number | null; signal: string | null; stderr: string }> {
  try {
    await run('node', [SCRIPT, ...args], { cwd, timeout: 15000, env });
    return { code: 0, signal: null, stderr: '' };
  } catch (err) {
    const e = err as { code: number | null; signal: string | null; stdout: string; stderr: string };
    return { code: e.code, signal: e.signal, stderr: e.stderr ?? '' };
  }
}

describe('ensure-serve SessionStart hook', () => {
  it('exits 0 when the router reports multi-tenant support', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', sonata: true, multiTenant: true }));
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

  it('exits 1 when the router predates multi-tenant routing', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', sonata: true, configPath: '/x' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    try {
      const { code, signal, stderr } = await invoke([String(port)]);
      expect(code).toBe(1);
      expect(signal).toBe(null);
      expect(stderr).toContain('predates multi-tenant routing');
    } finally {
      server.close();
    }
  });

  it('exits 1 when its own post-spawn probe finds a router that predates multi-tenant routing', async () => {
    const binDir = mkdtempSync(join(tmpdir(), 'ensure-serve-bin-'));
    writeFileSync(join(binDir, 'sonata'), '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o755 });
    let probes = 0;
    const server = createServer((_req, res) => {
      probes += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(probes === 1 ? '{}' : JSON.stringify({ status: 'ok', sonata: true, configPath: '/x' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    try {
      const { code, signal, stderr } = await invoke(
        [String(port)], process.cwd(), { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH}` },
      );
      expect(code).toBe(1);
      expect(signal).toBe(null);
      expect(stderr).toContain('predates multi-tenant routing');
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

  it('spawns a global-route daemon from the machine config directory, not $HOME', async () => {
    // For a --global install the spawned `sonata serve --daemon` must resolve
    // the machine config even when a stray ~/sonata.toml exists: configPath()'s
    // first check is `join(cwd, 'sonata.toml')`, so starting the daemon from
    // $HOME would land on the stray file first and shadow the real machine
    // config. The hook fixes that by launching the daemon with `cwd` set to
    // ~/.config/sonata, so we assert on that cwd: a stub `sonata` on PATH
    // records its cwd, and both a real machine config and a stray ~/sonata.toml
    // (the trap this test exists to catch) are in place.
    const home = mkdtempSync(join(tmpdir(), 'ensure-serve-home-'));
    const cfgDir = join(home, '.config', 'sonata');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, 'sonata.toml'), '');
    writeFileSync(join(home, 'sonata.toml'), ''); // the stray that must no longer be the daemon's cwd

    const binDir = mkdtempSync(join(tmpdir(), 'ensure-serve-bin-'));
    writeFileSync(join(binDir, 'sonata'),
      '#!/usr/bin/env node\n' +
      'require("node:fs").writeFileSync(process.env.SONATA_CWD_SENTINEL, process.cwd());\n' +
      'process.exit(0);\n',
      { mode: 0o755 });

    // First probe finds nothing (so the hook spawns its own daemon); the wait
    // loop's probe then reports a healthy multi-tenant router, so the hook exits
    // 0 without spinning the full
    // 10s wait. The sentinel captures the cwd the daemon was spawned with.
    let probes = 0;
    const server = createServer((_req, res) => {
      probes += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      if (probes === 1) {
        res.end(JSON.stringify({}));
      } else {
        res.end(JSON.stringify({ status: 'ok', sonata: true, multiTenant: true }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const sentinel = join(home, 'daemon-cwd.txt');
    try {
      const { code, signal } = await invoke(
        [String(port), '--global'],
        process.cwd(),
        {
          ...process.env,
          HOME: home,
          SONATA_CWD_SENTINEL: sentinel,
          PATH: `${binDir}${delimiter}${process.env.PATH}`,
        },
      );
      expect(code).toBe(0);
      expect(signal).toBe(null);
      // The daemon is detached and unref'd, so its write races the hook's exit.
      // Poll briefly rather than asserting immediately.
      const deadline = Date.now() + 3000;
      while (!existsSync(sentinel) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(realpathSync(readFileSync(sentinel, 'utf8'))).toBe(realpathSync(cfgDir));
    } finally {
      server.close();
    }
  });
});