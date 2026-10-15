import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweepStaleLoginBackups } from '../../src/native/oauth-login.js';

describe('sweepStaleLoginBackups', () => {
  it('removes an old leftover login backup, and keeps one still in its swap window', () => {
    const parent = mkdtempSync(join(tmpdir(), 'login-sweep-'));
    const stale = join(parent, '.login-aaa-old');
    const fresh = join(parent, '.login-bbb-old');
    const credential = join(parent, 'codex');
    for (const dir of [stale, fresh, credential]) mkdirSync(dir);
    const now = Date.now();
    const old = new Date(now - 11 * 60_000);
    utimesSync(stale, old, old);
    sweepStaleLoginBackups(parent, now);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    // Only login backups are touched: the live credential directory stays.
    expect(existsSync(credential)).toBe(true);
  });
});
