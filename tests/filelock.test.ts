import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withSessionLock } from '../src/filelock.js';

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
});