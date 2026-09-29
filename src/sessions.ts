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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { withSessionLock } from './filelock.js';

export interface SessionRecord {
  session: string;
  cwd: string;
  started: string;
}

export function sessionsPath(home: string): string {
  return join(home, '.config', 'sonata', 'sessions.json');
}

/**
 * The session → project map, or `{}` when there is none.
 *
 * Read on the router's request path without the writers' lock, so it must
 * not mistake a moment of contention for "no sessions": that sends a
 * session-resolved request to the machine config — other gateways, other
 * credentials, another budget — with nothing to say it happened. Writers
 * replace the file by rename, so sonata's own writes are never seen torn;
 * the single retry covers anything that still is (a writer from before that
 * change, or a read racing the file's creation).
 */
export function loadSessions(
  home: string,
  read: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): Record<string, SessionRecord> {
  const path = sessionsPath(home);
  if (!existsSync(path)) return {};
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const doc: unknown = JSON.parse(read(path));
      if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return {};
      return doc as Record<string, SessionRecord>;
    } catch {
      // Fall through to the one retry.
    }
  }
  return {};
}

/** Writes via a sibling temp file and a rename, so no reader sees half a file. */
function writeSessions(home: string, all: Record<string, SessionRecord>): void {
  const path = sessionsPath(home);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(all, null, 2)}\n`);
  renameSync(temp, path);
}

export async function recordSession(home: string, record: SessionRecord): Promise<void> {
  await withSessionLock(sessionsPath(home), () => {
    const all = loadSessions(home);
    all[record.session] = record;
    writeSessions(home, all);
  });
}

export async function pruneSessions(home: string, retentionDays: number, now: Date = new Date()): Promise<number> {
  return withSessionLock(sessionsPath(home), () => {
    const all = loadSessions(home);
    // Same day-floor as `pruneLedger`: the window is measured in whole UTC days,
    // not in exact milliseconds, so a session started at the boundary keeps
    // both prunes agreeing on which entries are "older than N days".
    const cutoff = Math.floor((now.getTime() - retentionDays * 24 * 3600 * 1000) / (24 * 3600 * 1000)) * (24 * 3600 * 1000);
    let removed = 0;
    for (const [id, record] of Object.entries(all)) {
      const started = Date.parse(record?.started ?? '');
      if (Number.isFinite(started) && started >= cutoff) continue;
      delete all[id];
      removed += 1;
    }
    if (removed > 0) writeSessions(home, all);
    return removed;
  });
}