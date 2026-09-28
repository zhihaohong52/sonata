import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  boundUnreadable, boundUnreadableDb, jsonStoreRead, newUnreadableMemory, UNREADABLE_STORE_WINDOW_MS,
} from '../../src/native/credential-reads.js';

// A store that cannot be read is torn only while it is plausibly mid-write.
// Read as torn forever, a permanently corrupt codex auth.json refused a
// gateway opencode could serve, with a 502 promising a retry that never came.
describe('boundUnreadable', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cred-reads-')); });
  const W = UNREADABLE_STORE_WINDOW_MS;

  it('answers a freshly written unreadable file as torn', () => {
    const path = join(dir, 'auth.json');
    writeFileSync(path, '');
    const memory = newUnreadableMemory();
    const read = boundUnreadable(path, jsonStoreRead(path), memory, Date.now());
    expect(read.state).toBe('unreadable');
    expect(memory.torn).toBe(1);
  });

  it('skips a file unreadable and untouched for the window as absent, warning once', () => {
    const path = join(dir, 'auth.json');
    writeFileSync(path, '');
    const old = (Date.now() - W - 5000) / 1000;
    utimesSync(path, old, old);
    const memory = newUnreadableMemory();
    const warnings: string[] = [];
    const first = boundUnreadable(path, jsonStoreRead(path), memory, Date.now(), (line) => warnings.push(line));
    const second = boundUnreadable(path, jsonStoreRead(path), memory, Date.now(), (line) => warnings.push(line));
    expect(first).toEqual({ state: 'absent', skipped: expect.stringContaining(path) });
    expect(second.state).toBe('absent');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(path);
    expect(warnings[0]).toContain('not valid JSON');
    expect(memory.torn).toBe(0);
  });

  it('goes steady once the window passes with nothing on disk changing', () => {
    const path = join(dir, 'auth.json');
    writeFileSync(path, '{"half');
    const memory = newUnreadableMemory();
    const t0 = Date.now();
    expect(boundUnreadable(path, jsonStoreRead(path), memory, t0).state).toBe('unreadable');
    expect(boundUnreadable(path, jsonStoreRead(path), memory, t0 + W + 1000).state).toBe('absent');
  });

  it('is torn again after a change seen between two unreadable reads, even with an old mtime', () => {
    const path = join(dir, 'auth.json');
    writeFileSync(path, '{');
    const old = (Date.now() - 3 * W) / 1000;
    utimesSync(path, old, old);
    const memory = newUnreadableMemory();
    const t0 = Date.now();
    expect(boundUnreadable(path, jsonStoreRead(path), memory, t0).state).toBe('absent');
    writeFileSync(path, '{"a');
    utimesSync(path, old, old);
    expect(boundUnreadable(path, jsonStoreRead(path), memory, t0 + 1).state).toBe('unreadable');
    expect(boundUnreadable(path, jsonStoreRead(path), memory, t0 + W + 2).state).toBe('absent');
  });

  it('forgets a file that reads cleanly, so its next failure starts fresh', () => {
    const path = join(dir, 'auth.json');
    writeFileSync(path, '{}');
    const memory = newUnreadableMemory();
    expect(boundUnreadable(path, jsonStoreRead(path), memory, Date.now()).state).toBe('ok');
    expect(memory.files.size).toBe(0);
  });
});

describe('boundUnreadableDb', () => {
  const W = UNREADABLE_STORE_WINDOW_MS;
  const failing = { state: 'unreadable' as const, detail: '/x/opencode.db: database is locked' };

  it('refuses for the window, then skips a database that keeps failing, warning once', () => {
    const memory = newUnreadableMemory();
    const warnings: string[] = [];
    const t0 = 1_000_000;
    expect(boundUnreadableDb('/x/opencode.db', failing, memory, t0, (l) => warnings.push(l)).state).toBe('unreadable');
    expect(boundUnreadableDb('/x/opencode.db', failing, memory, t0 + W - 1, (l) => warnings.push(l)).state).toBe('unreadable');
    expect(boundUnreadableDb('/x/opencode.db', failing, memory, t0 + W, (l) => warnings.push(l)))
      .toEqual({ state: 'absent', skipped: failing.detail });
    boundUnreadableDb('/x/opencode.db', failing, memory, t0 + 2 * W, (l) => warnings.push(l));
    expect(warnings).toEqual([expect.stringContaining('database is locked')]);
  });

  it('starts a new run after a clean read', () => {
    const memory = newUnreadableMemory();
    const t0 = 1_000_000;
    boundUnreadableDb('/x/opencode.db', failing, memory, t0);
    boundUnreadableDb('/x/opencode.db', { state: 'ok' }, memory, t0 + W);
    expect(boundUnreadableDb('/x/opencode.db', failing, memory, t0 + W + 1).state).toBe('unreadable');
  });
});
