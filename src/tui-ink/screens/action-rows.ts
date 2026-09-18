export interface ActionRow { key: string; label: string; runnable: boolean; note: string }

export function actionRows(): ActionRow[] {
  return [
    { key: 's', label: 'sync agents', runnable: true, note: 'regenerate .claude/agents from sonata.toml' },
    { key: 'c', label: 'update catalog', runnable: true, note: 'fetch model rankings and prices' },
    { key: 'l', label: 'install litellm', runnable: false, note: 'run `sonata litellm install` — a multi-minute install is indistinguishable from a hang inside a TUI' },
    { key: 'r', label: 'routing', runnable: false, note: 'run `sonata route auto` — it edits Claude Code settings this screen does not own' },
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
