import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeLock, reclaimStaleLock, withSessionLock } from '../src/filelock.js';

let dir: string;
let file: string;
let lock: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sonata-lock-'));
  file = join(dir, 'state.json');
  lock = `${file}.lock`;
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('withSessionLock', () => {
  it('does not reclaim a lock whose holder is still running past the staleness threshold', async () => {
    vi.useFakeTimers();
    try {
      let releaseFn!: () => void;
      const release = new Promise<void>((r) => { releaseFn = r; });

      const holder = withSessionLock(file, async () => {
        await release; // genuinely still running — not a crash
        return 'holder';
      });

      // The holder stays alive well past the 5s staleness threshold, renewing
      // its lease every 2s.
      await vi.advanceTimersByTimeAsync(6000);

      let waiterEntered = false;
      const waiter = withSessionLock(file, async () => {
        waiterEntered = true;
        return 'waiter';
      });
      const waiterSettled = waiter.then(
        () => 'resolved' as const,
        () => 'rejected' as const,
      );

      // Give the second waiter a chance to (wrongly) reclaim: it must not run
      // while the original holder is still alive.
      await vi.advanceTimersByTimeAsync(100);
      expect(waiterEntered).toBe(false);

      releaseFn();
      await vi.advanceTimersByTimeAsync(50);
      expect(await holder).toBe('holder');
      await waiterSettled;
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not delete a lock another process reclaimed while it ran", async () => {
    let releaseFn!: () => void;
    const release = new Promise<void>((r) => { releaseFn = r; });
    const holder = withSessionLock(file, async () => {
      await release;
      return 'holder';
    });

    // Simulate a rival process reclaiming the (to it, stale) lock with its own
    // owner token while the original holder is still inside fn().
    rmSync(lock, { recursive: true, force: true });
    mkdirSync(lock);
    writeFileSync(join(lock, 'owner'), 'other-token');

    releaseFn();
    await holder;

    // The original holder's finally must leave the new owner's live lock alone.
    expect(existsSync(lock)).toBe(true);
    expect(readFileSync(join(lock, 'owner'), 'utf8')).toBe('other-token');
  });

  it('reclaims a lock whose holder died, and leaves no tomb behind', async () => {
    mkdirSync(lock);
    writeFileSync(join(lock, 'owner'), 'dead');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);

    expect(await withSessionLock(file, () => 'ran')).toBe('ran');
    expect(existsSync(lock)).toBe(false);
    expect(readdirSync(dir).filter((name) => name.includes('tomb'))).toEqual([]);
  });
});

describe('reclaimStaleLock — two reclaimers', () => {
  // Both waiters saw the same dead lock. The first removed it and took a fresh
  // one; the second, acting on what it saw earlier, used to rm whatever was at
  // the path — the first one's live lock — and both then ran at once.
  it('does not take a lock that was replaced after it was observed', () => {
    mkdirSync(lock);
    writeFileSync(join(lock, 'owner'), 'dead');
    const seen = observeLock(lock);

    // Reclaimer one wins: removes the dead lock and holds a fresh one.
    expect(reclaimStaleLock(lock, observeLock(lock)!)).toBe(true);
    mkdirSync(lock);
    writeFileSync(join(lock, 'owner'), 'fresh');

    // Reclaimer two acts on its stale observation.
    expect(reclaimStaleLock(lock, seen!)).toBe(false);
    expect(readFileSync(join(lock, 'owner'), 'utf8')).toBe('fresh');
    expect(readdirSync(dir).filter((name) => name.includes('tomb'))).toEqual([]);
  });

  it('reports false when the lock is already gone', () => {
    mkdirSync(lock);
    const seen = observeLock(lock);
    rmSync(lock, { recursive: true });
    expect(reclaimStaleLock(lock, seen!)).toBe(false);
  });
});
