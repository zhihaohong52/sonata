import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setAside, sweepStaleLoginBackups } from '../../src/native/oauth-login.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

describe('sweepStaleLoginBackups', () => {
  it('removes an old leftover login backup, and keeps one still in its swap window', () => {
    const parent = mkdtempSync(join(tmpdir(), 'login-sweep-'));
    const stale = join(parent, '.login-aaa-old');
    const fresh = join(parent, '.login-bbb-old');
    const credential = join(parent, 'codex');
    for (const dir of [stale, fresh, credential]) mkdirSync(dir);
    const now = Date.now();
    const old = new Date(now - 11 * MINUTE);
    utimesSync(stale, old, old);
    sweepStaleLoginBackups(parent, now);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    // Only names this module makes are touched: the live credential directory stays.
    expect(existsSync(credential)).toBe(true);
  });

  it('removes a staging directory only once it is a day old', () => {
    const parent = mkdtempSync(join(tmpdir(), 'login-sweep-staging-'));
    const oldStaging = join(parent, '.login-ccc');
    const newStaging = join(parent, '.login-ddd');
    mkdirSync(oldStaging);
    mkdirSync(newStaging);
    const now = Date.now();
    const old = new Date(now - 2 * DAY);
    utimesSync(oldStaging, old, old);
    const waitingNow = new Date(now - 2 * MINUTE);
    utimesSync(newStaging, waitingNow, waitingNow);
    sweepStaleLoginBackups(parent, now);
    expect(existsSync(oldStaging)).toBe(false);
    expect(existsSync(newStaging)).toBe(true);
  });

  it('keeps a rollback copy made just now, even though the credential in it is months old', () => {
    const parent = mkdtempSync(join(tmpdir(), 'login-sweep-stamp-'));
    const dir = join(parent, 'codex');
    const backup = join(parent, '.login-eee-old');
    mkdirSync(dir);
    const months = new Date(Date.now() - 120 * DAY);
    utimesSync(dir, months, months);
    setAside(dir, backup);
    expect(existsSync(dir)).toBe(false);
    expect(Date.now() - statSync(backup).mtimeMs).toBeLessThan(MINUTE);
    sweepStaleLoginBackups(parent);
    expect(existsSync(backup)).toBe(true);
  });
});

describe('setAside reports the move before it stamps', () => {
  it('calls onMoved once the credential is aside, so a rollback is known to be owed', () => {
    const parent = mkdtempSync(join(tmpdir(), 'login-setaside-'));
    const dir = join(parent, 'codex');
    const backup = join(parent, '.login-fff-old');
    mkdirSync(dir);
    let moved = 0;
    setAside(dir, backup, () => { moved += 1; });
    expect(moved).toBe(1);
    expect(existsSync(backup)).toBe(true);
  });
});
