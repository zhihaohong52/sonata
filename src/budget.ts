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
 * **A dispatch run is counted when it finishes, not while it runs.** A
 * `sonata dispatch` run executes inside the foreign CLI's own process and
 * never transits the router; its tokens are read from the harness's own store
 * afterwards (`src/harness-usage.ts`) and land in the same ledger, so both
 * lanes count toward one cap. `sonata dispatch` refuses to launch once a cap
 * is reached — but it cannot stop a run midway the way the router refuses a
 * request, so a single run can carry spend past the cap.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { GLOBAL_CONFIG_RELATIVE, configPath, loadConfig } from './config.js';
import { readRows } from './ledger.js';
import { canonicalConfigPath, tenantId } from './native/tenants.js';

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
 * A `totalUsd` of 0 is a real price (a free tier). Unpriced and subscription-
 * covered rows are skipped — covered work has a list value but no per-token
 * charge, so it can never move a budget refusal.
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
    if (row.price.source === 'none' || row.price.source === 'covered' || row.price.totalUsd === undefined) continue;
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
      'Note this counts priced spend only, and counts a `sonata dispatch` run ' +
      'when it finishes, so one run can carry spend past the cap.'
    );
  }
  return undefined;
}

/**
 * The caps that apply to a `sonata dispatch` launched from `cwd`: the
 * project's own and the machine's — the same two the router applies to a
 * request from this directory, compared on canonical paths for the same
 * reason (see `budgetStatusesFor` in `commands/serve.ts`): a project whose
 * config IS the machine config has one cap, not two.
 */
export function dispatchBudgetStatuses(cwd: string, home: string, now: number = Date.now()): BudgetStatus[] | undefined {
  const out: BudgetStatus[] = [];
  const machineRaw = join(home, GLOBAL_CONFIG_RELATIVE);
  const machinePath = canonicalConfigPath(machineRaw);
  const projectRaw = configPath(cwd, home);
  if (projectRaw !== null) {
    const projectPath = canonicalConfigPath(projectRaw);
    const cap = projectPath === machinePath ? undefined : loadConfig(cwd, home).budget?.dailyUsd;
    if (cap !== undefined) {
      out.push({ dailyUsd: cap, spentUsd: spentTodayUsd(home, now, { tenant: tenantId(projectPath) }), configPath: projectRaw });
    }
  }
  if (existsSync(machineRaw)) {
    let cap: number | undefined;
    try {
      cap = loadConfig(join(home, '.config', 'sonata'), home).budget?.dailyUsd;
    } catch {
      // A machine config that will not load sets no cap here; `sonata doctor` names it.
    }
    if (cap !== undefined) out.push({ dailyUsd: cap, spentUsd: spentTodayUsd(home, now), configPath: machineRaw });
  }
  return out.length === 0 ? undefined : out;
}
