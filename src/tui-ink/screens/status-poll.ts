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

/**
 * The wall-clock time a route was served, in the reader's own timezone.
 *
 * Local, not UTC: this line is read by a person sitting at the machine
 * deciding whether what they just dispatched is the row on screen. The ledger
 * keeps UTC — `ledgerPathFor` explains why, a local date would roll the file
 * over at the wrong moment — and the conversion belongs here, at the surface
 * a human reads, rather than in the store.
 *
 * Seconds are included because routes arrive in bursts: a tier with fallbacks
 * can write three rows inside one minute, and `14:03` three times over says
 * less than nothing.
 */
export function localTime(ts: string | undefined): string {
  if (ts === undefined) return '';
  const at = new Date(ts);
  if (Number.isNaN(at.getTime())) return '';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

/** Which columns a status row can afford at a given width. */
export interface StatusColumns {
  time: boolean;
  tokens: boolean;
  gateway: boolean;
  /** Cells the alias may occupy. */
  alias: number;
  /** Cells the served model (plus its effort suffix) may occupy. */
  served: number;
}

/**
 * The status board's width budget.
 *
 * It had none: the alias was padded to a fixed 26 and the served model and
 * token counts ran free, so a narrow terminal wrapped every row — and because
 * a wrapped row is two rows, the screen's own header scrolled off the top.
 * Reported as `sonata status` simply not showing at some widths, which is
 * what it looked like. Measured broken at 40, 50 and 60 columns.
 *
 * Columns are dropped in reverse order of how much they answer. Tokens go
 * first: they are the only field a reader can get from `sonata usage`
 * instead. The gateway goes next, since the served model still names what
 * ran. The timestamp is kept longest despite being cheap to lose, because
 * "when" is the field with no other home on this screen — the alias and the
 * model are both in the row itself.
 */
export function statusColumns(width: number): StatusColumns {
  const tokens = width >= 96;
  const gateway = width >= 76;
  const time = width >= 52;
  // What the two flexible name columns share, after the fixed cells: 4 for the
  // status code, 4 for the stroke and its padding, and whatever the optional
  // columns take when present.
  const fixed = 4 + 4 + (time ? 9 : 0) + (gateway ? 12 : 0) + (tokens ? 20 : 0);
  // No minimum that can exceed what the terminal has. The previous version
  // floored the names at 16 cells and each column at 8, which is right on a
  // wide terminal and adds up to MORE than a narrow one — 24 cells of floor
  // on a 19-cell page — so every row wrapped. The shares now come out of what
  // is actually there, however little that is.
  const names = Math.max(2, width - fixed);
  const alias = Math.max(1, Math.floor(names * 0.45));
  return { time, tokens, gateway, alias, served: Math.max(1, names - alias - 1) };
}

/**
 * How many routes fit above the fold.
 *
 * The board drew a fixed twelve however tall the terminal was. A route costs
 * one line plus one per failed attempt behind it, so a burst of fallbacks in
 * a short window pushed the screen's own header off the top — which, with the
 * wrapping bug that shipped alongside it, is why `sonata status` looked like
 * it was not rendering at all.
 *
 * `chrome` is what the screen spends on itself: the two headings, their
 * rules, the router line and the footer. Returning at least one route keeps
 * the screen honest on a very short terminal — showing nothing would read as
 * "nothing routed", which is a different and wrong claim.
 */
export function routesThatFit(
  costs: readonly number[],
  terminalRows: number,
  chrome = 9,
): number {
  const room = terminalRows - chrome;
  if (room <= 0) return Math.min(1, costs.length);
  let used = 0;
  let taken = 0;
  for (const cost of costs) {
    if (used + cost > room) break;
    used += cost;
    taken++;
  }
  return Math.max(Math.min(1, costs.length), taken);
}
