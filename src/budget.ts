/**
 * A ceiling on what the router will spend in a day.
 *
 * Deliberately the smallest thing that works: one number the user writes down,
 * checked against what the ledger has already recorded. No forecasting, no
 * per-role split, no auto-tuning — those need real usage data to calibrate
 * against, and guessing a heuristic now would bake in numbers nobody has
 * measured.
 *
 * Two honesty constraints shape the whole feature, and both are limits worth
 * stating out loud rather than papering over:
 *
 * **It counts priced volume only.** The ledger records a row as unpriced when
 * no rate is known for that model and gateway, and `sonata usage` reports that
 * volume beside the priced total rather than folding it in as zero. A cap has
 * to keep the same discipline: an unpriced request is spend of unknown size,
 * not spend of no size, so real spending can exceed a cap that only ever sees
 * the priced part. Counting unknown as zero would make the cap quietly
 * permissive in exactly the case the user is least able to notice.
 *
 * **It covers the native path only.** A `sonata dispatch` run executes inside
 * the foreign CLI's own process and never transits the router, so its tokens
 * are unobservable here — the same reason `sonata usage` reports native
 * traffic alone. This is a cap on what the router forwards, not on what sonata
 * causes to be spent.
 */
import { readRows } from './ledger.js';

/** UTC, because the ledger's own daily files roll over on UTC. */
export function startOfUtcDay(now: number): number {
  return Date.UTC(
    new Date(now).getUTCFullYear(),
    new Date(now).getUTCMonth(),
    new Date(now).getUTCDate(),
  );
}

/**
 * Priced spend recorded so far in the current UTC day.
 *
 * A `totalUsd` of 0 is a real price (a free tier), so only `source: 'none'` and
 * a missing total are skipped — the same test `sonata usage` applies, kept
 * identical on purpose so the number a user sees there is the number the cap
 * compares against.
 */
export function spentTodayUsd(home: string, now: number = Date.now()): number {
  let total = 0;
  for (const row of readRows(home, startOfUtcDay(now), now)) {
    if (row.price.source === 'none' || row.price.totalUsd === undefined) continue;
    total += row.price.totalUsd;
  }
  return total;
}

export interface BudgetStatus {
  dailyUsd: number;
  spentUsd: number;
}

/**
 * Whether this request should be refused, and what to tell the caller.
 *
 * At the cap, not merely over it: the next request's cost is unknown before it
 * runs, so the only moment a limit can be enforced is before forwarding one
 * that would cross it.
 *
 * The message names the cap, the spend, and the file to edit. A refusal whose
 * remedy the user has to go looking for reads as a malfunction — and this one
 * arrives as a 429, which every other source of 429 in this system means
 * "rate limited, retry later" rather than "you set this deliberately".
 */
export function budgetRefusal(status: BudgetStatus | undefined): string | undefined {
  if (status === undefined) return undefined;
  if (status.spentUsd < status.dailyUsd) return undefined;
  return (
    `sonata daily budget reached: $${status.spentUsd.toFixed(4)} of ` +
    `$${status.dailyUsd.toFixed(2)} priced spend used today (UTC). ` +
    'Raise or remove [budget] daily_usd in sonata.toml to continue. ' +
    'Note this counts priced requests only, and covers the native router path ' +
    'alone — `sonata dispatch` runs never transit the router.'
  );
}
