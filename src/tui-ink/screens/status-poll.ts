/**
 * How often the status screen re-reads the router and the ledger.
 *
 * Generous on purpose: this is a screen someone reads, not a meter they stare
 * at, and every tick costs an HTTP call plus a scan of the day's ledger files.
 * Two seconds is under the threshold where a reader would start wondering
 * whether it is live at all, and far above the rate at which either source
 * meaningfully changes.
 */
export const STATUS_POLL_MS = 2000;

/**
 * How long ago, in the shortest form that is still true.
 *
 * Shown beside the header so a stalled poller is visible: without it a frozen
 * screen and a quiet one look identical, and the screen most worth trusting
 * is the one you reach when something is already wrong.
 */
export function agoLabel(ms: number): string {
  if (ms < 1500) return 'just now';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}
