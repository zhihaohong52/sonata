/**
 * Which project each routed session belonged to.
 *
 * The router sees a session id on a header but never a working directory, so
 * per-project reporting has to be joined from somewhere else. `cmdRouteSession`
 * runs at SessionStart and knows both.
 *
 * This is deliberately NOT `route-sessions.json`, which is a live refcount that
 * shrinks as sessions end. This is history: a ledger row from last week still
 * needs its project resolved long after that session is gone. It is pruned on
 * the same window as the ledger so the two cannot drift into a state where rows
 * exist with no map to join.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface SessionRecord {
  session: string;
  cwd: string;
  started: string;
}

export function sessionsPath(home: string): string {
  return join(home, '.config', 'sonata', 'sessions.json');
}

export function loadSessions(home: string): Record<string, SessionRecord> {
  const path = sessionsPath(home);
  if (!existsSync(path)) return {};
  try {
    const doc: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return {};
    return doc as Record<string, SessionRecord>;
  } catch {
    return {};
  }
}

export function recordSession(home: string, record: SessionRecord): void {
  const all = loadSessions(home);
  all[record.session] = record;
  mkdirSync(dirname(sessionsPath(home)), { recursive: true });
  writeFileSync(sessionsPath(home), `${JSON.stringify(all, null, 2)}\n`);
}

export function pruneSessions(home: string, retentionDays: number, now: Date = new Date()): number {
  const all = loadSessions(home);
  const cutoff = now.getTime() - retentionDays * 24 * 3600 * 1000;
  let removed = 0;
  for (const [id, record] of Object.entries(all)) {
    const started = Date.parse(record?.started ?? '');
    if (Number.isFinite(started) && started >= cutoff) continue;
    delete all[id];
    removed += 1;
  }
  if (removed > 0) writeFileSync(sessionsPath(home), `${JSON.stringify(all, null, 2)}\n`);
  return removed;
}