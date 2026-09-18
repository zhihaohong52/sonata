import type { Check } from '../../commands/doctor.js';

/** One doctor finding as the overview draws it. */
export interface OverviewRow { name: string; ok: boolean; detail: string }

/**
 * Doctor's checks in the order the overview shows them: failures first.
 *
 * Stable within each group, so a check a reader has learned the position of
 * does not move when an unrelated one starts failing.
 */
export function overviewRows(checks: readonly Check[]): OverviewRow[] {
  const failed = checks.filter((check) => !check.ok);
  const passed = checks.filter((check) => check.ok);
  return [...failed, ...passed].map((check) => ({
    name: check.name, ok: check.ok, detail: check.detail,
  }));
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
  if (warnings === 0) return 'all checks pass';
  return `${warnings} warning${warnings === 1 ? '' : 's'}`;
}
