/**
 * The sonata.toml schema version, and the migrations that carry an older file
 * forward on load.
 *
 * The promise this exists to keep: a sonata.toml written on launch day still
 * loads at 1.9. That needs three things, and this module owns all three — a
 * stamp saying which shape a file is in, a refusal when that stamp is from a
 * future sonata cannot understand, and an ordered chain to walk an old file
 * forward before the field-level parser ever sees it.
 *
 * Migration is **in-memory only**. `parseConfig` migrates every load, so every
 * command works against an old file; the file itself is rewritten only by
 * `sonata init`, the one command that writes sonata.toml (`sonata sync`
 * regenerates agents and never touches it). A read path that silently rewrote
 * the user's config would make `sonata dispatch` a file-modifying command.
 */

/** The shape this sonata writes and understands. */
export const CURRENT_SCHEMA_VERSION = 2;

/** The top-level key carrying the stamp. */
export const SCHEMA_VERSION_KEY = 'schema_version';

/** One step of the chain: `from` → `to`, transforming the raw parsed TOML. */
export interface Migration {
  from: number;
  to: number;
  /** Takes the raw TOML object and returns the next version's shape. */
  migrate: (raw: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * The chain, ordered by `from`.
 *
 * **Empty, and that is the honest answer for v1.** Version 1 names the shape
 * `parseConfig` already accepts, so a version-0 file — one written before the
 * stamp existed, in either the `[models]`+`[tiers]` shape or the older
 * `[generate.roles]`/`[generate.native]` one — needs no transform to load
 * today: the parser tolerates both, and `sonata init` still rewrites a legacy
 * config through `migrateLegacyConfig` (`src/normalize.ts`) when the user runs
 * it. Inventing a transform here to make the chain look busy would risk the
 * one path that already works.
 *
 * **v2 adds `@default` to the candidate grammar** and needs no transform
 * either — a v1 file cannot contain the value, so there is nothing to
 * rewrite. The bump is not for reading old files: it is for the *forward*
 * direction, which is the one that bit. A config carrying `@default` is
 * unloadable by any sonata predating it, and without a stamp that failure
 * reads `unknown effort level "default" — one of none, minimal, …`, which
 * blames the value and names no remedy. Worse, it takes down the WHOLE
 * config, so every tier in the project dies rather than the one rung.
 * Measured 2026-09-21: exactly that, after a config was hand-edited to
 * `@default` while the router still ran pre-`@default` code.
 *
 * Stamped v2, the same file instead refuses with "this sonata understands up
 * to 1 — upgrade sonata", which is true and actionable. That refusal already
 * exists in released 0.11.2, so the bump reaches installs in the wild.
 *
 * `applyMigrations` takes the list as a parameter so composition is proven by
 * tests against a synthetic chain rather than asserted about an empty one.
 */
export const MIGRATIONS: readonly Migration[] = [];

/**
 * The stamp on a raw config, or 0 when absent.
 *
 * Absent means "written before the stamp existed", which is a real version
 * rather than an error. A present-but-nonsense value is an error: silently
 * treating `schema_version = "two"` as 0 would run migrations against a file
 * whose author believed it was stamped.
 */
export function readSchemaVersion(raw: Record<string, unknown>): number {
  const value = raw[SCHEMA_VERSION_KEY];
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(
      `sonata.toml: ${SCHEMA_VERSION_KEY} must be a non-negative integer, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * Walks a raw config forward to `CURRENT_SCHEMA_VERSION`.
 *
 * Refuses a stamp from the future rather than parsing it best-effort: a newer
 * sonata may have moved a field this one still reads, so a best-effort parse
 * would not fail — it would succeed and mean something else. The same
 * reasoning refuses a mid-pagination version change in the AA catalog fetch.
 */
export function applyMigrations(
  raw: Record<string, unknown>,
  migrations: readonly Migration[] = MIGRATIONS,
  currentVersion: number = CURRENT_SCHEMA_VERSION,
): Record<string, unknown> {
  const version = readSchemaVersion(raw);
  if (version > currentVersion) {
    throw new Error(
      `sonata.toml: ${SCHEMA_VERSION_KEY} is ${version}, but this sonata understands up to ` +
      `${currentVersion} — upgrade sonata (\`npm install -g @zhihaohong52/sonata\`) to read this config.`,
    );
  }

  let current = raw;
  let at = version;
  while (at < currentVersion) {
    const step = migrations.find((migration) => migration.from === at);
    // No step for this version is not a gap to fail on: v0 → v1 has none by
    // design (see MIGRATIONS). Stamping and moving on keeps the loop finite
    // whether or not a given hop needs a transform.
    if (step === undefined) {
      at = at + 1;
      continue;
    }
    current = step.migrate(current);
    at = step.to;
  }

  return { ...current, [SCHEMA_VERSION_KEY]: currentVersion };
}
