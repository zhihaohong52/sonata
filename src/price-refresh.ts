/**
 * Keeping the models.dev price cache fresh, from the router daemon.
 *
 * A price cache is only useful while it matches what the gateways charge, but
 * nothing refreshed it: `sonata catalog update` is manual, so a machine that
 * had not run it in months priced every ledger row on stale rates and said so
 * only in one line of `sonata usage` output that nobody reads until they are
 * already suspicious.
 *
 * The router daemon is the right host and, deliberately, the *only* one. It is
 * long-lived, already does network I/O, and is the process that writes prices
 * into ledger rows in the first place. Putting a fetch into a read-only
 * command instead — `usage`, `doctor` — would make those commands hang on a
 * bad network, which is exactly when someone runs `doctor`.
 *
 * Three properties keep this from ever costing a request:
 *
 *   - It is **never awaited by the request path.** The check runs on a timer;
 *     a request in flight neither triggers nor waits for it.
 *   - A **failure is inert.** `updateModelsDev` already refuses to overwrite a
 *     good cache with a bad response, so an outage leaves the previous prices
 *     in place; this only logs and waits for the next tick. There is no tight
 *     retry, because the failure it is most likely to hit is "no network",
 *     which retrying in a loop cannot fix.
 *   - The timer is **unref'd**, so it never holds the process open by itself.
 */
import { loadModelsDev } from './modelsdev.js';

/** Refresh when the cache is older than this. */
export const PRICE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** How often to *check* the age. Cheap: a check is a file read, not a fetch. */
export const PRICE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface PriceRefreshDeps {
  /** Performs the fetch and writes the cache. */
  update: (home: string) => Promise<unknown>;
  now?: () => number;
  log?: (line: string) => void;
  /** Test seam: `setInterval` returns a handle we only ever `unref`/`clear`. */
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}

/**
 * Whether the cache warrants a fetch: absent, unreadable, or past its age.
 *
 * A cache whose `fetchedAt` will not parse, or names a moment in the future,
 * is treated as stale rather than fresh — neither is evidence of freshness,
 * and reading either as such would pin a broken cache in place.
 */
export function priceCacheIsStale(home: string, now: number): boolean {
  const cache = loadModelsDev(home);
  if (cache === undefined) return true;
  const fetched = Date.parse(cache.fetchedAt);
  if (!Number.isFinite(fetched)) return true;
  // A timestamp in the future is stale too. `fetchedAt` comes from the host
  // clock, so a correction backwards leaves a cache dated ahead of now:
  // `now - fetched` is then negative, the age check never fires, and the
  // router serves outdated rates until real time catches up — up to the skew
  // plus a full day. Same reasoning as the unparseable case above: a
  // timestamp that cannot be true is not evidence of freshness.
  if (fetched > now) return true;
  return now - fetched >= PRICE_MAX_AGE_MS;
}

/**
 * Refreshes once if the cache is stale. Resolves to what it did, so a caller
 * (and a test) can tell "declined because fresh" from "tried and failed".
 */
export async function refreshPricesIfStale(
  home: string,
  deps: PriceRefreshDeps,
): Promise<'fresh' | 'updated' | 'failed'> {
  const now = (deps.now ?? Date.now)();
  if (!priceCacheIsStale(home, now)) return 'fresh';
  try {
    await deps.update(home);
    deps.log?.('prices: models.dev cache refreshed');
    return 'updated';
  } catch (error) {
    // Never rethrown: this runs detached on a timer, and an unhandled
    // rejection there would take down a router that is otherwise healthy and
    // serving requests perfectly well on slightly old prices.
    deps.log?.(`prices: refresh failed (${(error as Error).message}) — keeping the existing cache`);
    return 'failed';
  }
}

/**
 * Starts the periodic check. Returns a stop function for shutdown and tests.
 *
 * The first check runs immediately rather than after one interval: a daemon
 * restarted after a long gap should not serve six hours of requests on months-
 * old prices when a refresh was available at startup.
 */
export function startPriceRefresh(home: string, deps: PriceRefreshDeps): () => void {
  const setTimer = deps.setInterval ?? setInterval;
  const clearTimer = deps.clearInterval ?? clearInterval;

  void refreshPricesIfStale(home, deps);
  const handle = setTimer(() => { void refreshPricesIfStale(home, deps); }, PRICE_CHECK_INTERVAL_MS);
  // A refresh timer must never be the reason the process stays alive.
  (handle as { unref?: () => void }).unref?.();
  return () => { clearTimer(handle); };
}
