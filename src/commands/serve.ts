import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

  const child = (opts.spawnLitellm ?? defaultSpawnLitellm)(configPath, childEnv, native.ports.litellm);
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
      try {
        await close(router);
      } finally {
        rmSync(tempDir, { force: true, recursive: true });
      }
    },
  };
}
