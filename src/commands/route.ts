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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

import { readSettings, writeSettings, installHook, uninstallHook, hookInstalled } from '../settings.js';
import type { Settings } from '../settings.js';
import { loadConfig, type SonataConfig } from '../config.js';
import { nativeSessionEnv } from './code.js';
import { isSonataRouter, startServeDaemon } from './serve.js';

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
 */
export function ensureServeCommand(packageRoot: string, port: number): string {
  return `node ${JSON.stringify(join(packageRoot, 'hooks', 'ensure-serve.mjs'))} ${port}`;
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
  const command = ensureServeCommand(packageRoot, port);
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

/** Where the ids of currently-routed auto sessions live. `.sonata/` is ignored. */
export function routeSessionsFile(cwd: string): string {
  return join(cwd, '.sonata', 'route-sessions.json');
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

/** The SessionStart/SessionEnd command auto mode installs. */
export function sessionHookCommand(packageRoot: string, phase: 'start' | 'end'): string {
  return `node ${JSON.stringify(join(packageRoot, 'hooks', 'route-session.mjs'))} ${phase}`;
}

/** Whether both lifecycle hooks for this install are present. */
export function autoInstalled(settings: Settings, packageRoot: string): boolean {
  return hookInstalled(settings, sessionHookCommand(packageRoot, 'start'), 'SessionStart')
    && hookInstalled(settings, sessionHookCommand(packageRoot, 'end'), 'SessionEnd');
}

export interface RouteAutoPlan {
  settings: Settings;
  changed: boolean;
}

/** What `route auto` would write: the SessionStart/SessionEnd hook pair. */
export function planRouteAuto(settings: Settings, packageRoot: string): RouteAutoPlan {
  let next = settings;
  let changed = false;
  for (const phase of ['start', 'end'] as const) {
    const event = phase === 'start' ? 'SessionStart' : 'SessionEnd';
    const res = installHook(next, sessionHookCommand(packageRoot, phase), '', event);
    next = res.settings;
    changed = changed || res.changed;
  }
  return { settings: next, changed };
}

/** What `route manual` would write: the same pair removed. */
export function planRouteManual(settings: Settings, packageRoot: string): RouteAutoPlan {
  let next = settings;
  let changed = false;
  for (const phase of ['start', 'end'] as const) {
    const event = phase === 'start' ? 'SessionStart' : 'SessionEnd';
    const res = uninstallHook(next, sessionHookCommand(packageRoot, phase), event);
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

function routeScopeStatus(settings: Settings, config: SonataConfig, packageRoot: string): RouteScopeStatus {
  const env = routeEnv(settings);
  const port = config.native?.ports.router;
  const base = env.ANTHROPIC_BASE_URL;
  const command = port !== undefined ? ensureServeCommand(packageRoot, port) : '';
  const hook = command !== '' && hookInstalled(settings, command, 'SessionStart');
  return {
    on: !!port && base === `http://localhost:${port}` && hook,
    auto: autoInstalled(settings, packageRoot),
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
): RouteStatus {
  const project = scopedSettings?.project ?? settings;
  const global = scopedSettings?.global ?? {};
  const current = routeScopeStatus(settings, config, packageRoot);
  const projectStatus = scopedSettings ? routeScopeStatus(project, config, packageRoot) : current;
  const globalStatus = routeScopeStatus(global, config, packageRoot);
  const sessions = cwd === undefined ? 0 : readSessions(routeSessionsFile(cwd)).length;
  return {
    ...current,
    sessions,
    port: config.native?.ports.router,
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
  let config: SonataConfig;
  try {
    config = loadConfig(opts.cwd, opts.home);
  } catch (err) {
    // route off/status can still describe a broken config; route on needs it.
    if (action === 'on') throw err;
    config = { native: undefined } as SonataConfig;
  }

  const status = (current: Settings): RouteStatus => routeStatus(
    current,
    config,
    opts.packageRoot,
    opts.cwd,
    {
      project: readSettings(routeSettingsFile(opts.cwd, 'project', opts.home)),
      global: readSettings(routeSettingsFile(opts.cwd, 'global', opts.home)),
    },
  );

  if (action === 'on') {
    const plan = planRouteOn(settings, config, opts.packageRoot);
    if (plan.changed) writeSettings(file, plan.settings);
    return status(plan.settings);
  }

  if (action === 'off') {
    const plan = planRouteOff(settings, opts.packageRoot);
    if (plan.changed) writeSettings(file, plan.settings);
    // An explicit `off` means stop routing, so the auto registry goes with it —
    // otherwise a stale id from a crashed session would have the next
    // SessionStart turn routing straight back on.
    writeSessions(routeSessionsFile(opts.cwd), []);
    return status(plan.settings);
  }

  if (action === 'auto' || action === 'manual') {
    const plan = action === 'auto'
      ? planRouteAuto(settings, opts.packageRoot)
      : planRouteManual(settings, opts.packageRoot);
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
  startDaemon?: (home: string, argv: string[]) => Promise<unknown>;
}

export async function cmdRouteSession(
  phase: 'start' | 'end',
  sessionId: string,
  opts: { cwd: string; home: string; packageRoot: string; serveArgv: string[] },
  deps: SessionDeps = {},
): Promise<SessionPhaseResult> {
  const registry = routeSessionsFile(opts.cwd);
  const ids = readSessions(registry);

  // A global hook runs in every directory; validate the project before touching
  // its registry so unrelated directories remain completely untouched.
  loadConfig(opts.cwd, opts.home);

  if (phase === 'end') {
    const remaining = ids.filter((id) => id !== sessionId);
    writeSessions(registry, remaining);
    if (remaining.length > 0) return { sessions: remaining.length, routing: 'on' };
    await cmdRoute('off', opts);
    return { sessions: 0, routing: 'off' };
  }

  writeSessions(registry, ids.includes(sessionId) ? ids : [...ids, sessionId]);
  await cmdRoute('on', opts);

  // `route on` installs the ensure-serve hook, but that hook cannot fire in the
  // session that just started — it was added after launch. So auto mode starts
  // the router here, the way `sonata code` does, or the session's first native
  // dispatch caches a connection error from a router that is not there.
  const probe = deps.probe ?? isSonataRouter;
  const startDaemon = deps.startDaemon ?? startServeDaemon;
  const config = loadConfig(opts.cwd, opts.home);
  const port = config.native?.ports.router;
  if (port !== undefined && !(await probe(port))) {
    await startDaemon(opts.home, opts.serveArgv);
  }

  const after = readSessions(registry);
  return { sessions: after.length, routing: 'on' };
}