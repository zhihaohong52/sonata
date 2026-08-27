/**
 * `sonata status` — what the router is doing, and what it recently did.
 *
 * This promotes `grep '\-> litellm' serve-*.log` into a product surface. It is
 * a different question from `sonata route status`, which reports whether
 * *settings* route this project's sessions; each command's output should point
 * at the other, because the names are close enough to confuse.
 */
import type { LedgerRow } from '../ledger.js';

export interface RouteLine {
  alias: string;
  attempts: { key: string; status: number }[];
  /** Absent when every candidate failed. A successful direct (keyless) model
   * request — no key, no failed candidates — surfaces its alias instead. */
  served?: string;
  status: number;
  input: number;
  output: number;
}

export function recentRoutes(rows: LedgerRow[], limit: number): RouteLine[] {
  return [...rows]
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
    .slice(0, limit)
    .map((row) => ({
      alias: row.alias,
      attempts: row.attempts,
      served: row.key ?? (row.attempts.length === 0 ? row.alias : undefined),
      status: row.status,
      input: row.tokens.input,
      output: row.tokens.output,
    }));
}