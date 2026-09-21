/**
 * Reasoning-effort levels, and the candidate grammar that carries one.
 *
 * This module has no imports on purpose: `config.ts` needs the grammar to
 * validate a tier list and `catalog.ts` needs the enum to group AA rows, and
 * neither may import the other.
 *
 * The enum is the candidate grammar, not a per-vendor table. Which levels a
 * *given model* has is answered by the catalog, never here.
 *
 * All of it but `default` is wire vocabulary — LiteLLM's `reasoning_effort`
 * set plus `max`, which AA publishes and OpenAI accepts.
 *
 * `default` is the one member that is NOT a wire value: it means "run the
 * model as it ships", i.e. send no `reasoning_effort` at all. It exists
 * because `none` was being made to carry two incompatible facts — "AA
 * evaluated this with reasoning explicitly OFF", and "AA stated no level".
 * `parseAaEffort` already tells those apart, returning `none` only for an
 * explicit `Non-Reasoning`; the catalog then coerced `undefined` to `none`
 * and threw the distinction away.
 *
 * Measured on a real catalog: 235 of 315 families were recorded `none` on
 * that coercion alone, including `claude-4-5-sonnet-thinking`,
 * `claude-4-5-haiku-reasoning` and `gemini-2-5-pro` — models ranked on a
 * reasoning score and then asked not to reason, which is precisely the
 * mismatch the `@<effort>` grammar exists to prevent. Most degrade silently;
 * `glm-5.3-flash` is the one that fails loudly, because its endpoint refuses
 * to run with reasoning disabled (`Reasoning is mandatory for this endpoint
 * and cannot be disabled`), so every ranked entry for it 400d unconditionally.
 *
 * It is deliberately NOT sent as the literal string `"default"`, although
 * LiteLLM's own signature accepts one. The `direct` transport bypasses
 * LiteLLM and posts to an Anthropic-native gateway, which has no
 * `reasoning_effort` field at all — omitting is the only behaviour correct on
 * both transports, and it is what "as it ships" means anyway.
 */
export const EFFORT_LEVELS = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
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

/**
 * The value to put on the wire, or `undefined` to send no `reasoning_effort`
 * field at all.
 *
 * One definition, because the router and all four adapters each need the same
 * answer and a second copy is how they stop agreeing.
 */
export function wireEffort(effort: Effort | undefined): Exclude<Effort, 'default'> | undefined {
  return effort === undefined || effort === 'default' ? undefined : effort;
}
