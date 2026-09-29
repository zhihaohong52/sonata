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
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, readFileSync, utimesSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
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
 *
 * The put-back must never replace a lock that appeared meanwhile. `rename`
 * onto a NON-empty directory fails, and `acquireLock` only ever installs a
 * lock that already holds its owner, so a lock taken by the current code is
 * safe by construction; the existence check narrows the one case left — a
 * lock mkdir'd by an older sonata, which is an EMPTY directory until it
 * writes its owner. A lock that cannot be put back is left in its tomb.
 *
 * Narrowed, not closed: an older sonata's mkdir landing between the
 * existence check and the rename is replaced by it, and its owner write then
 * lands in the lock put back. This is the same cross-version window
 * `acquireLock` accepts — two versions racing one lock within microseconds,
 * during an upgrade — and Node exposes no rename that refuses an existing
 * target. Dropping the put-back instead would be worse, and not only across
 * versions: two current waiters that both saw one dead lock race, the first
 * reclaims it and takes a fresh lock, the second then moves that live lock to
 * its tomb, and with no put-back its holder keeps running while the next
 * waiter takes the empty path — two holders at once.
 */
export function reclaimStaleLock(
  lock: string,
  seen: LockObservation,
  /** Test seam: runs between the move to the tomb and the put-back. */
  hooks: { beforePutBack?: () => void } = {},
): boolean {
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
  // Not the lock we saw. Best effort to return it, never over a newer one.
  hooks.beforePutBack?.();
  if (!existsSync(lock)) {
    try { renameSync(tomb, lock); } catch { /* the path has a newer lock now */ }
  }
  return false;
}

/** How old a staging or tomb directory must be before it counts as litter. */
const LITTER_MAX_AGE_MS = 10 * 60_000;

/**
 * Removes `<lock>.new-*` staging directories and `<lock>.tomb-*` tombs left by
 * a process that died mid-acquire or mid-reclaim. Only this lock's, and only
 * ones far older than any acquire or reclaim takes, so the caller's own
 * in-flight staging directory (and anyone else's) is never touched.
 */
function sweepLitter(lock: string): void {
  const prefix = basename(lock);
  let names: string[];
  try { names = readdirSync(dirname(lock)); } catch { return; }
  const cutoff = Date.now() - LITTER_MAX_AGE_MS;
  for (const name of names) {
    if (!name.startsWith(`${prefix}.new-`) && !name.startsWith(`${prefix}.tomb-`)) continue;
    const path = join(dirname(lock), name);
    try {
      if (statSync(path).mtimeMs < cutoff) rmSync(path, { recursive: true, force: true });
    } catch { /* gone already, or not ours to read */ }
  }
}

/**
 * Takes the lock at `lock` for `token`, or answers false if it is held.
 *
 * The lock is prepared under a private name with its owner already written,
 * then renamed into place. It therefore never exists at the lock path without
 * an owner, which is what makes `reclaimStaleLock`'s put-back unable to
 * replace it (rename refuses a non-empty target) — the old mkdir-then-write
 * left an empty directory at the path for a moment, and a put-back could
 * replace it, after which this process's token landed in someone else's lock.
 */
export function acquireLock(lock: string, token: string): boolean {
  sweepLitter(lock);
  if (existsSync(lock)) return false;
  const staging = `${lock}.new-${randomUUID()}`;
  try {
    mkdirSync(staging);
    writeFileSync(join(staging, 'owner'), token);
    renameSync(staging, lock);
  } catch {
    rmSync(staging, { recursive: true, force: true });
    return false;
  }
  // A legacy writer's empty directory is the one thing the rename can replace;
  // the owner check says whether this lock is the one at the path.
  //
  // Accepted, not closed: an older sonata acquires with a bare mkdir, then
  // writes its owner, so for that instant its lock is an EMPTY directory — and
  // this rename replaces an empty directory. The older process's owner write
  // then lands in this lock. It needs two sonata versions racing for one lock
  // within microseconds, during an upgrade; Node exposes no rename that
  // refuses an existing target, and the owner check above catches the case
  // where the older process wins the write.
  return readToken(lock) === token;
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
    if (acquireLock(lock, token)) break;
    waited = true;
    const seen = observeLock(lock);
    if (seen !== undefined && Date.now() - seen.mtimeMs > STALE_MS) reclaimStaleLock(lock, seen);
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