/**
 * `sonata route <on|off|status|auto|manual>` — route a plain `claude` session in
 * the project through the native router.
 *
 * `sonata code` routes one session by spawning `claude` with env vars on the
 * process. `sonata route on` writes those same env vars into the project's
 * `.claude/settings.local.json`, so *every* plain `claude` launched in the
 * directory (from an editor integration, a `.mcp.json` entry, a shell alias)
 * is routed too — no wrapper needed. The env vars come from `nativeSessionEnv`
 * in code.ts, so the two session paths cannot drift.
 *
 * A SessionStart hook (`hooks/ensure-serve.mjs`) makes the router come up like
 * `sonata code` does: `claude` alone has nothing of sonata running to start the
 * daemon, and the first thing an unrouted session would do is cache the error
 * from a router that is not there.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

import { readSettings, writeSettings, installHook, uninstallHook, hookInstalled } from '../settings.js';
import type { Settings } from '../settings.js';
import { configPath as resolveSonataConfigPath, loadConfig, GLOBAL_CONFIG_RELATIVE, parseConfig, type SonataConfig } from '../config.js';
import { nativeSessionEnv } from './code.js';
import { isSonataRouter, sonataRouterConfigPath, startServeDaemon } from './serve.js';

/** Where `route` always writes — the project's local, never-shared settings. */
export function routeSettingsFile(
  cwd: string,
  scope: 'project' | 'global' = 'project',
  home: string = homedir(),
): string {
  return scope === 'global'
    ? join(home, '.claude', 'settings.json')
    : join(cwd, '.claude', 'settings.local.json');
}

/**
 * The SessionStart command that keeps the router up for a routed session,
 * pointing at this installation's `ensure-serve.mjs` with the routing port.
 *
 * The `--global` marker matters: a daemon this hook starts for global-scope
 * routing is shared by every project, so it must resolve the machine config
 * regardless of which project's session happens to trigger it — `--global`
 * tells `ensure-serve.mjs` to start it from `home`, not its own inherited cwd.
 */
export function ensureServeCommand(packageRoot: string, port: number, scope: 'project' | 'global' = 'project'): string {
  const base = `node ${JSON.stringify(join(packageRoot, 'hooks', 'ensure-serve.mjs'))} ${port}`;
  return scope === 'global' ? `${base} --global` : base;
}

/** The two env keys a routed session needs. */
export const ROUTE_ENV_KEYS = ['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_MAX_CONTEXT_TOKENS'] as const;

/** `settings.env` as a string map. Claude Code settings put env as strings. */
export function routeEnv(settings: Settings): Record<string, string> {
  const raw = settings.env;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

export interface RouteOnPlan {
  settings: Settings;
  changed: boolean;
}

/**
 * What `route on` would write. Pure — no disk access; the caller passes the
 * current settings and gets back the amended ones plus whether anything changed.
 */
export function planRouteOn(
  settings: Settings,
  config: SonataConfig,
  packageRoot: string,
  scope: 'project' | 'global' = 'project',
): RouteOnPlan {
  if (!config.native) throw new Error('sonata route on: no [native] table in sonata.toml');
  const port = config.native.ports.router;
  const target = nativeSessionEnv(config);

  // Never clobber a base URL sonata did not write. A stale sonata port
  // (`http://localhost:<other>`) is rewritten — that is the drift `sonata
  // doctor` sends people here to fix — but anything else (a corporate
  // gateway, a cloud proxy) was put there by someone with a reason.
  const existing = routeEnv(settings).ANTHROPIC_BASE_URL;
  if (existing !== undefined && existing !== target.ANTHROPIC_BASE_URL && !isLocalhostUrl(existing)) {
    throw new Error(
      `sonata route on: ANTHROPIC_BASE_URL is already set to ${existing} in `
      + `.claude/settings.local.json — remove it yourself if sonata should take over`,
    );
  }

  // Merge the routing env in over whatever the user already has, preserving
  // every unrelated env var.
  const env = { ...routeEnv(settings), ...target };
  let next: Settings = envChanged(settings, target) ? { ...settings, env } : settings;

  // Simplest to always attempt the hook install; it is a no-op when present.
  const command = ensureServeCommand(packageRoot, port, scope);
  const hook = installHook(next, command, '', 'SessionStart');
  if (hook.changed) next = hook.settings;

  return { settings: next, changed: hook.changed || envChanged(settings, target) };
}

/** The shape of every URL sonata's router answers on — the ownership test. */
function isLocalhostUrl(url: string): boolean {
  return /^http:\/\/localhost:\d+$/.test(url);
}

function envChanged(settings: Settings, target: Record<string, string>): boolean {
  const current = routeEnv(settings);
  return ROUTE_ENV_KEYS.some((k) => current[k] !== target[k]);
}

export interface RouteOffPlan {
  settings: Settings;
  changed: boolean;
}

/**
 * What `route off` would write: drop the routing env keys and the SessionStart
 * hook, preserving everything else including unrelated env vars and hooks.
 */
export function planRouteOff(settings: Settings, packageRoot: string): RouteOffPlan {
  let next = settings;
  let any = false;

  // The hook was installed under a matcher-less SessionStart entry, so find it
  // by command shape and uninstall exactly that. `uninstallHook` is a no-op when
  // the command is absent, and an entry that ends up with no hooks is dropped.
  const s = settings.hooks?.SessionStart ?? [];
  const command = s
    .flatMap((entry) => entry.hooks)
    .find((h) => h.command.includes('ensure-serve.mjs'))?.command;
  if (command) {
    const removed = uninstallHook(next, command, 'SessionStart');
    next = removed.settings;
    any = removed.changed;
  }

  // Same ownership test as `route on`: a base URL that is not a localhost
  // router was written by someone else, and `route off` must not remove it.
  const base = routeEnv(settings).ANTHROPIC_BASE_URL;
  if (base !== undefined && !isLocalhostUrl(base)) {
    throw new Error(
      `sonata route off: ANTHROPIC_BASE_URL is set to ${base}, which sonata did `
      + `not write — remove it yourself if that is intended`,
    );
  }

  // Prune only when the routing base URL itself is present: a lone
  // CLAUDE_CODE_MAX_CONTEXT_TOKENS with no base URL was set by the user for
  // their own reasons, not by `route on`, and is not ours to remove.
  const env = settings.env;
  if (base !== undefined && env && typeof env === 'object' && !Array.isArray(env)
    && ROUTE_ENV_KEYS.some((k) => k in env)) {
    const pruned: Record<string, unknown> = { ...(env as Record<string, unknown>) };
    for (const k of ROUTE_ENV_KEYS) delete pruned[k];
    // Drop the `env` block entirely when nothing is left in it, so the file
    // stays as close to untouched as the write allows.
    next = Object.keys(pruned).length === 0 ? omit(next, 'env') : { ...next, env: pruned };
    any = true;
  }

  return { settings: next, changed: any };
}

function omit(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const out = { ...obj };
  delete out[key];
  return out;
}

/* --- auto mode: route a session without giving up Remote Control ------------
 *
 * `route on` leaves the routing env in the settings file permanently, so the
 * *next* session reads it at launch — and Claude Code decides there whether the
 * session keeps Remote Control, by looking at `ANTHROPIC_BASE_URL`. A session
 * launched under `route on` therefore always loses it.
 *
 * The two decisions are made at different times, and that asymmetry is the
 * whole trick. The Remote Control gate is evaluated once, at launch; the env
 * block is re-read per request. So a session that launches with a *clean*
 * settings file keeps Remote Control, and picks up routing anyway if the env
 * appears afterwards — which is exactly what a SessionStart hook can do.
 * Probed live on 2026-08-25: a session launched before `route on` kept Remote
 * Control and still dispatched a native subagent that the router logged as
 * `-> litellm`.
 *
 * Auto mode makes that deliberate: SessionStart turns routing on, SessionEnd
 * turns it back off so the next session also launches clean.
 *
 * Concurrent sessions are why the ids are counted rather than a boolean. Under
 * `route on` a live session cannot be un-routed (its env was exported at
 * launch and survives the key's removal), but an auto session has no exported
 * env — it reads the file every request — so a sibling's SessionEnd would cut
 * its routing mid-run. `route off` only fires when the last id is gone.
 *
 * A session that dies without its SessionEnd hook leaves its id behind, and
 * routing stays on. That is the safe direction to fail: the cost is one
 * launch without Remote Control, not a native agent whose model silently
 * became Claude. `sonata route off` clears the registry outright.
 */

/**
 * Where the ids of currently-routed auto sessions live. `.sonata/` is ignored.
 *
 * Global scope is one shared router across every project, so its session
 * count has to be shared too — a per-project registry would let a session
 * ending in project A (whose own registry hits zero) turn off routing while
 * project B's sessions, tracked in a registry A never sees, are still live.
 */
export function routeSessionsFile(
  cwd: string,
  scope: 'project' | 'global' = 'project',
  home: string = homedir(),
): string {
  return scope === 'global'
    ? join(home, '.config', 'sonata', 'route-sessions.json')
    : join(cwd, '.sonata', 'route-sessions.json');
}

export function readSessions(file: string): string[] {
  if (!existsSync(file)) return [];
  try {
    const doc: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(doc)) return [];
    return doc.filter((id): id is string => typeof id === 'string');
  } catch {
    // A corrupt registry must not stop a session from starting; treat it as
    // empty and let the write below replace it.
    return [];
  }
}

export function writeSessions(file: string, ids: string[]): void {
  if (ids.length === 0) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(ids, null, 2)}\n`);
}

async function withSessionLock<T>(file: string, fn: () => T | Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  mkdirSync(dirname(file), { recursive: true });
  const deadline = Date.now() + 2000;
  let held = false;
  for (;;) {
    try {
      mkdirSync(lock);
      held = true;
      break;
    } catch {
      try {
        const age = Date.now() - statSync(lock).mtimeMs;
        if (age > 5000) rmSync(lock, { recursive: true, force: true });
      } catch { /* raced with the holder releasing it */ }
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  try {
    return await fn();
  } finally {
    if (held) { try { rmSync(lock, { recursive: true, force: true }); } catch { /* already gone */ } }
  }
}

/**
 * The SessionStart/SessionEnd command auto mode installs.
 *
 * The `--global` marker matters the same way it does for `ensureServeCommand`:
 * without it, `route-session.mjs` calls `sonata route session-<phase>` with no
 * scope, the CLI defaults that to project scope, and a global auto session
 * ends up writing project-local routing settings and probing/starting a
 * project-configured daemon — silently recreating the cross-project
 * model/config leakage the machine-config fix (bd72ec4) was meant to prevent.
 */
export function sessionHookCommand(
  packageRoot: string,
  phase: 'start' | 'end',
  scope: 'project' | 'global' = 'project',
): string {
  const base = `node ${JSON.stringify(join(packageRoot, 'hooks', 'route-session.mjs'))} ${phase}`;
  return scope === 'global' ? `${base} --global` : base;
}

/** Whether both lifecycle hooks for this install are present. */
export function autoInstalled(
  settings: Settings,
  packageRoot: string,
  scope: 'project' | 'global' = 'project',
): boolean {
  return hookInstalled(settings, sessionHookCommand(packageRoot, 'start', scope), 'SessionStart')
    && hookInstalled(settings, sessionHookCommand(packageRoot, 'end', scope), 'SessionEnd');
}

export interface RouteAutoPlan {
  settings: Settings;
  changed: boolean;
}

/** What `route auto` would write: the SessionStart/SessionEnd hook pair. */
export function planRouteAuto(
  settings: Settings,
  packageRoot: string,
  scope: 'project' | 'global' = 'project',
): RouteAutoPlan {
  // Auto mode's guarantee is that a session launches from a clean settings
  // file; switching directly from `route on` must not leave the persistent
  // ANTHROPIC_BASE_URL/ensure-serve hook behind for the next session to
  // inherit before its own lifecycle hook ever runs.
  const cleared = planRouteOff(settings, packageRoot);
  let next = cleared.settings;
  let changed = cleared.changed;
  for (const phase of ['start', 'end'] as const) {
    const event = phase === 'start' ? 'SessionStart' : 'SessionEnd';
    const res = installHook(next, sessionHookCommand(packageRoot, phase, scope), '', event);
    next = res.settings;
    changed = changed || res.changed;
  }
  return { settings: next, changed };
}

/** What `route manual` would write: the same pair removed. */
export function planRouteManual(
  settings: Settings,
  packageRoot: string,
  scope: 'project' | 'global' = 'project',
): RouteAutoPlan {
  let next = settings;
  let changed = false;
  for (const phase of ['start', 'end'] as const) {
    const event = phase === 'start' ? 'SessionStart' : 'SessionEnd';
    const res = uninstallHook(next, sessionHookCommand(packageRoot, phase, scope), event);
    next = res.settings;
    changed = changed || res.changed;
  }
  return { settings: next, changed };
}

export interface RouteScopeStatus {
  on: boolean;
  auto: boolean;
  env: Record<string, string>;
  hook: { installed: boolean };
}

export interface RouteStatus extends RouteScopeStatus {
  sessions: number;
  port: number | undefined;
  scopes: {
    project: RouteScopeStatus;
    global: RouteScopeStatus;
  };
}

function routeScopeStatus(
  settings: Settings,
  config: SonataConfig,
  packageRoot: string,
  scope: 'project' | 'global' = 'project',
): RouteScopeStatus {
  const env = routeEnv(settings);
  const port = config.native?.ports.router;
  const base = env.ANTHROPIC_BASE_URL;
  const command = port !== undefined ? ensureServeCommand(packageRoot, port, scope) : '';
  const hook = command !== '' && hookInstalled(settings, command, 'SessionStart');
  return {
    on: !!port && base === `http://localhost:${port}` && hook,
    auto: autoInstalled(settings, packageRoot, scope),
    env,
    hook: { installed: hook },
  };
}

/** Whether a project's local settings currently route through the router. */
export function routeStatus(
  settings: Settings,
  config: SonataConfig,
  packageRoot: string,
  cwd?: string,
  scopedSettings?: { project: Settings; global: Settings },
  scope: 'project' | 'global' = 'project',
  /**
   * Global routing is one shared router resolving the *machine* config, not
   * whichever project's session happens to check status — defaults to
   * `config` so existing single-config callers (and tests) are unaffected,
   * but `cmdRoute` passes the machine config here explicitly so a global
   * status/port is never read from a project's own sonata.toml.
   */
  globalConfig: SonataConfig = config,
  home: string = homedir(),
): RouteStatus {
  const project = scopedSettings?.project ?? settings;
  const global = scopedSettings?.global ?? {};
  const activeConfig = scope === 'global' ? globalConfig : config;
  const current = routeScopeStatus(settings, activeConfig, packageRoot, scope);
  const projectStatus = scopedSettings ? routeScopeStatus(project, config, packageRoot, 'project') : current;
  const globalStatus = routeScopeStatus(global, globalConfig, packageRoot, 'global');
  const sessions = cwd === undefined ? 0 : readSessions(routeSessionsFile(cwd, scope, home)).length;
  return {
    ...current,
    sessions,
    port: activeConfig.native?.ports.router,
    scopes: { project: projectStatus, global: globalStatus },
  };
}

export type RouteAction = 'on' | 'off' | 'status' | 'auto' | 'manual';

export async function cmdRoute(
  action: RouteAction,
  opts: { cwd: string; home: string; packageRoot: string; scope?: 'project' | 'global' },
): Promise<RouteStatus | undefined> {
  const scope = opts.scope ?? 'project';
  const file = routeSettingsFile(opts.cwd, scope, opts.home);
  const settings = readSettings(file);

  const loadOrEmpty = (dir: string): { config: SonataConfig; error?: unknown } => {
    try {
      return { config: loadConfig(dir, opts.home) };
    } catch (err) {
      return { config: { native: undefined } as SonataConfig, error: err };
    }
  };
  const loadGlobalOrEmpty = (): { config: SonataConfig; error?: unknown } => {
    const globalPath = join(opts.home, GLOBAL_CONFIG_RELATIVE);
    try {
      if (!existsSync(globalPath)) {
        throw new Error(
          `No sonata.toml found at ${globalPath}. Run \`sonata init\` or create one.`,
        );
      }
      return { config: parseConfig(readFileSync(globalPath, 'utf8')) };
    } catch (err) {
      return { config: { native: undefined } as SonataConfig, error: err };
    }
  };
  // Global routing is one shared router that always resolves the *machine*
  // config, regardless of which project's session manages it — checking the
  // invoking project's config here would bake that project's router port
  // into ANTHROPIC_BASE_URL even though the daemon (per bd72ec4) resolves the
  // machine config, pointing settings at a port the daemon never opens.
  const projectLoaded = loadOrEmpty(opts.cwd);
  const globalLoaded = loadGlobalOrEmpty();
  const active = scope === 'global' ? globalLoaded : projectLoaded;
  // route off/status can still describe a broken config; route on and auto
  // both install something that depends on the config actually loading —
  // auto's failure mode is silent (its hook swallows cmdRouteSession's own
  // load error by design), so catching it here, loudly, is the only chance.
  if ((action === 'on' || action === 'auto') && active.error !== undefined) throw active.error;
  const config = projectLoaded.config;
  const globalConfig = globalLoaded.config;
  const activeConfig = active.config;

  const status = (current: Settings): RouteStatus => routeStatus(
    current,
    config,
    opts.packageRoot,
    opts.cwd,
    {
      project: readSettings(routeSettingsFile(opts.cwd, 'project', opts.home)),
      global: readSettings(routeSettingsFile(opts.cwd, 'global', opts.home)),
    },
    scope,
    globalConfig,
    opts.home,
  );

  if (action === 'on') {
    const plan = planRouteOn(settings, activeConfig, opts.packageRoot, scope);
    if (plan.changed) writeSettings(file, plan.settings);
    return status(plan.settings);
  }

  if (action === 'off') {
    const plan = planRouteOff(settings, opts.packageRoot);
    if (plan.changed) writeSettings(file, plan.settings);
    // An explicit `off` means stop routing, so the auto registry goes with it —
    // otherwise a stale id from a crashed session would have the next
    // SessionStart turn routing straight back on. This clears only this
    // scope's registry: an explicit `route off` (project-scoped) must not
    // wipe the shared global session count out from under other projects.
    writeSessions(routeSessionsFile(opts.cwd, scope, opts.home), []);
    return status(plan.settings);
  }

  if (action === 'auto' || action === 'manual') {
    const plan = action === 'auto'
      ? planRouteAuto(settings, opts.packageRoot, scope)
      : planRouteManual(settings, opts.packageRoot, scope);
    if (plan.changed) writeSettings(file, plan.settings);
    return status(plan.settings);
  }

  return status(settings);
}

export interface SessionPhaseResult {
  /** Sessions still routed after this phase. */
  sessions: number;
  /** Whether the phase flipped routing on or off. */
  routing: 'on' | 'off';
}

/**
 * The body of the auto-mode hooks: `start` registers this session and routes,
 * `end` unregisters it and un-routes once it was the last one.
 *
 * Lives in the CLI rather than in the hook script so it is ordinary tested
 * TypeScript, and so the hook can stay a few lines that cannot fail loudly.
 */
export interface SessionDeps {
  /** Resolves true when the router already answers on `port`. */
  probe?: (port: number) => Promise<boolean>;
  startDaemon?: (home: string, argv: string[], deps?: unknown, cwd?: string) => Promise<unknown>;
}

export async function cmdRouteSession(
  phase: 'start' | 'end',
  sessionId: string,
  opts: { cwd: string; home: string; packageRoot: string; serveArgv: string[]; scope?: 'project' | 'global' },
  deps: SessionDeps = {},
): Promise<SessionPhaseResult> {
  // A global session shares one machine-wide registry with every other
  // routed project — otherwise this project's own registry hitting zero
  // would turn off the single shared router while another project's global
  // sessions, tracked in a registry this one never sees, are still live.
  const registry = routeSessionsFile(opts.cwd, opts.scope ?? 'project', opts.home);

  // A global hook runs in every directory; validate the project before touching
  // its own registry (project scope) or the shared one (global scope) so an
  // unrelated, configless directory remains completely untouched.
  loadConfig(opts.cwd, opts.home);

  if (phase === 'end') {
    // The zero-session decision and the `off` transition must be one atomic
    // critical section — deciding "zero remain" and then acting on it as two
    // separate lock acquisitions leaves a gap where a concurrent SessionStart
    // can register and turn routing on, only for this stale decision to turn
    // it back off. Doing the read, write, decision, and (conditionally)
    // `cmdRoute('off')` inside a single lock hold closes that gap: whichever
    // of a concurrent start/end's lock acquisitions runs second always sees
    // the other's completed write.
    return await withSessionLock(registry, async () => {
      const current = readSessions(registry);
      const left = current.filter((id) => id !== sessionId);
      writeSessions(registry, left);
      if (left.length > 0) return { sessions: left.length, routing: 'on' };
      await cmdRoute('off', opts);
      return { sessions: 0, routing: 'off' };
    });
  }

  // `route on` installs the ensure-serve hook, but that hook cannot fire in the
  // session that just started — it was added after launch. So auto mode starts
  // the router here, the way `sonata code` does, or the session's first native
  // dispatch caches a connection error from a router that is not there.
  //
  // This whole block runs BEFORE the session is registered or routing is
  // turned on: the SessionStart hook that calls this command ignores a
  // thrown/nonzero exit, so if this validation happened after those writes,
  // a same-port-different-config collision would still leave the session
  // registered and routed through the wrong router despite the error.
  const probe = deps.probe ?? isSonataRouter;
  const startDaemon = deps.startDaemon ?? startServeDaemon;
  // Global routing is one shared router for every project — its config has
  // to be the machine one regardless of which project's session happens to
  // start it, or every other routed project silently inherits this one's
  // tiers, models and gateways for as long as the daemon lives. The port
  // probed here must be the same config's port, or a project whose own
  // [native.ports].router differs from the machine's would probe (and then
  // start the daemon on) the wrong port entirely.
  //
  // Using the machine config's own DIRECTORY as `configCwd` — not `opts.home`
  // itself — matters: configPath()'s first check is `join(cwd, 'sonata.toml')`,
  // and if `cwd` were `opts.home`, that check would land on a stray
  // `~/sonata.toml` (a known leftover some upgrades still have) before ever
  // reaching the real machine config. Pointing `cwd` at the machine config's
  // own directory makes that first check land exactly on
  // `~/.config/sonata/sonata.toml` instead, with no stray file in the way —
  // and since `startDaemon` below spawns the daemon with this same `cwd`,
  // the daemon's own internal config resolution is fixed by the same change,
  // with no separate fix needed in cmdServe.
  const configCwd = opts.scope === 'global'
    ? dirname(join(opts.home, GLOBAL_CONFIG_RELATIVE))
    : opts.cwd;
  const config = loadConfig(configCwd, opts.home);
  const port = config.native?.ports.router;
  if (port !== undefined) {
    const expectedConfigPath = resolveSonataConfigPath(configCwd, opts.home);
    const running = await probe(port);
    if (running && deps.probe === undefined) {
      // Only verify identity against the real network probe — an injected
      // test probe already encodes the scenario under test, and re-checking
      // against the real network here would defeat it. A router that cannot
      // or does not report its own configPath is treated the same as a
      // mismatch, not silently trusted.
      const actualConfigPath = await sonataRouterConfigPath(port);
      if (expectedConfigPath !== null && (actualConfigPath === null || actualConfigPath !== expectedConfigPath)) {
        throw new Error(
          actualConfigPath === null
            ? `sonata: router port ${port} answered but did not report which sonata configuration ` +
              `it is running (too old, or its own config resolution failed) — refusing to trust it. ` +
              `Restart it with \`sonata restart\` once confirmed to be this project's own router.`
            : `sonata: router port ${port} is already serving a different sonata configuration ` +
              `(${actualConfigPath}) than this project resolves to (${expectedConfigPath}). ` +
              `Two projects cannot share one router port — set a different [native.ports].router ` +
              `in one of the two configs.`,
        );
      }
    }
    if (!running) {
      await startDaemon(opts.home, opts.serveArgv, {}, configCwd);
      if (deps.probe === undefined) {
        // A concurrent SessionStart in another project could have won the
        // race to bind this same default port with ITS daemon between the
        // probe above and this daemon spawn's poll completing —
        // `startServeDaemon` only confirms *a* sonata router answered, not
        // that it is this project's. Verify identity again now that
        // something is confirmed to be listening. A router that cannot or
        // does not report its own configPath is treated the same as a
        // mismatch, not silently trusted.
        const startedConfigPath = await sonataRouterConfigPath(port);
        if (expectedConfigPath !== null && (startedConfigPath === null || startedConfigPath !== expectedConfigPath)) {
          throw new Error(
            startedConfigPath === null
              ? `sonata: router port ${port} answered but did not report which sonata configuration ` +
                `it is running (too old, or its own config resolution failed) — refusing to trust it. ` +
                `Restart it with \`sonata restart\` once confirmed to be this project's own router.`
              : `sonata: router port ${port} is already serving a different sonata configuration ` +
                `(${startedConfigPath}) than this project resolves to (${expectedConfigPath}). ` +
                `Two projects cannot share one router port — set a different [native.ports].router ` +
                `in one of the two configs.`,
          );
        }
      }
    }
  }

  await withSessionLock(registry, () => {
    const current = readSessions(registry);
    writeSessions(registry, current.includes(sessionId) ? current : [...current, sessionId]);
  });
  await cmdRoute('on', opts);

  const after = readSessions(registry);
  return { sessions: after.length, routing: 'on' };
}