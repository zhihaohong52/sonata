import { USAGE_DIMENSIONS, type UsageDimension } from '../../commands/usage.js';

/**
 * How often the usage screen re-reads the ledger.
 *
 * Slower than status: this is a report over days, and a 30-day window is a
 * scan of thirty ledger files. Five seconds still shows a dispatch that just
 * finished without the reader wondering whether the screen is live.
 */
export const USAGE_POLL_MS = 5000;

/**
 * The windows `w` cycles through. `sonata usage --since` takes any duration;
 * the screen offers the ones people ask about, and starts on whatever the
 * flag said even when it is not one of these.
 */
export const USAGE_WINDOWS: readonly string[] = ['1h', '24h', '7d', '30d'];

/** The next preset after `current`, or the first when `current` is not a preset. */
export function nextWindow(current: string): string {
  const at = USAGE_WINDOWS.indexOf(current);
  return USAGE_WINDOWS[(at + 1) % USAGE_WINDOWS.length]!;
}

/** The next `--by` dimension, wrapping. */
export function nextDimension(current: UsageDimension): UsageDimension {
  const at = USAGE_DIMENSIONS.indexOf(current);
  return USAGE_DIMENSIONS[(at + 1) % USAGE_DIMENSIONS.length]!;
}

/** A window as a reader says it: `7d` is "last 7 days". */
export function windowLabel(since: string): string {
  const match = /^(\d+)([mhd])$/.exec(since.trim());
  if (match === null) return `last ${since}`;
  const n = Number(match[1]);
  const unit = { m: 'minute', h: 'hour', d: 'day' }[match[2] as 'm' | 'h' | 'd'];
  return n === 1 ? `last ${unit}` : `last ${n} ${unit}s`;
}

/**
 * A token count in at most six cells: `812`, `12.4k`, `3.1M`.
 *
 * The printed report shows exact counts because it has the width; a board row
 * does not, and at the scale a week of routing reaches, the last five digits
 * are noise to a reader comparing buckets.
 */
export function compactCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
  return `${(n / 1_000_000_000).toFixed(1)}B`;
}

/** Which columns a usage row can afford at a given width. */
export interface UsageColumns {
  /** Cells the bucket label may occupy. */
  label: number;
  requests: boolean;
  tokens: boolean;
  covered: boolean;
}

/** Fixed cell widths, each including its leading gap. */
export const USAGE_CELL = { requests: 7, tokens: 16, spent: 11, covered: 11 } as const;

/**
 * The usage board's width budget.
 *
 * Built like `statusColumns`, and for the same reason: fixed columns that add
 * up to more than a narrow terminal wrap every row, and a wrapped row takes
 * the header off the top. Spend is never dropped — it is what the screen is
 * for. Tokens go first, then the request count, then the covered column —
 * covered money outranks a count, since a bucket that is all subscription
 * work shows `—` as spend and only this column says what it was worth. Each
 * is dropped only when the label would otherwise be too short to name the
 * bucket; 20 cells holds most model keys whole.
 */
export function usageColumns(width: number, anyCovered: boolean): UsageColumns {
  const w = Math.max(1, width);
  const MIN_LABEL = 20;
  let requests = true;
  let tokens = true;
  let covered = anyCovered;
  const fixed = (): number => USAGE_CELL.spent
    + (requests ? USAGE_CELL.requests : 0)
    + (tokens ? USAGE_CELL.tokens : 0)
    + (covered ? USAGE_CELL.covered : 0);
  if (w - fixed() < MIN_LABEL) tokens = false;
  if (w - fixed() < MIN_LABEL) requests = false;
  if (w - fixed() < MIN_LABEL) covered = false;
  return { label: Math.max(1, w - fixed()), requests, tokens, covered };
}

/**
 * How many buckets fit above the fold, holding one line back for "N more".
 *
 * At least one whenever there are any, so a very short terminal still shows
 * the largest bucket rather than reading as an empty report.
 */
export function bucketsThatFit(count: number, terminalRows: number, chrome: number): number {
  const room = terminalRows - chrome;
  if (count === 0) return 0;
  if (count <= room) return count;
  return Math.max(1, room - 1);
}
