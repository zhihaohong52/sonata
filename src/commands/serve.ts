import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { loadConfig } from '../config.js';
import { resolveKeys } from '../native/credentials.js';
import { codexAuthPath, opencodeAuthPath, readChatGptOAuth } from '../native/codex-auth.js';
import { readCopilotToken } from '../native/copilot-auth.js';
import { envVarForGateway, litellmConfigYaml } from '../native/litellm.js';
import { createRouterServer } from '../native/router.js';
import { timestampedLogPath } from './init-log.js';

export interface ServeHandle {
  routerPort: number;
  litellmPort: number;
  stop(): Promise<void>;
}

export interface ServeDeps {
  spawnLitellm?: (configPath: string, env: NodeJS.ProcessEnv, port: number) => { pid: number; kill(): void };
  /** Test seam: resolves when litellm answers on its port, rejects on timeout. */
  waitForLitellm?: (port: number) => Promise<void>;
  /**
   * Where the generated litellm config and any credential file are written.
   *
   * Injected by tests so a run never writes a 0600 master-key file into the
   * real system temp directory — two such files, carrying a test fixture's
   * gateway URL, were found there after a suite run.
   */
  tempDir?: string;
  /** Test seam for the "who holds the router port?" probe. */
  probeHealth?: typeof fetch;
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

/** Whether whatever holds a port is a sonata router. */
export async function isSonataRouter(
  port: number,
  doFetch: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await doFetch(serveHealthUrl(port), {
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return false;
    const body = await response.json() as { sonata?: unknown };
    return body?.sonata === true;
  } catch {
    return false;
  }
}

/**
 * What to say when the router port is taken.
 *
 * The occupant is usually sonata itself: an MCP dispatch to a native model
 * starts a router inside the `sonata mcp` process, and that router lives as
 * long as the MCP server does — which is until Claude Code is restarted, not
 * until the dispatch ends. A day-old one was found holding this port and
 * answering its health endpoint, while `serve` called it "a non-sonata
 * listener" and sent the user looking for a foreign program. The health
 * endpoint already exists; asking it costs one request and makes the message
 * true.
 */
export async function occupiedPortMessage(
  port: number,
  doFetch: typeof fetch = fetch,
): Promise<string> {
  if (await isSonataRouter(port, doFetch)) {
    return `sonata serve: router port ${port} is already served by another sonata router — ` +
      'usually one started inside a `sonata mcp` process by an earlier native dispatch, ' +
      'which lives until Claude Code restarts. Use that one, restart Claude Code to retire it, ' +
      `or give this instance a different [native.ports] router port.`;
  }
  return `sonata serve: router port ${port} is occupied by a non-sonata listener`;
}

/**
 * LiteLLM's own output is the only place a per-model startup failure appears.
 *
 * It drops a deployment it cannot authenticate and carries on, so the model
 * simply vanishes from the catalogue and the next request answers "no healthy
 * deployments for this model" — with the actual cause (for one real case, a 403
 * from GitHub's Copilot token exchange) written only to a stream nobody read.
 */
function defaultSpawnLitellm(configPath: string, env: NodeJS.ProcessEnv, port: number): { pid: number; kill(): void } {
  const child = spawn('litellm', ['--config', configPath, '--port', String(port)], {
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
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
  const tempDir = opts.tempDir ?? mkdtempSync(join(tmpdir(), 'sonata-litellm-'));
  mkdirSync(tempDir, { recursive: true });

  // Everything from here to a listening router owns `tempDir`. Cleanup used to
  // be duplicated on two failure branches and absent from every other throw, so
  // a run that died in between left its config behind.
  let child: { pid: number; kill(): void } | undefined;
  let router: ReturnType<typeof createRouterServer> | undefined;
  try {
    const configPath = join(tempDir, 'config.json');
    writeFileSync(configPath, litellmConfigYaml(native, masterKey), { mode: 0o600 });

    // LiteLLM still needs PATH for executable lookup; no other parent values are forwarded.
    const childEnv: NodeJS.ProcessEnv = process.env.PATH ? { PATH: process.env.PATH } : {};
    for (const { gateway, key } of resolveKeys(Object.keys(native.gateways), opts.home)) {
      childEnv[envVarForGateway(gateway)] = key;
    }

    // A codex-oauth gateway carries no key: LiteLLM's chatgpt provider reads the
    // subscription token from its own auth file and refreshes it in place.
    if (Object.values(native.gateways).some((gateway) => gateway.auth === 'codex-oauth')) {
      const record = readChatGptOAuth(opts.home);
      if (record === null) {
        throw new Error(
          'sonata serve: a native gateway uses codex-oauth but no ChatGPT credential was found ' +
          `in ${codexAuthPath(opts.home)} or ${opencodeAuthPath(opts.home)} — ` +
          'run `codex login` (or `opencode auth login` and choose openai).',
        );
      }
      const tokenDir = join(tempDir, 'chatgpt');
      mkdirSync(tokenDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(tokenDir, 'auth.json'), JSON.stringify(record), { mode: 0o600 });
      childEnv.CHATGPT_TOKEN_DIR = tokenDir;
    }

    // Likewise for Copilot: opencode holds a GitHub OAuth token, and LiteLLM's
    // github_copilot provider exchanges it for a short-lived Copilot key. The
    // provider reads the GitHub token from a plain `access-token` file.
    if (Object.values(native.gateways).some((gateway) => gateway.auth === 'copilot-oauth')) {
      const token = readCopilotToken(opts.home);
      if (token === null) {
        throw new Error(
          'sonata serve: a native gateway uses copilot-oauth but no Copilot login was found ' +
          `in ${opencodeAuthPath(opts.home)} — run \`opencode auth login\` and choose github-copilot.`,
        );
      }
      const tokenDir = join(tempDir, 'copilot');
      mkdirSync(tokenDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(tokenDir, 'access-token'), token, { mode: 0o600 });
      childEnv.GITHUB_COPILOT_TOKEN_DIR = tokenDir;
    }

    // A predecessor's orphaned litellm would hold the port and answer with the
    // wrong master key; kill it (recorded pid only) before spawning our own.
    killRecordedOrphan(opts.home);

    child = (opts.spawnLitellm ?? defaultSpawnLitellm)(configPath, childEnv, native.ports.litellm);
    recordLitellmPid(opts.home, child.pid);

    await (opts.waitForLitellm ?? defaultWaitForLitellm)(native.ports.litellm);

    router = createRouterServer({
      fetch,
      litellmBase: `http://localhost:${native.ports.litellm}`,
      litellmKey: masterKey,
      health: true,
      // Goes to serve's stdout, which --daemon captures to its log file. This
      // is the only record of which upstream served a request: litellm's access
      // log has the path and status but not the model, so without it "did that
      // agent really run on the foreign model?" cannot be answered from
      // evidence.
      log: (line) => console.log(line),
    });

    try {
      await listen(router, native.ports.router);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        throw new Error(await occupiedPortMessage(native.ports.router, opts.probeHealth));
      }
      throw error;
    }
  } catch (error) {
    child?.kill();
    rmSync(tempDir, { force: true, recursive: true });
    throw error;
  }

  // Both are assigned by the time the try block completes; the catch rethrows.
  const startedChild = child as { pid: number; kill(): void };
  const startedRouter = router as ReturnType<typeof createRouterServer>;

  const address = startedRouter.address();
  const routerPort = typeof address === 'object' && address !== null ? address.port : native.ports.router;
  let stopped = false;

  return {
    routerPort,
    litellmPort: native.ports.litellm,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      startedChild.kill();
      try { unlinkSync(serveStatePath(opts.home)); } catch { /* already gone */ }
      try {
        await close(startedRouter);
      } finally {
        rmSync(tempDir, { force: true, recursive: true });
      }
    },
  };
}

export interface DaemonDeps {
  spawn?: typeof spawn;
  /** Resolves true once the router answers on `port`. */
  probe?: (port: number) => Promise<boolean>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

export interface DaemonResult {
  pid: number;
  port: number;
  logPath: string;
}

/**
 * Starts `sonata serve` in a detached child and waits until it answers.
 *
 * `--daemon` used to be parsed, passed to `cmdServe`, and then ignored — the
 * command blocked forever like the foreground one, which is what "the flag does
 * nothing" looked like from a shell.
 *
 * The wait is the part worth keeping: a detached child that fails (an occupied
 * port, a gateway LiteLLM drops) would otherwise exit silently, leaving the
 * user with a success message and no server. Its output goes to a log file for
 * the same reason — a detached process has nowhere else to say why it stopped.
 */
export async function startServeDaemon(
  home: string,
  argv: string[],
  deps: DaemonDeps = {},
): Promise<DaemonResult> {
  const spawnFn = deps.spawn ?? spawn;
  const probe = deps.probe ?? ((port: number) => isSonataRouter(port));
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = deps.timeoutMs ?? 60_000;

  const config = loadConfig(process.cwd(), home);
  if (!config.native) throw new Error('sonata serve: no [native] table');
  const port = config.native.ports.router;

  const logPath = timestampedLogPath(home, 'serve');
  mkdirSync(dirname(logPath), { recursive: true });
  const log = openSync(logPath, 'a');

  const child = spawnFn(argv[0], argv.slice(1), {
    detached: true,
    stdio: ['ignore', log, log],
  });
  child.unref();

  const deadline = now() + timeoutMs;
  for (;;) {
    if (await probe(port)) return { pid: child.pid ?? 0, port, logPath };
    if (now() > deadline) {
      throw new Error(
        `sonata serve: the daemon did not answer on port ${port} within ${Math.round(timeoutMs / 1000)}s. ` +
        `See ${logPath}`,
      );
    }
    await sleep(500);
  }
}
