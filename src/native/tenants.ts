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

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { GLOBAL_CONFIG_RELATIVE, configPath as resolveConfigPath, parseConfig, type SonataConfig } from '../config.js';
import { loadSessions } from '../sessions.js';
import type { RouterTenant } from './router.js';

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
    return existsSync(path) ? path : null;
  }

  noteProject(cwd: string): void {
    this.noted.add(cwd);
  }

  private load(path: string): SonataConfig {
    return parseConfig(readFileSync(path, 'utf8'));
  }

  resolve(hint: { project?: string; session?: string }): RouterTenant {
    const cwd = hint.project ?? (hint.session === undefined ? undefined : loadSessions(this.home)[hint.session]?.cwd);
    let path: string | null;
    if (cwd !== undefined) {
      this.noteProject(cwd);
      path = resolveConfigPath(cwd, this.home);
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
      if (path !== null) paths.add(path);
    }
    for (const cwd of this.noted) {
      const path = resolveConfigPath(cwd, this.home);
      if (path !== null) paths.add(path);
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
