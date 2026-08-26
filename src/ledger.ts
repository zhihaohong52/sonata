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
import { join } from 'node:path';

import type { UsageTokens } from './native/usage.js';

export type LedgerPrice =
  | { source: 'none' }
  | { source: 'model' | 'gateway' | 'ai-pricing'; totalUsd: number; observedAt?: string };

export interface LedgerRow {
  ts: string;
  ms: number;
  session?: string;
  alias: string;
  role?: string;
  tier?: string;
  key?: string;
  gateway?: string;
  upstream: 'litellm' | 'anthropic';
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

export function readRows(home: string, sinceMs: number, now: number = Date.now()): LedgerRow[] {
  const dir = ledgerDir(home);
  if (!existsSync(dir)) return [];
  const out: LedgerRow[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!FILE_PATTERN.test(name)) continue;
    let raw: string;
    try {
      raw = readFileSync(join(dir, name), 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (line === '') continue;
      let row: LedgerRow;
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed === null || typeof parsed !== 'object' || typeof (parsed as { ts?: unknown }).ts !== 'string') continue;
        row = parsed as LedgerRow;
        if (!Number.isFinite(Date.parse(row.ts))) continue;
      } catch {
        // A torn final line (a crash mid-append) must not cost the whole report.
        continue;
      }
      const ts = Date.parse(row.ts);
      if (!Number.isFinite(ts) || ts < sinceMs || ts > now) continue;
      out.push(row);
    }
  }
  return out;
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
