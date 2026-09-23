import type { Check } from '../../commands/doctor.js';

/** One doctor finding as the overview draws it. */
export interface OverviewRow { name: string; ok: boolean; detail: string }

/**
 * Only what is wrong.
 *
 * A passing check is not information, it is reassurance — and twenty rows of
 * reassurance is where the two that matter go to hide. `sonata doctor` still
 * prints every check, because that is a report someone reads deliberately;
 * this is a home screen someone glances at, and a glance should land on the
 * problem or on nothing at all.
 *
 * Order is doctor's own, which groups related checks. Failures were once
 * sorted to the top; with the passes gone there is nothing to sort them above,
 * and doctor's order carries meaning that a re-sort would discard.
 */
export function overviewRows(checks: readonly Check[]): OverviewRow[] {
  return checks
    .filter((check) => !check.ok)
    .map((check) => ({ name: check.name, ok: check.ok, detail: check.detail }));
}

/**
 * The one-line state for the header.
 *
 * An empty list reports "no checks ran" rather than everything passing: it is
 * what a thrown `cmdDoctor` routes to, and claiming health from an absence of
 * results is the wrong direction to be wrong in.
 */
export function summarise(checks: readonly Check[]): string {
  if (checks.length === 0) return 'no checks ran';
  const warnings = checks.filter((check) => !check.ok).length;
  if (warnings === 0) return `${checks.length} checks pass`;
  return `${warnings} of ${checks.length} checks need attention`;
}
