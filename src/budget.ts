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
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
  /**
   * The load error for a config that sets a cap but will not load. A cap that
   * cannot be read is not the same as no cap: reading it as absent lets spend
   * proceed exactly where the user asked to bound it.
   */
  unreadable?: string;
}

/**
 * Whether this request should be refused, and what to tell the caller. Several
 * caps can apply to one request (the project's and the machine's); the first
 * one reached refuses, naming its own file.
 */
export function budgetRefusal(statuses: BudgetStatus[] | undefined): string | undefined {
  for (const status of statuses ?? []) {
    // Before the spend comparison: an unreadable cap is checked first, or a
    // broken file whose (lost) cap had room would read as room that exists.
    if (status.unreadable !== undefined) {
      return (
        `sonata budget cannot be checked: ${status.configPath} sets [budget] but will not load ` +
        `(${status.unreadable}). Fix the file to continue — sonata refuses rather than spend without the cap.`
      );
    }
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
 * A line that sets `[budget]` in any legal TOML spelling: a table header
 * (spaces inside the brackets, a quoted name and a trailing comment all
 * allowed) or a top-level `budget.` / `budget =` key. Matching only the bare
 * `[budget]` line let a broken file that wrote its cap another way lose it
 * silently. A `[budget.x]` subtable header and a key like `budgeted` do not
 * count; a commented-out line never starts with the name, so it does not
 * either. Erring wide is safe here: this is consulted only for a file that
 * already fails to load.
 */
const SETS_BUDGET = /^[ \t]*(?:\[[ \t]*(?:budget|"budget"|'budget')[ \t]*\]|(?:budget|"budget"|'budget')[ \t]*[.=])/m;

/**
 * The refusing status for a machine config that sets `[budget]` but will not
 * load — recovered from the raw file, since `loadConfig` can only say "this
 * does not parse". A cap's only visible effect is a refusal that has not
 * happened yet, so a machine cap lost to a load error reads exactly like one
 * that is working, right up until the bill.
 *
 * A broken machine config with no `[budget]` table had no cap to lose and
 * must not start refusing everything, so the table header has to be visible
 * in the raw text (`[budget]` alone on its line — a commented-out mention is
 * not a table). The status carries the raw path and zero spend because the
 * real numbers are unknowable for a file that will not load; `budgetRefusal`
 * refuses on `unreadable` before ever looking at them.
 */
export function unreadableMachineBudget(home: string): BudgetStatus | undefined {
  const raw = join(home, GLOBAL_CONFIG_RELATIVE);
  if (!existsSync(raw)) return undefined;
  let text: string;
  try {
    text = readFileSync(raw, 'utf8');
  } catch {
    // Unreadable as bytes too, so there is no way to know it had a cap.
    return undefined;
  }
  try {
    loadConfig(dirname(raw), home);
    return undefined; // loads — a missing cap here is a real absence
  } catch (err) {
    if (!SETS_BUDGET.test(text)) return undefined;
    return {
      dailyUsd: 0,
      spentUsd: 0,
      configPath: raw,
      unreadable: err instanceof Error ? err.message : String(err),
    };
  }
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
      // A machine config that will not load sets no readable cap here. When
      // it had a [budget] table to lose, that is a refusal rather than a
      // silence; `unreadableMachineBudget` decides which, so a broken file
      // with no cap does not refuse everything.
      const unreadable = unreadableMachineBudget(home);
      if (unreadable !== undefined) out.push(unreadable);
    }
    if (cap !== undefined) out.push({ dailyUsd: cap, spentUsd: spentTodayUsd(home, now), configPath: machineRaw });
  }
  return out.length === 0 ? undefined : out;
}
