import { describe, expect, it, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  boundUnreadable, boundUnreadableDb, FIRST_SIGHT_STALE_MS, jsonStoreRead, newUnreadableMemory, TORN_REPEAT_MS,
  UNREADABLE_STORE_WINDOW_MS,
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

  it('skips on its first read a file last written over a second ago — corrupt since before serve started', () => {
    // Its first sighting counts from its last write, not from now: a file
    // broken for a day refused every request in serve's first second.
    const path = join(dir, 'auth.json');
    writeFileSync(path, '{"auth_mode": "chatgpt", "tok');
    const old = (Date.now() - 86_400_000) / 1000;
    utimesSync(path, old, old);
    const memory = newUnreadableMemory();
    const warnings: string[] = [];
    const read = boundUnreadable(path, jsonStoreRead(path), memory, Date.now(), (line) => warnings.push(line));
    expect(read).toEqual({ state: 'absent', skipped: expect.stringContaining(path) });
    expect(memory.torn).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('so not a write in progress');
  });

  it('says a first-sight skip is judged by the file\'s age, not by content it has watched', () => {
    // One sighting is no observation of "the same content for Ns".
    const path = join(dir, 'auth.json');
    writeFileSync(path, '{"tok');
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(path, old, old);
    const warnings: string[] = [];
    expect(boundUnreadable(path, jsonStoreRead(path), newUnreadableMemory(), Date.now(), (l) => warnings.push(l)).state)
      .toBe('absent');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('not been modified for 60s');
    expect(warnings[0]).not.toContain('the same unparseable content');
  });

  it('is torn on its first read when its mtime is under the stale margin in the past — a coarse or lagging clock', () => {
    // FAT stores mtime to 2 s, and a file server's clock can lag the host's:
    // a write in progress can carry an mtime well behind now. Counted from
    // that mtime, a torn codex auth.json was skipped on its first read and
    // opencode's account served in its place (r17/tornskew.mts).
    const path = join(dir, 'auth.json');
    writeFileSync(path, '{"auth_mode": "chatgpt", "tok');
    const t0 = Date.now();
    const lagging = (t0 - (FIRST_SIGHT_STALE_MS - 1000)) / 1000;
    utimesSync(path, lagging, lagging);
    const memory = newUnreadableMemory();
    expect(boundUnreadable(path, jsonStoreRead(path), memory, t0).state).toBe('unreadable');
    // Then judged by its content, as any other file: the same bytes 1 s on are stuck.
    expect(boundUnreadable(path, jsonStoreRead(path), memory, t0 + TORN_REPEAT_MS).state).toBe('absent');
  });

  it('hashes the bytes the caller parsed, not a second read that may find a file renamed into place since', () => {
    // Re-reading to hash raced a writer: both failed reads hashed the valid
    // file that had landed between parse and hash, matched, and the second
    // skipped a file that had in fact moved.
    const path = join(dir, 'auth.json');
    const memory = newUnreadableMemory();
    const t0 = Date.now();
    const racedRead = (torn: string) => {
      writeFileSync(path, torn);
      const read = jsonStoreRead(path);
      writeFileSync(path, '{"auth_mode": "chatgpt"}');
      return read;
    };
    expect(boundUnreadable(path, racedRead('{"a'), memory, t0).state).toBe('unreadable');
    expect(boundUnreadable(path, racedRead('{"ab'), memory, t0 + TORN_REPEAT_MS).state).toBe('unreadable');
    expect(memory.files.get(path)?.hash).toBe(createHash('sha256').update('{"ab').digest('hex'));
  });

  it('is torn on its first read when just written, then skipped once the same bytes are seen 1 s later, warning once', () => {
    // A writer does not hold the same partial bytes for a second.
    const path = join(dir, 'auth.json');
    writeFileSync(path, '');
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
    // mtime counts only on a file's first sighting; after that, only its bytes.
    const path = join(dir, 'auth.json');
    writeFileSync(path, '{');
    const old = (Date.now() - 3 * W) / 1000;
    utimesSync(path, old, old);
    const memory = newUnreadableMemory();
    const t0 = Date.now();
    expect(boundUnreadable(path, jsonStoreRead(path), memory, t0).state).toBe('absent');
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
      utimesSync(path, (at - 200) / 1000, (at - 200) / 1000);
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

  it('keeps a stuck file skipped through one transient read error in between', () => {
    // A read error has no bytes, so it says nothing about the stuck bytes on
    // record: one EMFILE must not restart the second those bytes are judged by.
    const path = join(dir, 'auth.json');
    writeFileSync(path, '{"broken');
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(path, old, old);
    const memory = newUnreadableMemory();
    const warnings: string[] = [];
    const t0 = Date.now();
    expect(boundUnreadable(path, jsonStoreRead(path), memory, t0, (l) => warnings.push(l)).skipped).toBeDefined();
    const emfile = { state: 'unreadable' as const, detail: `${path}: EMFILE` };
    // The error itself is torn: its own run has only just begun.
    expect(boundUnreadable(path, emfile, memory, t0 + 3000, (l) => warnings.push(l)).state).toBe('unreadable');
    const after = boundUnreadable(path, jsonStoreRead(path), memory, t0 + 3100, (l) => warnings.push(l));
    expect(after.state).toBe('absent');
    expect(after.skipped).toBeDefined();
    expect(warnings).toHaveLength(1);
  });

  it('bounds a run of read errors on a file with stuck bytes on record by the 10 s cap of the errors alone', () => {
    const path = join(dir, 'auth.json');
    writeFileSync(path, '{"broken');
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(path, old, old);
    const memory = newUnreadableMemory();
    const t0 = Date.now();
    expect(boundUnreadable(path, jsonStoreRead(path), memory, t0).state).toBe('absent');
    const emfile = { state: 'unreadable' as const, detail: `${path}: EMFILE` };
    expect(boundUnreadable(path, emfile, memory, t0 + 1000).state).toBe('unreadable');
    expect(boundUnreadable(path, emfile, memory, t0 + 1000 + W - 1).state).toBe('unreadable');
    expect(boundUnreadable(path, emfile, memory, t0 + 1000 + W).state).toBe('absent');
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
    expect(states).toEqual(['absent', 'absent', 'absent', 'absent']);
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
