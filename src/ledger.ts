/**
 * The append-only record of what the router did.
 *
 * One JSON line per completed request, in a file per UTC day. Global rather
 * than per-project because the router is a daemon shared across every project;
 * per-project reporting comes from the session map in `src/sessions.ts`.
 *
 * Daily files exist so retention is a file deletion rather than a rewrite.
 * "opencode's event table grows without bound — 6.5 GB across 140k rows" is
 * already a documented limitation caused by another tool doing this
 * carelessly, and sonata does not get to repeat it in its own store.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { join } from 'node:path';

import type { Effort } from './effort.js';
import type { UsageTokens } from './native/usage.js';

export type LedgerPrice =
  | { source: 'none' }
  /**
   * `ai-pricing` is **legacy, read-only**: it is never written any more, but
   * ledger files written before the models.dev switch carry it. Rejecting it
   * would drop that spend from `sonata usage` *and* from `spentTodayUsd`,
   * silently lowering a budget cap's view of a day it should still count.
   */
  | { source: 'model' | 'gateway' | 'models-dev' | 'covered' | 'ai-pricing'; totalUsd: number; observedAt?: string };

export interface LedgerRow {
  ts: string;
  ms: number;
  session?: string;
  /** The project directory the request was attributed to, written by the router from the resolved tenant. Absent on rows written before multi-tenant routing and on requests no project could be resolved for. */
  project?: string;
  /**
   * The tenant (project *identity*) the request was attributed to — the hash of
   * the canonical `sonata.toml` path, from `tenantId`.
   *
   * `project` is a cwd string and two spellings of one repository (a
   * subdirectory, a symlinked path) produce two of them, which split a
   * project's spend into disjoint buckets and turned `daily_usd` into a cap per
   * directory spelling. `project` stays because `sonata usage --by project`
   * shows it to a human; the budget sums on this.
   */
  tenant?: string;
  alias: string;
  role?: string;
  tier?: string;
  key?: string;
  /**
   * The reasoning-effort level the router sent (`reasoning_effort`), when the
   * candidate carried one. Absent means none was asked for. Present means it
   * was SENT, not that it was honoured: a provider with no effort control
   * drops the field silently (`drop_params`), and the router cannot tell.
   * The only evidence a level applied is this row's cost moving with it.
   */
  effort?: Effort;
  gateway?: string;
  upstream: 'litellm' | 'anthropic' | 'direct';
  litellmModel?: string;
  callId?: string;
  status: number;
  complete: boolean;
  tokens: UsageTokens;
  price: LedgerPrice;
  attempts: { key: string; status: number }[];
  litellm?: { fallbacks: number; retries: number };
}

export const LEDGER_RETENTION_DAYS = 30;

const FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

export function ledgerDir(home: string): string {
  return join(home, '.config', 'sonata', 'usage');
}

/** UTC date, never local: a local date would roll the file over at the wrong moment. */
export function ledgerPathFor(home: string, at: Date): string {
  return join(ledgerDir(home), `${at.toISOString().slice(0, 10)}.jsonl`);
}

export function appendRow(home: string, row: LedgerRow): void {
  const at = new Date(row.ts);
  mkdirSync(ledgerDir(home), { recursive: true });
  // O_APPEND plus one write keeps concurrent appends as whole lines.
  appendFileSync(ledgerPathFor(home, at), `${JSON.stringify(row)}\n`);
}

const DAY_MS = 24 * 3600 * 1000;

/**
 * The day files that could hold a row in `[sinceMs, now]`.
 *
 * The filename **is** the UTC date, so a file whose whole day lies outside the
 * window provably cannot help and is not opened. Measured before this existed:
 * a 24-hour query parsed 14 files / 15 MB / 36,797 lines to answer from one —
 * every 5 seconds while the UI page was open, on the event loop the router
 * serves every native agent's request from.
 *
 * A one-day margin is kept on **both** sides: a row whose `ts` disagrees with
 * its filename (clock skew, a hand-edited file) must still be found. The
 * per-row `ts` filter stays the source of truth; this only avoids opening
 * files that cannot contribute, so the selection is behaviour-preserving.
 */
function ledgerFileNames(names: string[], sinceMs: number, now: number): string[] {
  const from = Number.isFinite(sinceMs) ? sinceMs - DAY_MS : -Infinity;
  const to = Number.isFinite(now) ? now + DAY_MS : Infinity;
  const out: string[] = [];
  for (const name of names.sort()) {
    const match = FILE_PATTERN.exec(name);
    if (match === null) continue;
    const dayStart = Date.parse(`${match[1]}T00:00:00.000Z`);
    // A filename this module wrote always parses; one that does not is kept
    // rather than skipped, so a surprise can never silently lose rows.
    if (Number.isFinite(dayStart) && (dayStart + DAY_MS <= from || dayStart >= to)) continue;
    out.push(name);
  }
  return out;
}

/** One file's lines, validated and windowed, appended to `out`. */
function collectRows(raw: string, sinceMs: number, now: number, out: LedgerRow[]): void {
  for (const line of raw.split('\n')) {
    if (line === '') continue;
    let row: LedgerRow;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== 'object' || typeof (parsed as { ts?: unknown }).ts !== 'string') continue;
      row = parsed as LedgerRow;
      if (!Number.isFinite(Date.parse(row.ts))) continue;
      if (!hasRequiredFields(row)) continue;
    } catch {
      // A torn final line (a crash mid-append) must not cost the whole report.
      continue;
    }
    const ts = Date.parse(row.ts);
    if (!Number.isFinite(ts) || ts < sinceMs || ts > now) continue;
    out.push(row);
  }
}

export function readRows(home: string, sinceMs: number, now: number = Date.now()): LedgerRow[] {
  const dir = ledgerDir(home);
  if (!existsSync(dir)) return [];
  const out: LedgerRow[] = [];
  for (const name of ledgerFileNames(readdirSync(dir), sinceMs, now)) {
    let raw: string;
    try {
      raw = readFileSync(join(dir, name), 'utf8');
    } catch {
      continue;
    }
    collectRows(raw, sinceMs, now, out);
  }
  return out;
}

/**
 * The same read, off the event loop.
 *
 * An **addition**, never a replacement: `spentTodayUsd` and every CLI command
 * depend on the synchronous signature above. Both share `ledgerFileNames` and
 * `collectRows`, so the two cannot drift about which rows exist.
 */
export async function readRowsAsync(
  home: string,
  sinceMs: number,
  now: number = Date.now(),
): Promise<LedgerRow[]> {
  const dir = ledgerDir(home);
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const out: LedgerRow[] = [];
  for (const name of ledgerFileNames(names, sinceMs, now)) {
    let raw: string;
    try {
      raw = await fsp.readFile(join(dir, name), 'utf8');
    } catch {
      continue;
    }
    collectRows(raw, sinceMs, now, out);
  }
  return out;
}

function priceIsValid(price: LedgerRow['price']): boolean {
  if (price === null || typeof price !== 'object' || Array.isArray(price)) return false;
  if (price.source === 'none') return true;
  if (
    price.source === 'model' || price.source === 'gateway' || price.source === 'models-dev'
    || price.source === 'covered'
    // Legacy, still readable — see LedgerPrice.
    || price.source === 'ai-pricing'
  ) {
    return typeof price.totalUsd === 'number' && Number.isFinite(price.totalUsd);
  }
  return false;
}

/**
 * A persisted row is untrusted input. Every downstream reader (`aggregate`,
 * `recentRoutes`) reaches into `tokens.input`/`tokens.output`, `attempts.length`
 * and `price.source`/`price.totalUsd`, so a parseable-but-incomplete row must be
 * dropped here rather than crash those readers later. `aggregate` dereferences
 * `price.source` directly, so a `null` or otherwise malformed price must be
 * rejected too, not just an absent `tokens`/`attempts`.
 */
function hasRequiredFields(row: LedgerRow): boolean {
  const tokens = row.tokens;
  if (tokens === null || typeof tokens !== 'object' || Array.isArray(tokens)) return false;
  if (typeof tokens.input !== 'number' || !Number.isFinite(tokens.input)) return false;
  if (typeof tokens.output !== 'number' || !Number.isFinite(tokens.output)) return false;
  if (!priceIsValid(row.price)) return false;
  return Array.isArray(row.attempts);
}

/** Deletes whole day-files older than the window. Returns how many were removed. */
export function pruneLedger(home: string, retentionDays: number, now: Date = new Date()): number {
  const dir = ledgerDir(home);
  if (!existsSync(dir)) return 0;
  const cutoff = Math.floor((now.getTime() - retentionDays * 24 * 3600 * 1000) / (24 * 3600 * 1000)) * (24 * 3600 * 1000);
  let removed = 0;
  for (const name of readdirSync(dir)) {
    const match = FILE_PATTERN.exec(name);
    if (match === null) continue; // never delete a file this module did not write
    const day = Date.parse(`${match[1]}T00:00:00.000Z`);
    if (!Number.isFinite(day) || day >= cutoff) continue;
    try {
      rmSync(join(dir, name), { force: true });
      removed += 1;
    } catch { /* a file we cannot remove is not worth failing serve over */ }
  }
  return removed;
}
