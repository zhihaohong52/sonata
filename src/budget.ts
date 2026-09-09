/**
 * A ceiling on what the router will spend in a day.
 *
 * Deliberately the smallest thing that works: one number per config file,
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
export function spentTodayUsd(
  home: string,
  now: number = Date.now(),
  filter?: { tenant?: string },
): number {
  let total = 0;
  for (const row of readRows(home, startOfUtcDay(now), now)) {
    // Summed per *tenant*, never per cwd string: one repository entered from
    // two spellings (a subdirectory, a symlinked path) resolves to one
    // `sonata.toml` but writes two `project` values, which would make
    // `daily_usd` a cap per directory spelling rather than per project. Rows
    // written before the tenant field existed carry no id and are therefore
    // outside every project cap — the same way they carried no project.
    if (filter?.tenant !== undefined && row.tenant !== filter.tenant) continue;
    if (row.price.source === 'none' || row.price.totalUsd === undefined) continue;
    total += row.price.totalUsd;
  }
  return total;
}

export interface BudgetStatus {
  dailyUsd: number;
  spentUsd: number;
  /** The sonata.toml that set this cap — named in the refusal, since a project and the machine can each set one. */
  configPath: string;
}

/**
 * Whether this request should be refused, and what to tell the caller. Several
 * caps can apply to one request (the project's and the machine's); the first
 * one reached refuses, naming its own file.
 */
export function budgetRefusal(statuses: BudgetStatus[] | undefined): string | undefined {
  for (const status of statuses ?? []) {
    if (status.spentUsd < status.dailyUsd) continue;
    return (
      `sonata daily budget reached: $${status.spentUsd.toFixed(4)} of ` +
      `$${status.dailyUsd.toFixed(2)} priced spend used today (UTC). ` +
      `Raise or remove [budget] daily_usd in ${status.configPath} to continue. ` +
      'Note this counts priced requests only, and covers the native router path ' +
      'alone — `sonata dispatch` runs never transit the router.'
    );
  }
  return undefined;
}
