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
 */
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export async function withSessionLock<T>(file: string, fn: () => T | Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  mkdirSync(dirname(file), { recursive: true });
  const deadline = Date.now() + 2000;
  let held = false;
  for (;;) {
    try {
      mkdirSync(lock);
      held = true;
      break;
    } catch {
      try {
        const age = Date.now() - statSync(lock).mtimeMs;
        if (age > 5000) rmSync(lock, { recursive: true, force: true });
      } catch { /* raced with the holder releasing it */ }
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  try {
    return await fn();
  } finally {
    if (held) { try { rmSync(lock, { recursive: true, force: true }); } catch { /* already gone */ } }
  }
}