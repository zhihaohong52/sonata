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

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { GLOBAL_CONFIG_RELATIVE, configPath as resolveConfigPath, parseConfig, type SonataConfig } from '../config.js';
import { assertEffortsPinned, loadAaCatalog } from '../catalog.js';
import { loadModelsDev } from '../modelsdev.js';
import { configUpstreamFor } from '../pricing.js';
import { readSessions, sessionsPath, type SessionRecord } from '../sessions.js';
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
  /**
   * sessions.json as last parsed, keyed by the file's own stat, with the
   * distinct cwds it names.
   *
   * `fingerprint()` runs on every request, and it used to re-read and
   * re-parse this file and run `configPath` + realpath once per session
   * RECORD — not per distinct cwd — every time: measured 53 ms per request
   * at 256 projects and 2000 sessions, synchronous, Anthropic passthrough
   * included. Parsing is now once per version of the file, and resolution
   * once per distinct cwd.
   *
   * What a cwd resolves to is deliberately NOT cached with it. `sonata init`
   * in a project whose session is already registered writes ./sonata.toml
   * and leaves sessions.json alone, so a resolution keyed by the file's
   * version kept answering "the machine config" and the project never
   * entered the LiteLLM union. The dedup is where the saving was.
   */
  private sessionsCache?: { stamp: string; records: Record<string, SessionRecord>; cwds: string[] };
  /** The invalid sessions.json records last logged, so each set is logged once. */
  private loggedInvalid = '';

  constructor(
    private readonly home: string,
    private readonly deps: {
      log?: (line: string) => void;
      /** Test seam: how sessions.json's bytes are read, so a test can count re-reads. */
      readSessionsFile?: (path: string) => string;
    } = {},
  ) {}

  /** The current sessions.json version, parsed once per version. */
  private sessions(): NonNullable<TenantRegistry['sessionsCache']> {
    const path = sessionsPath(this.home);
    let stamp: string;
    try {
      const { ino, mtimeMs, size } = statSync(path);
      stamp = `${ino}:${mtimeMs}:${size}`;
    } catch {
      stamp = 'absent';
    }
    if (this.sessionsCache?.stamp === stamp) return this.sessionsCache;
    const { sessions: records, ok, invalid } = readSessions(this.home, this.deps.readSessionsFile);
    const invalidKey = invalid.join('\0');
    if (invalid.length > 0 && invalidKey !== this.loggedInvalid) {
      this.deps.log?.(`tenants: ${sessionsPath(this.home)} has an invalid record (no string cwd), ignored: ${invalid.join(', ')}`);
    }
    if (ok) this.loggedInvalid = invalidKey;
    // A failed read (EMFILE, say) returns `{}` under a stamp that is perfectly
    // valid. Cached, that pinned every session to the machine config until
    // sessions.json next changed; answered even once, it sent this request
    // there with the machine's credentials. The last good read answers
    // instead, and is left under its own stamp so the next call reads again.
    // `{}` only when there has never been a good read.
    if (!ok) return this.sessionsCache ?? { stamp, records: {}, cwds: [] };
    const cwds = [...new Set(Object.values(records).map((record) => record.cwd))];
    this.sessionsCache = { stamp, records, cwds };
    return this.sessionsCache;
  }

  /** `cwd`'s canonical config path, resolved now. */
  private configFor(cwd: string): string | null {
    const found = resolveConfigPath(cwd, this.home);
    return found === null ? null : canonicalConfigPath(found);
  }

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
   * values it had ever seen. Insertion order is Set iteration order, and a
   * project is re-inserted each time it is noted, so the victim is the one
   * least recently used — a project still in use is never the one evicted.
   */
  noteProject(cwd: string): void {
    if (this.noted.delete(cwd)) {
      this.noted.add(cwd);
      return;
    }
    if (this.noted.size >= MAX_NOTED_PROJECTS) {
      const oldest = this.noted.values().next();
      if (!oldest.done) this.noted.delete(oldest.value);
    }
    this.noted.add(cwd);
  }

  private load(path: string): SonataConfig {
    const config = parseConfig(readFileSync(path, 'utf8'));
    // A config with no [tiers] has no candidate to pin, so it can never be
    // refused — and this runs per request, and again per known tenant. Only
    // the catalog read is skipped; parsing happens either way.
    if (config.tiers === undefined) return config;
    // Router requests bypass loadConfig, so validate against this registry's cache here.
    assertEffortsPinned(config, loadAaCatalog(this.home), configUpstreamFor(config, loadModelsDev(this.home)));
    return config;
  }

  resolve(hint: { project?: string; session?: string }): RouterTenant {
    const cwd = hint.project ?? (hint.session === undefined ? undefined : this.sessions().records[hint.session]?.cwd);
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

  /**
   * A cheap token that changes whenever the set of known tenants, or any of
   * their config files, does: each known path with its mtime and size, no
   * parsing. Serve compares it per request to know when the gateway merge
   * (and so which gateways are dropped, and their keys) is out of date.
   */
  fingerprint(): string {
    return this.knownPaths().map((path) => {
      try {
        const { mtimeMs, size } = statSync(path);
        return `${path}:${mtimeMs}:${size}`;
      } catch {
        return `${path}:missing`;
      }
    }).join('\n');
  }

  private knownPaths(): string[] {
    const paths = new Set<string>();
    const machine = this.machinePath();
    if (machine !== null) paths.add(machine);
    // Every distinct cwd — session and noted alike, one resolution each — is
    // resolved fresh on every call: a project gains its sonata.toml without
    // either set changing.
    for (const cwd of new Set([...this.sessions().cwds, ...this.noted])) {
      const path = this.configFor(cwd);
      if (path !== null) paths.add(path);
    }
    return [...paths].sort();
  }

  known(): KnownTenant[] {
    const out: KnownTenant[] = [];
    for (const path of this.knownPaths()) {
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

  /** `loaded` lets a caller that already has `loadable()` skip parsing every config again. */
  unionSnapshot(loaded: { id: string; config: SonataConfig }[] = this.loadable()): string {
    return JSON.stringify(loaded.map(({ id, config }) => ({ id, snapshot: nativeSnapshot(config) })));
  }

  summary(): { id: string; configPath: string | null }[] {
    return this.known().map(({ id, configPath }) => ({ id, configPath }));
  }
}
