import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initLogDir, openInitLog, pruneInitLogs, nullInitLog } from '../src/commands/init-log.js';

describe('openInitLog', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'init-log-')); });
  // The suite must not accumulate temp directories; this repo already has that.
  afterEach(() => { rmSync(home, { force: true, recursive: true }); });

  it('writes into the config directory, named by the start time', () => {
    const log = openInitLog(home, new Date('2026-08-21T02:34:40.920Z'));
    expect(log.path).toBe(join(initLogDir(home), 'init-2026-08-21T02-34-40-920Z.log'));
    expect(readFileSync(log.path, 'utf8')).toContain('2026-08-21T02:34:40.920Z');
  });

  it('appends each line as it happens', () => {
    // Line by line rather than at the end, because the run worth reading about
    // is the one that never reaches its end.
    const log = openInitLog(home);
    log.line('first');
    log.line('second');
    const body = readFileSync(log.path, 'utf8');
    expect(body).toContain('first\nsecond\n');
  });

  it('records an error with its stack', () => {
    const log = openInitLog(home);
    log.fail(new Error('boom'));
    const body = readFileSync(log.path, 'utf8');
    expect(body).toContain('Error: boom');
    expect(body).toContain('init-log.test');
  });

  it('records a thrown non-Error too', () => {
    const log = openInitLog(home);
    log.fail('just a string');
    expect(readFileSync(log.path, 'utf8')).toContain('just a string');
  });

  it('never throws when the home cannot be written', () => {
    // Logging must not be able to fail the command it is logging.
    // The unwritable home is a plain file, so mkdir fails ENOTDIR on every
    // platform. Never point this at /proc: on Linux the EACCES mid-walk sends
    // recursive mkdirSync into a synchronous spin that no test timeout can
    // interrupt — it hung every CI run while passing on /proc-less macOS.
    const fileAsHome = join(home, 'not-a-directory');
    writeFileSync(fileAsHome, '');
    const log = openInitLog(fileAsHome);
    expect(() => { log.line('x'); log.fail(new Error('y')); }).not.toThrow();
  });

  it('nullInitLog accepts everything and writes nothing', () => {
    expect(() => { nullInitLog.line('x'); nullInitLog.fail(new Error('y')); }).not.toThrow();
    expect(nullInitLog.path).toBe('');
  });
});

describe('pruneInitLogs', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'init-log-prune-'));
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => { rmSync(dir, { force: true, recursive: true }); });

  it('keeps the newest logs and deletes the rest', () => {
    for (let n = 1; n <= 15; n++) {
      writeFileSync(join(dir, `init-2026-08-21T00-00-${String(n).padStart(2, '0')}Z.log`), 'x');
    }
    const removed = pruneInitLogs(dir, 10);
    expect(removed).toHaveLength(5);
    const left = readdirSync(dir).sort();
    expect(left).toHaveLength(10);
    // Names are timestamps, so lexical order is chronological order.
    expect(left[0]).toContain('00-00-06Z');
  });

  it('leaves files it did not write alone', () => {
    writeFileSync(join(dir, 'notes.txt'), 'mine');
    for (let n = 1; n <= 12; n++) {
      writeFileSync(join(dir, `init-2026-08-21T00-00-${String(n).padStart(2, '0')}Z.log`), 'x');
    }
    pruneInitLogs(dir, 5);
    expect(readdirSync(dir)).toContain('notes.txt');
  });

  it('tolerates a missing directory', () => {
    expect(pruneInitLogs(join(dir, 'nope'))).toEqual([]);
  });
});
