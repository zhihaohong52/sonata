/**
 * Reasoning-effort levels, and the candidate grammar that carries one.
 *
 * This module has no imports on purpose: `config.ts` needs the grammar to
 * validate a tier list and `catalog.ts` needs the enum to group AA rows, and
 * neither may import the other.
 *
 * The enum is the wire vocabulary — LiteLLM's `reasoning_effort` set plus
 * `max`, which AA publishes and OpenAI accepts — rather than a per-vendor
 * table. Which levels a *given model* has is answered by the catalog, never
 * here.
 */
export const EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export function isEffort(value: string): value is Effort {
  return (EFFORT_LEVELS as readonly string[]).includes(value);
}

/**
 * `<key>@<effort>` → its parts. Split on the *last* `@`: a model key is
 * `<harness>-<provider>-<model>` with slashes flattened to dashes, so `@`
 * never appears inside one today, and the last-`@` rule keeps that true if
 * one ever does.
 */
export function splitCandidate(candidate: string): { key: string; effort?: Effort } {
  const at = candidate.lastIndexOf('@');
  if (at < 0) return { key: candidate };
  const key = candidate.slice(0, at);
  const level = candidate.slice(at + 1);
  if (key === '') {
    throw new Error(`"${candidate}": a model key must precede "@"`);
  }
  if (level === '') {
    throw new Error(`"${candidate}": an effort level follows "@" — one of ${EFFORT_LEVELS.join(', ')}`);
  }
  if (!isEffort(level)) {
    throw new Error(`"${candidate}": unknown effort level "${level}" — one of ${EFFORT_LEVELS.join(', ')}`);
  }
  return { key, effort: level };
}

export function joinCandidate(key: string, effort?: Effort): string {
  return effort === undefined ? key : `${key}@${effort}`;
}

/**
 * The level an Artificial Analysis row was evaluated at, read from the
 * trailing parenthetical of its display name: `GPT-5.6 Luna (max)`,
 * `DeepSeek V4 Pro (Reasoning, High Effort)`, `GPT-5.2 (Non-Reasoning)`.
 *
 * Only a token from the enum is read as a level; everything else AA puts in
 * that position — a date (`Dec '24`), `Preview`, `Vision`, `32B`, a bare
 * `Reasoning` — yields no effort. `Non-reasoning` is checked first because
 * Anthropic rows spell thinking-off as `Non-reasoning, High Effort`, where
 * the level word describes something sonata cannot set on a foreign model.
 */
export function parseAaEffort(name: string): Effort | undefined {
  const match = /\(([^)]*)\)\s*$/.exec(name);
  if (match === null) return undefined;
  const label = match[1].toLowerCase();
  if (/\bnon-reasoning\b/.test(label)) return 'none';
  const level = /\b(minimal|low|medium|high|xhigh|max)\b/.exec(label);
  return level === null ? undefined : (level[1] as Effort);
}

/** How the level is spelled at the end of an AA slug (`…-non-reasoning`). */
export function aaEffortSuffix(effort: Effort): string {
  return effort === 'none' ? 'non-reasoning' : effort;
}
