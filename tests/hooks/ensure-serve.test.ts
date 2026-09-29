import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, delimiter } from 'node:path';

const run = promisify(execFile);

// Address the hook absolutely so tests can invoke it from temporary projects.
const SCRIPT = join(process.cwd(), 'hooks', 'ensure-serve.mjs');

async function invoke(
  args: string[],
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
  timeout = 15000,
): Promise<{ code: number | null; signal: string | null; stderr: string; stdout: string }> {
  try {
    const { stdout } = await run('node', [SCRIPT, ...args], { cwd, timeout, env });
    return { code: 0, signal: null, stderr: '', stdout };
  } catch (err) {
    const e = err as { code: number | null; signal: string | null; stdout: string; stderr: string };
    return { code: e.code, signal: e.signal, stderr: e.stderr ?? '', stdout: e.stdout ?? '' };
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

  it('exits 0 and does not spawn when a Sonata router is still starting', async () => {
    const binDir = mkdtempSync(join(tmpdir(), 'ensure-serve-bin-'));
    const sentinel = join(binDir, 'spawned');
    writeFileSync(join(binDir, 'sonata'),
      `#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'yes');
`,
      { mode: 0o755 });
    const server = createServer((_req, res) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'starting', sonata: true, multiTenant: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    try {
      const { code, signal } = await invoke([String(port)], process.cwd(), { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH}` });
      expect(code).toBe(0);
      expect(signal).toBe(null);
      expect(existsSync(sentinel)).toBe(false);
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
  it('spawns from the session\'s own cwd when ~/.config/sonata holds no machine config', async () => {
    // The directory alone is no evidence: sonata creates it for logs, keys and
    // the router token on machines whose only config is a project's. Starting
    // the daemon there gave it a cwd with no config, which `serve` refuses.
    const home = mkdtempSync(join(tmpdir(), 'ensure-serve-home-'));
    mkdirSync(join(home, '.config', 'sonata', 'logs'), { recursive: true });
    const project = mkdtempSync(join(tmpdir(), 'ensure-serve-project-'));
    const binDir = mkdtempSync(join(tmpdir(), 'ensure-serve-bin-'));
    writeFileSync(join(binDir, 'sonata'),
      '#!/usr/bin/env node\n' +
      'require("node:fs").writeFileSync(process.env.SONATA_CWD_SENTINEL, process.cwd());\n' +
      'process.exit(0);\n',
      { mode: 0o755 });
    let probes = 0;
    const server = createServer((_req, res) => {
      probes += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(probes === 1 ? '{}' : JSON.stringify({ status: 'ok', sonata: true, multiTenant: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const sentinel = join(home, 'daemon-cwd.txt');
    try {
      const { code } = await invoke([String(port)], project, {
        ...process.env, HOME: home, SONATA_CWD_SENTINEL: sentinel, PATH: `${binDir}${delimiter}${process.env.PATH}`,
      });
      expect(code).toBe(0);
      const deadline = Date.now() + 3000;
      while (!existsSync(sentinel) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
      expect(realpathSync(readFileSync(sentinel, 'utf8'))).toBe(realpathSync(project));
    } finally {
      server.close();
    }
  });
  it('says so, as a systemMessage, when the router never comes up — and still exits 0', async () => {
    // The poll used to end with nothing: a session whose router never started
    // got no word of why, only connection errors later. A hook must not break
    // the session, so it reports rather than failing.
    const home = mkdtempSync(join(tmpdir(), 'ensure-serve-home-'));
    const binDir = mkdtempSync(join(tmpdir(), 'ensure-serve-bin-'));
    writeFileSync(join(binDir, 'sonata'), '#!/usr/bin/env node\nprocess.exit(1);\n', { mode: 0o755 });
    const server = createServer((_req, res) => { res.writeHead(200); res.end('{}'); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    try {
      const { code, stdout } = await invoke([String(port)], process.cwd(), {
        ...process.env, HOME: home, PATH: `${binDir}${delimiter}${process.env.PATH}`,
      }, 40000); // the hook's own wait is 10s of polling; leave room for a loaded runner
      expect(code).toBe(0);
      const message = JSON.parse(stdout.trim()).systemMessage as string;
      expect(message).toContain(`did not come up on port ${port}`);
      expect(message).toContain(join(home, '.config', 'sonata', 'logs'));
      expect(message).toContain('sonata serve --daemon');
    } finally {
      server.close();
    }
  }, 45000);

  it('reports a sonata binary that cannot be spawned instead of crashing', async () => {
    const server = createServer((_req, res) => { res.writeHead(200); res.end('{}'); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const emptyBin = mkdtempSync(join(tmpdir(), 'ensure-serve-empty-'));
    try {
      const { code, stdout } = await invoke([String(port)], process.cwd(), {
        ...process.env, PATH: `${emptyBin}${delimiter}${dirname(process.execPath)}`,
      });
      expect(code).toBe(0);
      expect(JSON.parse(stdout.trim()).systemMessage).toContain('could not start `sonata serve --daemon`');
    } finally {
      server.close();
    }
  }, 20000);
});