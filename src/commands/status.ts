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
  /**
   * When the router served it, as the ledger's ISO stamp.
   *
   * The ledger has always recorded this and the view dropped it, so a reader
   * could see *what* ran but never *when* — and "the last hour" is a
   * different claim from "four seconds ago". Rendered in local time, because
   * it is read by a person sitting at the machine; the ledger keeps UTC, for
   * the reason `ledgerPathFor` records.
   */
  ts?: string;
  /**
   * Which gateway served it. The same model can be reachable through several,
   * and when one is rate-limited or billing-capped the question is always
   * "which provider was that" — recorded per row, never surfaced.
   */
  gateway?: string;
  /**
   * The reasoning-effort level the router sent, when the candidate pinned one.
   *
   * Present means it was SENT, not honoured: a provider with no effort
   * control drops the field silently and the router cannot tell. Shown
   * because two rows of one model at different levels are otherwise
   * indistinguishable, which is exactly the case a reader is checking.
   */
  effort?: string;
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
      ts: row.ts,
      gateway: row.gateway,
      effort: row.effort,
    }));
}