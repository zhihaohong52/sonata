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

  it('keeps both writes when two sessions are recorded concurrently', async () => {
    // Regression for the unlocked read-modify-write: two near-simultaneous
    // SessionStart hooks previously could silently clobber each other's
    // session. `withSessionLock` serialises them so neither write is lost.
    await Promise.all([
      recordSession(home, { session: 'a', cwd: '/repo/a', started: '2026-08-27T10:00:00.000Z' }),
      recordSession(home, { session: 'b', cwd: '/repo/b', started: '2026-08-27T11:00:00.000Z' }),
    ]);
    expect(Object.keys(loadSessions(home)).sort()).toEqual(['a', 'b']);
  });

  it('keeps both prunes-concurrent-with-record when run concurrently', async () => {
    await recordSession(home, { session: 'keep', cwd: '/a', started: '2026-08-25T10:00:00.000Z' });
    await recordSession(home, { session: 'drop', cwd: '/b', started: '2026-07-01T10:00:00.000Z' });
    await Promise.all([
      pruneSessions(home, 30, new Date('2026-08-27T12:00:00Z')),
      recordSession(home, { session: 'new', cwd: '/c', started: '2026-08-27T11:00:00.000Z' }),
    ]);
    expect(Object.keys(loadSessions(home)).sort()).toEqual(['keep', 'new']);
  });
});