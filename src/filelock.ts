/**
 * A mkdir-based lockfile mutex, shared by the route and usage systems that do
 * read-modify-write on a JSON file from separate processes.
 *
 * Two `SessionStart` hooks can fire near-simultaneously (a user can launch
 * sessions in different projects around the same time). If their updates to a
 * shared file each did a plain `load`-then-`write`, one's write would silently
 * clobber the other's — neither ever sees the other's in-flight change. This
 * serialises those updates so the read-modify-write is atomic across processes.
 *
 * The lock is the creation of a sibling `<file>.lock` directory (mkdir is
 * atomic): the winner of `mkdirSync` owns the lock. The loser polls until the
 * owner removes it, giving up after 2s; a lock older than 5s is treated as
 * stale (the holder crashed) and reclaimed — by `reclaimStaleLock`, which only
 * ever removes the exact lock the waiter saw.
 *
 * A lock is a renewable lease, not a fixed claim. On winning, the holder writes
 * a unique owner token into `<lock>/owner` and refreshes the lock's mtime every
 * 2s (well under the 5s staleness threshold) for as long as `fn()` runs, so a
 * holder that is legitimately slow — `route.ts` awaits `cmdRoute('on'/'off')`
 * inside the lock — is never mistaken for a crash. When `fn()` finishes the
 * holder only deletes the lock if `<lock>/owner` still holds *its own* token:
 * if another process reclaimed it in the meantime (a stale lock the holder
 * failed to renew), that process's live lock is left alone.
 */
import { mkdirSync, renameSync, rmSync, statSync, writeFileSync, readFileSync, utimesSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const RENEW_INTERVAL_MS = 2000;
const STALE_MS = 5000;

/** What a waiter saw of a lock: enough to recognise that exact lock later. */
export interface LockObservation {
  ino: number;
  mtimeMs: number;
  /** Absent when the holder died between its mkdir and writing the token. */
  token: string | undefined;
}

function readToken(lock: string): string | undefined {
  try { return readFileSync(join(lock, 'owner'), 'utf8'); } catch { return undefined; }
}

/** The lock at `lock` as it is now, or undefined when there is none. */
export function observeLock(lock: string): LockObservation | undefined {
  try {
    const { ino, mtimeMs } = statSync(lock);
    return { ino, mtimeMs, token: readToken(lock) };
  } catch {
    return undefined;
  }
}

/**
 * Removes the lock `seen` described — and only that lock.
 *
 * Reclaiming used to be stat, then rm: two waiters that both saw one dead lock
 * would each remove "the lock", and the second removal took the fresh lock the
 * first had just acquired, so both ran at once. Here the lock is first renamed
 * to a tomb only this call knows (rename is atomic, so exactly one lock is
 * moved), and the tomb is checked against what was seen. A match is the dead
 * lock and is deleted; anything else is someone's live lock and is put back.
 *
 * Returns whether the observed lock was removed.
 */
export function reclaimStaleLock(lock: string, seen: LockObservation): boolean {
  const tomb = `${lock}.tomb-${randomUUID()}`;
  try {
    renameSync(lock, tomb);
  } catch {
    return false; // already gone — another waiter reclaimed it
  }
  let ino: number | undefined;
  try { ino = statSync(tomb).ino; } catch { /* vanished: treat as a mismatch */ }
  if (ino === seen.ino && readToken(tomb) === seen.token) {
    rmSync(tomb, { recursive: true, force: true });
    return true;
  }
  // Not the lock we saw. Best effort to return it: the rename fails if a new
  // lock has been created at the path meanwhile, and then this one is left
  // where it is rather than replacing that one.
  try { renameSync(tomb, lock); } catch { /* the path has a newer lock now */ }
  return false;
}

export async function withSessionLock<T>(
  file: string,
  /** `waited` is true when another holder had the lock as this call arrived. */
  fn: (info: { waited: boolean }) => T | Promise<T>,
  /** How long to wait for the lock; 2s suits the short registry updates, and a caller holding it for minutes passes more. */
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  const lock = `${file}.lock`;
  const ownerPath = join(lock, 'owner');
  mkdirSync(dirname(file), { recursive: true });
  const deadline = Date.now() + (opts.timeoutMs ?? 2000);
  const token = randomUUID();
  let waited = false;
  for (;;) {
    let acquired = false;
    try {
      mkdirSync(lock);
      acquired = true;
    } catch {
      waited = true;
      const seen = observeLock(lock);
      if (seen !== undefined && Date.now() - seen.mtimeMs > STALE_MS) reclaimStaleLock(lock, seen);
    }
    if (acquired) {
      // The token can fail to land only if a reclaimer moved the directory in
      // the instant after the mkdir; then this lock is not held, so try again.
      try {
        writeFileSync(ownerPath, token);
        break;
      } catch { /* lost the lock before claiming it */ }
    }
    if (Date.now() > deadline) {
      throw new Error(`sonata: timed out waiting for lock on ${file}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }

  let timer: ReturnType<typeof setInterval>;
  const renew = (): void => {
    try {
      // Someone else owns it now (a reclaim wrote their token): stop touching
      // their lock, or we would keep it alive on their behalf.
      if (readFileSync(ownerPath, 'utf8') !== token) {
        clearInterval(timer);
        return;
      }
      utimesSync(lock, new Date(), new Date());
    } catch { /* lock gone — nothing left to renew */ clearInterval(timer); }
  };
  timer = setInterval(renew, RENEW_INTERVAL_MS);

  try {
    return await fn({ waited });
  } finally {
    clearInterval(timer);
    try {
      if (readFileSync(ownerPath, 'utf8') === token) {
        rmSync(lock, { recursive: true, force: true });
      }
    } catch { /* already gone */ }
  }
}