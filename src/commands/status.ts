/**
 * `sonata status` — what the router is doing, and what it recently did.
 *
 * This promotes `grep '\-> litellm' serve-*.log` into a product surface. It is
 * a different question from `sonata route status`, which reports whether
 * *settings* route this project's sessions; each command's output should point
 * at the other, because the names are close enough to confuse.
 */
import type { LedgerRow } from '../ledger.js';
import { configPath } from '../config.js';
import { canonicalConfigPath, tenantId } from '../native/tenants.js';

/**
 * The tenant a directory belongs to, resolved exactly as the router resolves
 * one: the config `configPath` picks for it, canonicalised, hashed.
 *
 * Not a bare `cwd` comparison, which is what the TUI used and what the spec
 * forbids. A linked worktree borrows its main checkout's config and shares
 * its tenant id, so it must see that checkout's rows; a symlinked path is the
 * same project under another spelling. Both fall out of using the router's own
 * identity, and neither survives a string compare.
 *
 * `undefined` when no config resolves at all. Nothing can be attributed to
 * "this project" then — the router answers such a request with a 400 and
 * writes no row — so the caller says so rather than showing a list.
 */
export function projectTenant(cwd: string, home: string): string | undefined {
  const path = configPath(cwd, home);
  return path === null ? undefined : tenantId(canonicalConfigPath(path));
}

/**
 * The rows `sonata status` is about: this project's, or every project's.
 *
 * The ledger is machine-wide and until this existed nothing filtered it by
 * project. The CLI narrowed to "the most recent session" computed across
 * every tenant, so inside one repository it could print another's session in
 * full; the TUI compared `project === cwd` and let every *unattributed* row
 * through as well. Measured on one machine's day: 5167 rows from one project
 * and 857 from the repository the command was actually run in.
 *
 * Scoped on `tenant`, never on `project`. `project` is a cwd string, and two
 * spellings of one repository produce two of them — which is exactly why the
 * ledger grew a `tenant` field for the budget to sum on.
 */
export function scopeRows(
  rows: readonly LedgerRow[],
  scope: { global: true } | { global: false; tenant: string | undefined },
): LedgerRow[] {
  if (scope.global) return [...rows];
  if (scope.tenant === undefined) return [];
  return rows.filter((row) => row.tenant === scope.tenant);
}

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