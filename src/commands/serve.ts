import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer as createHttpServer, type RequestListener, type Server } from 'node:http';

import { loadModelsDev } from '../modelsdev.js';
import { spentTodayUsd, unreadableMachineBudget, type BudgetStatus } from '../budget.js';
import { GLOBAL_CONFIG_RELATIVE, loadConfig, nativeRouteFor, oauthCredentialIdentity, resolveTierAlias, type NativeConfig, type SonataConfig } from '../config.js';
import { appendRow, LEDGER_RETENTION_DAYS, pruneLedger, type LedgerRow } from '../ledger.js';
import { pruneSessions } from '../sessions.js';
import { resolveKeyDetail, resolveKeys, resolveKeyFromSource, sonataKeyStorePath } from '../native/credentials.js';
import {
  boundUnreadable, boundUnreadableDb, fileStoreRead, jsonStoreRead, newUnreadableMemory, opencodeDbRead,
  UNREADABLE_SKIP_RULE, type StoreRead, type UnreadableMemory,
} from '../native/credential-reads.js';
import { chatgptAccountId, codexAuthPath, opencodeAuthPath, readChatGptOAuth, readCodexOAuth, readOpencodeChatGptOAuth, type ChatGptAuthRecord } from '../native/codex-auth.js';
import { opencodeCredentialOrigin, opencodeCredentialStamp, opencodeDbPath } from '../native/opencode-store.js';
import { credentialDir } from '../native/oauth-login.js';
import { readCopilotToken } from '../native/copilot-auth.js';
import { withReadSnapshot } from '../native/read-snapshot.js';
import { envVarForGateway, litellmConfigForTenants, litellmConfigYamlForTenants } from '../native/litellm.js';
import { litellmRequired, transportFor } from '../native/providers.js';
import { litellmStatus, managedLitellmPath } from '../native/litellm-venv.js';
import type { UiDeps } from '../native/ui.js';
import { decisionClassifier, decisionKeyFor, type TierClassifier } from '../native/auto-route.js';
import { ModelListCache, chooseDecisionModel } from '../native/decision-models.js';
import { loadDecisionCatalog } from '../decision-catalog.js';
import { createRouterServer, type RouterTenant } from '../native/router.js';
import { LITELLM_CHATGPT_LOGIN_REFUSED, pipeLitellmOutput } from '../native/litellm-output.js';
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
  /**
   * Hands every line the child writes, to stdout or stderr, to `cb` — after
   * it has been forwarded to serve's own output. Omitted by stubs with no
   * output; see `pipeLitellmOutput`.
   */
  onOutputLine?(cb: (line: string) => void): void;
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
 *
 * So every line still reaches serve's own stdout and stderr — piped rather
 * than inherited, and forwarded line by line (`pipeLitellmOutput`), because
 * the same output is also the only early sign that LiteLLM's ChatGPT login
 * was refused and it has fallen into a fifteen-minute device-code login.
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
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const listeners: ((line: string) => void)[] = [];
  const toListeners = (line: string): void => { for (const cb of listeners) cb(line); };
  if (child.stdout !== null) pipeLitellmOutput(child.stdout, process.stdout, toListeners);
  if (child.stderr !== null) pipeLitellmOutput(child.stderr, process.stderr, toListeners);
  return {
    pid: child.pid ?? 0,
    kill: () => child.kill(),
    forceKill: () => child.kill('SIGKILL'),
    onExit: (cb) => child.on('exit', cb),
    onOutputLine: (cb) => { listeners.push(cb); },
  };
}

/** A gateway whose credential could not be resolved, and why. */
interface CredentialFailure {
  gateway: string;
  message: string;
  /**
   * Set when nothing was resolved because a store in the gateway's lookup
   * could not be read and there was no earlier resolution to keep. Answered
   * like any other failure — left out, a named 502 — and retried on the next
   * request, but never fatal at startup: it is a moment, not a missing login.
   */
  unreadable?: true;
  /**
   * Set when nothing was resolved because opencode.db's credential table has
   * just read empty where it last held rows (`StoreRead.emptied`). The
   * request is refused like any failure, but the gateway keeps its last
   * resolution — its LiteLLM config and its seed — until a later read agrees:
   * one empty read may be a gap, and treating it as a logout restarted
   * LiteLLM twice and re-seeded it from the store when the row came back.
   */
  tentative?: true;
}

/**
 * Which login a ChatGPT token belongs to: the store it was read from, in
 * `resolvedOauthIdentity`'s spelling, and the account (`chatgptAccountId`),
 * or no account when nothing in the record says.
 */
export interface ChatGptLineage {
  identity: string;
  account?: string;
}

/**
 * Whether a LiteLLM seeded with `seeded` holds a different login from the
 * store's `current` — the one question that restarts it for a credential.
 *
 * A different store is a different login. So is a different account, but only
 * when both sides name one: an account that is merely unknown on one side (an
 * opencode v2 row has no `accountId`, and a token may lack the claim) is not
 * evidence of a switch, and reading it as one is what overwrote LiteLLM's
 * rotated token on every re-merge.
 */
export function chatgptLineageChanged(seeded: ChatGptLineage, current: ChatGptLineage): boolean {
  if (seeded.identity !== current.identity) return true;
  return seeded.account !== undefined && current.account !== undefined && seeded.account !== current.account;
}

/** What a LiteLLM spawn would seed a ChatGPT token directory with, and whose login it is. */
interface ChatGptSeed {
  gateway: string;
  record: ChatGptAuthRecord;
  lineage: ChatGptLineage;
}

interface ChildEnvResolution {
  env: NodeJS.ProcessEnv;
  /** Positively missing, or never resolved in this process: left out, and answered with the message. */
  failures: CredentialFailure[];
  /** A store that could not be read just now: the gateway kept its last credential. Logged, never answered. */
  transient: CredentialFailure[];
  /**
   * The OAuth tokens a LiteLLM spawn copies into its token directories, for
   * the gateways served from a harness's store. Nothing here is written by
   * the resolution itself: only a spawn writes, and only into a directory no
   * running LiteLLM is using.
   */
  seeds: { chatgpt?: ChatGptSeed; copilot?: string };
  /**
   * The ChatGPT stores (`resolvedOauthIdentity`'s spelling) a harness-sourced
   * codex-oauth gateway read this build and found positively holding no
   * login — neither unreadable nor a tentative empty read. How serve tells a
   * login has ended, by the login and not by the gateway's name.
   */
  chatgptGone: string[];
}

/**
 * What one serve process remembers between child-env builds.
 *
 * `lastGood` holds the env entries each gateway last resolved to, keyed by
 * its lineage — name, auth and credential source — so an entry is reused
 * only for the very lookup that produced it: a name another project has
 * since taken with a different source is a different lineage, and starts
 * with nothing. Entries for gateways no longer in the merge are forgotten,
 * so "has resolved in this process" means since it last reappeared. `seeds`
 * is the OAuth token each such lineage last read, under the same key and the
 * same lifetime, so a spawn while its store cannot be read still has one.
 */
interface CredentialMemory {
  lastGood: Map<string, Record<string, string>>;
  /**
   * The store each `lastGood` entry was read from, under the same key and the
   * same lifetime: a store skipped for staying unreadable keeps a lineage's
   * credential only when it is the store that credential came from.
   */
  lastGoodSource: Map<string, string>;
  seeds: Map<string, ChatGptSeed | string>;
  /** opencode.db's credential row count at the last read; see `opencodeDbRead`. */
  opencodeDb: { rows?: number };
  /** How long each store has been unreadable; see `boundUnreadable`. */
  unreadable: UnreadableMemory;
}

function newCredentialMemory(): CredentialMemory {
  return { lastGood: new Map(), lastGoodSource: new Map(), seeds: new Map(), opencodeDb: {}, unreadable: newUnreadableMemory() };
}

/**
 * The ChatGPT token in a LiteLLM token directory, as a comparable string: a
 * sha256 of its `auth.json`'s `refresh_token`, else its `access_token` (the
 * record LiteLLM's authenticator reads and writes). Undefined when there is
 * no directory, no file, or no token in it. A hash of the token and not the
 * file, so LiteLLM rewriting other fields — `device_code_requested_at` —
 * leaves it unchanged.
 */
function chatgptTokenHash(dir: string | undefined): string | undefined {
  if (dir === undefined) return undefined;
  try {
    const record: unknown = JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8'));
    if (record === null || typeof record !== 'object') return undefined;
    const { refresh_token: refresh, access_token: access } = record as Record<string, unknown>;
    const token = typeof refresh === 'string' && refresh !== '' ? refresh
      : typeof access === 'string' && access !== '' ? access : undefined;
    return token === undefined ? undefined : createHash('sha256').update(token).digest('hex');
  } catch {
    return undefined;
  }
}

/**
 * How long after a ChatGPT refusal is marked a torn or tokenless read of the
 * refused directory is retried. LiteLLM truncates and rewrites `auth.json` as
 * it records the device-code request, so the mark can land mid-write; the
 * first readable token within this window is the refused one. Never later: a
 * sonata-owned login is re-written into that same directory, and a read
 * after the window caught the user's new login and kept the mark on it.
 */
const REFUSED_TOKEN_CAPTURE_MS = 1000;

/** A store's read, tagged with which store it is, as `resolveChildEnv` chains them. */
type ChainStore = StoreRead & { id: string };

function lineageKey(name: string, gateway: { auth?: string; credentialSource?: string }): string {
  return `${name}|${gateway.auth ?? 'api-key'}|${gateway.credentialSource ?? 'default'}`;
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
 * The LiteLLM child's environment, and the OAuth tokens a spawn would seed
 * its token directories with, read out of the store each gateway reads.
 *
 * Nothing is written. A ChatGPT or Copilot token served from a harness's
 * store reaches LiteLLM only when serve spawns a child into a fresh token
 * directory (`cmdServe`'s `seedTokenDirs`); once LiteLLM owns a directory it
 * is the only writer of it. LiteLLM refreshes that file in place and ChatGPT
 * rotates refresh tokens, so any rule for a second writer deciding which copy
 * wins has failed on some shape of record — an absent account id, a torn
 * write, a store refreshed by its own harness. `CHATGPT_TOKEN_DIR` is set to
 * `chatgptTokenDir`, the directory the caller says a child uses.
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
 * default fall through to opencode's account): it keeps the last one, and
 * with no last one it is refused for now (`unreadable`) rather than served
 * from the later store. Without a memory — every caller but `cmdServe` —
 * nothing is remembered.
 */
interface ResolveChildEnvOptions {
  memory?: CredentialMemory;
  chatgptTokenDir?: string;
  /** The clock `boundUnreadable` measures against; with a memory only. */
  now?: () => number;
  /** Where a store skipped for being steadily unreadable is reported, once. */
  warn?: (line: string) => void;
}

/**
 * Every store is read once for the whole build (`withReadSnapshot`): the read
 * that classifies a store (`jsonStoreRead`, `opencodeDbRead`) and the reads
 * that parse it (`readCodexOAuth`, the opencode and sonata key readers) see
 * the same bytes. Read separately, a write landing between them classified a
 * store as answering and parsed it as holding nothing — a logout, which
 * ended the login and restarted LiteLLM for a write still in progress.
 */
function resolveChildEnv(
  native: NativeConfig,
  home: string,
  tempDir: string,
  opts: ResolveChildEnvOptions = {},
): ChildEnvResolution {
  return withReadSnapshot(() => resolveChildEnvFromSnapshot(native, home, tempDir, opts));
}

function resolveChildEnvFromSnapshot(
  native: NativeConfig,
  home: string,
  tempDir: string,
  opts: ResolveChildEnvOptions,
): ChildEnvResolution {
  const bounded = opts.memory !== undefined;
  const memory = opts.memory ?? newCredentialMemory();
  const clock = opts.now ?? Date.now;
  const fileRead = (path: string): StoreRead => {
    const raw = jsonStoreRead(path);
    return bounded ? boundUnreadable(path, raw, memory.unreadable, clock(), opts.warn) : raw;
  };
  const chatgptTokenDir = opts.chatgptTokenDir ?? join(tempDir, 'chatgpt');
  const failures: CredentialFailure[] = [];
  const transient: CredentialFailure[] = [];
  const seeds: ChildEnvResolution['seeds'] = {};
  const chatgptGone: string[] = [];
  // LiteLLM still needs PATH for executable lookup; no other parent values are forwarded.
  const childEnv: NodeJS.ProcessEnv = process.env.PATH ? { PATH: process.env.PATH } : {};

  // Each store read at most once per build, tagged with which store it is.
  const reads = new Map<string, ChainStore>();
  const read = (id: string, how: () => StoreRead): ChainStore => {
    const cached = reads.get(id);
    if (cached !== undefined) return cached;
    const fresh = { ...how(), id };
    reads.set(id, fresh);
    return fresh;
  };
  // A store `boundUnreadable` has stopped treating as mid-write
  // reads as absent here, and every credential reader already skips it, so
  // the lookup falls through to the next store exactly as it would for a
  // store that is not there.
  const keysStore = () => read('keys', () => fileRead(sonataKeyStorePath(home)));
  const codexStore = () => read('codex', () => fileRead(codexAuthPath(home)));
  const opencodeStores = () => [
    read('opencode.db', () => {
      const raw = opencodeDbRead(home, memory.opencodeDb);
      return bounded ? boundUnreadableDb(opencodeDbPath(home), raw, memory.unreadable, clock(), opts.warn) : raw;
    }),
    read('opencode', () => fileRead(opencodeAuthPath(home))),
  ];
  /** opencode's stores an entry's answer depends on: the table alone when it answered, since it wins over auth.json. */
  const opencodeChain = (integration: string): ChainStore[] => {
    const [db, file] = opencodeStores();
    return opencodeCredentialOrigin(home, integration) === 'opencode.db' ? [db] : [db, file];
  };

  const live = new Set<string>();
  /**
   * The entries one lineage resolves to this build: the last good ones when
   * a store in `chain` could not be read, else `resolved`; nothing when there
   * is neither — refused for now when a store could not be read (whatever a
   * later store answered), else reported with `missing` (a gateway that needs
   * no credential passes none).
   *
   * `chain` is the stores the lookup consulted, in order, ending at the one
   * that answered when `resolved` is set; that last store is recorded as the
   * source of the entries kept.
   */
  const settle = (
    name: string,
    lineage: string,
    resolved: Record<string, string> | undefined,
    chain: ChainStore[],
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
    if (unreadable !== undefined && resolved === undefined && missing === undefined) {
      // A lookup that requires no credential (the automatic key lookup: a
      // default-sourced api-key gateway is forwarded keyless, an OAuth one
      // resolves through its own chain) found nothing. An unreadable store
      // is then transient, not a refusal: refusing pulled the gateway's
      // models out of LiteLLM for the length of one write to keys.json.
      transient.push({
        gateway: name,
        message: `gateway "${name}": its key store could not be read (${unreadable.detail}) — it needs no key, ` +
          'so it is served without one; read again on the next request',
      });
      return undefined;
    }
    if (unreadable !== undefined) {
      // Nothing to keep: an answer found past a store that could not be read
      // may be another store's account, and none at all may be a torn read.
      // Neither is served; the next request reads again.
      failures.push({
        gateway: name,
        unreadable: true,
        message: `gateway "${name}": its credential store could not be read (${unreadable.detail}) and it has ` +
          'not resolved before — not serving it while the store may be mid-write, rather than use whatever a ' +
          `later store holds; retried on the next request, and skipped as absent ${UNREADABLE_SKIP_RULE}`,
      });
      return undefined;
    }
    // A store skipped for staying unreadable reads as absent, and resolution
    // goes on from the stores that remain — with one exception: when it is
    // the store this lineage's last credential came from. That store not
    // reading is not a logout — it says nothing about the login it holds —
    // so the lineage keeps what it resolved to and does not end, and the file
    // reading again restarts and re-seeds nothing. A skipped store the
    // credential did NOT come from says nothing about that credential either:
    // keeping it there pinned a key rotated or removed in the store that
    // actually holds it.
    const source = memory.lastGoodSource.get(lineage);
    const skipped = chain.find((store) => store.skipped !== undefined && store.id === source);
    if (skipped !== undefined && last !== undefined) {
      transient.push({
        gateway: name,
        message: `gateway "${name}": its credential store is skipped as unreadable (${skipped.skipped}) — ` +
          'keeping the credential it last resolved to',
      });
      return last;
    }
    if (resolved !== undefined) {
      memory.lastGood.set(lineage, resolved);
      const answeredBy = chain.at(-1);
      if (answeredBy === undefined) memory.lastGoodSource.delete(lineage);
      else memory.lastGoodSource.set(lineage, answeredBy.id);
      return resolved;
    }
    if (last !== undefined && chain.some((store) => store.emptied === true)) {
      // opencode.db's table read empty twice where it last held rows: a
      // logout, or a gap. Refused now; kept, so nothing restarts for it, until
      // a later read — which then has no `emptied` — says which.
      failures.push({
        gateway: name,
        tentative: true,
        message: `gateway "${name}": opencode's credential table has just read empty — not serving it until ` +
          'the next read confirms a logout or finds the login again; retried on the next request',
      });
      return last;
    }
    memory.lastGood.delete(lineage);
    memory.lastGoodSource.delete(lineage);
    memory.seeds.delete(lineage);
    if (missing !== undefined) failures.push({ gateway: name, message: missing });
    return undefined;
  };

  // The stores a key lookup's answer depends on: the one that answered and
  // every store searched before it, or all of them when none answered.
  const keyChain = (answeredBy: string | undefined, order: ('sonata' | 'opencode')[]): ChainStore[] => {
    const chain: ChainStore[] = [];
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
      const store = { ...fileStoreRead(join(dir, 'auth.json')), id: join(dir, 'auth.json') };
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
        : source === 'opencode' ? opencodeChain('openai')
          : found?.identity === 'codex store' ? [codexStore()] : [codexStore(), ...opencodeChain('openai')];
      const fresh = found === null ? undefined : { CHATGPT_TOKEN_DIR: chatgptTokenDir };
      const entries = settle(
        name, lineage, fresh, chain,
        `gateway "${name}" uses codex-oauth but no ChatGPT credential was found ` +
          `in ${codexAuthPath(home)} or ${opencodeAuthPath(home)} — ` +
          `run \`sonata auth login ${name}\`, or \`codex login\`.`,
      );
      if (entries === undefined) {
        // Gone means positively holding no login: a store that could not be
        // read, or was skipped for staying unreadable, says nothing either way.
        const answered = (stores: StoreRead[]) =>
          stores.every((store) => store.state !== 'unreadable' && store.skipped === undefined);
        if (source !== 'opencode' && answered([codexStore()])) chatgptGone.push('codex store');
        if (source !== 'codex' && answered(opencodeChain('openai'))) chatgptGone.push('opencode store');
      }
      if (entries !== undefined) {
        if (entries === fresh && found !== null) {
          memory.seeds.set(lineage, {
            gateway: name,
            record: found.record,
            lineage: { identity: found.identity, account: chatgptAccountId(found.record) },
          });
        }
        const seed = memory.seeds.get(lineage);
        if (seed !== undefined && typeof seed !== 'string') seeds.chatgpt = seed;
        // Whatever directory the kept entries named, a child is pointed at
        // the one serve says it uses.
        Object.assign(childEnv, entries, { CHATGPT_TOKEN_DIR: chatgptTokenDir });
      }
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
      const store = { ...fileStoreRead(join(dir, 'api-key.json')), id: join(dir, 'api-key.json') };
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
        name, lineage, fresh, opencodeChain('github-copilot'),
        `gateway "${name}" uses copilot-oauth but no Copilot login was found ` +
          `in ${opencodeAuthPath(home)} — run \`sonata auth login ${name}\`, ` +
          'or `opencode auth login` and choose github-copilot.',
      );
      if (entries !== undefined) {
        if (entries === fresh && token !== null) memory.seeds.set(lineage, token);
        const seed = memory.seeds.get(lineage);
        if (typeof seed === 'string') seeds.copilot = seed;
        Object.assign(childEnv, entries);
      }
    }
  }

  for (const lineage of [...memory.lastGood.keys()]) {
    if (!live.has(lineage)) memory.lastGood.delete(lineage);
  }
  for (const lineage of [...memory.lastGoodSource.keys()]) {
    if (!live.has(lineage)) memory.lastGoodSource.delete(lineage);
  }
  for (const lineage of [...memory.seeds.keys()]) {
    if (!live.has(lineage)) memory.seeds.delete(lineage);
  }
  return { env: childEnv, failures, transient, seeds, chatgptGone };
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
  identity: (name: string, gateway: { auth?: string; credentialSource?: string }) => string | undefined,
): { auth: string; names: string[]; why: string }[] {
  const byKind = new Map<string, typeof entries>();
  for (const entry of entries) {
    const auth = entry.gateway.auth;
    if (auth !== 'codex-oauth' && auth !== 'copilot-oauth') continue;
    byKind.set(auth, [...(byKind.get(auth) ?? []), entry]);
  }
  const out: { auth: string; names: string[]; why: string }[] = [];
  for (const [auth, group] of byKind) {
    // An identity that cannot be told just now is no evidence of a conflict:
    // its gateway is refused on its own until its store reads, rather than
    // taking every other gateway of its kind down with a guess.
    const ids = group.map((entry) => identity(entry.name, entry.gateway));
    if (new Set(ids.filter((id) => id !== undefined)).size <= 1) continue;
    const listed = group.map((entry, k) => `"${entry.name}" (${entry.owner}, ${ids[k] ?? 'unreadable'})`).join(', ');
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
  /**
   * Which credential a gateway is served from; serve passes
   * `resolvedOauthIdentity`, or undefined when that cannot be told just now.
   */
  identity: (name: string, gateway: { auth?: string; credentialSource?: string }) => string | undefined =
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

/**
 * A file as a stat-only token: its identity, mtime, size and mode, or `-`
 * when absent. The mode is there because `chmod` moves no mtime: a store
 * made unreadable (EACCES) or readable again otherwise changed nothing the
 * plan fingerprint could see, and was never re-read.
 */
function statSignal(path: string): string {
  try {
    const { ino, mtimeMs, size, mode } = statSync(path);
    return `${ino}:${mtimeMs}:${size}:${mode}`;
  } catch {
    return '-';
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
  const clock = opts.now ?? Date.now;
  /** The gateways the last merge kept — what a LiteLLM child is serving. */
  let lastMergedGateways: NativeConfig['gateways'] = {};
  /**
   * Set when LiteLLM's ChatGPT login has been refused — its own output said
   * so (`LITELLM_CHATGPT_LOGIN_REFUSED`), or a response did (the router's
   * backstop) — to the 502 every codex-oauth gateway is answered with.
   * LiteLLM has one ChatGPT token directory, so every such gateway is served
   * from it. Without this, each request hung in LiteLLM's device-code login
   * for up to fifteen minutes.
   *
   * `dir` is the directory the refused child was serving, and `token` the
   * token that was refused there (`chatgptTokenHash`: the refresh token in
   * its `auth.json`, else its access token), read at mark time. That read
   * can land mid-write and find none; it is retried at later checks for
   * `REFUSED_TOKEN_CAPTURE_MS` only (`refusedToken`), then never.
   *
   * A deliberate spawn clears it when it starts LiteLLM on a different
   * directory — a new login, seeded fresh — whether or not a token was
   * captured; or on the same directory when that holds a readable token
   * that differs from the captured one — a sonata-owned re-login. Any other
   * restart — a model-list edit, another project's gateway, a spawn with no
   * ChatGPT gateway at all, the same directory with no token captured —
   * keeps it: LiteLLM may start on the same refused token, and clearing then
   * served a device-code hang again. Keyed on the token and not the file's
   * stat, LiteLLM's own rewrite of `auth.json` (`device_code_requested_at`)
   * does not clear it. A fresh process (`sonata restart`) starts with none.
   */
  let chatgptLoginRefused: {
    message: string; dir: string | undefined; token: string | undefined; markedAt: number;
  } | undefined;
  /** The refused token: read at mark time, and again only within `REFUSED_TOKEN_CAPTURE_MS` of it. */
  const refusedToken = (): string | undefined => {
    const refused = chatgptLoginRefused;
    if (refused === undefined) return undefined;
    if (refused.token === undefined && clock() - refused.markedAt <= REFUSED_TOKEN_CAPTURE_MS) {
      refused.token = chatgptTokenHash(refused.dir);
    }
    return refused.token;
  };
  /** The ChatGPT token directory the current child was spawned into; set once the child bookkeeping exists. */
  let currentChatgptTokenDir: () => string | undefined = () => undefined;
  /**
   * Marks the refusal of the child serving `served` — the token directory it
   * was spawned into. One that is no longer the current child's is from a
   * LiteLLM a new login has since replaced: a response forwarded before the
   * restart and answered after it says nothing about the new one.
   *
   * The mark records the current child's directory. Undefined only when no
   * directory is known at all — then no spawn clears it (see
   * `spawnLitellmChild`) and it stays until `sonata restart`.
   */
  const markChatgptLoginRefused = (served: string | undefined): void => {
    if (chatgptLoginRefused !== undefined) return;
    const current = currentChatgptTokenDir();
    if (served !== current) {
      console.error('sonata serve: ignoring a ChatGPT login refusal from a LiteLLM that has since been replaced');
      return;
    }
    const affected = Object.entries(lastMergedGateways).filter(([, gateway]) => gateway.auth === 'codex-oauth');
    if (affected.length === 0) return;
    const names = affected.map(([name]) => `"${name}"`).join(', ');
    const sonataOwned = affected.filter(([, gateway]) => gateway.credentialSource === 'sonata').map(([name]) => name);
    const relogin = sonataOwned.length > 0
      ? sonataOwned.map((name) => `\`sonata auth login ${name}\``).join(' / ')
      : '`codex login` (or `opencode auth login`)';
    const remedy = `LiteLLM's ChatGPT login was refused by OpenAI — run ${relogin} and then \`sonata restart\``;
    chatgptLoginRefused = {
      message: `gateway ${names}: ${remedy} (LiteLLM had fallen back to an interactive device-code ` +
        'login, which would hold each request for up to fifteen minutes)',
      dir: current,
      token: chatgptTokenHash(current),
      markedAt: clock(),
    };
    console.error(`sonata serve: ${remedy} — affects gateway ${names}`);
  };
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
  /** A credential store skipped for staying unreadable, reported once per stretch by `boundUnreadable`. */
  const warnSkipped = (line: string): void => { console.error(`sonata serve: ${line}`); };
  /**
   * The store each default-sourced ChatGPT gateway was last seen to read.
   * `resolvedOauthIdentity` answers "opencode" whenever codex's file does not
   * read as a login — torn mid-write included — and a conflict drop decided
   * on that would take the gateway away for the length of one write. While
   * codex's file cannot be read, the last answer stands; with none, the
   * identity is unknown, which conflicts with nothing (the gateway itself is
   * refused by `resolveChildEnv` until codex's file reads).
   */
  const lastOauthIdentity = new Map<string, string>();
  const mergeGateways = (
    log: (line: string) => void,
    loaded: ReturnType<TenantRegistry['loadable']> = registry.loadable(),
  ): NativeConfig['gateways'] => withReadSnapshot(() => {
    const dropped = new Map<string, string>();
    const unknown = new Set<string>();
    const gateways = mergeTenantGateways(
      loaded.map(({ id, config }) => ({ id, gateways: config.native?.gateways ?? {} })),
      log,
      (name, gateway) => {
        const lineage = lineageKey(name, gateway);
        if (gateway.auth === 'codex-oauth' && gateway.credentialSource === undefined) {
          const codex = boundUnreadable(codexAuthPath(opts.home), jsonStoreRead(codexAuthPath(opts.home)),
            credentialMemory.unreadable, clock(), warnSkipped);
          const held = lastOauthIdentity.get(lineage);
          if (codex.state === 'unreadable') {
            if (held === undefined) unknown.add(name);
            return held;
          }
          // Skipped for staying unreadable: a gateway that was reading codex's
          // login keeps it; any other falls through, codex's file reading as
          // absent — the same rule `resolveChildEnv` settles credentials by.
          if (codex.skipped !== undefined && held === 'codex store') return held;
        }
        const identity = resolvedOauthIdentity(opts.home, name, gateway);
        lastOauthIdentity.set(lineage, identity);
        return identity;
      },
      dropped,
    );
    // Served whichever ChatGPT login LiteLLM holds, a gateway whose own login
    // cannot be told yet could be handed another store's account: refused
    // until codex's file reads, which moves the plan fingerprint and re-merges.
    for (const name of unknown) {
      if (!Object.hasOwn(gateways, name)) continue;
      delete gateways[name];
      dropped.set(name, `gateway "${name}": ${codexAuthPath(opts.home)} could not be read (a write in progress?) ` +
        'and it has not resolved before, so which ChatGPT login it reads cannot be told — not serving it ' +
        `while that file may be mid-write; retried on the next request, and skipped as absent ${UNREADABLE_SKIP_RULE}`);
    }
    droppedGateways = dropped;
    lastMergedGateways = gateways;
    return gateways;
  });
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
  const servableTenants = (loaded: ReturnType<TenantRegistry['loadable']> = registry.loadable()) => {
    mergeGateways(() => { /* logged by mergedNative */ }, loaded);
    const dropped = droppedGateways;
    const unresolved = litellmCredentialFailures;
    return loaded.map((tenant) => {
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
   * opencode.db's credential rows as a hash, re-read only when the database
   * or its WAL changes on disk. The file is written constantly, so its stat
   * alone would re-merge on nearly every request; the rows are what decide
   * whether anything a gateway reads has changed. A read that fails keeps the
   * last stamp and is retried on the next change, so a moment's lock is not
   * a login changing. The database's ctime is part of the signal too: a
   * `chmod`, `chown` or ACL change moves no rows (and an ACL change not even
   * the mode), so without it a database made unreadable (or readable again)
   * was never re-read. ctime also moves when opencode writes the main file
   * (a checkpoint, in WAL mode), which costs a re-merge and nothing more:
   * LiteLLM restarts only when a credential a gateway reads has changed.
   */
  let opencodeDbStamp: { stat: string; stamp: string } | undefined;
  const opencodeDbSignal = (): string => {
    const path = opencodeDbPath(opts.home);
    const stat = `${statSignal(path)}|${statSignal(`${path}-wal`)}`;
    let ctime = '-';
    try { ctime = String(statSync(path).ctimeMs); } catch { /* absent: no ctime */ }
    if (opencodeDbStamp?.stat !== stat) {
      const stamp = opencodeCredentialStamp(opts.home);
      if (stamp !== 'unreadable') opencodeDbStamp = { stat, stamp };
      else return `${ctime}:${opencodeDbStamp?.stamp ?? stamp}`;
    }
    return `${ctime}:${opencodeDbStamp.stamp}`;
  };
  /**
   * What the gateway merge depends on, as a cheap comparable string: the
   * known configs, and every credential store a gateway reads — codex's
   * `auth.json` (which `resolvedOauthIdentity` also consults for a
   * default-sourced ChatGPT gateway, so `codex login`/`logout` while serving
   * changes the answer), sonata's `keys.json`, and opencode's `auth.json` and
   * credential table. A login or `sonata auth add`/`remove` while serving
   * moves it, and the re-merge — under the last-good and lineage rules —
   * decides whether anything a gateway reads actually changed. Stat-only but
   * for the table's rows, which are read only when the database changes.
   */
  const gatewayPlanInputs = (): string => [
    registry.fingerprint(),
    `codex:${statSignal(codexAuthPath(opts.home))}`,
    `keys:${statSignal(sonataKeyStorePath(opts.home))}`,
    `opencode:${statSignal(opencodeAuthPath(opts.home))}`,
    `opencode.db:${opencodeDbSignal()}`,
  ].join('\n');
  /**
   * Whether anything LiteLLM would be given needs it: asked of the servable
   * tenants, after drops and credential failures, not of the configs. Asked
   * of the configs, a union whose only LiteLLM gateway was left out started
   * a child with an empty model list, at startup and on the lazy path alike.
   */
  const unionNeedsLitellm = (): boolean => servableTenants().some(({ config }) => litellmRequired(config));

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
  /**
   * Every child whose exit has been observed, however it came about. A
   * restart of a child already in here skips its bounded wait, and stopping
   * skips signalling it: that exit will not fire again, and waiting on it
   * gave a crash respawn time to spawn a second child beside the restart's.
   */
  const exitObserved = new WeakSet<SpawnedLitellm>();
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
      for (const { gateway, message, tentative } of failures) {
        const gw = cfg.gateways[gateway];
        if (gw === undefined) continue;
        all.set(gateway, message);
        // A tentative failure keeps its models in LiteLLM's config: the
        // router refuses them, and a gap that closes restarts nothing.
        if (transportFor(gw, gateway) !== 'direct' && tentative !== true) litellm.add(gateway);
      }
      credentialFailures = all;
      litellmCredentialFailures = litellm;
    };

    // Startup fails outright only for the machine config's own gateways — the
    // config it is loading. Any other tenant's missing credential leaves that
    // gateway out, exactly as a re-merge does: a registered session in an
    // unrelated project must not stop the router from starting at all.
    /**
     * The ChatGPT token directory the LiteLLM child was last spawned into, and
     * whose login it was seeded with.
     *
     * LiteLLM is the only writer of that directory while it runs: it refreshes
     * `auth.json` in place (`open("w")`, not a rename) and ChatGPT rotates
     * refresh tokens, so every rule for sonata deciding which of two copies
     * wins has had a case where it put back a refresh token already spent
     * (`refresh_token_reused`) or wrote over a half-written file. So sonata
     * writes a token only into a directory it has just created, empty, for a
     * spawn. A crash respawn reuses the directory as it is, since LiteLLM's
     * latest token is there; so does a restart for anything else. Only a
     * different login in the store — another store, or another account where
     * both sides name one (`chatgptLineageChanged`) — or a login returning
     * after positively going away (`ended`) seeds a new directory, and that
     * is itself a reason to restart: `litellmPlanSnapshot` carries the
     * generation the next spawn would seed.
     */
    let chatgptSeeded: { gateway: string; dir: string; lineage: ChatGptLineage; generation: number; ended?: true } | undefined;
    // `gateway` is only the name for messages: every decision is keyed on the
    // login — `lineage` (store and account) — so a renamed gateway reading the
    // same login still sees its logout and its return.
    /** The OAuth tokens the latest child-env build read; see `ChildEnvResolution.seeds`. */
    let seeds: ChildEnvResolution['seeds'] = {};
    const chatgptDirFor = (generation: number): string =>
      join(tempDir, generation <= 1 ? 'chatgpt' : `chatgpt-${generation}`);
    /** Whether the next deliberate spawn seeds a new ChatGPT token directory, and why; undefined when it reuses the one it has. */
    const chatgptReseed = (): { why?: string } | undefined => {
      const store = seeds.chatgpt;
      if (store === undefined) return undefined;
      const held = chatgptSeeded;
      if (held === undefined) return {};
      const name = `gateway "${store.gateway}"`;
      if (held.ended === true) return { why: `${name}: logged in again — restarting litellm with the new login` };
      if (held.lineage.identity !== store.lineage.identity) {
        return {
          why: `${name}: credential source changed (${held.lineage.identity} → ${store.lineage.identity}) — ` +
            'restarting litellm with the new login',
        };
      }
      if (chatgptLineageChanged(held.lineage, store.lineage)) {
        return { why: `${name}: account changed — restarting litellm with the new login` };
      }
      return undefined;
    };
    /**
     * Every child-env build goes through this: the env names the token
     * directory the current child uses, and the build's seeds are kept for
     * the next deliberate spawn.
     */
    const buildChildEnv = (cfg: NativeConfig): ChildEnvResolution => {
      const built = resolveChildEnv(cfg, opts.home, tempDir, {
        memory: credentialMemory,
        chatgptTokenDir: chatgptSeeded?.dir ?? chatgptDirFor(1),
        now: clock,
        warn: warnSkipped,
      });
      seeds = built.seeds;
      const held = chatgptSeeded;
      const store = built.seeds.chatgpt;
      if (held !== undefined && held.ended === undefined) {
        if (built.chatgptGone.includes(held.lineage.identity)) {
          // The store the seeded login came from positively holds none —
          // `codex logout`, a removed row, opencode.db still empty on a
          // second build — rather than unreadable for a moment or empty for
          // one read: whatever login comes back there is a new one.
          held.ended = true;
        } else if (store !== undefined && !chatgptLineageChanged(held.lineage, store.lineage)) {
          // Unknown to known is not a switch; learning the account now lets a
          // later switch away from it be seen.
          if (held.lineage.account === undefined && store.lineage.account !== undefined) {
            held.lineage = { ...held.lineage, account: store.lineage.account };
          }
          held.gateway = store.gateway;
        }
      }
      return built;
    };

    const tornAtStart = credentialMemory.unreadable.torn;
    // The merge and the build read the stores once, together (`withReadSnapshot`).
    const { startupNative, startup } = withReadSnapshot(() => {
      const native = mergedNative();
      return { startupNative: native, startup: buildChildEnv(native) };
    });
    /** Whether a store read as mid-write since `before` — a build that must be retried, never committed. */
    const readTorn = (before: number): boolean => credentialMemory.unreadable.torn !== before;
    const startupTorn = readTorn(tornAtStart);
    const machineGateways = machineConfig()?.native?.gateways ?? {};
    const fatal = startup.failures.find(({ gateway, unreadable }) =>
      unreadable === undefined && Object.hasOwn(machineGateways, gateway));
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
     * compared too, as they always were. It merges again (`servableTenants`),
     * in a read snapshot of its own rather than the build's.
     */
    const litellmPlanSnapshot = (): string => {
      // Every tenant config is parsed per `loadable()`, so once here, not
      // once for each of the three things read off it.
      const loaded = registry.loadable();
      const tenants = servableTenants(loaded);
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
        // A seeded ChatGPT directory is named by the generation a spawn would
        // use: its path changes only when its login does, and that is exactly
        // when LiteLLM has to restart to be given it.
        if (name === 'CHATGPT_TOKEN_DIR' && seeds.chatgpt !== undefined) {
          const generation = chatgptReseed() === undefined
            ? chatgptSeeded?.generation ?? 1
            : (chatgptSeeded?.generation ?? 0) + 1;
          return `${name}=seed-${generation}`;
        }
        const value = childEnv[name];
        return `${name}=${value === undefined ? '-' : createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
      });
      return `${registry.unionSnapshot(loaded)}\n${JSON.stringify(litellmConfigForTenants(tenants, ''))}\n${env.join(',')}`;
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
    // The fingerprint is committed only once the rebuild resolves every
    // credential. One that failed — a gateway whose credential is not stored
    // yet — is retried on the next request, which is also what picks up a
    // later `sonata auth login`: that writes a login directory no fingerprint
    // watches. The startup build is held to the same rule; committed
    // regardless, a credential missing at startup was never retried unless a
    // config or a watched store happened to change.
    const startupInputs = gatewayPlanInputs();
    const startupSettled = startup.failures.length === 0 && startup.transient.length === 0 && !startupTorn;
    let planFingerprint: string | undefined = startupSettled ? startupInputs : undefined;
    /** The fingerprint whose rebuild last failed; a retry of it merges quietly, since its drops were already logged. */
    let failedFingerprint: string | undefined = startupSettled ? undefined : startupInputs;
    const refreshGatewayPlan = (): void => {
      const now = gatewayPlanInputs();
      if (now === planFingerprint) return;
      const tornBefore = credentialMemory.unreadable.torn;
      const { cfg, built } = withReadSnapshot(() => {
        const merged = now === failedFingerprint ? mergedNative(() => { /* logged by the first attempt */ }) : mergedNative();
        return { cfg: merged, built: buildChildEnv(merged) };
      });
      // Writes nothing: a token directory belongs to the running child. A
      // store whose login has changed is read here, and the plan snapshot the
      // next model-change check compares then carries the new seed
      // generation, so that check restarts LiteLLM into a fresh directory.
      //
      // Per gateway: a failing gateway is left out of the new env and every
      // other one keeps its key. Replaced rather than mutated: `childEnv` is
      // also the environment a LiteLLM child was spawned with. A failing
      // DIRECT gateway's key is therefore absent, not carried over — it is
      // looked up by name, so a project that has just taken over a name
      // another project dropped would otherwise be sent that project's key.
      // With no key it is recorded as failed, and its request is answered
      // with a 502 naming the missing credential without being forwarded.
      const { env, failures, transient } = built;
      childEnv = env;
      applyCredentialFailures(failures, cfg);
      reportCredentialFailures([...failures, ...transient]);
      refreshGatewayKeys(cfg);
      // A store that could not be read is retried on the next request too,
      // so its recovery — or a login written meanwhile — is not missed. So is
      // one read as mid-write anywhere in the merge (a default ChatGPT
      // gateway's identity included, which is a drop and not a failure):
      // nothing on disk may change when its window lapses, so a committed
      // fingerprint would keep the refusal forever.
      if (failures.length > 0 || transient.length > 0 || readTorn(tornBefore)) {
        failedFingerprint = now;
        // And the last committed fingerprint is forgotten: inputs that return
        // to it — opencode.db's rows are hashed, not stat'd, so a row removed
        // and restored reads identical — must still rebuild, or the refusal
        // this build recorded would stand with nothing left to clear it.
        planFingerprint = undefined;
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
    /** The ChatGPT token directory each child was spawned into. */
    const childTokenDir = new Map<SpawnedLitellm, string | undefined>();
    /**
     * Token directories no future spawn will use, removed only once no child
     * spawned into one can still be running: a LiteLLM whose directory is
     * pulled out from under it answers every request with a device-code login.
     */
    const retiredTokenDirs = new Set<string>();
    const sweepRetiredTokenDirs = (): void => {
      for (const dir of retiredTokenDirs) {
        const inUse = [...childTokenDir].some(([spawned, used]) => used === dir && !exitObserved.has(spawned));
        if (inUse) continue;
        rmSync(dir, { recursive: true, force: true });
        retiredTokenDirs.delete(dir);
      }
      // Never the current child's entry, even once it has exited: until the
      // respawn replaces it, a crashed child is still the one a refusal —
      // buffered stdout delivered after its exit, or a response it gave — is
      // attributed to, and without its entry that refusal marked no directory.
      for (const [spawned] of childTokenDir) {
        if (exitObserved.has(spawned) && spawned !== child) childTokenDir.delete(spawned);
      }
    };
    currentChatgptTokenDir = () => (child === undefined ? undefined : childTokenDir.get(child));
    /**
     * A crash respawn waiting out its delay. A deliberate restart that goes
     * ahead cancels it — the restart spawns the replacement — and one still
     * waiting when a model-change check is in flight waits for that check,
     * so the two never spawn side by side.
     */
    let pendingCrashRespawn: { cancel: () => void } | undefined;

    /**
     * Before a deliberate spawn — never a crash respawn — seeds the OAuth
     * token directories that spawn will own. The ChatGPT one is new and
     * empty when `chatgptReseed` says the login changed, and otherwise the
     * directory the previous child left, untouched. The previous directory
     * is retired, and removed once every child spawned into it has been seen
     * to exit — normally already, since a restart waits for the old child,
     * but a child that outlived its SIGKILL keeps its directory until it goes.
     */
    const seedTokenDirs = (): void => {
      const store = seeds.chatgpt;
      if (store !== undefined && chatgptReseed() !== undefined) {
        const generation = (chatgptSeeded?.generation ?? 0) + 1;
        const dir = chatgptDirFor(generation);
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        writeFileSync(join(dir, 'auth.json'), JSON.stringify(store.record), { mode: 0o600, flag: 'wx' });
        const previous = chatgptSeeded?.dir;
        chatgptSeeded = { gateway: store.gateway, dir, lineage: store.lineage, generation };
        if (previous !== undefined && previous !== dir) {
          retiredTokenDirs.add(previous);
          sweepRetiredTokenDirs();
        }
      }
      if (store !== undefined && chatgptSeeded !== undefined && childEnv.CHATGPT_TOKEN_DIR !== undefined) {
        childEnv = { ...childEnv, CHATGPT_TOKEN_DIR: chatgptSeeded.dir };
      }
      const copilotDir = join(tempDir, 'copilot');
      if (seeds.copilot !== undefined && childEnv.GITHUB_COPILOT_TOKEN_DIR === copilotDir) {
        mkdirSync(copilotDir, { recursive: true, mode: 0o700 });
        writeFileSync(join(copilotDir, 'access-token'), seeds.copilot, { mode: 0o600 });
      }
    };

    const spawnLitellmChild = (deliberate = true): SpawnedLitellm => {
      if (deliberate) {
        // The last chance to capture the refused token, if still in its window.
        refusedToken();
        seedTokenDirs();
        // Cleared when this spawn starts LiteLLM on another directory — a new
        // login, seeded fresh — or on the refused one holding a readable token
        // that is not the refused one. No directory at all (no ChatGPT gateway
        // just now), an unreadable file, or no refused token captured says
        // nothing about the token LiteLLM will use, and keeps it. So does a
        // mark that knows no directory: no spawn's directory can be told apart
        // from it, and it stays until `sonata restart`.
        const refused = chatgptLoginRefused;
        const dir = childEnv.CHATGPT_TOKEN_DIR;
        if (refused !== undefined && refused.dir !== undefined && dir !== undefined) {
          const token = dir === refused.dir && refused.token !== undefined ? chatgptTokenHash(dir) : undefined;
          if (dir !== refused.dir || (token !== undefined && token !== refused.token)) chatgptLoginRefused = undefined;
        }
      }
      const spawned = (opts.spawnLitellm ?? defaultSpawnLitellm)(
        configPath, childEnv, ports.litellm, litellmBin,
      );
      spawned.onOutputLine?.((line) => {
        // Only the child serving now: an old one's last words during a
        // restart say nothing about its replacement.
        if (child === spawned && LITELLM_CHATGPT_LOGIN_REFUSED.test(line)) markChatgptLoginRefused(childTokenDir.get(spawned));
      });
      recordLitellmPid(opts.home, ports.router, spawned.pid);
      childTokenDir.set(spawned, childEnv.CHATGPT_TOKEN_DIR);
      spawned.onExit?.((code, signal) => {
        exitObserved.add(spawned);
        if (stopping) return;
        sweepRetiredTokenDirs();
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
        let cancelled = false;
        let wake: () => void = () => {};
        const woken = new Promise<void>((resolve) => { wake = resolve; });
        const pending = { cancel: () => { cancelled = true; wake(); } };
        pendingCrashRespawn?.cancel();
        pendingCrashRespawn = pending;
        litellmReady = (async () => {
          await Promise.race([sleep(respawnDelayMs), woken]);
          // A model-change check in flight may restart LiteLLM itself; wait
          // for it rather than spawn beside it, then respawn only if nothing
          // has replaced the crashed child meanwhile.
          while (!cancelled && !stopping && restartInFlight !== undefined) {
            await restartInFlight.catch(() => { /* reported by its own caller */ });
          }
          if (pendingCrashRespawn === pending) pendingCrashRespawn = undefined;
          if (stopping || cancelled || child !== spawned) return;
          console.error('sonata serve: respawning litellm...');
          // Into the directory the crashed child used: its latest token is there.
          child = spawnLitellmChild(false);
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
      const { cfg, built } = withReadSnapshot(() => {
        const merged = mergedNative();
        return { cfg: merged, built: buildChildEnv(merged) };
      });
      const { env, failures, transient } = built;
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
        console.error(`sonata serve: ${chatgptReseed()?.why ?? 'model registry changed — restarting litellm to pick it up...'}`);
        // This restart spawns the replacement, so a crash respawn still
        // waiting out its delay is superseded rather than raced.
        pendingCrashRespawn?.cancel();
        pendingCrashRespawn = undefined;
        const oldChild = child;
        // A child that has already exited — crashed, awaiting a respawn this
        // restart has just cancelled — is neither signalled nor waited on.
        const alreadyExited = exitObserved.has(oldChild);
        if (!alreadyExited) expectedRestartChild = oldChild;
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
            if (alreadyExited) resolve();
            else if (oldChild?.onExit) oldChild.onExit(() => resolve());
            else {
              // No exit to observe: the kill below is all there is to go on.
              exitObserved.add(oldChild);
              resolve();
            }
          });
          const exitTimeoutMs = opts.litellmExitTimeoutMs ?? LITELLM_EXIT_TIMEOUT_MS;
          if (!alreadyExited && await raceTimeout(exited, exitTimeoutMs, sleep)) {
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
        if (!alreadyExited) oldChild.kill();
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
    const decisionClassifiers = new Map<string, TierClassifier>();
    const modelLists = new ModelListCache(fetch);
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
      // Built per project setting, since [auto_route] is per project and one
      // router serves them all. With no key it throws per call and the router
      // falls back, which is the documented off-by-default-key behaviour.
      // One classifier per URL + pin; the model is chosen per call from the
      // URL's listed decision models and the cached JevBench scores, so a
      // `sonata catalog update` or a new model at the URL needs no restart.
      classifierFor: (settings) => {
        const id = `${settings.baseUrl}|${settings.model ?? ''}`;
        let classifier = decisionClassifiers.get(id);
        if (classifier === undefined) {
          const credential = () => decisionKeyFor(settings.baseUrl, {
            openrouter: () => resolveKeys(['openrouter'], opts.home)[0]?.key,
            typesafe: () => resolveKeyFromSource('typesafe', opts.home, 'sonata'),
            other: () => resolveKeyFromSource('auto-route', opts.home, 'sonata'),
          });
          classifier = decisionClassifier(settings, {
            fetch,
            key: () => credential().key,
            keyHint: credential().hint,
            model: async () => settings.model ?? chooseDecisionModel({
              baseUrl: settings.baseUrl,
              listed: await modelLists.list(settings.baseUrl, credential().key),
              catalog: loadDecisionCatalog(opts.home),
            }).model,
          });
          decisionClassifiers.set(id, classifier);
        }
        return classifier;
      },
      resolveGateway: (key, tenant) => tenant.config?.unifiedModels[key]?.gateway,
      gatewayUnavailable: (tenant, gateway) => droppedGateways.get(gateway) ?? credentialFailures.get(gateway) ??
        (chatgptLoginRefused !== undefined && tenant.config?.native?.gateways[gateway]?.auth === 'codex-oauth'
          ? (refusedToken(), chatgptLoginRefused.message) : undefined),
      chatgptTokenDir: () => currentChatgptTokenDir(),
      chatgptLoginRefused: (served) => markChatgptLoginRefused(served),
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
      if (child !== undefined && !exitObserved.has(child)) {
        await terminateLitellm(child, opts.litellmExitTimeoutMs ?? LITELLM_EXIT_TIMEOUT_MS, sleep);
      }
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
