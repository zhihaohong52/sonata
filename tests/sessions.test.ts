import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { sessionsPath, recordSession, loadSessions, pruneSessions } from '../src/sessions.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'sonata-sessions-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('sessions map', () => {
  it('records and reads back a session', () => {
    recordSession(home, { session: 's1', cwd: '/repo/a', started: '2026-08-27T10:00:00.000Z' });
    expect(loadSessions(home).s1.cwd).toBe('/repo/a');
  });

  it('keeps earlier sessions when a new one is recorded', () => {
    recordSession(home, { session: 's1', cwd: '/repo/a', started: '2026-08-27T10:00:00.000Z' });
    recordSession(home, { session: 's2', cwd: '/repo/b', started: '2026-08-27T11:00:00.000Z' });
    expect(Object.keys(loadSessions(home)).sort()).toEqual(['s1', 's2']);
  });

  it('overwrites a repeated session id rather than duplicating it', () => {
    recordSession(home, { session: 's1', cwd: '/repo/a', started: '2026-08-27T10:00:00.000Z' });
    recordSession(home, { session: 's1', cwd: '/repo/moved', started: '2026-08-27T12:00:00.000Z' });
    expect(loadSessions(home).s1.cwd).toBe('/repo/moved');
  });

  it('returns an empty map when absent or corrupt', () => {
    expect(loadSessions(home)).toEqual({});
    mkdirSync(dirname(sessionsPath(home)), { recursive: true });
    writeFileSync(sessionsPath(home), '{not json');
    expect(loadSessions(home)).toEqual({});
  });

  it('prunes entries older than the retention window', () => {
    recordSession(home, { session: 'old', cwd: '/a', started: '2026-07-01T10:00:00.000Z' });
    recordSession(home, { session: 'new', cwd: '/b', started: '2026-08-27T10:00:00.000Z' });
    expect(pruneSessions(home, 30, new Date('2026-08-27T12:00:00Z'))).toBe(1);
    expect(Object.keys(loadSessions(home))).toEqual(['new']);
  });
});