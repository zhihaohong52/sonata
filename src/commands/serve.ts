import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { loadConfig } from '../config.js';
import { resolveKeys } from '../native/credentials.js';
import { envVarForGateway, litellmConfigYaml } from '../native/litellm.js';
import { createRouterServer } from '../native/router.js';

export interface ServeHandle {
  routerPort: number;
  litellmPort: number;
  stop(): Promise<void>;
}

export interface ServeDeps {
  spawnLitellm?: (configPath: string, env: NodeJS.ProcessEnv, port: number) => { pid: number; kill(): void };
  /** Test seam: resolves when litellm answers on its port, rejects on timeout. */
  waitForLitellm?: (port: number) => Promise<void>;
}

/**
 * Where a serve instance records its litellm child's pid.
 *
 * The router dies with the process that started serve (an MCP reconnect kills
 * it), but the spawned litellm child is reparented and survives. The next
 * serve then cannot bind the litellm port: its own child dies silently, and
 * the new router forwards a new master key to the ORPHANED litellm, whose
 * virtual-key lookup fails as "No connected db". Measured 2026-08-20, twice.
 * Recording the pid lets the next serve kill its predecessor's orphan —
 * only a pid sonata itself recorded is ever killed.
 */
export function serveStatePath(home: string): string {
  return join(home, '.config', 'sonata', 'serve-state.json');
}

function killRecordedOrphan(home: string): void {
  const path = serveStatePath(home);
  if (!existsSync(path)) return;
  try {
    const state = JSON.parse(readFileSync(path, 'utf8')) as { litellmPid?: number };
    if (typeof state.litellmPid === 'number' && state.litellmPid > 0) {
      process.kill(state.litellmPid);
    }
  } catch {
    // Already dead, or unreadable state — either way there is nothing to kill.
  }
  try { unlinkSync(path); } catch { /* gone is the goal */ }
}

function recordLitellmPid(home: string, pid: number): void {
  const path = serveStatePath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ litellmPid: pid, recordedAt: new Date().toISOString() }));
}

/** Polls litellm until it answers, so a silent bind failure surfaces here. */
async function defaultWaitForLitellm(port: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`http://localhost:${port}/health/liveliness`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) {
      throw new Error(
        `sonata serve: litellm did not come up on port ${port} within 30s — ` +
        'it may have failed to bind (another litellm running?) or failed to start. ' +
        'Check `litellm --config` by hand.',
      );
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

export function serveHealthUrl(routerPort: number): string {
  return `http://localhost:${routerPort}/__sonata_health`;
}

function defaultSpawnLitellm(configPath: string, env: NodeJS.ProcessEnv, port: number): { pid: number; kill(): void } {
  const child = spawn('litellm', ['--config', configPath, '--port', String(port)], { env });
  return { pid: child.pid ?? 0, kill: () => child.kill() };
}

function listen(server: ReturnType<typeof createRouterServer>, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, 'localhost');
  });
}

function close(server: ReturnType<typeof createRouterServer>): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

export async function cmdServe(
  opts: { cwd: string; home: string; daemon?: boolean } & ServeDeps,
): Promise<ServeHandle> {
  const config = loadConfig(opts.cwd, opts.home);
  if (!config.native) throw new Error('sonata serve: no [native] table');

  const native = config.native;
  const masterKey = `sk-sonata-${randomBytes(32).toString('hex')}`;
  const tempDir = mkdtempSync(join(tmpdir(), 'sonata-litellm-'));
  const configPath = join(tempDir, 'config.json');
  writeFileSync(configPath, litellmConfigYaml(native, masterKey), { mode: 0o600 });

  // LiteLLM still needs PATH for executable lookup; no other parent values are forwarded.
  const childEnv: NodeJS.ProcessEnv = process.env.PATH ? { PATH: process.env.PATH } : {};
  for (const { gateway, key } of resolveKeys(Object.keys(native.gateways), opts.home)) {
    childEnv[envVarForGateway(gateway)] = key;
  }

  // A predecessor's orphaned litellm would hold the port and answer with the
  // wrong master key; kill it (recorded pid only) before spawning our own.
  killRecordedOrphan(opts.home);

  const child = (opts.spawnLitellm ?? defaultSpawnLitellm)(configPath, childEnv, native.ports.litellm);
  recordLitellmPid(opts.home, child.pid);

  try {
    await (opts.waitForLitellm ?? defaultWaitForLitellm)(native.ports.litellm);
  } catch (error) {
    child.kill();
    rmSync(tempDir, { force: true, recursive: true });
    throw error;
  }
  const router = createRouterServer({
    fetch,
    litellmBase: `http://localhost:${native.ports.litellm}`,
    litellmKey: masterKey,
    health: true,
  });

  try {
    await listen(router, native.ports.router);
  } catch (error) {
    child.kill();
    rmSync(tempDir, { force: true, recursive: true });
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new Error(`sonata serve: router port ${native.ports.router} is occupied by a non-sonata listener`);
    }
    throw error;
  }

  const address = router.address();
  const routerPort = typeof address === 'object' && address !== null ? address.port : native.ports.router;
  let stopped = false;

  return {
    routerPort,
    litellmPort: native.ports.litellm,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      child.kill();
      try { unlinkSync(serveStatePath(opts.home)); } catch { /* already gone */ }
      try {
        await close(router);
      } finally {
        rmSync(tempDir, { force: true, recursive: true });
      }
    },
  };
}
