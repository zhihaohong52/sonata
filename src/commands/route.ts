/**
 * `sonata route <on|off|status>` — route a plain `claude` session in the project
 * through the native router.
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
import { join } from 'node:path';

import { readSettings, writeSettings, installHook, uninstallHook, hookInstalled } from '../settings.js';
import type { Settings } from '../settings.js';
import { loadConfig, type SonataConfig } from '../config.js';
import { nativeSessionEnv } from './code.js';

/** Where `route` always writes — the project's local, never-shared settings. */
export function routeSettingsFile(cwd: string): string {
  return join(cwd, '.claude', 'settings.local.json');
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

export interface RouteStatus {
  on: boolean;
  port: number | undefined;
  env: Record<string, string>;
  hook: { installed: boolean };
}

/** Whether a project's local settings currently route through the router. */
export function routeStatus(
  settings: Settings,
  config: SonataConfig,
  packageRoot: string,
): RouteStatus {
  const env = routeEnv(settings);
  const port = config.native?.ports.router;
  const base = env.ANTHROPIC_BASE_URL;
  const command = port !== undefined ? ensureServeCommand(packageRoot, port) : '';
  const hook = command !== '' && hookInstalled(settings, command, 'SessionStart');
  const on = !!port && base === `http://localhost:${port}` && hook;
  return { on, port, env, hook: { installed: hook } };
}

export async function cmdRoute(
  action: 'on' | 'off' | 'status',
  opts: { cwd: string; home: string; packageRoot: string },
): Promise<RouteStatus | undefined> {
  const settings = readSettings(routeSettingsFile(opts.cwd));
  let config: SonataConfig;
  try {
    config = loadConfig(opts.cwd, opts.home);
  } catch (err) {
    // route off/status can still describe a broken config; route on needs it.
    if (action === 'on') throw err;
    config = { native: undefined } as SonataConfig;
  }

  if (action === 'on') {
    const plan = planRouteOn(settings, config, opts.packageRoot);
    if (plan.changed) writeSettings(routeSettingsFile(opts.cwd), plan.settings);
    return routeStatus(plan.settings, config, opts.packageRoot);
  }

  if (action === 'off') {
    const plan = planRouteOff(settings, opts.packageRoot);
    if (plan.changed) writeSettings(routeSettingsFile(opts.cwd), plan.settings);
    return routeStatus(plan.settings, config, opts.packageRoot);
  }

  return routeStatus(settings, config, opts.packageRoot);
}