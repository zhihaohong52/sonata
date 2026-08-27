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
 * stale (the holder crashed) and reclaimed.
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
import { mkdirSync, rmSync, statSync, writeFileSync, readFileSync, utimesSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const RENEW_INTERVAL_MS = 2000;

export async function withSessionLock<T>(file: string, fn: () => T | Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  const ownerPath = join(lock, 'owner');
  mkdirSync(dirname(file), { recursive: true });
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      try {
        const age = Date.now() - statSync(lock).mtimeMs;
        if (age > 5000) rmSync(lock, { recursive: true, force: true });
      } catch { /* raced with the holder releasing it */ }
      if (Date.now() > deadline) {
        throw new Error(`sonata: timed out waiting for lock on ${file}`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  const token = randomUUID();
  writeFileSync(ownerPath, token);

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
    return await fn();
  } finally {
    clearInterval(timer);
    try {
      if (readFileSync(ownerPath, 'utf8') === token) {
        rmSync(lock, { recursive: true, force: true });
      }
    } catch { /* already gone */ }
  }
}