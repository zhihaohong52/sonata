import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  boundUnreadable, boundUnreadableDb, jsonStoreRead, newUnreadableMemory, TORN_REPEAT_MS, UNREADABLE_STORE_WINDOW_MS,
} from '../../src/native/credential-reads.js';

// A store that cannot be read is torn only while it is plausibly mid-write:
// while its bytes are still changing, or, with no bytes to compare, for 10 s.
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

  it('is torn on its first read however old its mtime, then skipped once the same bytes are seen 1 s later, warning once', () => {
    // Nothing on disk says a file is mid-write but its bytes moving: a writer
    // does not hold the same partial bytes for a second.
    const path = join(dir, 'auth.json');
    writeFileSync(path, '');
    const old = (Date.now() - W - 5000) / 1000;
    utimesSync(path, old, old);
    const memory = newUnreadableMemory();
    const warnings: string[] = [];
    const t0 = Date.now();
    expect(boundUnreadable(path, jsonStoreRead(path), memory, t0, (line) => warnings.push(line)).state).toBe('unreadable');
    expect(boundUnreadable(path, jsonStoreRead(path), memory, t0 + 500, (line) => warnings.push(line)).state).toBe('unreadable');
    const skipped = boundUnreadable(path, jsonStoreRead(path), memory, t0 + TORN_REPEAT_MS, (line) => warnings.push(line));
    const again = boundUnreadable(path, jsonStoreRead(path), memory, t0 + 2 * TORN_REPEAT_MS, (line) => warnings.push(line));
    expect(skipped).toEqual({ state: 'absent', skipped: expect.stringContaining(path) });
    expect(again.state).toBe('absent');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(path);
    expect(warnings[0]).toContain('not valid JSON');
    expect(memory.torn).toBe(2);
  });

  it('goes steady once the window passes with nothing on disk changing', () => {
    const path = join(dir, 'auth.json');
    writeFileSync(path, '{"half');
    const memory = newUnreadableMemory();
    const t0 = Date.now();
    expect(boundUnreadable(path, jsonStoreRead(path), memory, t0).state).toBe('unreadable');
    expect(boundUnreadable(path, jsonStoreRead(path), memory, t0 + W + 1000).state).toBe('absent');
  });

  it('is torn again when its bytes change between two unreadable reads, even with an old mtime', () => {
    const path = join(dir, 'auth.json');
    writeFileSync(path, '{');
    const old = (Date.now() - 3 * W) / 1000;
    utimesSync(path, old, old);
    const memory = newUnreadableMemory();
    const t0 = Date.now();
    expect(boundUnreadable(path, jsonStoreRead(path), memory, t0).state).toBe('unreadable');
    expect(boundUnreadable(path, jsonStoreRead(path), memory, t0 + TORN_REPEAT_MS).state).toBe('absent');
    writeFileSync(path, '{"a');
    utimesSync(path, old, old);
    expect(boundUnreadable(path, jsonStoreRead(path), memory, t0 + TORN_REPEAT_MS + 1).state).toBe('unreadable');
    expect(boundUnreadable(path, jsonStoreRead(path), memory, t0 + 2 * TORN_REPEAT_MS + 1).state).toBe('absent');
  });

  it('skips a file that is kept freshly written with the same bytes, however recent its mtime', () => {
    // Its mtime is always recent, so an mtime rule read it as torn; a gap
    // rule read it as torn again after every quiet spell (r14/touched.mts).
    const path = join(dir, 'auth.json');
    const memory = newUnreadableMemory();
    const t0 = Date.now();
    const touch = (at: number, text: string) => {
      writeFileSync(path, text);
      utimesSync(path, (at - 2000) / 1000, (at - 2000) / 1000);
    };
    const at = [0, 3000, 6000, 9000, 20_000, 31_000, 42_000];
    const states = at.map((offset) => {
      touch(t0 + offset, '{"broken');
      return boundUnreadable(path, jsonStoreRead(path), memory, t0 + offset).state;
    });
    expect(states).toEqual(['unreadable', 'absent', 'absent', 'absent', 'absent', 'absent', 'absent']);
    // A clean read ends the run; the next failure is torn again.
    touch(t0 + 43_000, '{}');
    expect(boundUnreadable(path, jsonStoreRead(path), memory, t0 + 43_000).state).toBe('ok');
    touch(t0 + 44_000, '{"broken');
    expect(boundUnreadable(path, jsonStoreRead(path), memory, t0 + 44_000).state).toBe('unreadable');
  });

  it('is torn after a quiet spell when the bytes changed — a new write, not one stuck', () => {
    const path = join(dir, 'auth.json');
    const memory = newUnreadableMemory();
    const t0 = Date.now();
    writeFileSync(path, '{"a');
    expect(boundUnreadable(path, jsonStoreRead(path), memory, t0).state).toBe('unreadable');
    writeFileSync(path, '{"ab');
    expect(boundUnreadable(path, jsonStoreRead(path), memory, t0 + 15_000).state).toBe('unreadable');
    expect(memory.torn).toBe(2);
  });

  it('is skipped after a quiet spell when the bytes are the same — stuck, not mid-write', () => {
    const path = join(dir, 'auth.json');
    const memory = newUnreadableMemory();
    const t0 = Date.now();
    writeFileSync(path, '{"a');
    expect(boundUnreadable(path, jsonStoreRead(path), memory, t0).state).toBe('unreadable');
    writeFileSync(path, '{"a');
    expect(boundUnreadable(path, jsonStoreRead(path), memory, t0 + 15_000).state).toBe('absent');
  });

  it('stays torn while its bytes change on every read, however long — the accepted limitation', () => {
    const path = join(dir, 'auth.json');
    const memory = newUnreadableMemory();
    const t0 = Date.now();
    for (let i = 0; i < 8; i++) {
      writeFileSync(path, `{"${'a'.repeat(i)}`);
      expect(boundUnreadable(path, jsonStoreRead(path), memory, t0 + i * 5000).state).toBe('unreadable');
    }
  });

  it('bounds a read error that returns no bytes by the 10 s cap from its first failure, across gaps', () => {
    // A directory where the file should be: EISDIR, no bytes to compare.
    const memory = newUnreadableMemory();
    const t0 = Date.now();
    expect(jsonStoreRead(dir).state).toBe('unreadable');
    expect(boundUnreadable(dir, jsonStoreRead(dir), memory, t0).state).toBe('unreadable');
    expect(boundUnreadable(dir, jsonStoreRead(dir), memory, t0 + 5000).state).toBe('unreadable');
    expect(boundUnreadable(dir, jsonStoreRead(dir), memory, t0 + W).state).toBe('absent');
    const gapped = newUnreadableMemory();
    expect(boundUnreadable(dir, jsonStoreRead(dir), gapped, t0).state).toBe('unreadable');
    expect(boundUnreadable(dir, jsonStoreRead(dir), gapped, t0 + 15_000).state).toBe('absent');
  });

  it('warns once for a file that stays broken, however far apart it is read', () => {
    const path = join(dir, 'auth.json');
    writeFileSync(path, '{');
    const old = (Date.now() - 3 * W) / 1000;
    utimesSync(path, old, old);
    const memory = newUnreadableMemory();
    const warnings: string[] = [];
    const t0 = Date.now();
    const states = [0, 1, 2, 3].map((i) =>
      boundUnreadable(path, jsonStoreRead(path), memory, t0 + i * 2 * W, (l) => warnings.push(l)).state);
    expect(states).toEqual(['unreadable', 'absent', 'absent', 'absent']);
    expect(warnings).toHaveLength(1);
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
