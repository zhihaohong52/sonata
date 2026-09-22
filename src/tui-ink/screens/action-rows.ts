export interface ActionRow { key: string; label: string; runnable: boolean; note: string }

/*
 * Every row here runs.
 *
 * `install litellm` and `routing` were listed as unavailable on two reasons
 * that were true while this screen was a leaf and are false now that `Setup`
 * is a row in the same menu:
 *
 * - "a multi-minute install is indistinguishable from a hang inside a TUI" —
 *   but the catalog action beside it already runs async behind a progress
 *   line, and `Setup` runs the *real* LiteLLM installer from inside this same
 *   shell. The shell already performs a multi-minute install; what it needed
 *   was to say so while it happens, which is a running state, not a refusal.
 * - "it edits Claude Code settings this screen does not own" — but init calls
 *   `cmdRoute('auto', …)` in `apply.ts`, so the shell already edits them.
 *
 * Two rows advertising keys that did nothing, three lines above a row that
 * does both, is the screen contradicting itself — and a menu whose entries
 * cannot be actioned teaches the reader to stop trusting the menu.
 */

/*
 * Every row here runs.
 *
 * `install litellm` and `routing` were listed as unavailable, on two reasons
 * that were true when this screen was a leaf and are false now that `Setup`
 * is a row in the same menu:
 *
 * - "a multi-minute install is indistinguishable from a hang inside a TUI" —
 *   but the catalog action beside it already runs async behind a progress
 *   line, and `Setup` runs the *real* LiteLLM installer from inside this same
 *   shell. The shell already does a multi-minute install; what it needed was
 *   to say so while it happens.
 * - "it edits Claude Code settings this screen does not own" — but init calls
 *   `cmdRoute('auto', …)` as part of apply, so the shell already edits them.
 *
 * Two rows advertising keys that did nothing, directly above a row that does
 * both, is the screen contradicting itself. A menu whose entries cannot be
 * actioned teaches the reader to stop trusting the menu.
 */

export function actionRows(): ActionRow[] {
  return [
    { key: 's', label: 'sync agents', runnable: true, note: 'regenerate .claude/agents from sonata.toml' },
    { key: 'c', label: 'update catalog', runnable: true, note: 'fetch model rankings and prices' },
    { key: 'l', label: 'install litellm', runnable: true, note: 'set up the pinned venv that translates for non-Anthropic gateways' },
    { key: 'r', label: 'route this project', runnable: true, note: 'install the hooks that route plain `claude` sessions through sonata' },
  ];
}

export function summariseSync(result: { written: string[]; stale: string[]; skipped: string[] }): string {
  return `wrote ${result.written.length} · ${result.stale.length} stale · ${result.skipped.length} skipped`;
}

/**
 * The stale files by name, for the screen to show beneath the summary.
 *
 * Separate from `summariseSync` so the summary is one stable line whatever the
 * file count — and named at all because sonata deliberately does **not** delete
 * a stale agent. Claude Code goes on offering it as a subagent type whose alias
 * no longer resolves, so a dispatch to it fails rather than falling back; a
 * count alone does not tell you which one to remove.
 */
export function staleNames(result: { stale: string[] }): string[] {
  return [...result.stale];
}

/**
 * What a catalog update actually did, per source.
 *
 * `cmdCatalogUpdate` fetches two independent catalogs and **returns** each
 * outcome rather than throwing, so one can fail while the other succeeds. A
 * screen that only handled the promise rejection could therefore never report
 * a failed half at all — the old one stringified the whole result, which is
 * why the failure was visible and also why it read as a debug dump.
 *
 * Each source is named, because the two are not interchangeable: Artificial
 * Analysis supplies the ranking and models.dev the prices, so "half of it
 * worked" has different consequences depending on which half.
 */
export function summariseCatalog(result: {
  aa: { models: number } | { error: Error };
  modelsDev: { models: number } | { error: Error };
}): string {
  const part = (name: string, outcome: { models: number } | { error: Error }): string =>
    'error' in outcome ? `${name} failed — ${outcome.error.message}` : `${name} ${outcome.models} models`;
  return `${part('rankings', result.aa)} · ${part('prices', result.modelsDev)}`;
}
