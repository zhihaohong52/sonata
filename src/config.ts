import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';

export const KNOWN_HARNESSES = ['opencode', 'codex', 'pi', 'reasonix'] as const;
export const KNOWN_ROLES = ['review', 'code', 'explore', 'plan'] as const;

/** Harnesses whose `--model` needs a provider segment; codex takes a bare id. */
const QUALIFIED_ID_HARNESSES: readonly string[] = ['opencode', 'pi', 'reasonix'];

/** Roles that must never write, whatever permission mode the session is in. */
export const READ_ONLY_ROLES = ['review', 'explore', 'plan'] as const;

export function isReadOnlyRole(role: string): boolean {
  return (READ_ONLY_ROLES as readonly string[]).includes(role);
}

export interface ModelConfig { harness: string; id: string }

export interface SonataConfig {
  models: Record<string, ModelConfig>;
  generate: { roles: Record<string, string[]> };
  run: {
    tailWindowSeconds: number;
    stallTimeoutSeconds: number;
    runTimeoutSeconds: number;
  };
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' ? v : fallback;
}

export function parseConfig(text: string): SonataConfig {
  const raw = parseToml(text) as Record<string, any>;

  const models: Record<string, ModelConfig> = {};
  for (const [name, def] of Object.entries(raw.models ?? {})) {
    const d = def as Record<string, unknown>;
    if (typeof d.harness !== 'string' || typeof d.id !== 'string') {
      throw new Error(`sonata.toml: model "${name}" needs string "harness" and "id"`);
    }
    if (!KNOWN_HARNESSES.includes(d.harness as any)) {
      throw new Error(
        `sonata.toml: model "${name}" has unknown harness "${d.harness}". ` +
        `Known harnesses: ${KNOWN_HARNESSES.join(', ')}`,
      );
    }
    // Opencode, pi and reasonix address models as provider/model; codex takes a
    // bare id, so this cannot be a global rule. Reasonix's provider segment is
    // the name of a `[providers]` entry in that machine's reasonix.toml, so the
    // same id can mean different things on two machines.
    if (QUALIFIED_ID_HARNESSES.includes(d.harness) && !d.id.includes('/')) {
      throw new Error(
        `sonata.toml: model "${name}" needs a provider — ${d.harness} takes ` +
        `ids in provider/model form, not "${d.id}". Re-run \`sonata init\` to ` +
        'choose a provider.',
      );
    }
    models[name] = { harness: d.harness, id: d.id };
  }

  const gen = (raw.generate ?? {}) as Record<string, unknown>;

  // TOML cannot express both `roles = [...]` and `[generate.roles]`, so the
  // old form is distinguishable exactly. Fail loudly rather than approximate:
  // a config read as something nobody intended is worse than one that errors.
  if (Array.isArray(gen.roles) || gen.models !== undefined) {
    throw new Error(
      'sonata.toml: [generate] now maps each role to its own models. Replace\n' +
      '    roles  = [...]\n    models = [...]\n' +
      'with, for example:\n' +
      '    [generate.roles]\n    code   = ["<model-key>"]\n    review = ["<model-key>"]\n' +
      'or re-run `sonata init`.',
    );
  }

  const roles: Record<string, string[]> = {};
  for (const [role, list] of Object.entries((gen.roles ?? {}) as Record<string, unknown>)) {
    if (!KNOWN_ROLES.includes(role as any)) {
      throw new Error(
        `sonata.toml: generate.roles contains unknown role "${role}". ` +
        `Known roles: ${KNOWN_ROLES.join(', ')}`,
      );
    }
    if (!Array.isArray(list)) {
      throw new Error(`sonata.toml: generate.roles.${role} must be a list of model keys.`);
    }
    for (const m of list) {
      if (!models[m as string]) {
        throw new Error(
          `sonata.toml: generate.roles.${role} references unknown model "${m}". ` +
          `Define [models."${m}"] first.`,
        );
      }
    }
    roles[role] = list as string[];
  }

  return {
    models,
    generate: { roles },
    run: {
      tailWindowSeconds: num(raw.run?.tail_window_seconds, 20),
      stallTimeoutSeconds: num(raw.run?.stall_timeout_seconds, 120),
      runTimeoutSeconds: num(raw.run?.run_timeout_seconds, 1800),
    },
  };
}

/** Where a machine-level config lives, relative to the home directory. */
export const GLOBAL_CONFIG_RELATIVE = join('.config', 'sonata', 'sonata.toml');

/**
 * The config file that will be used, or null if there is none.
 *
 * A project config wins outright — it is not merged with the machine one.
 * Exactly one file is ever in effect, so it is always possible to say which
 * file produced a run.
 */
export function configPath(cwd: string, home: string): string | null {
  const local = join(cwd, 'sonata.toml');
  if (existsSync(local)) return local;
  const global = join(home, GLOBAL_CONFIG_RELATIVE);
  if (existsSync(global)) return global;
  return null;
}

/**
 * `home` is optional so that callers which have not yet been threaded through
 * keep working; it is always injected in tests, which must never read the
 * real home directory.
 */
export function loadConfig(cwd: string, home: string = homedir()): SonataConfig {
  const path = configPath(cwd, home);
  if (path === null) {
    throw new Error(
      `No sonata.toml found. Looked in ${join(cwd, 'sonata.toml')} and ` +
      `${join(home, GLOBAL_CONFIG_RELATIVE)}. Run \`sonata init\` or create one.`,
    );
  }
  return parseConfig(readFileSync(path, 'utf8'));
}

/**
 * Every agent the config asks for.
 *
 * The single definition of what should exist. The roles × models product used
 * to be written out in `cmdSync`, again in `init`'s summary, and again as the
 * expected set for `staleAgents` — three copies that could disagree, and stale
 * agents caused three separate failures.
 */
export function generatedAgents(config: SonataConfig): { role: string; model: string }[] {
  const out: { role: string; model: string }[] = [];
  for (const [role, models] of Object.entries(config.generate.roles)) {
    for (const model of models) out.push({ role, model });
  }
  return out;
}
