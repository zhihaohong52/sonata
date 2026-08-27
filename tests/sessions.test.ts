import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { sessionsPath, recordSession, loadSessions, pruneSessions } from '../src/sessions.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'sonata-sessions-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('sessions map', () => {
  it('records and reads back a session', async () => {
    await recordSession(home, { session: 's1', cwd: '/repo/a', started: '2026-08-27T10:00:00.000Z' });
    expect(loadSessions(home).s1.cwd).toBe('/repo/a');
  });

  it('keeps earlier sessions when a new one is recorded', async () => {
    await recordSession(home, { session: 's1', cwd: '/repo/a', started: '2026-08-27T10:00:00.000Z' });
    await recordSession(home, { session: 's2', cwd: '/repo/b', started: '2026-08-27T11:00:00.000Z' });
    expect(Object.keys(loadSessions(home)).sort()).toEqual(['s1', 's2']);
  });

  it('overwrites a repeated session id rather than duplicating it', async () => {
    await recordSession(home, { session: 's1', cwd: '/repo/a', started: '2026-08-27T10:00:00.000Z' });
    await recordSession(home, { session: 's1', cwd: '/repo/moved', started: '2026-08-27T12:00:00.000Z' });
    expect(loadSessions(home).s1.cwd).toBe('/repo/moved');
  });

  it('returns an empty map when absent or corrupt', () => {
    expect(loadSessions(home)).toEqual({});
    mkdirSync(dirname(sessionsPath(home)), { recursive: true });
    writeFileSync(sessionsPath(home), '{not json');
    expect(loadSessions(home)).toEqual({});
  });

  it('prunes entries older than the retention window', async () => {
    await recordSession(home, { session: 'old', cwd: '/a', started: '2026-07-01T10:00:00.000Z' });
    await recordSession(home, { session: 'new', cwd: '/b', started: '2026-08-27T10:00:00.000Z' });
    expect(await pruneSessions(home, 30, new Date('2026-08-27T12:00:00Z'))).toBe(1);
    expect(Object.keys(loadSessions(home))).toEqual(['new']);
  });

  it('waits for the lock instead of clobbering a concurrent writer', async () => {
    // Manual contention test for `withSessionLock`: `recordSession`'s critical
    // section is fully synchronous, so two `Promise.all`ed calls could never
    // interleave on JS's single thread — this would pass with the lock deleted.
    // Holding the `<file>.lock` directory ourselves simulates a real other
    // process mid-write, and asserts recordSession actually waits for it.
    const path = sessionsPath(home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ a: { session: 'a', cwd: '/repo/a', started: '2026-08-27T10:00:00.000Z' } }));

    // Simulate another process already holding the lock.
    const lockDir = `${path}.lock`;
    mkdirSync(lockDir);

    const recordPromise = recordSession(home, { session: 'b', cwd: '/repo/b', started: '2026-08-27T11:00:00.000Z' });

    // While the lock is held, recordSession must not have written yet.
    await new Promise((r) => setTimeout(r, 10));
    expect(Object.keys(loadSessions(home)).sort()).toEqual(['a']); // 'b' not written yet — still blocked

    rmSync(lockDir, { recursive: true, force: true }); // release the "other process"'s lock
    await recordPromise;

    // Now it should have gone through, and 'a' must still be present (not clobbered).
    expect(Object.keys(loadSessions(home)).sort()).toEqual(['a', 'b']);
  });

  it('prune waits for the lock too, so a blocked record is not dropped', async () => {
    const path = sessionsPath(home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      keep: { session: 'keep', cwd: '/a', started: '2026-08-25T10:00:00.000Z' },
      drop: { session: 'drop', cwd: '/b', started: '2026-07-01T10:00:00.000Z' },
    }));

    const lockDir = `${path}.lock`;
    mkdirSync(lockDir);

    const prunePromise = pruneSessions(home, 30, new Date('2026-08-27T12:00:00Z'));

    await new Promise((r) => setTimeout(r, 10));
    // Still blocked — the old rows are untouched while the lock is held.
    expect(Object.keys(loadSessions(home)).sort()).toEqual(['drop', 'keep']);

    rmSync(lockDir, { recursive: true, force: true });
    expect(await prunePromise).toBe(1);

    // The old 'drop' row was pruned; 'keep' survived.
    expect(Object.keys(loadSessions(home)).sort()).toEqual(['keep']);
  });
});