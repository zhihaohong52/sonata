import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';

export const KNOWN_HARNESSES = ['opencode', 'codex', 'pi'] as const;
export const KNOWN_ROLES = ['review', 'code', 'explore', 'plan'] as const;

/** Roles that must never write, whatever permission mode the session is in. */
export const READ_ONLY_ROLES = ['review', 'explore', 'plan'] as const;

export function isReadOnlyRole(role: string): boolean {
  return (READ_ONLY_ROLES as readonly string[]).includes(role);
}

export interface ModelConfig { harness: string; id: string }

export interface SonataConfig {
  models: Record<string, ModelConfig>;
  generate: { roles: string[]; models: string[] };
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
    models[name] = { harness: d.harness, id: d.id };
  }

  const roles: string[] = raw.generate?.roles ?? [];
  const genModels: string[] = raw.generate?.models ?? [];

  for (const role of roles) {
    if (!KNOWN_ROLES.includes(role as any)) {
      throw new Error(
        `sonata.toml: generate.roles contains unknown role "${role}". ` +
        `Known roles: ${KNOWN_ROLES.join(', ')}`,
      );
    }
  }
  for (const m of genModels) {
    if (!models[m]) {
      throw new Error(
        `sonata.toml: generate.models references unknown model "${m}". ` +
        `Define [models."${m}"] first.`,
      );
    }
  }

  return {
    models,
    generate: { roles, models: genModels },
    run: {
      tailWindowSeconds: num(raw.run?.tail_window_seconds, 20),
      stallTimeoutSeconds: num(raw.run?.stall_timeout_seconds, 120),
      runTimeoutSeconds: num(raw.run?.run_timeout_seconds, 1800),
    },
  };
}

export function loadConfig(cwd: string): SonataConfig {
  const path = join(cwd, 'sonata.toml');
  if (!existsSync(path)) {
    throw new Error(`No sonata.toml found at ${path}. Run \`sonata init\` or create one.`);
  }
  return parseConfig(readFileSync(path, 'utf8'));
}
