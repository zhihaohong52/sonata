import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { loadConfig, resolveTierAlias } from '../config.js';
import { resolveKeyFromSource, resolveKeys } from '../native/credentials.js';
import { codexAuthPath, opencodeAuthPath, readChatGptOAuth } from '../native/codex-auth.js';
import { credentialDir } from '../native/oauth-login.js';
import { readCopilotToken } from '../native/copilot-auth.js';
import { envVarForGateway, litellmConfigYaml } from '../native/litellm.js';
import { createRouterServer } from '../native/router.js';
import { timestampedLogPath } from './init-log.js';

export interface ServeHandle {
  routerPort: number;
  litellmPort: number;
  stop(): Promise<void>;
}

export interface SpawnedLitellm {
  pid: number;
  kill(): void;
  /** Fires when the process exits on its own — omitted by stubs that never crash. */
  onExit?(cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
}

export interface ServeDeps {
  spawnLitellm?: (configPath: string, env: NodeJS.ProcessEnv, port: number) => SpawnedLitellm;
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
  /** Test seam: delay before respawning a litellm child that exited on its own. */
  respawnDelayMs?: number;
  /** Test seam: max respawns tolerated within `respawnWindowMs` before giving up. */
  maxRespawns?: number;
  respawnWindowMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Where a serve instance records its own pid and its litellm child's pid.
 *
 * The router dies with the process that started serve, but the spawned litellm
 * child is reparented and survives. The next
 * serve then cannot bind the litellm port: its own child dies silently, and
 * the new router forwards a new master key to the ORPHANED litellm, whose
 * virtual-key lookup fails as "No connected db". Measured 2026-08-20, twice.
 * Recording the pid lets the next serve kill its predecessor's orphan —
 * only a pid sonata itself recorded is ever killed.
 *
 * `routerPid` is `process.pid` at the point the router successfully binds,
 * allowing `sonata restart` to stop only a process Sonata recorded itself.
 * `sonata restart` reads it to kill a stale router without guessing a pid by
 * scanning the OS.
 */
export function serveStatePath(home: string): string {
  return join(home, '.config', 'sonata', 'serve-state.json');
}

interface ServeState {
  routerPid?: number;
  litellmPid?: number;
  recordedAt: string;
}

function readServeState(home: string): ServeState | undefined {
  const path = serveStatePath(home);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ServeState;
  } catch {
    return undefined;
  }
}

function writeServeState(home: string, state: Omit<ServeState, 'recordedAt'>): void {
  const path = serveStatePath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...state, recordedAt: new Date().toISOString() }));
}

function killPid(pid: number | undefined): void {
  if (typeof pid !== 'number' || pid <= 0) return;
  try { process.kill(pid); } catch { /* already dead */ }
}

function killRecordedOrphan(home: string): void {
  const state = readServeState(home);
  killPid(state?.litellmPid);
  try { unlinkSync(serveStatePath(home)); } catch { /* gone is the goal */ }
}

function recordLitellmPid(home: string, pid: number): void {
  writeServeState(home, { ...readServeState(home), litellmPid: pid });
}

function recordRouterPid(home: string, pid: number): void {
  writeServeState(home, { ...readServeState(home), routerPid: pid });
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
 * The occupant may be another Sonata process. Probe the health endpoint
 * before describing the listener so the error tells the user what actually
 * holds the port.
 */
export async function occupiedPortMessage(
  port: number,
  doFetch: typeof fetch = fetch,
): Promise<string> {
  if (await isSonataRouter(port, doFetch)) {
    return `sonata serve: router port ${port} is already served by another sonata router — ` +
      'usually an earlier native router. Use that one, restart it to retire it, ' +
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
function defaultSpawnLitellm(configPath: string, env: NodeJS.ProcessEnv, port: number): SpawnedLitellm {
  const child = spawn('litellm', ['--config', configPath, '--port', String(port)], {
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  return {
    pid: child.pid ?? 0,
    kill: () => child.kill(),
    onExit: (cb) => child.on('exit', cb),
  };
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

/**
 * A shutdown, not a graceful drain: `server.close()` alone stops accepting
 * new connections but waits for every existing one to end on its own —
 * including idle keep-alive sockets, which under an active session can sit
 * open well past any reasonable restart timeout. That's what made a live
 * `sonata restart` report a killed router pid as "still running" long after
 * the process should have exited (observed 2026-08-24, `stopServe`'s 10s
 * wait). Idle connections are closed immediately, since nothing is lost;
 * anything genuinely in-flight gets a short grace window before every
 * remaining connection is forced closed, so this can never hang forever.
 */
function close(server: ReturnType<typeof createRouterServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    server.close((error) => {
      if (settled) return;
      settled = true;
      error ? reject(error) : resolve();
    });
    server.closeIdleConnections();
    // `closeIdleConnections()` only reaches keep-alive sockets that already
    // completed a request — measured directly against a connection that
    // never sent one (e.g. a lingering TCP probe), it does nothing. A
    // restart wants to be fast, not gentle: losing an in-flight response is
    // an acceptable cost of the user explicitly asking to restart, so this
    // window is short.
    setTimeout(() => {
      if (settled) return;
      server.closeAllConnections();
    }, 500).unref();
  });
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
  let child: SpawnedLitellm | undefined;
  let router: ReturnType<typeof createRouterServer> | undefined;
  let stopping = false;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const respawnDelayMs = opts.respawnDelayMs ?? 1000;
  const maxRespawns = opts.maxRespawns ?? 5;
  const respawnWindowMs = opts.respawnWindowMs ?? 60_000;
  const respawnTimestamps: number[] = [];
  try {
    const configPath = join(tempDir, 'config.json');
    writeFileSync(configPath, litellmConfigYaml(native, masterKey, config.unifiedModels), { mode: 0o600 });

    // LiteLLM still needs PATH for executable lookup; no other parent values are forwarded.
    const childEnv: NodeJS.ProcessEnv = process.env.PATH ? { PATH: process.env.PATH } : {};
    const automaticallyResolved = Object.entries(native.gateways)
      .filter(([, gateway]) => gateway.auth !== 'api-key' || gateway.credentialSource === undefined)
      .map(([name]) => name);
    for (const { gateway, key } of resolveKeys(automaticallyResolved, opts.home)) {
      childEnv[envVarForGateway(gateway)] = key;
    }
    for (const [name, gateway] of Object.entries(native.gateways)) {
      const source = gateway.credentialSource;
      if (gateway.auth !== 'api-key' || (source !== 'sonata' && source !== 'opencode')) continue;
      const key = resolveKeyFromSource(name, opts.home, source);
      if (key === undefined) {
        throw new Error(
          `sonata serve: gateway "${name}" takes its credential from ${source} but none was found — ` +
          `run \`sonata auth add ${name}\` (for sonata) or check opencode's own credential store.`,
        );
      }
      childEnv[envVarForGateway(name)] = key;
    }

    // A sonata-owned credential is already in LiteLLM's native format. Point
    // directly at its persistent directory so LiteLLM's refresh survives serve.
    const chatgptGateway = Object.entries(native.gateways)
      .find(([, gateway]) => gateway.auth === 'codex-oauth');
    if (chatgptGateway) {
      const [name, gateway] = chatgptGateway;
      if (gateway.credentialSource === 'sonata') {
        const dir = credentialDir(opts.home, name);
        if (!existsSync(join(dir, 'auth.json'))) {
          throw new Error(
            `sonata serve: gateway "${name}" takes its credential from sonata but none is stored — ` +
            `run \`sonata auth login ${name}\`.`,
          );
        }
        childEnv.CHATGPT_TOKEN_DIR = dir;
      } else {
        const record = readChatGptOAuth(opts.home, gateway.credentialSource);
        if (record === null) {
          throw new Error(
            'sonata serve: a native gateway uses codex-oauth but no ChatGPT credential was found ' +
            `in ${codexAuthPath(opts.home)} or ${opencodeAuthPath(opts.home)} — ` +
            `run \`sonata auth login ${name}\`, or \`codex login\`.`,
          );
        }
        const tokenDir = join(tempDir, 'chatgpt');
        mkdirSync(tokenDir, { recursive: true, mode: 0o700 });
        writeFileSync(join(tokenDir, 'auth.json'), JSON.stringify(record), { mode: 0o600 });
        childEnv.CHATGPT_TOKEN_DIR = tokenDir;
      }
    }

    // Copilot's api-key.json is refreshed and re-exchanged in place too, so a
    // sonata-owned credential must likewise avoid the temporary directory.
    const copilotGateway = Object.entries(native.gateways)
      .find(([, gateway]) => gateway.auth === 'copilot-oauth');
    if (copilotGateway) {
      const [name, gateway] = copilotGateway;
      if (gateway.credentialSource === 'sonata') {
        const dir = credentialDir(opts.home, name);
        if (!existsSync(join(dir, 'api-key.json'))) {
          throw new Error(
            `sonata serve: gateway "${name}" takes its credential from sonata but none is stored — ` +
            `run \`sonata auth login ${name}\`.`,
          );
        }
        childEnv.GITHUB_COPILOT_TOKEN_DIR = dir;
      } else {
        const token = readCopilotToken(opts.home);
        if (token === null) {
          throw new Error(
            'sonata serve: a native gateway uses copilot-oauth but no Copilot login was found ' +
            `in ${opencodeAuthPath(opts.home)} — run \`sonata auth login ${name}\`, ` +
            'or `opencode auth login` and choose github-copilot.',
          );
        }
        const tokenDir = join(tempDir, 'copilot');
        mkdirSync(tokenDir, { recursive: true, mode: 0o700 });
        writeFileSync(join(tokenDir, 'access-token'), token, { mode: 0o600 });
        childEnv.GITHUB_COPILOT_TOKEN_DIR = tokenDir;
      }
    }

    // A predecessor's orphaned litellm would hold the port and answer with the
    // wrong master key; kill it (recorded pid only) before spawning our own.
    killRecordedOrphan(opts.home);

    // The litellm child dying on its own (not via `stop()`) used to go
    // unnoticed until the next request 502'd and someone ran `sonata restart`
    // by hand — measured directly: the child exits, nothing is watching, the
    // router stays up and answers requests with a dead upstream. This watches
    // the exact child this process spawned and respawns it in place, which is
    // why it's safe where `ensure-serve.mjs`'s external health-probe respawn
    // (bug D in the ledger) was not: there is only ever one spawn racing here,
    // never a second `serve` guessing whether an existing one is healthy.
    const spawnLitellmChild = (): SpawnedLitellm => {
      const spawned = (opts.spawnLitellm ?? defaultSpawnLitellm)(configPath, childEnv, native.ports.litellm);
      recordLitellmPid(opts.home, spawned.pid);
      spawned.onExit?.((code, signal) => {
        if (stopping) return;
        const nowMs = now();
        respawnTimestamps.push(nowMs);
        while (respawnTimestamps.length > 0 && nowMs - respawnTimestamps[0] > respawnWindowMs) {
          respawnTimestamps.shift();
        }
        console.error(`sonata serve: litellm exited unexpectedly (code=${code}, signal=${signal})`);
        if (respawnTimestamps.length > maxRespawns) {
          console.error(
            `sonata serve: litellm crashed ${respawnTimestamps.length} times within ` +
            `${Math.round(respawnWindowMs / 1000)}s — giving up on automatic respawn. ` +
            'Fix the underlying problem, then run `sonata restart`.',
          );
          return;
        }
        void (async () => {
          await sleep(respawnDelayMs);
          if (stopping) return;
          console.error('sonata serve: respawning litellm...');
          child = spawnLitellmChild();
        })();
      });
      return spawned;
    };

    child = spawnLitellmChild();

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
      // Config is re-read per call (not the `config`/`native` closed over
      // above) so a tier edit in sonata.toml takes effect without a restart.
      resolveTier: (alias) => resolveTierAlias(loadConfig(opts.cwd, opts.home), alias),
    });

    try {
      await listen(router, native.ports.router);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        throw new Error(await occupiedPortMessage(native.ports.router, opts.probeHealth));
      }
      throw error;
    }
    recordRouterPid(opts.home, process.pid);
  } catch (error) {
    // Suppress the respawn watcher before killing the child — otherwise its
    // `exit` handler schedules a respawn against `configPath`, which the
    // `rmSync` below is about to delete, producing a doomed child spawned
    // after this whole call has already thrown.
    stopping = true;
    child?.kill();
    rmSync(tempDir, { force: true, recursive: true });
    throw error;
  }

  // Router is assigned by the time the try block completes; the catch rethrows.
  // `child` is read fresh in `stop()` below (not frozen here) because a respawn
  // can replace it after this point.
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
      stopping = true;
      child?.kill();
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

export interface StopDeps {
  probeHealth?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  /** Test seam — production default is `process.kill`. */
  kill?: (pid: number) => void;
  /** Test seam — production default checks the OS for the pid. */
  isAlive?: (pid: number) => boolean;
}

/**
 * Whether a pid still exists. `process.kill(pid, 0)` sends no signal, only
 * probes: `ESRCH` means the process is gone, anything else (including
 * `EPERM` — exists, just not owned by us) means it is still alive. An
 * unrecognized error is treated as alive too, so a probe failure never makes
 * `stopServe` declare victory early.
 */
function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export interface StopResult {
  /** False when nothing was running — `restart` on a clean slate is not an error. */
  killed: boolean;
}

/**
 * Kills whatever sonata router currently holds the configured port, using
 * only the pids `cmdServe` itself recorded — never a pid found by scanning
 * the OS, which could belong to an unrelated process reusing the port after
 * a previous sonata instance already exited.
 *
 * The recorded router pid is `process.pid` of the process that called
 * `cmdServe` and won the bind. Killing it is intentional: `sonata restart`
 * makes the lifecycle trade explicit instead of leaving a stale router
 * unreachable forever.
 */
export async function stopServe(
  opts: { cwd: string; home: string } & StopDeps,
): Promise<StopResult> {
  const config = loadConfig(opts.cwd, opts.home);
  if (!config.native) throw new Error('sonata restart: no [native] table');
  const port = config.native.ports.router;
  const probeHealth = opts.probeHealth;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = opts.timeoutMs ?? 10_000;

  if (!(await isSonataRouter(port, probeHealth))) return { killed: false };

  const state = readServeState(opts.home);
  if (state?.routerPid === undefined && state?.litellmPid === undefined) {
    throw new Error(
      `sonata restart: router port ${port} answers as a sonata router, but no recorded pid for it ` +
      `was found in ${serveStatePath(opts.home)} — it may have been started by a different sonata ` +
      'install or an older version. Kill it by hand, then run `sonata serve --daemon`.',
    );
  }

  const kill = opts.kill ?? killPid;
  const isAlive = opts.isAlive ?? defaultIsAlive;
  const pids = [state.routerPid, state.litellmPid].filter((pid): pid is number => pid !== undefined);
  for (const pid of pids) kill(pid);
  try { unlinkSync(serveStatePath(opts.home)); } catch { /* already gone */ }

  // Wait for the pids we killed to actually exit — not for the port to go
  // quiet. Polling the port instead confused "still dying" with "already
  // replaced": an external supervisor that respawns `sonata serve` the
  // instant the port frees can put a brand-new, legitimate router on the
  // same port before our old process has finished exiting, so the port
  // never stops answering and this used to time out reporting failure even
  // though the kill had already succeeded. Checking the specific pids
  // sidesteps that race entirely.
  const deadline = now() + timeoutMs;
  while (pids.some((pid) => isAlive(pid))) {
    if (now() > deadline) {
      const stillAlive = pids.filter((pid) => isAlive(pid));
      throw new Error(
        `sonata restart: killed the recorded process(es) but pid(s) ${stillAlive.join(', ')} ` +
        `are still running after ${Math.round(timeoutMs / 1000)}s.`,
      );
    }
    await sleep(300);
  }

  return { killed: true };
}

/**
 * Stops whatever router currently holds the configured port, then starts a
 * fresh daemon in its place. The two-step split — rather than one call that
 * always wins the bind — exists so a stale in-process router or a daemon left
 * over from a previous build gets cleared out first: `startServeDaemon` alone
 * just times out with "the daemon did not answer" against `EADDRINUSE`,
 * which reads as a startup failure rather than the actual cause.
 */
export async function cmdRestart(
  home: string,
  argv: string[],
  opts: { cwd: string } & StopDeps & DaemonDeps = { cwd: process.cwd() },
): Promise<DaemonResult> {
  await stopServe({
    cwd: opts.cwd, home,
    probeHealth: opts.probeHealth, now: opts.now, sleep: opts.sleep, timeoutMs: opts.timeoutMs, kill: opts.kill,
  });
  return startServeDaemon(home, argv, opts);
}
