/**
 * Extended context for foreign-model subagents.
 *
 * Claude Code sizes a subagent's context window from its *model*, and it has
 * no idea what a sonata tier alias resolves to — `sonata-code-simple` is not a
 * name it recognises, so it falls back to a default rather than the real
 * window of whichever gateway model answers. Two levers exist, both
 * session-wide from sonata's side, and they apply to different ids:
 *
 * - `CLAUDE_CODE_MAX_CONTEXT_TOKENS` applies **directly** to an unrecognized,
 *   non-`claude-` id that carries no `[1m]` suffix — which is exactly what a
 *   bare sonata alias is. (For an id Claude Code *does* recognise it needs
 *   `DISABLE_COMPACT` as well, which is why it never throttles the main
 *   Claude conversation. Measured 2026-09-11: set to 37000, a routed
 *   interactive session on `claude-fable-5-1[1m]` still reported a 1M window.)
 * - An id that *contains* `[1m]` is assumed to have a 1M window, and the
 *   suffix is stripped before the request is forwarded. Measured the same day:
 *   an agent declaring `model: sonata-explore-simple[1m]` produced the router
 *   line `model=sonata-explore-simple -> gpt-5.6-luna -> litellm`, so the
 *   suffix costs nothing at the routing layer and `resolveTierAlias` needs no
 *   change.
 *
 * The second lever is per-alias, which is what makes a per-tier window
 * possible at all. The first is one number for every remaining alias, so it
 * has to stay the smallest window that could answer.
 */
import type { SonataConfig } from './config.js';

/** The window Claude Code assumes for an id carrying `[1m]`. */
export const EXTENDED_CONTEXT_TOKENS = 1_000_000;

/** The suffix Claude Code reads as "assume a 1M window", then strips. */
export const EXTENDED_CONTEXT_SUFFIX = '[1m]';

/**
 * Whether every model that could serve this tier has a 1M-or-larger window.
 *
 * Three deliberate refusals, each one the difference between an unused window
 * and a run that dies on its first oversized request:
 *
 * - **Every** candidate must qualify, not the best one. A tier is a ranked
 *   fallback list; the claim has to hold for whichever model actually answers.
 * - A candidate declaring **no** `context_window` disqualifies the tier.
 *   Unknown is not 1M, and this is the one place where guessing upward turns a
 *   wasted window into a hard context-limit error.
 * - Only **natively routed** candidates count. A harness-only entry is a
 *   `sonata dispatch` fallback that never serves the alias, so its absent
 *   window must not veto the tier — but a tier with no native candidate at all
 *   cannot qualify, because nothing there answers through the router.
 */
export function tierQualifiesForExtendedContext(config: SonataConfig, keys: readonly string[]): boolean {
  let native = 0;
  for (const key of keys) {
    const model = config.unifiedModels[key];
    if (model === undefined || model.gateway === undefined) continue;
    native += 1;
    if (model.contextWindow === undefined || model.contextWindow < EXTENDED_CONTEXT_TOKENS) return false;
  }
  return native > 0;
}

/**
 * The floor for every alias that is *not* addressed through a `[1m]` suffix.
 *
 * Models at or above the extended-context threshold are excluded: they are
 * reached through a suffixed alias which no longer consults this variable, and
 * leaving them in could only drag the floor down for the models that do. When
 * nothing is left below the threshold there is no floor to declare, and the
 * variable is omitted rather than written at a value that means nothing.
 */
export function contextFloorFor(windows: readonly number[]): number | undefined {
  const below = windows.filter((window) => window < EXTENDED_CONTEXT_TOKENS);
  return below.length === 0 ? undefined : Math.min(...below);
}

/**
 * What routing costs the *main* session, and how to get it back.
 *
 * Pointing `ANTHROPIC_BASE_URL` at sonata's router makes Claude Code treat the
 * endpoint as an LLM gateway, and behind a gateway it cannot verify that a
 * model really has the 1M window it claims natively — so Sonnet 5, the Fable
 * models and Opus 4.7+ are budgeted at 200K instead. An *explicit* `[1m]` is
 * immune, because there is nothing left to verify; that is why a session
 * pinned to `fable[1m]` keeps its full window while a bare `sonnet` does not.
 *
 * Sonata causes this and nothing on screen says so: the window silently
 * shrinks by 80% and the only clue is a number in `/context`. Hence the
 * advisory. Sonata deliberately does **not** apply the fix itself — on Pro,
 * Opus at 1M draws usage credits, and behind a gateway Claude Code skips the
 * credit check and lets the upstream decide, so enabling it unasked could
 * spend a user's money.
 */
export function extendedContextAdvice(input: { routed: boolean; model?: unknown }): string | undefined {
  if (!input.routed) return undefined;
  // `model` arrives from a settings file, which is an open record: it can hold
  // any JSON value. A non-string is not a model name, so it is treated as
  // unset rather than coerced — and never reaches a string method, which is
  // how it previously threw and took the whole of `sonata doctor` down with
  // it. A diagnostic that crashes is worse than the problem it diagnoses.
  const model = typeof input.model === 'string' ? input.model : undefined;
  if (model !== undefined && model.toLowerCase().includes(EXTENDED_CONTEXT_SUFFIX)) return undefined;
  const fix = model === undefined
    ? 'pin one with the suffix (e.g. `"model": "opus[1m]"`), or pick the "(1M context)" entry in `/model`'
    : `set \`"model": "${model}${EXTENDED_CONTEXT_SUFFIX}"\`, or pick the "(1M context)" entry in \`/model\``;
  return `routing budgets a native 1M model at 200K — Claude Code cannot verify 1M support behind a gateway; ${fix}`;
}
