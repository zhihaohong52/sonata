import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer as createHttpServer, type RequestListener, type Server } from 'node:http';

import { loadModelsDev } from '../modelsdev.js';
import { spentTodayUsd, unreadableMachineBudget, type BudgetStatus } from '../budget.js';
import { GLOBAL_CONFIG_RELATIVE, loadConfig, nativeRouteFor, oauthCredentialIdentity, resolveTierAlias, type NativeConfig, type SonataConfig } from '../config.js';
import { appendRow, LEDGER_RETENTION_DAYS, pruneLedger, type LedgerRow } from '../ledger.js';
import { pruneSessions } from '../sessions.js';
import { resolveKeyDetail, resolveKeys, sonataKeyStorePath } from '../native/credentials.js';
import { fileStoreRead, jsonStoreRead, opencodeDbRead, type StoreRead } from '../native/credential-reads.js';
import { codexAuthPath, jwtExpiry, opencodeAuthPath, readChatGptOAuth, readCodexOAuth, readOpencodeChatGptOAuth, type ChatGptAuthRecord } from '../native/codex-auth.js';
import { opencodeDbPath } from '../native/opencode-store.js';
import { credentialDir } from '../native/oauth-login.js';
import { readCopilotToken } from '../native/copilot-auth.js';
import { envVarForGateway, litellmConfigForTenants, litellmConfigYamlForTenants } from '../native/litellm.js';
import { litellmRequired, transportFor } from '../native/providers.js';
import { litellmStatus, managedLitellmPath } from '../native/litellm-venv.js';
import type { UiDeps } from '../native/ui.js';
import { createRouterServer, type RouterTenant } from '../native/router.js';
import { canonicalConfigPath, TenantRegistry } from '../native/tenants.js';
import { ensureRouterToken } from '../native/router-token.js';
import { resolvePrice } from '../pricing.js';
import { timestampedLogPath } from './init-log.js';
import { routerPorts } from './ports.js';
import { startPriceRefresh } from '../price-refresh.js';
import { updateModelsDev } from './catalog.js';

export interface ServeHandle {
  routerPort: number;
  /**
   * The port a LiteLLM child is listening on, or `undefined` when this config
   * needs none. Reported rather than assumed: the startup line used to name a
   * port unconditionally, so an Anthropic-only config announced "litellm
   * listening on 4178" with no child anywhere — a claim measurably untrue, on
   * the exact line a user reads to find out what came up.
   */
  litellmPort?: number;
  stop(): Promise<void>;
}

export interface SpawnedLitellm {
  pid: number;
  kill(): void;
  /**
   * Escalates past a plain `kill()` (SIGTERM) when the child ignores it —
   * used only after a bounded wait for exit expires. Omitted by stubs that
   * always exit promptly on `kill()`.
   */
  forceKill?(): void;
  /** Fires when the process exits on its own — omitted by stubs that never crash. */
  onExit?(cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
}

export interface ServeDeps {
  spawnLitellm?: (configPath: string, env: NodeJS.ProcessEnv, port: number, bin: string) => SpawnedLitellm;
  /**
   * Test seam: resolves when litellm answers on its port *as this router's own
   * instance*, rejects on timeout. The master key is what tells our child apart
   * from another daemon's holding the same port.
   */
  waitForLitellm?: (port: number, masterKey: string) => Promise<void>;
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
  /**
   * Test seam: binds one of the router's loopback servers. Injected to make a
   * family unavailable, which cannot be arranged on a machine that has both.
   */
  listenOn?: (server: Server, port: number, host: string) => Promise<void>;
  /** Test seam: delay before respawning a litellm child that exited on its own. */
  respawnDelayMs?: number;
  /** Test seam: max respawns tolerated within `respawnWindowMs` before giving up. */
  maxRespawns?: number;
  respawnWindowMs?: number;
  /** Test seam: how long a model-registry restart waits for the old litellm child to exit before escalating to `forceKill`, and again after that before giving up and proceeding anyway. */
  litellmExitTimeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Test seam, and the router's observation channel: receives one *unpriced*
   * row per request exactly as the router emits it (`price.source === 'none'`).
   * Pricing is applied only by `cmdServe`'s default closure below, never by the
   * router. Tests inject this to capture rows without touching disk.
   */
  recordUsage?: (row: LedgerRow) => void;
  /**
   * Fetches models.dev and writes the price cache, when the cache is stale.
   * Production default is the real fetch; tests inject a no-op so no
   * `cmdServe` reaches the network.
   */
  refreshPrices?: (home: string) => Promise<void>;
  /**
   * Test seam for the id `cmdServe` reports on `/__sonata_health`. Production
   * default reads `SONATA_SERVE_INSTANCE_ID` (set by `startServeDaemon` on the
   * child it spawns) and falls back to a freshly generated id when neither is
   * present — a foreground `sonata serve` with no daemon wrapper still needs
   * one.
   */
  instanceId?: string;
  /**
   * Test seam: the ports the machine config would otherwise decide.
   *
   * `routerPorts` reads the machine config and nothing else, so a test of the
   * no-machine-config case has no way to ask for an ephemeral port and would
   * bind the real default 4100.
   */
  ports?: { router: number; litellm: number };
  /**
   * Test seam — production default is `processCommand` (the pid's `ps` command
   * line). Handed to `killRecordedOrphan`, which refuses to signal a recorded
   * litellm pid the OS has since reused for something else.
   */
  processCommand?: (pid: number) => string | undefined;
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
export function serveStatePath(home: string, routerPort: number): string {
  return join(home, '.config', 'sonata', `serve-state-${routerPort}.json`);
}

/**
 * Where versions before per-port state recorded their pids.
 *
 * Read, never written. A daemon started by an older sonata recorded itself
 * here, and dropping the path would make that process unstoppable by
 * `sonata restart` — the exact "no recorded pid" dead end this file exists to
 * avoid, handed to every user mid-upgrade.
 */
function legacyServeStatePath(home: string): string {
  return join(home, '.config', 'sonata', 'serve-state.json');
}

interface ServeState {
  routerPid?: number;
  litellmPid?: number;
  recordedAt: string;
}

/**
 * A state file's contents, or `undefined` when it is absent or not a record.
 *
 * `JSON.parse` answers `null` for a file containing `null` without throwing,
 * and a bare number or array parses just as happily. Casting any of those to
 * `ServeState` and dereferencing `.litellmPid` throws a TypeError out of
 * `killRecordedOrphan`, which runs on the startup path — so one malformed file
 * stopped `sonata serve` from starting at all, rather than being ignored the
 * way the `catch` below plainly intends.
 */
function readStateFile(path: string): ServeState | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as ServeState;
  } catch {
    // A corrupt file is not a record.
    return undefined;
  }
}

/**
 * This router port's own record — never the legacy unkeyed one.
 *
 * The legacy file records no port, so it cannot say which router it describes.
 * Reading it here made every caller port-scoped in name only: a daemon coming
 * up on 4110 with no `serve-state-4110.json` yet would read a pre-upgrade
 * record left by a daemon on 4100 and treat that daemon's pids as its own —
 * killing its litellm child in `killRecordedOrphan`, or copying its
 * `routerPid` into 4110's fresh file through `recordLitellmPid`'s merge, from
 * where `stopServe` would later kill a router it never started. Per-port state
 * exists precisely to stop parallel daemons clobbering each other; a fallback
 * that silently reintroduces the unkeyed record undoes it.
 *
 * `stopServe` is the one caller that may still use the legacy record, and only
 * against proof of ownership — see `readLegacyServeStateFor`.
 */
function readServeStateFrom(home: string, routerPort: number): { path: string; state: ServeState } | undefined {
  const path = serveStatePath(home, routerPort);
  const state = readStateFile(path);
  return state === undefined ? undefined : { path, state };
}

/**
 * The pre-per-port record, but only when it provably describes `routerPort`:
 * its `routerPid` must be the process currently listening there.
 *
 * That keeps the upgrade path the legacy file exists for — a daemon started by
 * an older sonata is still stoppable, and in the ordinary case it *is* the
 * process holding the port its own config named — while refusing the case the
 * record cannot support, where it belongs to some other port's daemon.
 * The OS scan only ever *validates* a pid sonata recorded; it never supplies
 * one to kill, so the "never kill a pid we did not record" rule is intact.
 */
function readLegacyServeStateFor(
  home: string,
  routerPort: number,
  findPortPid: (port: number) => string | undefined,
): { path: string; state: ServeState } | undefined {
  const path = legacyServeStatePath(home);
  const state = readStateFile(path);
  if (state?.routerPid === undefined) return undefined;
  // `findPortPid` answers with the pid as text; an unparseable or absent one
  // is `NaN`, which matches nothing, so the record goes unused.
  const listening = Number.parseInt(findPortPid(routerPort) ?? '', 10);
  return listening === state.routerPid ? { path, state } : undefined;
}

function readServeState(home: string, routerPort: number): ServeState | undefined {
  return readServeStateFrom(home, routerPort)?.state;
}

function writeServeState(home: string, routerPort: number, state: Omit<ServeState, 'recordedAt'>): void {
  const path = serveStatePath(home, routerPort);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...state, recordedAt: new Date().toISOString() }));
}

function killPid(pid: number | undefined): void {
  if (typeof pid !== 'number' || pid <= 0) return;
  try { process.kill(pid); } catch { /* already dead */ }
}

function forcePid(pid: number | undefined): void {
  if (typeof pid !== 'number' || pid <= 0) return;
  try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
}

/**
 * What `ps` says a pid is running, or `undefined` when it cannot tell.
 *
 * This is the "positive evidence" a recorded litellm pid is checked against
 * before it is signalled: the OS reuses pid numbers, so a record that outlived
 * its child can name a process that has nothing to do with sonata. An answer
 * of `undefined` — no ps, no permission, pid already gone — is "cannot tell",
 * never "reused", so callers proceed as before on it (the same rule as
 * `findPortPid` in `stopServe`): treating unknown as mismatch would strand a
 * real orphan litellm on every machine where ps is unavailable.
 */
export function processCommand(pid: number): string | undefined {
  try {
    const out = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 2000,
    }).trim();
    return out === '' ? undefined : out;
  } catch {
    return undefined;
  }
}

export async function killRecordedOrphan(
  home: string,
  routerPort: number,
  deps: {
    processCommand?: (pid: number) => string | undefined;
    kill?: (pid: number) => void;
    forceKill?: (pid: number) => void;
    isAlive?: (pid: number) => boolean;
    sleep?: (ms: number) => Promise<void>;
    timeoutMs?: number;
  } = {},
): Promise<{ survivor?: { pid: number; command: string } }> {
  const found = readServeStateFrom(home, routerPort);
  const litellmPid = found?.state.litellmPid;
  let stillRunning = false;
  let command: string | undefined;
  if (litellmPid !== undefined) {
    // Signalled only on POSITIVE identification. The OS reuses pid numbers,
    // so a record that outlived its child may now name anything:
    //  - ps names it litellm: SIGTERM, a bounded wait, SIGKILL. A VERIFIED
    //    litellm that survives even that is reported, and blocks the spawn.
    //  - ps names something else: the pid was reused; leave it alone.
    //  - ps cannot answer (no procps, hidepid, a timeout): nothing is known,
    //    so nothing is signalled and nothing is blocked — an unverifiable
    //    pid wedging every start, Anthropic and direct routing included, is
    //    worse than the orphan it might be.
    // In the last two cases the record is forgotten.
    command = (deps.processCommand ?? processCommand)(litellmPid);
    if (command === undefined) {
      // ps has nothing to say about a pid that no longer exists, which is the
      // common case — that is not "unverified", just finished.
      console.error((deps.isAlive ?? defaultIsAlive)(litellmPid)
        ? `sonata serve: recorded litellm pid ${litellmPid} could not be verified (ps gave no command ` +
          'line) — left alone and forgotten'
        : `sonata serve: recorded litellm pid ${litellmPid} is already gone — forgotten`);
    } else if (!/litellm/i.test(command)) {
      console.error(
        `sonata serve: recorded litellm pid ${litellmPid} is no longer LiteLLM ` +
        `(${command}) — leaving it alone`,
      );
    } else {
      stillRunning = !(await terminatePid(litellmPid, deps));
    }
  }
  // Only this port's own record is ever read here, so the file cleared is
  // always this router's. The unkeyed legacy record is deliberately out of
  // reach: it names no port, so it could just as easily describe another
  // project's daemon, whose litellm is not ours to kill.
  if (found !== undefined) {
    // Keep the router's ownership record: lazy startup can run after the
    // router has recorded its pid, and a losing serve can run before it binds
    // while another router is still using this file. The litellm pid is kept
    // too while it is still running — forgetting a live process is how it
    // becomes an orphan nothing will ever stop.
    writeServeState(home, routerPort, {
      routerPid: found.state.routerPid,
      ...(stillRunning ? { litellmPid } : {}),
    });
  }
  return stillRunning && litellmPid !== undefined && command !== undefined
    ? { survivor: { pid: litellmPid, command } }
    : {};
}

/**
 * Why a recorded LiteLLM that outlived every signal blocks a new spawn: it
 * very likely still holds the port, and recording the new child's pid would
 * forget the old one for good. Only a pid ps has VERIFIED as litellm gets
 * here. Names the pid and its command line, and both remedies: `kill -9`, or
 * deleting the serve-state record if the pid is not what it seems.
 */
export function orphanSurvivorMessage(
  survivor: { pid: number; command: string },
  statePath: string,
  phase: 'eager' | 'lazy',
): string {
  const head = `sonata serve: a LiteLLM from an earlier daemon (pid ${survivor.pid}, running \`${survivor.command}\`) ` +
    'is still alive after SIGTERM and SIGKILL and probably holds the LiteLLM port — not starting another. ';
  // Lazily, this router is live: the state file also holds ITS routerPid, so
  // deleting it would orphan the router itself from `sonata restart`.
  return phase === 'lazy'
    ? `${head}Stop it with \`kill -9 ${survivor.pid}\`, then run \`sonata restart\`.`
    : `${head}Stop it with \`kill -9 ${survivor.pid}\`, then start sonata serve again — or, if that pid ` +
      `is not what it seems, delete ${statePath} to forget it first.`;
}

/**
 * The pid form of `terminateLitellm`: SIGTERM, a bounded wait for the exit,
 * then SIGKILL (once), then a second bounded wait. True once the process is
 * gone; false if it outlived both signals.
 */
async function terminatePid(
  pid: number,
  deps: {
    kill?: (pid: number) => void;
    forceKill?: (pid: number) => void;
    isAlive?: (pid: number) => boolean;
    sleep?: (ms: number) => Promise<void>;
    timeoutMs?: number;
  },
): Promise<boolean> {
  const isAlive = deps.isAlive ?? defaultIsAlive;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = deps.timeoutMs ?? LITELLM_EXIT_TIMEOUT_MS;
  const gone = async (): Promise<boolean> => {
    for (let waited = 0; waited < timeoutMs; waited += 50) {
      if (!isAlive(pid)) return true;
      await sleep(50);
    }
    return !isAlive(pid);
  };
  (deps.kill ?? killPid)(pid);
  if (await gone()) return true;
  console.error(`sonata serve: recorded litellm pid ${pid} did not exit after SIGTERM — sending SIGKILL`);
  (deps.forceKill ?? forcePid)(pid);
  return gone();
}

function recordLitellmPid(home: string, routerPort: number, pid: number): void {
  writeServeState(home, routerPort, { ...readServeState(home, routerPort), litellmPid: pid });
}

function recordRouterPid(home: string, routerPort: number, pid: number): void {
  writeServeState(home, routerPort, { ...readServeState(home, routerPort), routerPid: pid });
}

/**
 * Removes this process's failed-start record before releasing its port.
 *
 * The pid check prevents a late startup failure from deleting a replacement
 * router's record if another process has already taken the port and rewritten
 * the keyed state. The child is killed separately by the caller, so removing
 * the whole record cannot strand its LiteLLM pid; the legacy file is never read.
 */
function clearFailedRouterRecord(home: string, routerPort: number, orphanPid?: number): void {
  const state = readServeState(home, routerPort);
  if (state?.routerPid !== process.pid) return;
  // An orphan LiteLLM that outlived its signals and blocked this start is not
  // our child, and must stay recorded — dropped here, nothing would ever
  // find it again.
  if (orphanPid !== undefined && state.litellmPid === orphanPid) {
    writeServeState(home, routerPort, { litellmPid: orphanPid });
    return;
  }
  try { unlinkSync(serveStatePath(home, routerPort)); } catch { /* already gone */ }
}

/**
 * Polls litellm until it answers *as ours*, so a silent bind failure surfaces
 * here.
 *
 * Liveness alone is not enough, because `/health/liveliness` needs no
 * credential and any litellm answers it. Two daemons whose configs name
 * different `ports.router` but the same `ports.litellm` — one router port
 * changed to dodge a clash, the other left at its default — are not covered by
 * `killRecordedOrphan`, which is correctly scoped to this router's own port.
 * The second child then fails to bind and exits, this poll sees the *first*
 * child's liveness, and serve starts "successfully" while forwarding a master
 * key that instance has never heard of. Every routed request then fails
 * authentication, naming neither the port clash nor the key.
 *
 * So the probe authenticates. Measured against litellm 1.98.0 on a live
 * instance: the configured master key gets 200 from `/v1/models`, a foreign
 * key gets 400 `No connected db.` (a keyless proxy has no store to resolve a
 * virtual key against), and no key at all gets 500. Only 200 proves the
 * instance holding the port is the one this process configured.
 */
export async function defaultWaitForLitellm(
  port: number,
  masterKey?: string,
  deps: {
    doFetch?: typeof fetch;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    timeoutMs?: number;
  } = {},
): Promise<void> {
  const doFetch = deps.doFetch ?? fetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + (deps.timeoutMs ?? 30_000);
  let foreign = false;
  for (;;) {
    try {
      // Each probe is bounded: a listener that accepts and never answers
      // would otherwise hold this loop past its deadline, and every
      // LiteLLM-bound request awaits it. 2 s, as `isSonataRouter` uses.
      const res = await doFetch(`http://${LITELLM_HOST}:${port}/health/liveliness`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        if (masterKey === undefined) return;
        const mine = await doFetch(`http://${LITELLM_HOST}:${port}/v1/models`, {
          headers: { authorization: `Bearer ${masterKey}` },
          signal: AbortSignal.timeout(2000),
        });
        if (mine.ok) return;
        // Something is alive here and it is not ours. Keep polling anyway: our
        // own child may still be binding, and if it wins the port the next
        // pass sees 200.
        foreign = true;
      }
    } catch { /* not up yet */ }
    if (now() > deadline) {
      throw new Error(
        foreign
          ? `sonata serve: port ${port} is held by a litellm that does not accept this router's ` +
            'master key — it belongs to another sonata daemon, and every request routed through it ' +
            'would fail authentication. Give this project its own `[native.ports] litellm` port, ' +
            'or stop the other daemon with `sonata restart` in the project that owns it.'
          // The old wording named only "failed to bind (another litellm
          // running?)", which is the rarer cause and sends the reader to
          // `lsof`. The common one is an OAuth credential whose refresh token
          // has expired: LiteLLM falls back to an INTERACTIVE device-code
          // login and blocks there, so uvicorn never binds and the prompt is
          // printed into a daemon log nobody is reading. Measured twice on
          // 2026-09-21, and it cost two sessions ~40 minutes each because the
          // message pointed away from the log line that named the cause.
          : `sonata serve: litellm did not come up on port ${port} within 30s. ` +
            'Most often an OAuth credential has expired and litellm is blocked on an ' +
            'interactive sign-in it cannot complete — look for "Sign in with ChatGPT using ' +
            'device code" or "re-login required" earlier in this log, and fix it with ' +
            '`sonata auth login <gateway>` (or `codex login` for a gateway with ' +
            '`credential_source = "codex"`). Otherwise it failed to bind or failed to ' +
            'start; check `litellm --config` by hand.',
      );
    }
    await sleep(500);
  }
}

export function serveHealthUrl(routerPort: number): string {
  return `http://localhost:${routerPort}/__sonata_health`;
}

/**
 * Answers the identity question, not the readiness question.
 *
 * A router reports `503 starting` while its eager LiteLLM child is coming up,
 * but it is still a Sonata process holding the port. Reading the body before
 * checking HTTP status keeps `occupiedPortMessage` from calling that process
 * a foreign listener; malformed, non-Sonata and unreachable responses remain
 * negative.
 */
export async function isSonataRouter(
  port: number,
  doFetch: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await doFetch(serveHealthUrl(port), {
      signal: AbortSignal.timeout(2000),
    });
    const body = await response.json() as { sonata?: unknown };
    return body?.sonata === true;
  } catch {
    return false;
  }
}

/** Whether a Sonata health response is ready to serve traffic. */
export async function sonataRouterReady(
  port: number,
  doFetch: typeof fetch = fetch,
  expectedInstanceId?: string,
): Promise<boolean> {
  try {
    const response = await doFetch(serveHealthUrl(port), {
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return false;
    const body = await response.json() as { sonata?: unknown; ready?: unknown; status?: unknown; instanceId?: unknown };
    return body.sonata === true
      && body.ready !== false
      && body.status !== 'starting'
      && (expectedInstanceId === undefined || body.instanceId === expectedInstanceId);
  } catch {
    return false;
  }
}

/**
 * Whether a health payload says its router serves the UI.
 *
 * `sonata: true` alone is not enough: a router started from an older build
 * passes that and has no UI, so advertising the URL would send the user to a
 * 404. A payload without the field is treated as not having it.
 */
export function healthReportsUi(body: unknown): boolean {
  return body !== null && typeof body === 'object'
    && (body as { sonata?: unknown }).sonata === true
    && (body as { ui?: unknown }).ui === true;
}

/** `healthReportsUi` against a live port — the form `sonata status` needs. */
export async function sonataRouterHasUi(
  port: number,
  doFetch: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await doFetch(serveHealthUrl(port), { signal: AbortSignal.timeout(2000) });
    // UI capability is only advertised from a successful response. This keeps
    // the PR #38 compatibility guard: an older router must never be given a
    // URL it cannot serve, even though identity accepts its health body.
    if (!response.ok) return false;
    return healthReportsUi(await response.json());
  } catch {
    return false;
  }
}

/** Whether the sonata router on `port` is a multi-tenant one: true, false for an older single-config router, null when the port is not a sonata router. */
export async function sonataRouterMultiTenant(
  port: number,
  doFetch: typeof fetch = fetch,
): Promise<boolean | null> {
  try {
    const response = await doFetch(serveHealthUrl(port), { signal: AbortSignal.timeout(2000) });
    const body = await response.json() as { sonata?: unknown; multiTenant?: unknown };
    if (body?.sonata !== true) return null;
    return body.multiTenant === true;
  } catch {
    return null;
  }
}

/** The one refusal every caller gives a router that predates this design. */
export function preMultiTenantMessage(port: number): string {
  return `sonata: router on port ${port} predates multi-tenant routing — run \`sonata restart\``;
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
function defaultSpawnLitellm(
  configPath: string, env: NodeJS.ProcessEnv, port: number, bin: string,
): SpawnedLitellm {
  // The managed venv's binary, never the bare name. `which litellm` resolving
  // says a script exists, not that an importable LiteLLM does — measured on the
  // development machine, the PATH hit's shebang names an interpreter under
  // which `import litellm` fails outright.
  const child = spawn(bin, ['--config', configPath, '--host', LITELLM_HOST, '--port', String(port)], {
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  return {
    pid: child.pid ?? 0,
    kill: () => child.kill(),
    forceKill: () => child.kill('SIGKILL'),
    onExit: (cb) => child.on('exit', cb),
  };
}

/** A gateway whose credential could not be resolved, and why. */
interface CredentialFailure {
  gateway: string;
  message: string;
}

interface ChildEnvResolution {
  env: NodeJS.ProcessEnv;
  /** Positively missing, or never resolved in this process: left out, and answered with the message. */
  failures: CredentialFailure[];
  /** A store that could not be read just now: the gateway kept its last credential. Logged, never answered. */
  transient: CredentialFailure[];
}

/**
 * What one serve process remembers between child-env builds.
 *
 * `lastGood` holds the env entries each gateway last resolved to, keyed by
 * its lineage — name, auth and credential source — so an entry is reused
 * only for the very lookup that produced it: a name another project has
 * since taken with a different source is a different lineage, and starts
 * with nothing. Entries for gateways no longer in the merge are forgotten,
 * so "has resolved in this process" means since it last reappeared.
 */
interface CredentialMemory {
  lastGood: Map<string, Record<string, string>>;
  /** opencode.db's credential row count at the last read; see `opencodeDbRead`. */
  opencodeDb: { rows?: number };
}

function newCredentialMemory(): CredentialMemory {
  return { lastGood: new Map(), opencodeDb: {} };
}

function lineageKey(name: string, gateway: { auth?: string; credentialSource?: string }): string {
  return `${name}|${gateway.auth ?? 'api-key'}|${gateway.credentialSource ?? 'default'}`;
}

/** When a ChatGPT record expires, in epoch seconds: its own field, else its access token's `exp`. */
function chatgptExpiry(record: Partial<ChatGptAuthRecord>): number | undefined {
  if (typeof record.expires_at === 'number' && Number.isFinite(record.expires_at)) return record.expires_at;
  return typeof record.access_token === 'string' ? jwtExpiry(record.access_token) : undefined;
}

/**
 * The latest modification time of the store `readChatGptOAuth` read for this
 * source, or undefined when none can be stat'ed. opencode's credential may sit
 * in either of its two stores, so both count.
 */
function chatgptStoreMtimeMs(home: string, source: 'codex' | 'opencode' | undefined): number | undefined {
  const fromCodex = source === 'codex' || (source === undefined && readCodexOAuth(home) !== null);
  const paths = fromCodex ? [codexAuthPath(home)] : [opencodeAuthPath(home), opencodeDbPath(home)];
  let latest: number | undefined;
  for (const path of paths) {
    try {
      const { mtimeMs } = statSync(path);
      if (latest === undefined || mtimeMs > latest) latest = mtimeMs;
    } catch { /* absent: this store says nothing */ }
  }
  return latest;
}

/**
 * Beside LiteLLM's ChatGPT token file: which credential store, and which
 * account, the file was last written from. LiteLLM rewrites `auth.json` in
 * place and never touches this, so it still names the file's lineage after
 * any number of LiteLLM refreshes.
 */
const CHATGPT_LINEAGE_FILE = 'sonata-source.json';

interface ChatGptLineage {
  /** `resolvedOauthIdentity`'s spelling of the store the record was read from. */
  identity: string;
  accountId?: string;
}

/** Written through a sibling temp file and a rename, so LiteLLM never reads half a token. */
function writeAtomic(path: string, content: string): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, content, { mode: 0o600 });
  renameSync(temp, path);
}

/**
 * Writes the store's ChatGPT record into LiteLLM's token dir unless LiteLLM
 * already holds a newer token of the SAME login.
 *
 * The file is LiteLLM's own once it runs: it re-reads it on every access
 * token it needs and refreshes it in place, and ChatGPT rotates refresh
 * tokens — writing the store's older record over a refreshed one hands
 * LiteLLM a refresh token already refused as `refresh_token_reused`. Never
 * writing it on a re-merge had the opposite failure: a `codex login` while
 * serving, the remedy serve's own error names, never reached a running
 * LiteLLM.
 *
 * "Newer" is only meaningful within one lineage — one store, one account.
 * An expiry compared across two of them kept account A's longer-lived token
 * in LiteLLM indefinitely after `credential_source` moved to another store,
 * or after `codex logout` let the default fall through to opencode's login.
 * So the record is written outright when the held file is missing or does
 * not parse, when the lineage file beside it is missing or names another
 * store, or when the held account (LiteLLM keeps `account_id` through a
 * refresh; the lineage file remembers it otherwise) differs from the
 * store's. Only within one lineage does the later expiry win — both LiteLLM
 * (`_build_auth_record`) and sonata write `expires_at`, and the access
 * token's JWT `exp` stands in where it is absent. Where neither side has
 * one, a store whose contents differ and that was modified after LiteLLM's
 * copy wins.
 */
function syncChatGptTokenFile(
  tokenDir: string,
  record: ChatGptAuthRecord,
  identity: string,
  storeMtimeMs: number | undefined,
): void {
  const path = join(tokenDir, 'auth.json');
  const lineagePath = join(tokenDir, CHATGPT_LINEAGE_FILE);
  const next = JSON.stringify(record);
  const write = ((): boolean => {
    let current: string;
    try {
      current = readFileSync(path, 'utf8');
    } catch {
      return true;
    }
    let held: Partial<ChatGptAuthRecord>;
    try {
      const parsed: unknown = JSON.parse(current);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return true;
      held = parsed as Partial<ChatGptAuthRecord>;
    } catch {
      return true; // torn: nothing in it can be trusted, and LiteLLM cannot use it either
    }
    let lineage: Partial<ChatGptLineage>;
    try {
      const parsed: unknown = JSON.parse(readFileSync(lineagePath, 'utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return true;
      lineage = parsed as Partial<ChatGptLineage>;
    } catch {
      return true;
    }
    if (lineage.identity !== identity) return true;
    const heldAccount = typeof held.account_id === 'string' ? held.account_id : lineage.accountId;
    if (heldAccount !== record.account_id) return true;
    if (current === next) return false;
    const storeExpiry = chatgptExpiry(record);
    const heldExpiry = chatgptExpiry(held);
    if (storeExpiry !== undefined && heldExpiry !== undefined) return storeExpiry > heldExpiry;
    let heldMtimeMs: number | undefined;
    try { heldMtimeMs = statSync(path).mtimeMs; } catch { return true; }
    return storeMtimeMs !== undefined && storeMtimeMs > heldMtimeMs;
  })();
  if (!write) return;
  mkdirSync(tokenDir, { recursive: true, mode: 0o700 });
  writeAtomic(path, next);
  const lineage: ChatGptLineage = { identity, ...(record.account_id === undefined ? {} : { accountId: record.account_id }) };
  writeAtomic(lineagePath, JSON.stringify(lineage));
}

/**
 * The ChatGPT record a codex-oauth gateway reads, and the store it came from
 * in `resolvedOauthIdentity`'s spelling — the same order `readChatGptOAuth`
 * reads them in, so the lineage names the store that actually answered.
 */
function readChatGptWithIdentity(
  home: string,
  source: 'codex' | 'opencode' | undefined,
): { record: ChatGptAuthRecord; identity: string } | null {
  if (source !== 'opencode') {
    const record = readCodexOAuth(home);
    if (record !== null) return { record, identity: 'codex store' };
    if (source === 'codex') return null;
  }
  const record = readOpencodeChatGptOAuth(home);
  return record === null ? null : { record, identity: 'opencode store' };
}

/**
 * The LiteLLM child's environment, and the OAuth token files it points at,
 * copied out of the store each gateway reads.
 *
 * The ChatGPT file is written on every path under `syncChatGptTokenFile`'s
 * lineage-and-newer-wins rule. Copilot's `access-token` carries no expiry to
 * compare — it is a bare `gho_` string, and the short-lived `api-key.json`
 * LiteLLM exchanges it for is its own — so it is still written only when
 * `spawning`, i.e. when a child is about to start on this env. The env it
 * returns names the same directories either way.
 *
 * Each gateway is resolved on its own, and one whose credential is missing is
 * reported in `failures` and left out of the env rather than aborting the
 * rest. The union spans every project, so a single project's missing login
 * used to stop every other project's gateways from resolving at all. Left
 * out means absent, never carried over from another lineage: a direct key is
 * looked up by gateway NAME, and a stale one under a name another project has
 * since taken would be sent to that project's base_url.
 *
 * Missing is decided per store, with `memory`: a gateway that has resolved
 * before, under the same lineage, keeps that resolution through a read that
 * failed for any reason but a store positively holding nothing — a torn
 * write, EACCES, EMFILE, a locked or momentarily empty opencode.db. Such a
 * read is reported in `transient`, not `failures`, so nothing is dropped and
 * nothing restarts. A resolution that succeeded while a store in its lookup
 * chain could not be read is suspect the same way (a torn codex file lets the
 * default fall through to opencode's account) and keeps the last one too.
 * Without a memory — every caller but `cmdServe` — nothing is remembered and
 * every miss is a failure, as before.
 */
function resolveChildEnv(
  native: NativeConfig,
  home: string,
  tempDir: string,
  opts: { spawning?: boolean; memory?: CredentialMemory } = {},
): ChildEnvResolution {
  const spawning = opts.spawning ?? true;
  const memory = opts.memory ?? newCredentialMemory();
  const failures: CredentialFailure[] = [];
  const transient: CredentialFailure[] = [];
  // LiteLLM still needs PATH for executable lookup; no other parent values are forwarded.
  const childEnv: NodeJS.ProcessEnv = process.env.PATH ? { PATH: process.env.PATH } : {};

  // Each store read at most once per build.
  const reads = new Map<string, StoreRead>();
  const read = (id: string, how: () => StoreRead): StoreRead => {
    const cached = reads.get(id);
    if (cached !== undefined) return cached;
    const fresh = how();
    reads.set(id, fresh);
    return fresh;
  };
  const keysStore = () => read('keys', () => jsonStoreRead(sonataKeyStorePath(home)));
  const codexStore = () => read('codex', () => jsonStoreRead(codexAuthPath(home)));
  const opencodeStores = () => [
    read('opencode.db', () => opencodeDbRead(home, memory.opencodeDb)),
    read('opencode', () => jsonStoreRead(opencodeAuthPath(home))),
  ];

  const live = new Set<string>();
  /**
   * The entries one lineage resolves to this build: `resolved` when the
   * lookup found one it can trust, else the last good ones when a store in
   * `chain` could not be read, else nothing — reported as a failure with
   * `missing` (a gateway that needs no credential passes none).
   */
  const settle = (
    name: string,
    lineage: string,
    resolved: Record<string, string> | undefined,
    chain: StoreRead[],
    missing: string | undefined,
  ): Record<string, string> | undefined => {
    live.add(lineage);
    const unreadable = chain.find((store) => store.state === 'unreadable');
    const last = memory.lastGood.get(lineage);
    if (unreadable !== undefined && last !== undefined) {
      transient.push({
        gateway: name,
        message: `gateway "${name}": its credential store could not be read (${unreadable.detail}) — ` +
          'keeping the credential it last resolved to',
      });
      return last;
    }
    if (resolved !== undefined) {
      memory.lastGood.set(lineage, resolved);
      return resolved;
    }
    memory.lastGood.delete(lineage);
    if (missing !== undefined) {
      failures.push({
        gateway: name,
        message: unreadable === undefined ? missing : `${missing} (${unreadable.detail})`,
      });
    }
    return undefined;
  };

  // The stores a key lookup's answer depends on: the one that answered and
  // every store searched before it, or all of them when none answered.
  const keyChain = (answeredBy: string | undefined, order: ('sonata' | 'opencode')[]): StoreRead[] => {
    const chain: StoreRead[] = [];
    for (const store of order) {
      if (store === 'sonata') {
        chain.push(keysStore());
        if (answeredBy === 'sonata') return chain;
      } else {
        const [db, file] = opencodeStores();
        chain.push(db);
        if (answeredBy === 'opencode.db') return chain;
        chain.push(file);
        if (answeredBy === 'opencode') return chain;
      }
    }
    return chain;
  };

  const automaticallyResolved = Object.entries(native.gateways)
    .filter(([, gateway]) => gateway.auth !== 'api-key' || gateway.credentialSource === undefined);
  const found = new Map(resolveKeys(automaticallyResolved.map(([name]) => name), home).map((hit) => [hit.gateway, hit]));
  for (const [name, gateway] of automaticallyResolved) {
    const hit = found.get(name);
    // No failure when nothing is found: a default-sourced gateway may need
    // no key at all, which is how it has always been served.
    const entries = settle(
      name, `${lineageKey(name, gateway)}|key`,
      hit === undefined ? undefined : { [envVarForGateway(name)]: hit.key },
      keyChain(hit?.source, ['sonata', 'opencode']),
      undefined,
    );
    if (entries !== undefined) Object.assign(childEnv, entries);
  }
  for (const [name, gateway] of Object.entries(native.gateways)) {
    const source = gateway.credentialSource;
    if (gateway.auth !== 'api-key' || (source !== 'sonata' && source !== 'opencode')) continue;
    const hit = resolveKeyDetail(name, home, source);
    const entries = settle(
      name, lineageKey(name, gateway),
      hit === undefined ? undefined : { [envVarForGateway(name)]: hit.key },
      keyChain(hit?.source, [source]),
      `gateway "${name}" takes its credential from ${source} but none was found — ` +
        `run \`sonata auth add ${name}\` (for sonata) or check opencode's own credential store.`,
    );
    if (entries !== undefined) Object.assign(childEnv, entries);
  }

  // A sonata-owned credential is already in LiteLLM's native format. Point
  // directly at its persistent directory so LiteLLM's refresh survives serve.
  const chatgptGateway = Object.entries(native.gateways)
    .find(([, gateway]) => gateway.auth === 'codex-oauth');
  if (chatgptGateway) {
    const [name, gateway] = chatgptGateway;
    const lineage = lineageKey(name, gateway);
    if (gateway.credentialSource === 'sonata') {
      const dir = credentialDir(home, name);
      const store = fileStoreRead(join(dir, 'auth.json'));
      const entries = settle(
        name, lineage, store.state === 'ok' ? { CHATGPT_TOKEN_DIR: dir } : undefined, [store],
        `gateway "${name}" takes its credential from sonata but none is stored — ` +
          `run \`sonata auth login ${name}\`.`,
      );
      if (entries !== undefined) Object.assign(childEnv, entries);
    } else {
      const source = gateway.credentialSource;
      const found = readChatGptWithIdentity(home, source);
      const chain = source === 'codex' ? [codexStore()]
        : source === 'opencode' ? opencodeStores()
          : found?.identity === 'codex store' ? [codexStore()] : [codexStore(), ...opencodeStores()];
      const tokenDir = join(tempDir, 'chatgpt');
      const fresh = found === null ? undefined : { CHATGPT_TOKEN_DIR: tokenDir };
      const entries = settle(
        name, lineage, fresh, chain,
        `gateway "${name}" uses codex-oauth but no ChatGPT credential was found ` +
          `in ${codexAuthPath(home)} or ${opencodeAuthPath(home)} — ` +
          `run \`sonata auth login ${name}\`, or \`codex login\`.`,
      );
      // Synced only when the fresh read is what is being used: a kept last
      // resolution leaves LiteLLM's own file exactly as it is.
      if (entries !== undefined && entries === fresh && found !== null) {
        syncChatGptTokenFile(tokenDir, found.record, found.identity, chatgptStoreMtimeMs(home, source));
      }
      if (entries !== undefined) Object.assign(childEnv, entries);
    }
  }

  // Copilot's api-key.json is refreshed and re-exchanged in place too, so a
  // sonata-owned credential must likewise avoid the temporary directory.
  const copilotGateway = Object.entries(native.gateways)
    .find(([, gateway]) => gateway.auth === 'copilot-oauth');
  if (copilotGateway) {
    const [name, gateway] = copilotGateway;
    const lineage = lineageKey(name, gateway);
    if (gateway.credentialSource === 'sonata') {
      const dir = credentialDir(home, name);
      const store = fileStoreRead(join(dir, 'api-key.json'));
      const entries = settle(
        name, lineage, store.state === 'ok' ? { GITHUB_COPILOT_TOKEN_DIR: dir } : undefined, [store],
        `gateway "${name}" takes its credential from sonata but none is stored — ` +
          `run \`sonata auth login ${name}\`.`,
      );
      if (entries !== undefined) Object.assign(childEnv, entries);
    } else {
      const token = readCopilotToken(home);
      const tokenDir = join(tempDir, 'copilot');
      const fresh = token === null ? undefined : { GITHUB_COPILOT_TOKEN_DIR: tokenDir };
      const entries = settle(
        name, lineage, fresh, opencodeStores(),
        `gateway "${name}" uses copilot-oauth but no Copilot login was found ` +
          `in ${opencodeAuthPath(home)} — run \`sonata auth login ${name}\`, ` +
          'or `opencode auth login` and choose github-copilot.',
      );
      if (entries !== undefined && entries === fresh && token !== null && spawning) {
        mkdirSync(tokenDir, { recursive: true, mode: 0o700 });
        writeFileSync(join(tokenDir, 'access-token'), token, { mode: 0o600 });
      }
      if (entries !== undefined) Object.assign(childEnv, entries);
    }
  }

  for (const lineage of [...memory.lastGood.keys()]) {
    if (!live.has(lineage)) memory.lastGood.delete(lineage);
  }
  return { env: childEnv, failures, transient };
}

/** Default bound on how long a model-registry restart waits for the old litellm child to exit (see `litellmExitTimeoutMs`). */
const LITELLM_EXIT_TIMEOUT_MS = 5000;

/** How often a running daemon re-applies ledger and session retention. */
const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Prunes ledger day-files and session records past the retention window.
 * Housekeeping: every failure is swallowed, since it must never block serving.
 * The session prune is awaited so it does not race its own lock against a
 * concurrent hook.
 */
async function pruneRetention(home: string): Promise<void> {
  try {
    const removed = pruneLedger(home, LEDGER_RETENTION_DAYS);
    if (removed > 0) console.log(`ledger: pruned ${removed} day file(s) older than ${LEDGER_RETENTION_DAYS}d`);
  } catch { /* housekeeping */ }
  try {
    const removedSessions = await pruneSessions(home, LEDGER_RETENTION_DAYS);
    if (removedSessions > 0) console.log(`sessions: pruned ${removedSessions} record(s) older than ${LEDGER_RETENTION_DAYS}d`);
  } catch { /* housekeeping */ }
}

/**
 * SIGTERM, a bounded wait for the exit, then SIGKILL (once). Shared by the
 * startup-failure path and `stop()`, so the two cannot drift apart again.
 */
async function terminateLitellm(
  dying: SpawnedLitellm,
  timeoutMs: number,
  sleepFn: (ms: number) => Promise<void>,
): Promise<void> {
  const exited = new Promise<void>((resolve) => {
    if (dying.onExit) dying.onExit(() => resolve());
    else resolve();
  });
  dying.kill();
  if (await raceTimeout(exited, timeoutMs, sleepFn)) {
    console.error('sonata serve: litellm did not exit after SIGTERM — sending SIGKILL');
    (dying.forceKill ?? dying.kill).call(dying);
  }
}

/** Resolves `true` if `promise` had not settled after `timeoutMs`, `false` if it settled first. Never rejects. */
async function raceTimeout(promise: Promise<void>, timeoutMs: number, sleepFn: (ms: number) => Promise<void>): Promise<boolean> {
  let timedOut = false;
  await Promise.race([
    promise,
    sleepFn(timeoutMs).then(() => { timedOut = true; }),
  ]);
  return timedOut;
}

/** Binds `server` to one address, resolving once it listens and rejecting with the bind error. */
export function listenOn(server: Server, port: number, host: string): Promise<void> {
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
    server.listen(port, host);
  });
}

/**
 * The one address the managed LiteLLM child binds, and the one the router
 * reaches it at.
 *
 * LiteLLM's own default is `0.0.0.0` — every IPv4 interface, overridable by
 * a stray `HOST` in the environment — while the router reached it as
 * `localhost`, which tries `::1` first. So the child was exposed beyond
 * loopback, and a foreign listener holding `::1` on that port would have
 * answered in its place. Binding and connecting to one literal address
 * removes both.
 */
export const LITELLM_HOST = '127.0.0.1';

/**
 * The addresses the router binds: both loopback families, never a wildcard.
 *
 * Every client reaches the router as `localhost` — Claude Code's
 * `ANTHROPIC_BASE_URL`, the SessionStart hook, doctor — and `localhost`
 * resolves to both `::1` and `127.0.0.1`. Node connects with happy-eyeballs:
 * an attempt not *seen* to complete within 250ms is abandoned for the next
 * family. Bound to `localhost` the router held `::1` alone, so a client that
 * stalled at the wrong moment dropped a connection that had in fact
 * succeeded, fell through to `127.0.0.1` where nothing listened, and failed
 * `fetch failed` / ETIMEDOUT. Holding both families leaves no address to
 * fall through to.
 */
export const ROUTER_LOOPBACK_HOSTS = ['127.0.0.1', '::1'] as const;

/**
 * A machine without one family — IPv6 disabled, or no IPv4 loopback — answers
 * the bind with one of these. The router serves on the family it has; any
 * other error, `EADDRINUSE` included, still fails the start.
 */
const FAMILY_UNAVAILABLE = new Set(['EADDRNOTAVAIL', 'EAFNOSUPPORT']);

/** Attempts at an ephemeral port before giving up on finding one free on both families. */
const EPHEMERAL_ATTEMPTS = 5;

/**
 * Binds `first`, plus one more server sharing its request handler, to every
 * loopback family the machine has, on one port. Resolves with the servers
 * that listen and the port they share.
 *
 * A configured port is held on both families or not at all: a router coming
 * up on `127.0.0.1` beside an older one that holds `::1` would split
 * `localhost` between two daemons, so `EADDRINUSE` on either is the same
 * refusal it always was. Port 0 lets the kernel choose for the first family
 * only; that number being taken on the second is a collision to route around,
 * so it is retried with a fresh choice.
 */
async function listenLoopback(
  first: Server,
  port: number,
  bind: (server: Server, port: number, host: string) => Promise<void>,
): Promise<{ servers: Server[]; port: number }> {
  const handler = first.listeners('request')[0] as RequestListener;
  for (let attempt = 1; ; attempt += 1) {
    const servers: Server[] = [];
    let bound = port;
    let unavailable: Error | undefined;
    try {
      for (const host of ROUTER_LOOPBACK_HOSTS) {
        const server = servers.length > 0 ? createHttpServer(handler) : first;
        try {
          await bind(server, bound, host);
        } catch (error) {
          if (FAMILY_UNAVAILABLE.has((error as NodeJS.ErrnoException).code ?? '')) {
            unavailable = error as Error;
            continue;
          }
          throw error;
        }
        servers.push(server);
        const address = server.address();
        if (typeof address === 'object' && address !== null) bound = address.port;
      }
    } catch (error) {
      await Promise.all(servers.map((server) => close(server).catch(() => {})));
      const inUse = (error as NodeJS.ErrnoException).code === 'EADDRINUSE';
      if (port === 0 && inUse && servers.length > 0 && attempt < EPHEMERAL_ATTEMPTS) continue;
      throw error;
    }
    if (servers.length === 0) throw unavailable ?? new Error('sonata serve: no loopback address to bind');
    return { servers, port: bound };
  }
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
function close(server: Server): Promise<void> {
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

/**
 * Attaches a price to a row the router produced unpriced.
 *
 * Pricing lives here rather than in the router because it needs the config and
 * the price cache, and because a token count must never be lost to a pricing
 * failure — the row is written either way, with `source: 'none'` when no rate
 * applies.
 *
 * Priced at the row's own timestamp, not at now: a row is priced by when the
 * request ran, which is what makes a time-windowed rate mean anything.
 */
export function priceRow(config: SonataConfig, home: string, row: LedgerRow): LedgerRow {
  try {
    const price = resolvePrice(config, row.key, row.tokens, new Date(row.ts), loadModelsDev(home));
    return { ...row, price };
  } catch {
    return row; // an unpriceable row is still a row
  }
}

/**
 * Which caps apply to one request: the tenant's own, and the machine's.
 *
 * Extracted because the whole subtlety is the comparison against
 * `machineConfigPath` — both sides must be canonicalised, or the machine
 * config is mistaken for a project tenant and its machine-wide cap is applied
 * per project directory.
 */
export function budgetStatusesFor(args: {
  tenant: RouterTenant;
  /** Canonical — see `canonicalConfigPath`. */
  machineConfigPath: string;
  machineDailyUsd?: number;
  projectSpend: () => number;
  machineSpend: () => number;
}): BudgetStatus[] | undefined {
  const out: BudgetStatus[] = [];
  const project = args.tenant.config?.budget?.dailyUsd;
  if (project !== undefined && args.tenant.configPath !== undefined && args.tenant.configPath !== args.machineConfigPath) {
    out.push({ dailyUsd: project, spentUsd: args.projectSpend(), configPath: args.tenant.configPath });
  }
  if (args.machineDailyUsd !== undefined) {
    out.push({ dailyUsd: args.machineDailyUsd, spentUsd: args.machineSpend(), configPath: args.machineConfigPath });
  }
  return out.length === 0 ? undefined : out;
}

/**
 * One gateway definition per name, across every tenant — and no definition at
 * all where two tenants disagree about how that name authenticates.
 *
 * Credentials are machine-wide **by gateway name**: `resolveChildEnv` resolves
 * one `SONATA_KEY_<NAME>` per name, and both transports then use it. Two
 * projects naming one gateway with different `base_url`s is deliberate and
 * supported — they share the credential and reach their own endpoints. Two
 * projects disagreeing about the gateway's `auth` or `credential_source` is
 * not: a last-one-wins merge would resolve one project's credential and hand
 * it to the other project's endpoint. Dropping the name leaves neither with a
 * key, so both fail visibly rather than one silently borrowing the other's.
 */
/**
 * OAuth kinds whose gateways would be served different accounts: LiteLLM
 * holds one credential per kind, so every gateway of such a kind has to go.
 * Pure; `mergeTenantGateways` drops by it.
 */
function oauthConflicts(
  entries: { name: string; owner: string; gateway: { auth?: string; credentialSource?: string } }[],
  identity: (name: string, gateway: { auth?: string; credentialSource?: string }) => string,
): { auth: string; names: string[]; why: string }[] {
  const byKind = new Map<string, typeof entries>();
  for (const entry of entries) {
    const auth = entry.gateway.auth;
    if (auth !== 'codex-oauth' && auth !== 'copilot-oauth') continue;
    byKind.set(auth, [...(byKind.get(auth) ?? []), entry]);
  }
  const out: { auth: string; names: string[]; why: string }[] = [];
  for (const [auth, group] of byKind) {
    const ids = group.map((entry) => identity(entry.name, entry.gateway));
    if (new Set(ids).size <= 1) continue;
    const listed = group.map((entry, k) => `"${entry.name}" (${entry.owner}, ${ids[k]})`).join(', ');
    out.push({
      auth,
      names: group.map((entry) => entry.name),
      why: `gateways with auth = "${auth}" read different credentials — ${listed} — serving none of them, ` +
        "since LiteLLM holds one credential of that kind and a project would be served another's " +
        'account; point them at one credential',
    });
  }
  return out;
}

/**
 * The one definition serve drops gateways by and `sonata doctor` warns by.
 * Sharing the function is not enough on its own: doctor also passes the same
 * inputs — every tenant the router would merge, the machine config included —
 * because a conflict can span two files that are each fine alone.
 */
export function mergeTenantGateways(
  tenants: { id: string; gateways: NativeConfig['gateways'] }[],
  log: (line: string) => void,
  /** Which credential a gateway is served from; serve passes `resolvedOauthIdentity`. */
  identity: (name: string, gateway: { auth?: string; credentialSource?: string }) => string =
    (name, gateway) => oauthCredentialIdentity(name, gateway),
  /** Filled with each dropped gateway's name and why, for the router to answer with. */
  dropped?: Map<string, string>,
): NativeConfig['gateways'] {
  const merged: NativeConfig['gateways'] = {};
  const owner: Record<string, string> = {};
  const conflicted = new Set<string>();
  for (const { id, gateways } of tenants) {
    for (const [name, gateway] of Object.entries(gateways)) {
      if (conflicted.has(name)) continue;
      const seen = merged[name];
      if (seen === undefined) {
        merged[name] = gateway;
        owner[name] = id;
        continue;
      }
      // Only the credential-bearing fields. A differing base_url is the
      // supported per-project-endpoint case, not a conflict.
      if (seen.auth === gateway.auth && seen.credentialSource === gateway.credentialSource) continue;
      conflicted.add(name);
      delete merged[name];
      const why = `gateway "${name}" is defined by two projects with different credentials ` +
        `(${owner[name]}: auth=${seen.auth} source=${seen.credentialSource ?? 'default'}; ` +
        `${id}: auth=${gateway.auth} source=${gateway.credentialSource ?? 'default'}) — ` +
        'serving neither, since one project\'s credential must not reach the other\'s endpoint';
      dropped?.set(name, why);
      log(why);
    }
  }
  // Two DIFFERENT names can still share one key variable across projects:
  // parseConfig refuses `foo-bar` beside `foo_bar` inside one file, but the
  // child env is keyed by envVarForGateway over the merged set, so one
  // project's `foo-bar` and another's `foo_bar` would write the same
  // SONATA_KEY_FOO_BAR. Serve neither, as above.
  const byKeyVar = new Map<string, string>();
  for (const name of Object.keys(merged)) {
    const keyVar = envVarForGateway(name);
    const other = byKeyVar.get(keyVar);
    if (other === undefined) {
      byKeyVar.set(keyVar, name);
      continue;
    }
    delete merged[name];
    delete merged[other];
    const why = `gateways "${other}" (${owner[other]}) and "${name}" (${owner[name]}) would share the key ` +
      `variable ${keyVar} — serving neither, since one project's credential must not reach the ` +
      'other\'s endpoint; rename one of them';
    dropped?.set(name, why);
    dropped?.set(other, why);
    log(why);
  }
  // Likewise one OAuth credential of each kind per LiteLLM child
  // (CHATGPT_TOKEN_DIR / GITHUB_COPILOT_TOKEN_DIR): every gateway of a kind is
  // served whichever credential resolveChildEnv finds first. Kept when they all
  // resolve to one credential (`identity`, which serve binds to
  // `resolvedOauthIdentity` — the store actually read); when any two do not,
  // EVERY gateway of that kind is dropped — dropping only the odd one out
  // still leaves one child deciding between accounts it cannot tell apart.
  for (const conflict of oauthConflicts(
    Object.entries(merged).map(([name, gateway]) => ({ name, owner: owner[name] ?? '?', gateway })),
    identity,
  )) {
    for (const name of conflict.names) {
      delete merged[name];
      dropped?.set(name, conflict.why);
    }
    log(conflict.why);
  }
  return merged;
}

/**
 * The credential store an OAuth gateway will actually be served from, on this
 * machine, as a comparable string. `sonata` is a login per gateway name.
 * Copilot's machine sources both read opencode's login (`readCopilotToken`).
 * ChatGPT: `codex` reads codex's store, `opencode` opencode's, and the
 * default reads codex's when it holds a login, else opencode's — exactly
 * `readChatGptOAuth`'s order.
 */
export function resolvedOauthIdentity(
  home: string,
  name: string,
  gateway: { auth?: string; credentialSource?: string },
): string {
  const source = gateway.credentialSource ?? 'default';
  if (source === 'sonata') return `sonata:${name}`;
  if (gateway.auth === 'copilot-oauth') return 'opencode store';
  if (source === 'codex') return 'codex store';
  if (source === 'opencode') return 'opencode store';
  return readChatGptOAuth(home, 'codex') !== null ? 'codex store' : 'opencode store';
}

/** codex's ChatGPT store as a stat-only token: its mtime and size, or absent. */
function codexStoreSignal(home: string): string {
  try {
    const { mtimeMs, size } = statSync(codexAuthPath(home));
    return `codex:${mtimeMs}:${size}`;
  } catch {
    return 'codex:absent';
  }
}

export async function cmdServe(
  opts: { cwd: string; home: string; daemon?: boolean } & ServeDeps,
): Promise<ServeHandle> {
  // `opts.cwd` no longer chooses a config: there is one router per machine and
  // it serves every project, resolving each request's own sonata.toml. It is
  // kept on the options so callers compile, and noted as a tenant so a plain
  // `sonata serve` run inside a project has that project in the union from
  // the first request.
  const registry = new TenantRegistry(opts.home, { log: (line) => console.error(`sonata serve: ${line}`) });
  registry.noteProject(opts.cwd);
  const ports = opts.ports ?? routerPorts(opts.home);
  // Canonicalised once, because `TenantRegistry` realpaths every config path it
  // reports and a raw `join` does not: where $HOME or .config traverses a
  // symlink the two spellings differ, the machine config then looks like a
  // project tenant, and its machine-wide cap is applied per project directory.
  // The same defect class `df12401` fixed for tenant identity.
  const machineConfigPathRaw = join(opts.home, GLOBAL_CONFIG_RELATIVE);
  const machineConfigPath = canonicalConfigPath(machineConfigPathRaw);
  const machineConfig = (): SonataConfig | undefined => {
    try { return existsSync(machineConfigPathRaw) ? loadConfig(dirname(machineConfigPathRaw), opts.home) : undefined; } catch { return undefined; }
  };
  // A router serves every project, so "is there anything to serve?" is a
  // question about tenants, not about the machine config. `sonata init`
  // defaults to project scope, so a fresh install has no machine config at
  // all — asking only about that file killed the daemon at startup, and the
  // user saw nothing but "the daemon did not answer".
  if (!registry.loadable().some(({ config }) => config.native !== undefined)) {
    throw new Error('sonata serve: no [native] table');
  }

  /**
   * Gateways serve has dropped, and why. Refreshed by every merge; read per
   * request by the router, which answers a model on one of them with the
   * reason instead of forwarding it.
   */
  let droppedGateways = new Map<string, string>();
  /**
   * Gateways whose credential did not resolve in the last child-env build,
   * and why — the message names the gateway, the missing credential and the
   * remedy. Treated like a dropped gateway: the router answers a model on one
   * with this reason and forwards nothing.
   *
   * Direct gateways too. One with no key used to go out with an empty bearer:
   * the conversation was sent, the upstream answered 401, and the tier path
   * turned that into a 529 pointing at `sonata dispatch` while the bare path
   * handed Claude Code a 401 it reads as its own login failing.
   */
  let credentialFailures = new Map<string, string>();
  /**
   * The LiteLLM-transport ones among them, whose models are also left out of
   * LiteLLM's config, so LiteLLM never loads a deployment it cannot
   * authenticate. A direct gateway's models are not LiteLLM's to serve, and
   * leaving them in keeps its failure from restarting LiteLLM.
   */
  let litellmCredentialFailures = new Set<string>();
  /** Each gateway's last good credential, across child-env builds; see `resolveChildEnv`. */
  const credentialMemory = newCredentialMemory();
  /**
   * The store each default-sourced ChatGPT gateway was last seen to read.
   * `resolvedOauthIdentity` answers "opencode" whenever codex's file does not
   * read as a login — torn mid-write included — and a conflict drop decided
   * on that would take the gateway away for the length of one write. While
   * codex's file cannot be read, the last answer stands.
   */
  const lastOauthIdentity = new Map<string, string>();
  const mergeGateways = (log: (line: string) => void): NativeConfig['gateways'] => {
    const dropped = new Map<string, string>();
    const gateways = mergeTenantGateways(
      registry.loadable().map(({ id, config }) => ({ id, gateways: config.native?.gateways ?? {} })),
      log,
      (name, gateway) => {
        const lineage = lineageKey(name, gateway);
        const held = lastOauthIdentity.get(lineage);
        if (held !== undefined && gateway.auth === 'codex-oauth' && gateway.credentialSource === undefined
          && jsonStoreRead(codexAuthPath(opts.home)).state === 'unreadable') return held;
        const identity = resolvedOauthIdentity(opts.home, name, gateway);
        lastOauthIdentity.set(lineage, identity);
        return identity;
      },
      dropped,
    );
    droppedGateways = dropped;
    return gateways;
  };
  /** Merged gateways across every loadable tenant — what credential resolution and the child env are built from. */
  const mergedNative = (
    log: (line: string) => void = (line) => console.error(`sonata serve: ${line}`),
  ): NativeConfig => ({
    models: {},
    gateways: mergeGateways(log),
    ports,
    generate: {},
  });
  /**
   * The tenants as LiteLLM should see them: every model on a dropped gateway,
   * or on one whose credential did not resolve, removed. Leaving one in lets LiteLLM serve it from whatever credential it
   * does hold — for an OAuth kind, another project's account, or a blocking
   * device-code login.
   */
  const servableTenants = () => {
    mergeGateways(() => { /* logged by mergedNative */ });
    const dropped = droppedGateways;
    const unresolved = litellmCredentialFailures;
    return registry.loadable().map((tenant) => {
      const native = tenant.config.native;
      const keep = <T extends { gateway?: string }>(models: Record<string, T>) =>
        Object.fromEntries(Object.entries(models).filter(([, model]) =>
          model.gateway === undefined || (!dropped.has(model.gateway) && !unresolved.has(model.gateway))));
      return {
        ...tenant,
        config: {
          ...tenant.config,
          unifiedModels: keep(tenant.config.unifiedModels),
          ...(native === undefined ? {} : { native: { ...native, models: keep(native.models) } }),
        },
      };
    });
  };
  /**
   * What the gateway merge depends on, as a cheap comparable string: the
   * known configs, and whether codex's ChatGPT store holds a login — which
   * `resolvedOauthIdentity` consults for a default-sourced codex-oauth
   * gateway, so `codex login`/`logout` while serving changes the answer.
   * Both are stat-only.
   */
  const gatewayPlanInputs = (): string => `${registry.fingerprint()}\n${codexStoreSignal(opts.home)}`;
  const unionNeedsLitellm = (): boolean => registry.loadable().some(({ config }) => litellmRequired(config));

  const litellmBin = managedLitellmPath(opts.home);
  /** Why litellm cannot serve, or undefined. Set lazily; cleared when a later check finds the venv healthy. */
  let litellmUnavailable: string | undefined;
  const litellmHealthy = (): boolean => {
    const status = litellmStatus(opts.home, true);
    if (status.state === 'ok' || status.state === 'stale') { litellmUnavailable = undefined; return true; }
    litellmUnavailable = `a project routes through LiteLLM, which is ${status.state} — run \`sonata litellm install\``;
    return false;
  };
  /**
   * Set while a recorded LiteLLM from an earlier daemon outlives its signals.
   * Nothing is spawned over it, and every LiteLLM-bound request is answered
   * with this instead of reaching whatever holds the port.
   */
  let orphanBlocking: string | undefined;
  let orphanPid: number | undefined;
  const clearOrphan = async (phase: 'eager' | 'lazy'): Promise<void> => {
    const { survivor } = await killRecordedOrphan(opts.home, ports.router, {
      processCommand: opts.processCommand,
      timeoutMs: opts.litellmExitTimeoutMs,
    });
    if (survivor !== undefined) {
      orphanPid = survivor.pid;
      orphanBlocking = orphanSurvivorMessage(survivor, serveStatePath(opts.home, ports.router), phase);
      throw new Error(orphanBlocking);
    }
    orphanBlocking = undefined;
    orphanPid = undefined;
  };

  const masterKey = `sk-sonata-${randomBytes(32).toString('hex')}`;
  const instanceId = opts.instanceId ?? process.env.SONATA_SERVE_INSTANCE_ID ?? randomUUID();
  const tempDir = opts.tempDir ?? mkdtempSync(join(tmpdir(), 'sonata-litellm-'));
  mkdirSync(tempDir, { recursive: true });

  // Everything from here to a listening router owns `tempDir`. Cleanup used to
  // be duplicated on two failure branches and absent from every other throw, so
  // a run that died in between left its config behind.
  let child: SpawnedLitellm | undefined;
  let router: ReturnType<typeof createRouterServer> | undefined;
  /** Every loopback server the router listens on — one per family the machine has. */
  let listening: Server[] = [];
  let boundPort = 0;
  let uiDeps: UiDeps;
  let stopping = false;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const respawnDelayMs = opts.respawnDelayMs ?? 1000;
  const maxRespawns = opts.maxRespawns ?? 5;
  const respawnWindowMs = opts.respawnWindowMs ?? 60_000;
  const respawnTimestamps: number[] = [];
  try {
    const configPath = join(tempDir, 'config.json');

    /**
     * Records which gateways' credentials failed, for the router's answer and,
     * for LiteLLM's, `servableTenants` and the plan snapshot. Every build of
     * the child env goes through this, so the sets always describe the env
     * that was just built.
     */
    const applyCredentialFailures = (failures: CredentialFailure[], cfg: NativeConfig): void => {
      const all = new Map<string, string>();
      const litellm = new Set<string>();
      for (const { gateway, message } of failures) {
        const gw = cfg.gateways[gateway];
        if (gw === undefined) continue;
        all.set(gateway, message);
        if (transportFor(gw, gateway) !== 'direct') litellm.add(gateway);
      }
      credentialFailures = all;
      litellmCredentialFailures = litellm;
    };

    // Startup fails outright only for the machine config's own gateways — the
    // config it is loading. Any other tenant's missing credential leaves that
    // gateway out, exactly as a re-merge does: a registered session in an
    // unrelated project must not stop the router from starting at all.
    const startupNative = mergedNative();
    const startup = resolveChildEnv(startupNative, opts.home, tempDir, { memory: credentialMemory });
    const machineGateways = machineConfig()?.native?.gateways ?? {};
    const fatal = startup.failures.find(({ gateway }) => Object.hasOwn(machineGateways, gateway));
    if (fatal !== undefined) throw new Error(`sonata serve: ${fatal.message}`);
    let childEnv = startup.env;
    /**
     * What a LiteLLM (re)spawn would be given, as a comparable string: the
     * config.json it would be written — the servable tenants' model list,
     * after drops and credential failures — and the env entries those models
     * read, hashed. A drop, a login appearing, a token dir moving or a key
     * changing all move it, including with every config untouched: compared
     * on the configs alone, a login that un-dropped two gateways left LiteLLM
     * on an empty model list answering "Invalid model name".
     *
     * What would be written, not why: it used to carry the failed gateways'
     * names, so a credential store torn for the length of one write — or a
     * failing gateway no model uses — restarted LiteLLM for a config and env
     * identical to the running one, twice per flap. The configs are still
     * compared too, as they always were. Reads the merge `refreshGatewayPlan`
     * has already run for this request rather than merging again.
     */
    const litellmPlanSnapshot = (): string => {
      const tenants = servableTenants();
      const vars = new Set<string>();
      for (const { config } of tenants) {
        const gateways = config.native?.gateways ?? {};
        const names = [
          ...Object.values(config.unifiedModels).map((model) => model.gateway),
          ...Object.values(config.native?.models ?? {}).map((model) => model.gateway),
        ];
        for (const name of names) {
          const gateway = name === undefined ? undefined : gateways[name];
          if (name === undefined || gateway === undefined || transportFor(gateway, name) !== 'litellm') continue;
          if (gateway.auth === 'codex-oauth') vars.add('CHATGPT_TOKEN_DIR');
          else if (gateway.auth === 'copilot-oauth') vars.add('GITHUB_COPILOT_TOKEN_DIR');
          else vars.add(envVarForGateway(name));
        }
      }
      const env = [...vars].sort().map((name) => {
        const value = childEnv[name];
        return `${name}=${value === undefined ? '-' : createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
      });
      return `${registry.unionSnapshot()}\n${JSON.stringify(litellmConfigForTenants(tenants, ''))}\n${env.join(',')}`;
    };
    applyCredentialFailures(startup.failures, startupNative);
    writeFileSync(configPath, litellmConfigYamlForTenants(servableTenants(), masterKey), { mode: 0o600 });
    const needsLitellmAtStart = unionNeedsLitellm();

    /**
     * Credential failures, each logged once per distinct message rather than
     * once per request — a missing key is retried on every request until it
     * is added. A message is forgotten once it stops failing, so a gateway
     * that breaks again is reported again.
     */
    let loggedCredentialFailures = new Set<string>();
    const reportCredentialFailures = (failures: CredentialFailure[]): void => {
      const now = new Set(failures.map(({ message }) => message));
      for (const message of now) {
        if (!loggedCredentialFailures.has(message)) console.error(`sonata serve: ${message}`);
      }
      loggedCredentialFailures = now;
    };
    reportCredentialFailures(startup.failures);

    // The direct transport bypasses LiteLLM entirely, so the gateway's own
    // credential has to reach the router rather than the child's environment.
    // Mutated in place (not rebuilt) so the object the router closed over stays
    // current across a config-triggered rebuild of `childEnv`.
    const gatewayKeys: Record<string, string> = {};
    const refreshGatewayKeys = (cfg: NativeConfig): void => {
      for (const name of Object.keys(gatewayKeys)) delete gatewayKeys[name];
      for (const [name, gateway] of Object.entries(cfg.gateways)) {
        if (transportFor(gateway, name) !== 'direct') continue;
        const key = childEnv[envVarForGateway(name)];
        if (key !== undefined && key !== '') gatewayKeys[name] = key;
      }
    };
    refreshGatewayKeys(mergedNative());

    /**
     * Keeps the gateway merge — which gateways are dropped, and the direct
     * gateways' keys — current for the request about to be routed. Called
     * right after tenant resolution, which is where a new project is noted,
     * so it runs before EVERY path (tier, bare litellm, bare direct) rather
     * than only where a model-change check happens to fire. Without it, a
     * newly noted project whose gateway conflicts with another's was routed
     * on the previous merge: its direct request carried the other project's
     * key to its own base_url until some later merge.
     */
    //
    // The fingerprint is committed only once the rebuild succeeds. A rebuild
    // that throws — a gateway whose credential is not stored yet — is retried
    // on the next request, which is also what picks up a later `sonata auth
    // add`: that writes the key store, not a config, so no fingerprint moves.
    let planFingerprint = gatewayPlanInputs();
    /** The fingerprint whose rebuild last failed; a retry of it merges quietly, since its drops were already logged. */
    let failedFingerprint: string | undefined;
    const refreshGatewayPlan = (): void => {
      const now = gatewayPlanInputs();
      if (now === planFingerprint) return;
      const cfg = now === failedFingerprint ? mergedNative(() => { /* logged by the first attempt */ }) : mergedNative();
      // Not spawning: Copilot's token file belongs to the running child. The
      // ChatGPT file is synced under its newer-wins rule, which is how a
      // `codex login` while serving — it moves `codexStoreSignal`, so it
      // lands here — reaches a LiteLLM that re-reads the file per token.
      //
      // Per gateway: a failing gateway is left out of the new env and every
      // other one keeps its key. Replaced rather than mutated: `childEnv` is
      // also the environment a LiteLLM child was spawned with. A failing
      // DIRECT gateway's key is therefore absent, not carried over — it is
      // looked up by name, so a project that has just taken over a name
      // another project dropped would otherwise be sent that project's key.
      // With no key it is recorded as failed, and its request is answered
      // with a 502 naming the missing credential without being forwarded.
      const { env, failures, transient } = resolveChildEnv(cfg, opts.home, tempDir, { spawning: false, memory: credentialMemory });
      childEnv = env;
      applyCredentialFailures(failures, cfg);
      reportCredentialFailures([...failures, ...transient]);
      refreshGatewayKeys(cfg);
      // A store that could not be read is retried on the next request too,
      // so its recovery — or a login written meanwhile — is not missed.
      if (failures.length > 0 || transient.length > 0) {
        failedFingerprint = now;
        return;
      }
      planFingerprint = now;
      failedFingerprint = undefined;
    };

    // The litellm child dying on its own (not via `stop()`) used to go
    // unnoticed until the next request 502'd and someone ran `sonata restart`
    // by hand — measured directly: the child exits, nothing is watching, the
    // router stays up and answers requests with a dead upstream. This watches
    // the exact child this process spawned and respawns it in place, which is
    // why it's safe where `ensure-serve.mjs`'s external health-probe respawn
    // (bug D in the ledger) was not: there is only ever one spawn racing here,
    // never a second `serve` guessing whether an existing one is healthy.
    // Resolves once the current child is confirmed healthy, or once serve has
    // given up waiting on it — awaited by the router before every litellm-bound
    // request so a request landing in a respawn's brief startup gap waits for
    // it, rather than getting a connection-refused failure that would cool the
    // candidate down for a crash it already recovered from. The `.catch` means
    // a hard failure resolves this too: the router's own fetch then fails for
    // real, and a genuine outage cools down exactly as before.
    // Tracks the native config LiteLLM's own config file currently reflects
    // — legacy [native.models], unified [models], AND gateways, not just the
    // unified table — so a config change (a new model added, an existing
    // model's id/gateway edited under EITHER table, or a gateway's
    // base_url/wire_format/auth/credential_source edited) while the daemon
    // is already running can be told apart from "nothing changed" without
    // restarting litellm on every single tier-resolution call. Gateways
    // matter here even when the model list itself is unchanged: rerunning
    // `sonata init` without touching model selection can still rewrite a
    // gateway's endpoint or credential source, and litellm's own config
    // would otherwise keep the stale one indefinitely. Legacy
    // `native.models` matters too — `litellmConfig` (native/litellm.ts)
    // builds the model list from `native.models` first, unconditionally, so
    // a transitional config editing a legacy entry's id/gateway needs the
    // same restart a unified edit gets.
    let activeModelsJson = litellmPlanSnapshot();
    // The child a deliberate kill-for-config-change is about to terminate, so
    // the crash-exit handler below (which fires for ANY exit, deliberate or
    // not) does not also schedule its own duplicate respawn on top of the one
    // already in flight from that deliberate restart.
    //
    // It names the *child*, not a bare boolean. A boolean is cleared by
    // whichever exit happens to arrive first, and the abandoned-child branch
    // returned before ever reading it — so a flag set for child A and consumed
    // by an unrelated exit leaked, and from then on the next genuine crash of
    // the live child was swallowed as "expected", no respawn fired, and the
    // router answered every litellm request against a dead upstream until a
    // manual `sonata restart`. Identity cannot leak on any ordering.
    let expectedRestartChild: SpawnedLitellm | undefined;
    let litellmReady: Promise<void> = Promise.resolve();
    // A lazy child that fails its readiness probe is deliberately terminated;
    // identify that exact child so its exit cannot schedule crash recovery.
    const abandonedChildren = new Set<SpawnedLitellm>();
    // Retain exit knowledge long enough for the readiness owner to avoid
    // signalling a process whose exit callback already ran.
    const exitedChildren = new Set<SpawnedLitellm>();

    const spawnLitellmChild = (): SpawnedLitellm => {
      const spawned = (opts.spawnLitellm ?? defaultSpawnLitellm)(
        configPath, childEnv, ports.litellm, litellmBin,
      );
      recordLitellmPid(opts.home, ports.router, spawned.pid);
      spawned.onExit?.((code, signal) => {
        if (stopping) return;
        const deliberate = expectedRestartChild === spawned;
        if (expectedRestartChild === spawned) expectedRestartChild = undefined;
        if (abandonedChildren.delete(spawned)) {
          exitedChildren.add(spawned);
          return;
        }
        if (deliberate) return;
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
        litellmReady = (async () => {
          await sleep(respawnDelayMs);
          if (stopping) return;
          console.error('sonata serve: respawning litellm...');
          child = spawnLitellmChild();
          await (opts.waitForLitellm ?? defaultWaitForLitellm)(ports.litellm, masterKey);
        })().catch((error) => {
          console.error(`sonata serve: respawned litellm never came up: ${String(error)}`);
        });
      });
      return spawned;
    };

    // Detects a model-registry change (e.g. `sonata init` adding a new
    // model while this daemon is already running) and restarts litellm with
    // a freshly generated config so it actually knows about the new model —
    // hot-reloading only the tier half (as `resolveTier` below already does)
    // is not enough, since litellm's own model list is otherwise frozen at
    // whatever it was given at startup. Reuses the same respawn machinery
    // already proven for crash recovery, including the `litellmReady` gate
    // every request already awaits before reaching litellm.
    /** The child env for a (re)spawn, resolved per gateway; failures recorded and reported, never thrown. */
    const rebuildChildEnv = (): void => {
      const cfg = mergedNative();
      const { env, failures, transient } = resolveChildEnv(cfg, opts.home, tempDir, { memory: credentialMemory });
      childEnv = env;
      applyCredentialFailures(failures, cfg);
      reportCredentialFailures([...failures, ...transient]);
      refreshGatewayKeys(cfg);
    };

    const runRestartForModelChange = async (): Promise<void> => {
      if (stopping) return;
      const freshModelsJson = litellmPlanSnapshot();
      if (freshModelsJson === activeModelsJson) return;
      if (registry.loadable().length === 0) {
        activeModelsJson = freshModelsJson;
        return;
      }
      // With no litellm child there is nothing to restart — but the direct
      // path's credentials still have to follow the new registry. A config
      // that has newly grown a litellm-transport gateway needs a real
      // `sonata restart`, because `serve` must never install.
      if (child === undefined) {
        // No child yet: refresh direct credentials, and if the union now needs
        // litellm, start it here — tenants appear after startup, and "run
        // sonata restart" is not an answer a hook can act on.
        //
        // Per gateway, like the re-merge: a gateway whose credential is
        // missing is left out of the env and of LiteLLM's config, and every
        // other one starts. Failing the whole start here left no project's
        // LiteLLM model reachable over one project's missing login.
        rebuildChildEnv();
        // Re-taken after the rebuild, which is what the child will be given.
        const planned = litellmPlanSnapshot();
        if (!unionNeedsLitellm()) {
          activeModelsJson = planned;
          return;
        }
        if (!litellmHealthy()) {
          // Do not commit the snapshot: after `sonata litellm install`, the
          // unchanged union must still retry lazy child startup.
          console.error(`sonata serve: ${litellmUnavailable}`);
          return;
        }
        writeFileSync(configPath, litellmConfigYamlForTenants(servableTenants(), masterKey), { mode: 0o600 });
        console.error('sonata serve: a project now routes through LiteLLM — starting it');
        litellmReady = (async () => {
          // A daemon that died without stopping its child leaves that child
          // recorded here; the lazy start is the first spawn after it, so it
          // clears it exactly as an eager start does.
          await clearOrphan('lazy');
          const spawned = spawnLitellmChild();
          child = spawned;
          // The readiness await owns this child. Its exit can race the failed
          // probe, so the crash watcher must not respawn it until ready.
          abandonedChildren.add(spawned);
          try {
            await (opts.waitForLitellm ?? defaultWaitForLitellm)(ports.litellm, masterKey);
            if (exitedChildren.has(spawned)) throw new Error('litellm exited before becoming ready');
          } catch (error) {
            // A spawned process is not a usable child until its health probe
            // passes. It remains abandoned while being terminated, so only
            // the next request owns the retry.
            if (child === spawned) {
              child = undefined;
              if (!exitedChildren.has(spawned)) spawned.kill();
            }
            exitedChildren.delete(spawned);
            throw error;
          }
          abandonedChildren.delete(spawned);
          activeModelsJson = planned;
        })().catch((error) => { console.error(`sonata serve: litellm never came up: ${String(error)}`); });
        await litellmReady;
        return;
      }
      // Only committed once the replacement is ready (inside `litellmReady`
      // below) — not up front, and not merely once its config is prepared. A
      // replacement that never comes up is then tried again by the next
      // request, whose comparison still differs. A gateway whose credential
      // is missing is not such a failure any more: it is left out, and the
      // snapshot carries the failed set, so its login appearing is itself
      // the change that restarts LiteLLM with it.
      try {
        // Env first: which gateways failed decides what config.json may list.
        // A missing credential no longer throws here — that left the restart
        // failing, and logging so, on every request until the login appeared.
        // A mixed config restarts litellm for its translated gateways while
        // its direct ones keep serving from `gatewayKeys` — which is read off
        // `childEnv` and would otherwise still hold the pre-change credential.
        rebuildChildEnv();
        // Re-taken after the rebuild: if what the child would be given is what
        // it already has, there is nothing to restart it for.
        const planned = litellmPlanSnapshot();
        if (planned === activeModelsJson) return;
        writeFileSync(configPath, litellmConfigYamlForTenants(servableTenants(), masterKey), { mode: 0o600 });
        console.error('sonata serve: model registry changed — restarting litellm to pick it up...');
        const oldChild = child;
        expectedRestartChild = oldChild;
        litellmReady = (async () => {
          // Wait for the old child's actual exit before spawning its
          // replacement: kill() only requests termination, and racing a new
          // spawn/probe against a still-alive old process can either fail to
          // bind the port or let the health probe see the stale
          // (old-model-list) process and declare the restart done before it
          // actually happened. `onExit` supports multiple independent
          // listeners (it's backed by `child.on('exit', cb)`), so this does
          // not disturb the crash-respawn handler's own listener on the
          // same child.
          //
          // The wait is bounded: a litellm that ignores SIGTERM (hung, or
          // wedged on a slow shutdown) would otherwise leave this promise
          // unresolved forever, and since it's installed as `litellmReady`,
          // every subsequent foreign-model request would then wait forever
          // too. Escalate to `forceKill` (SIGKILL) once, wait once more
          // bounded by the same timeout, then proceed regardless — a stray
          // process holding the port fails the following bind/probe loudly,
          // which is recoverable; a hung `litellmReady` is not.
          const exited = new Promise<void>((resolve) => {
            if (oldChild?.onExit) oldChild.onExit(() => resolve());
            else resolve();
          });
          const exitTimeoutMs = opts.litellmExitTimeoutMs ?? LITELLM_EXIT_TIMEOUT_MS;
          if (await raceTimeout(exited, exitTimeoutMs, sleep)) {
            console.error(
              `sonata serve: old litellm child did not exit within ${exitTimeoutMs}ms — sending SIGKILL`,
            );
            (oldChild?.forceKill ?? oldChild?.kill)?.call(oldChild);
            if (await raceTimeout(exited, exitTimeoutMs, sleep)) {
              console.error(
                'sonata serve: old litellm child still has not exited after SIGKILL — proceeding anyway; ' +
                'a stray process may be holding the litellm port',
              );
            }
          }
          if (stopping) return;
          child = spawnLitellmChild();
          await (opts.waitForLitellm ?? defaultWaitForLitellm)(ports.litellm, masterKey);
          // Committed only once the replacement answers. Committed earlier, a
          // replacement that never came up was never tried again: the next
          // request saw no change and served a dead upstream until a manual
          // `sonata restart`. Left uncommitted, the next check retries.
          activeModelsJson = planned;
        })().catch((error) => {
          console.error(`sonata serve: restarted litellm never came up: ${String(error)}`);
        });
        oldChild?.kill();
        await litellmReady;
      } catch (error) {
        console.error(`sonata serve: failed to restart litellm for a model registry change: ${String(error)}`);
      }
    };

    /**
     * One model-change check at a time.
     *
     * Every request calls this, and two concurrent first requests from one
     * project is the normal case a multi-tenant router creates (parallel
     * subagents). Without a guard, request 1 took the lazy-start branch and
     * request 2 — arriving before that child was ready — saw `child !== undefined`
     * and took the *restart* branch, killing a child that was still coming up.
     * The extra kill/respawn was the smaller half of the cost; the larger was
     * that the deliberate-restart marker was then consumed by the wrong exit.
     * Serialising the check removes both, and a second caller simply awaits the
     * check already in flight, which is the same answer it would have computed.
     */
    let restartInFlight: Promise<void> | undefined;
    const maybeRestartForModelChange = async (): Promise<void> => {
      if (restartInFlight !== undefined) return restartInFlight;
      const inFlight = runRestartForModelChange().finally(() => {
        if (restartInFlight === inFlight) restartInFlight = undefined;
      });
      restartInFlight = inFlight;
      return inFlight;
    };

    // Retention is enforced by the writer — at startup and then daily (the
    // timer is started beside the price refresh below) — so a daemon that
    // stays up for weeks cannot accumulate day-files the way opencode's event
    // table did (6.5 GB, and not something sonata gets to repeat in its own
    // store). Pruning only at startup let everything outlive the window for
    // as long as the daemon lived.
    await pruneRetention(opts.home);

    let litellmReadyResolved = !needsLitellmAtStart;

    // Held by reference so the bound port can be written back after `listen`:
    // a configured port of 0 means "pick an ephemeral one", and a UiDeps still
    // carrying 0 fails every request's Host check.
    uiDeps = { home: opts.home, port: ports.router, tenants: () => registry.summary() };
    router = createRouterServer({
      fetch,
      litellmBase: `http://${LITELLM_HOST}:${ports.litellm}`,
      litellmKey: masterKey,
      health: true,
      healthReady: () => !needsLitellmAtStart || litellmReadyResolved,
      instanceId,
      log: (line) => console.log(line),
      tenants: () => registry.summary(),
      ui: uiDeps,
      resolveTenant: (hint) => {
        const tenant = registry.resolve(hint);
        refreshGatewayPlan();
        return tenant;
      },
      // Created here, not per request: a settings file written once has to keep
      // authorising its project hint across restarts.
      projectHintToken: ensureRouterToken(opts.home),
      resolveTier: (alias, tenant) => tenant.config === undefined ? undefined : resolveTierAlias(tenant.config, alias),
      resolveGateway: (key, tenant) => tenant.config?.unifiedModels[key]?.gateway,
      gatewayUnavailable: (_tenant, gateway) => droppedGateways.get(gateway) ?? credentialFailures.get(gateway),
      resolveNative: (key, tenant) => tenant.config === undefined ? undefined : nativeRouteFor(tenant.config, key),
      // Opt-in only: a captured request is a whole conversation.
      capture400Dir: process.env.SONATA_CAPTURE_400_DIR,
      budget: (tenant) => {
        const statuses = budgetStatusesFor({
          tenant,
          machineConfigPath,
          machineDailyUsd: machineConfig()?.budget?.dailyUsd,
          projectSpend: () => spentTodayUsd(opts.home, Date.now(), { tenant: tenant.id }),
          machineSpend: () => spentTodayUsd(opts.home),
        });
        // `machineConfig()` swallows a load failure and answers undefined, so
        // a machine config that sets [budget] but will not parse would lose
        // its machine-wide cap and read exactly like one that never set one.
        // `unreadableMachineBudget` recovers the refusal; a broken file with
        // no [budget] table had no cap to lose and is left alone. Other
        // callers of `machineConfig()` keep their present behaviour.
        const unreadable = unreadableMachineBudget(opts.home);
        return unreadable === undefined ? statuses : [...(statuses ?? []), unreadable];
      },
      gatewayKeys: (tenant) => {
        const out: Record<string, string> = {};
        for (const [name, gateway] of Object.entries(tenant.config?.native?.gateways ?? {})) {
          if (transportFor(gateway, name) !== 'direct') continue;
          const key = childEnv[envVarForGateway(name)];
          if (key !== undefined && key !== '') out[name] = key;
        }
        return out;
      },
      litellmUnavailable: () => {
        // Tenant resolution has just noted the request's project, so re-probe
        // for a lazily-needed child before answering: an unavailable venv is
        // surfaced on this same request rather than forwarding it to whatever
        // might happen to occupy the LiteLLM port. `litellmHealthy` is called
        // for its effect on `litellmUnavailable`, which is the answer either
        // way.
        if (child === undefined && unionNeedsLitellm()) litellmHealthy();
        return orphanBlocking ?? litellmUnavailable;
      },
      checkModelChange: () => {
        void maybeRestartForModelChange().catch((error) => {
          console.error(`sonata serve: model-registry restart check failed: ${String(error)}`);
        });
      },
      litellmReady: () => litellmReady,
      recordUsage: opts.recordUsage ?? ((row, config) => {
        setImmediate(() => {
          let priced = row;
          try {
            // The config the request was routed under, snapshotted at its
            // start; re-resolving here would price it under whatever the file
            // says when the stream ends, and re-parse it once per row.
            priced = priceRow(config ?? registry.resolve({ project: row.project }).config!, opts.home, row);
          } catch {
            // A config that will not load is still no reason to drop the row.
          }
          try {
            appendRow(opts.home, priced);
          } catch { /* a ledger write never breaks a request */ }
        });
      }),
    });
    try {
      ({ servers: listening, port: boundPort } = await listenLoopback(router, ports.router, opts.listenOn ?? listenOn));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        throw new Error(await occupiedPortMessage(ports.router, opts.probeHealth));
      }
      throw error;
    }
    recordRouterPid(opts.home, ports.router, process.pid);
    // Do all shared-state cleanup only after this process owns the router port.
    // Requests can already arrive after listen(), so publish the startup work
    // as the readiness gate before yielding to the event loop.
    if (needsLitellmAtStart) {
      litellmReady = (async () => {
        if (!litellmHealthy()) {
          throw new Error(`sonata serve: this config routes through LiteLLM, which is ${litellmStatus(opts.home, true).state} — run \`sonata litellm install\``);
        }
        await clearOrphan('eager');
        child = spawnLitellmChild();
        await (opts.waitForLitellm ?? defaultWaitForLitellm)(ports.litellm, masterKey);
      })();
      await litellmReady;
      litellmReadyResolved = true;
    }
    // `listen` has resolved, so this is the port actually bound — the same as
    // the configured one unless that was 0.
    uiDeps.port = boundPort;
    console.log(`sonata UI: http://localhost:${uiDeps.port}/`);
  } catch (error) {
    // A post-bind startup failure must not strand an unusable router for an
    // in-process caller: before eager startup moved after `listen`, this path
    // could only fail before a socket existed.
    stopping = true;
    // SIGTERM then SIGKILL, not SIGTERM alone. A LiteLLM that failed to come
    // up is frequently one BLOCKED on an interactive device-code login — the
    // expired-ChatGPT-credential case — and such a child ignores SIGTERM for
    // the whole of its 15-minute poll. It was therefore orphaned here (PPID 1)
    // on every failed startup, while `rmSync(tempDir)` below pulled its config
    // out from under it. Six such orphans were found on one machine on
    // 2026-09-21, oldest six hours, none holding the port it was started for,
    // each one making the next `sonata restart` look like it had failed too.
    //
    // Killing is unconditional and needs no grace period: this child never
    // became ready, so it is serving nothing and has nothing to flush.
    if (child !== undefined) await terminateLitellm(child, opts.litellmExitTimeoutMs ?? LITELLM_EXIT_TIMEOUT_MS, sleep);
    // Clear the record while this process still owns the bound port. A
    // replacement cannot have written a new record until after close begins.
    if (listening.length > 0) clearFailedRouterRecord(opts.home, ports.router, orphanPid);
    for (const server of listening) {
      try { await close(server); } catch { /* preserve the startup error */ }
    }
    rmSync(tempDir, { force: true, recursive: true });
    throw error;
  }

  // Router is assigned by the time the try block completes; the catch rethrows.
  // `child` is read fresh in `stop()` below (not frozen here) because a respawn
  // can replace it after this point.
  const startedServers = listening;
  const routerPort = boundPort;

  // Started only once the router is actually listening, so a daemon that
  // failed to bind never reaches out to the network. Detached and unref'd: it
  // can neither delay a request nor hold the process open, and a failed fetch
  // leaves the previous cache in place rather than emptying it.
  const stopPriceRefresh = startPriceRefresh(opts.home, {
    update: opts.refreshPrices ?? (async (home) => updateModelsDev(home, fetch, {})),
    log: (line) => console.log(line),
  });
  // Same posture as the price refresh: never delays a request, never holds the
  // process open.
  const retentionTimer = setInterval(() => { void pruneRetention(opts.home); }, RETENTION_INTERVAL_MS);
  retentionTimer.unref?.();

  let stopped = false;

  return {
    routerPort,
    litellmPort: child !== undefined ? ports.litellm : undefined,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      // Before anything else: an interval firing during teardown would fetch
      // against a daemon that is going away.
      stopPriceRefresh();
      clearInterval(retentionTimer);
      stopping = true;
      // SIGTERM, bounded wait, then SIGKILL — the startup-failure path's
      // sequence, and BEFORE the state file naming its pid and the temp dir
      // holding its config are removed. A bare SIGTERM left a SIGTERM-deaf
      // child (one blocked on a device-code login) running as an orphan that
      // nothing recorded any more.
      if (child !== undefined) await terminateLitellm(child, opts.litellmExitTimeoutMs ?? LITELLM_EXIT_TIMEOUT_MS, sleep);
      try { unlinkSync(serveStatePath(opts.home, ports.router)); } catch { /* already gone */ }
      try {
        await Promise.all(startedServers.map((server) => close(server)));
      } finally {
        rmSync(tempDir, { force: true, recursive: true });
      }
    },
  };
}

export interface DaemonDeps {
  spawn?: typeof spawn;
  /** Resolves true once the router answers on `port` with the given instance id. */
  probe?: (port: number, instanceId: string) => Promise<boolean>;
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
  cwd: string = process.cwd(),
): Promise<DaemonResult> {
  const spawnFn = deps.spawn ?? spawn;
  const probe = deps.probe ?? (async (port: number, id: string) => (await sonataRouterReady(port, fetch, id)));
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = deps.timeoutMs ?? 60_000;

  const port = routerPorts(home).router;

  // A machine-wide daemon must start where its machine config is visible;
  // otherwise a project-local sonata.toml can still win config resolution.
  // Decided from the config FILE, and before the log mkdir below: that mkdir
  // creates ~/.config/sonata, so asking about the directory afterwards always
  // answered yes and a project-only machine started its router in a directory
  // with no config at all — which `serve` refuses.
  const machineConfigFile = join(home, GLOBAL_CONFIG_RELATIVE);
  const daemonCwd = existsSync(machineConfigFile) ? dirname(machineConfigFile) : cwd;

  const logPath = timestampedLogPath(home, 'serve');
  mkdirSync(dirname(logPath), { recursive: true });
  const log = openSync(logPath, 'a');

  // Generated here, before spawning, and handed to the child via its own
  // environment — so the polling loop below can tell its own freshly-spawned
  // process apart from a stale router that happens to still be answering the
  // same port, which is what let `sonata restart` false-report success
  // against a leftover daemon (see the design doc for the reproduction).
  const instanceId = randomUUID();

  // The child holds its own duplicate of the log fd once spawned, so the
  // parent's copy is closed straight away — on every path, including a spawn
  // that throws. Left open, a long-lived caller (`sonata code`, a route hook's
  // CLI) leaked one fd per daemon start.
  let child: ReturnType<typeof spawnFn>;
  try {
    child = spawnFn(argv[0], argv.slice(1), {
      detached: true,
      stdio: ['ignore', log, log],
      cwd: daemonCwd,
      env: { ...process.env, SONATA_SERVE_INSTANCE_ID: instanceId },
    });
  } finally {
    closeSync(log);
  }
  child.unref();

  const deadline = now() + timeoutMs;
  for (;;) {
    if (await probe(port, instanceId)) return { pid: child.pid ?? 0, port, logPath };
    if (now() > deadline) {
      throw new Error(
        `sonata serve: the daemon did not answer on port ${port} within ${Math.round(timeoutMs / 1000)}s. ` +
        `See ${logPath}`,
      );
    }
    await sleep(500);
  }
}

/**
 * Finds the OS pid bound to a TCP port. `lsof -ti` prints one pid per line; an
 * empty or ambiguous (more than one) result means "don't know", which every
 * caller treats the same as a lookup failure.
 *
 * Sonata never kills what this returns. It is used to *print* the pid in the
 * takeover message below, and — in `readLegacyServeStateFor` — to check that a
 * pid sonata itself recorded is the one holding the port. Validating a
 * recorded pid is not the same as adopting a scanned one: the kill list is
 * still built exclusively from sonata's own state file.
 */
function defaultFindPortPid(port: number): string | undefined {
  try {
    const out = execFileSync('lsof', ['-ti', `:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim();
    if (out === '') return undefined;
    const pids = out.split('\n').filter((line) => line !== '');
    return pids.length === 1 ? pids[0] : undefined;
  } catch {
    return undefined;
  }
}

export interface StopDeps {
  probeHealth?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  /** Test seam — production default is `process.kill`. */
  kill?: (pid: number) => void;
  /** Test seam — production default is `process.kill(pid, 'SIGKILL')`. */
  forceKill?: (pid: number) => void;
  /** Test seam — production default checks the OS for the pid. */
  isAlive?: (pid: number) => boolean;
  /**
   * Test seam — production default shells out to `lsof -ti:<port>` purely to
   * *print* the result in the takeover message below; sonata never kills a
   * pid this way itself. Returns `undefined` on any failure or ambiguity
   * (0 or more than 1 pid found).
   */
  findPortPid?: (port: number) => string | undefined;
  /**
   * Test seam — production default is `processCommand` (the pid's `ps` command
   * line). Consulted for the recorded litellm pid before it is signalled.
   */
  processCommand?: (pid: number) => string | undefined;
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
  const port = routerPorts(opts.home).router;
  const probeHealth = opts.probeHealth;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = opts.timeoutMs ?? 10_000;

  if (!(await isSonataRouter(port, probeHealth))) return { killed: false };

  const findPortPid = opts.findPortPid ?? defaultFindPortPid;
  // Port-keyed state first; the unkeyed pre-upgrade record only as a fallback,
  // and only when the pid it names is the one actually holding this port.
  // Without that check a legacy record left by a daemon on another port would
  // be read as this port's, and `sonata restart` would kill an unrelated
  // router and its litellm while the port it was asked about kept answering —
  // then report success, because the freshly started daemon loses the race for
  // a port that was never freed.
  const found = readServeStateFrom(opts.home, port)
    ?? readLegacyServeStateFor(opts.home, port, findPortPid);
  const state = found?.state;
  if (state?.routerPid === undefined) {
    const foundPid = findPortPid(port);
    const nextStep = foundPid !== undefined
      ? ` Kill it yourself, then run \`sonata serve --daemon\`:\n  kill ${foundPid}`
      : ' Kill it by hand, then run `sonata serve --daemon`.';
    throw new Error(
      `sonata restart: router port ${port} answers as a sonata router, but no recorded pid for it ` +
      `was found in ${serveStatePath(opts.home, port)} — it may have been started by a different sonata ` +
      `install or an older version.${nextStep}`,
    );
  }

  // `isSonataRouter(port)` proves a sonata router answers here; it does NOT
  // prove that `state.routerPid` is the process answering. A record survives
  // a daemon that was SIGKILLed or died hard, and the OS reuses pids — so a
  // stale record can name a number now belonging to something else entirely,
  // and signalling it would kill an unrelated process while the real router
  // kept running. The SIGKILL escalation below raised the cost of getting
  // that wrong from "a signal it can ignore" to "a process that dies", which
  // is what makes the check worth its weight now.
  //
  // Refused only on POSITIVE evidence of a mismatch. `findPortPid` answers
  // `undefined` for any failure or ambiguity — no `lsof`, no permission, two
  // holders — and treating "cannot tell" as "mismatch" would refuse every
  // restart on a machine without lsof, breaking the working case to guard the
  // rare one. Unknown therefore proceeds exactly as before.
  // `findPortPid` answers a string (it is otherwise only printed). A value
  // that is not a clean positive integer is treated as "cannot tell", same as
  // undefined, rather than compared as NaN — which would mismatch always.
  const holderRaw = findPortPid(port);
  const holderNum = holderRaw === undefined ? Number.NaN : Number(holderRaw);
  const holder = Number.isInteger(holderNum) && holderNum > 0 ? holderNum : undefined;
  if (holder !== undefined && state.routerPid !== holder) {
    throw new Error(
      `sonata restart: ${serveStatePath(opts.home, port)} records router pid ${state.routerPid}, ` +
      `but port ${port} is held by pid ${holder}. Refusing to signal a pid that does not own the ` +
      'port — the record is stale and its number may since have been reused by an unrelated ' +
      `process. Check the holder, then stop it yourself and run \`sonata serve --daemon\`:\n  kill ${holder}`,
    );
  }

  const kill = opts.kill ?? killPid;
  const isAlive = opts.isAlive ?? defaultIsAlive;
  const commandOf = opts.processCommand ?? processCommand;
  // The recorded litellm child is checked against its command line before it
  // is signalled — unlike the routerPid above, this check happens at kill
  // time rather than against the port holder, because nothing else proves
  // which process the number is. A serve-state file outlives its child, and
  // the OS reuses pids, so a stale record can name a process that has nothing
  // to do with sonata.
  //
  // Refused only on POSITIVE evidence of a mismatch, the same rule as the
  // routerPid check above: `commandOf` answers `undefined` whenever it cannot
  // tell — no ps, no permission — and "cannot tell" proceeds exactly as
  // before, or a real orphan litellm would be stranded (and keep its port) on
  // every machine where ps is unavailable. A known command naming no litellm
  // is that positive evidence, and the pid is left off the kill list below
  // entirely — signalling, waiting, and the SIGKILL escalation alike, which
  // would otherwise escalate against a stranger that is simply still running.
  const pids = [state.routerPid];
  const litellmPid = state.litellmPid;
  if (litellmPid !== undefined) {
    const command = commandOf(litellmPid);
    if (command !== undefined && !/litellm/i.test(command)) {
      console.error(
        `sonata restart: recorded litellm pid ${litellmPid} is no longer LiteLLM ` +
        `(${command}) — leaving it alone`,
      );
    } else {
      pids.push(litellmPid);
    }
  }
  for (const pid of pids) kill(pid);
  // The file the record actually came from, which may be the legacy path when
  // the daemon being stopped predates per-port state.
  try { unlinkSync(found!.path); } catch { /* already gone */ }

  // Wait for the pids we killed to actually exit — not for the port to go
  // quiet. Polling the port instead confused "still dying" with "already
  // replaced": an external supervisor that respawns `sonata serve` the
  // instant the port frees can put a brand-new, legitimate router on the
  // same port before our old process has finished exiting, so the port
  // never stops answering and this used to time out reporting failure even
  // though the kill had already succeeded. Checking the specific pids
  // sidesteps that race entirely.
  // Escalate rather than give up. A LiteLLM blocked on an interactive
  // device-code login does not act on SIGTERM — it sits in its 15-minute
  // poll — so the old code waited out the timeout and threw, leaving the
  // process alive, the port unusable, and the user with an error naming no
  // remedy. Every later `sonata restart` then added another one: six were
  // found on one machine on 2026-09-21, the oldest six hours old, none of
  // them holding the port they were started for.
  //
  // SIGKILL is safe *here* in a way it is not in general: these are pids
  // sonata itself recorded as its own router and its own litellm child, the
  // router pid has just been checked against the port's actual holder above,
  // and the user has asked for them to be replaced. The same escalation
  // already guards the in-process restart path.
  const deadline = now() + timeoutMs;
  const forceKill = opts.forceKill ?? forcePid;
  let escalated = false;
  while (pids.some((pid) => isAlive(pid))) {
    if (now() > deadline) {
      const stillAlive = pids.filter((pid) => isAlive(pid));
      if (!escalated) {
        escalated = true;
        for (const pid of stillAlive) forceKill(pid);
        // One more window, so SIGKILL is actually observed to land before
        // reporting a failure it may well have just fixed.
        await sleep(300);
        if (!pids.some((pid) => isAlive(pid))) break;
        continue;
      }
      throw new Error(
        `sonata restart: killed the recorded process(es) but pid(s) ${stillAlive.join(', ')} ` +
        `are still running after ${Math.round(timeoutMs / 1000)}s and did not respond to SIGKILL.`,
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
  // Forwarded by spread, not by enumeration. Listing the keys by hand meant
  // `cmdRestart` and `StopDeps` were two lists that had to agree, and they
  // stopped agreeing: `isAlive` was added to `StopDeps` and never added here,
  // so every seam passed through `cmdRestart` silently fell back to probing
  // the real OS. That is invisible on a developer machine — a fake pid is
  // usually dead — and cost a 10s timeout and a red CI run on a runner where
  // pid 111 happens to be a live process. `startServeDaemon` reads the same
  // object, so a `DaemonDeps` key riding along here is inert.
  await stopServe({ ...opts, home });
  return startServeDaemon(home, argv, opts);
}
