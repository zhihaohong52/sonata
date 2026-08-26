import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';

const run = promisify(execFile);

// The hook is invoked with a relative path in the original test, relying on
// the repo root as cwd. An identity-mismatch test needs a temp project cwd
// (so the hook resolves a known config from its own directory), so the script
// itself must be addressed absolutely.
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
  it('exits 0 when the router answers the health endpoint with a matching config', async () => {
    // A project-scoped session resolves the config from its own cwd; report
    // that same path so the identity check passes. The hook compares against
    // `process.cwd()`, which is the realpath (macOS `getcwd` resolves the
    // `/var` -> `/private/var` symlink), so the expected path must be the
    // realpath too.
    const cwd = mkdtempSync(join(tmpdir(), 'ensure-serve-ok-'));
    writeFileSync(join(cwd, 'sonata.toml'), '');
    const expectedConfig = realpathSync(join(cwd, 'sonata.toml'));
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', sonata: true, configPath: expectedConfig }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    try {
      const { code, signal } = await invoke([String(port)], cwd);
      expect(code).toBe(0);
      expect(signal).toBe(null);
    } finally {
      server.close();
    }
  });

  it('exits 1 when the router answers but reports no configPath at all', async () => {
    // "The router won't tell us who it is" is indistinguishable from a
    // different project's router and must be rejected, not silently trusted.
    const cwd = mkdtempSync(join(tmpdir(), 'ensure-serve-nocfg-'));
    writeFileSync(join(cwd, 'sonata.toml'), '');
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', sonata: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    try {
      const { code, signal, stderr } = await invoke([String(port)], cwd);
      expect(code).toBe(1);
      expect(signal).toBe(null);
      expect(stderr).toContain('did not report which sonata configuration');
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

  it('exits 1 when its own post-spawn probe reports a different config', async () => {
    // Simulates the race the pre-spawn check alone cannot catch: nothing is
    // listening on the first probe (so the hook spawns its own daemon), but by
    // the time the wait loop's first health probe goes out, another project's
    // daemon has won the port — the hook must fail loud, not quietly adopt a
    // router whose config it never checked.
    const cwd = mkdtempSync(join(tmpdir(), 'ensure-serve-race-'));
    writeFileSync(join(cwd, 'sonata.toml'), '');

    // The spawned daemon is detached with stdio ignored, but `spawn('sonata', …)`
    // still has to resolve a binary — put a no-op stub on PATH so the ENOENT
    // uncaught 'error' event doesn't kill the hook before its wait loop runs.
    const binDir = mkdtempSync(join(tmpdir(), 'ensure-serve-bin-'));
    writeFileSync(join(binDir, 'sonata'), '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o755 });

    let probes = 0;
    const server = createServer((_req, res) => {
      probes += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      if (probes === 1) {
        // "Nothing running yet": the pre-spawn probe finds no router at all.
        res.end('{}');
      } else {
        res.end(JSON.stringify({ status: 'ok', sonata: true, configPath: '/some/other/project/sonata.toml' }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    try {
      const { code, signal, stderr } = await invoke(
        [String(port)],
        cwd,
        { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH}` },
      );
      expect(code).toBe(1);
      expect(signal).toBe(null);
      expect(stderr).toContain('different sonata configuration');
    } finally {
      server.close();
    }
  });

  it('exits 1 when its own post-spawn probe reports no configPath', async () => {
    // The race's losing side then finds a router that answers but reports no
    // configPath — unverifiable, so it must be rejected rather than silently
    // adopted.
    const cwd = mkdtempSync(join(tmpdir(), 'ensure-serve-race-nocfg-'));
    writeFileSync(join(cwd, 'sonata.toml'), '');

    const binDir = mkdtempSync(join(tmpdir(), 'ensure-serve-bin-'));
    writeFileSync(join(binDir, 'sonata'), '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o755 });

    let probes = 0;
    const server = createServer((_req, res) => {
      probes += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      if (probes === 1) {
        res.end('{}');
      } else {
        res.end(JSON.stringify({ status: 'ok', sonata: true }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    try {
      const { code, signal, stderr } = await invoke(
        [String(port)],
        cwd,
        { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH}` },
      );
      expect(code).toBe(1);
      expect(signal).toBe(null);
      expect(stderr).toContain('did not report which sonata configuration');
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
    // loop's probe then reports a healthy router whose configPath matches what a
    // --global session resolves, so the hook exits 0 without spinning the full
    // 10s wait. The sentinel captures the cwd the daemon was spawned with.
    let probes = 0;
    const expectedConfig = join(cfgDir, 'sonata.toml');
    const server = createServer((_req, res) => {
      probes += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      if (probes === 1) {
        res.end(JSON.stringify({}));
      } else {
        res.end(JSON.stringify({ status: 'ok', sonata: true, configPath: expectedConfig }));
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