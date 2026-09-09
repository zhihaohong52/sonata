import { createHash } from 'node:crypto';

/**
 * The request header a routed session carries naming its project directory.
 * Written into settings `env` as `ANTHROPIC_CUSTOM_HEADERS` by the routing
 * planner (`nativeSessionEnv`), so a subagent's very first request already
 * says which project it belongs to — no registry, no ordering.
 */
export const SONATA_PROJECT_HEADER = 'x-sonata-project';

/** Stable, log-readable, and safe inside a LiteLLM model name. */
export function tenantId(configPath: string): string {
  return createHash('sha256').update(configPath).digest('hex').slice(0, 12);
}

/** "This request cannot be attributed to a loadable configuration" — a 400, never a 5xx. */
export class TenantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantError';
  }
}

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

import { GLOBAL_CONFIG_RELATIVE, configPath as resolveConfigPath, parseConfig, type SonataConfig } from '../config.js';
import { loadSessions } from '../sessions.js';
import type { RouterTenant } from './router.js';

/**
 * The canonical spelling of a config path, which is what a tenant is identified
 * by.
 *
 * A path string is not an identity: macOS symlinks `/var` to `/private/var`, so
 * one `sonata.toml` reached two ways hashed to two tenant ids. Measured on a
 * live two-project run (2026-09-09): the same machine config appeared twice on
 * `/__sonata_health`, LiteLLM carried duplicate entries for it, a needless
 * restart fired, and cooldowns and budget attribution split across the two ids
 * for what is one project. Any path traversing a symlink does this — a
 * symlinked `~/Code`, a mounted path, a worktree — not only a temp directory.
 *
 * Best-effort by design: a path that cannot be resolved (deleted between calls,
 * unreadable) keeps its original spelling rather than throwing. Canonicalising
 * is an improvement to identity, never a new way for resolution to fail.
 */
export function canonicalConfigPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** How many distinct projects the registry remembers; see `noteProject`. */
export const MAX_NOTED_PROJECTS = 256;

export interface KnownTenant {
  id: string;
  configPath: string;
  config?: SonataConfig;
  error?: string;
}

/** What `maybeRestartForModelChange` compares — the same fields `serve` snapshotted for one config. */
function nativeSnapshot(cfg: SonataConfig): unknown {
  return { legacyModels: cfg.native?.models, models: cfg.unifiedModels, gateways: cfg.native?.gateways };
}

/**
 * Which project a request belongs to, and every project the router knows.
 *
 * Configs are re-read on every call, as the single-config router already did
 * per request: the file is the user's live control surface, and a tenant edit
 * that only applies after `sonata restart` reads as broken. A parse failure is
 * logged once per distinct message per tenant, not once per request.
 */
export class TenantRegistry {
  private readonly noted = new Set<string>();
  private readonly logged = new Map<string, string>();

  constructor(
    private readonly home: string,
    private readonly deps: { log?: (line: string) => void } = {},
  ) {}

  private machinePath(): string | null {
    const path = join(this.home, GLOBAL_CONFIG_RELATIVE);
    return existsSync(path) ? canonicalConfigPath(path) : null;
  }

  /**
   * Remembers a project so `known()` includes it in the LiteLLM union.
   *
   * Bounded, because the value reaching this is `x-sonata-project` — supplied
   * by the caller on every request — and `known()` does filesystem work per
   * noted path *on the request path*. Unbounded, a long-lived machine daemon
   * would grow memory and per-request I/O with the number of distinct header
   * values it had ever seen. Insertion order is Set iteration order, so the
   * oldest goes first; a project still in use is re-noted by its next request.
   */
  noteProject(cwd: string): void {
    if (this.noted.has(cwd)) return;
    if (this.noted.size >= MAX_NOTED_PROJECTS) {
      const oldest = this.noted.values().next();
      if (!oldest.done) this.noted.delete(oldest.value);
    }
    this.noted.add(cwd);
  }

  private load(path: string): SonataConfig {
    return parseConfig(readFileSync(path, 'utf8'));
  }

  resolve(hint: { project?: string; session?: string }): RouterTenant {
    const cwd = hint.project ?? (hint.session === undefined ? undefined : loadSessions(this.home)[hint.session]?.cwd);
    let path: string | null;
    if (cwd !== undefined) {
      const found = resolveConfigPath(cwd, this.home);
      path = found === null ? null : canonicalConfigPath(found);
      // Noted only once the hint resolves to a real config, and only when it is
      // that project's own: a directory with no `sonata.toml` resolves to the
      // machine config, which `known()` already has. Noting before this point
      // let any header value enlarge the set the request path walks.
      if (path !== null && path !== this.machinePath()) this.noteProject(cwd);
      if (path === null) {
        throw new TenantError(
          `No sonata.toml found for ${cwd}. Looked in ${join(cwd, 'sonata.toml')} and ` +
          `${join(this.home, GLOBAL_CONFIG_RELATIVE)}. Run \`sonata init\` there, or create one.`,
        );
      }
    } else {
      path = this.machinePath();
      if (path === null) {
        throw new TenantError(
          `No sonata.toml found. The request named no project and there is no machine config at ` +
          `${join(this.home, GLOBAL_CONFIG_RELATIVE)}. Run \`sonata init\`.`,
        );
      }
    }
    let config: SonataConfig;
    try {
      config = this.load(path);
    } catch (error) {
      throw new TenantError(`${path} does not load: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { id: tenantId(path), project: cwd, configPath: path, config };
  }

  known(): KnownTenant[] {
    const paths = new Set<string>();
    const machine = this.machinePath();
    if (machine !== null) paths.add(machine);
    for (const record of Object.values(loadSessions(this.home))) {
      const path = resolveConfigPath(record.cwd, this.home);
      if (path !== null) paths.add(canonicalConfigPath(path));
    }
    for (const cwd of this.noted) {
      const path = resolveConfigPath(cwd, this.home);
      if (path !== null) paths.add(canonicalConfigPath(path));
    }
    const out: KnownTenant[] = [];
    for (const path of [...paths].sort()) {
      const id = tenantId(path);
      try {
        out.push({ id, configPath: path, config: this.load(path) });
        this.logged.delete(id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (this.logged.get(id) !== message) {
          this.logged.set(id, message);
          this.deps.log?.(`tenants: ${path} does not load and is left out of the litellm model list: ${message}`);
        }
        out.push({ id, configPath: path, error: message });
      }
    }
    return out;
  }

  loadable(): { id: string; config: SonataConfig; configPath: string }[] {
    return this.known()
      .filter((t): t is KnownTenant & { config: SonataConfig } => t.config !== undefined)
      .map(({ id, config, configPath }) => ({ id, config, configPath }))
      .sort((x, y) => x.id.localeCompare(y.id));
  }

  unionSnapshot(): string {
    return JSON.stringify(this.loadable().map(({ id, config }) => ({ id, snapshot: nativeSnapshot(config) })));
  }

  summary(): { id: string; configPath: string | null }[] {
    return this.known().map(({ id, configPath }) => ({ id, configPath }));
  }
}
