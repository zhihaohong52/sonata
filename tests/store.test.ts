import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  newRunId, runDir, createRun, readMeta, writeMeta,
  readExit, readReport, readCursor, writeCursor,
  appendEvents, readEvents, listRuns,
} from '../src/store.js';

let cwd: string;
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'sonata-store-')); });

describe('run store', () => {
  it('generates six-hex-char ids', () => {
    expect(newRunId()).toMatch(/^[0-9a-f]{6}$/);
  });

  it('creates a run and reads its meta back', () => {
    const meta = createRun(cwd, {
      role: 'code', model: 'deepseek-v4-flash', harness: 'opencode',
      mode: 'acceptEdits', interactive: false, startedAt: '2026-08-10T00:00:00.000Z',
    });
    expect(meta.id).toMatch(/^[0-9a-f]{6}$/);
    expect(meta.session).toBe(`sonata-${meta.id}`);
    expect(readMeta(cwd, meta.id)).toEqual(meta);
    expect(listRuns(cwd)).toEqual([meta.id]);
  });

  it('returns null for a missing exit sentinel and a number once written', () => {
    const meta = createRun(cwd, {
      role: 'code', model: 'm', harness: 'opencode',
      mode: 'default', interactive: true, startedAt: '2026-08-10T00:00:00.000Z',
    });
    expect(readExit(cwd, meta.id)).toBeNull();
    writeFileSync(join(runDir(cwd, meta.id), 'exit'), '0\n');
    expect(readExit(cwd, meta.id)).toBe(0);
  });

  it('round-trips report, cursor and events', () => {
    const meta = createRun(cwd, {
      role: 'review', model: 'm', harness: 'opencode',
      mode: 'plan', interactive: false, startedAt: '2026-08-10T00:00:00.000Z',
    });
    expect(readReport(cwd, meta.id)).toBeNull();
    writeFileSync(join(runDir(cwd, meta.id), 'report.md'), 'done');
    expect(readReport(cwd, meta.id)).toBe('done');

    expect(readCursor(cwd, meta.id)).toBe(0);
    appendEvents(cwd, meta.id, ['a', 'b']);
    writeCursor(cwd, meta.id, 2);
    expect(readCursor(cwd, meta.id)).toBe(2);
    expect(readEvents(cwd, meta.id)).toEqual(['a', 'b']);
  });

  it('persists meta updates', () => {
    const meta = createRun(cwd, {
      role: 'code', model: 'm', harness: 'opencode',
      mode: 'default', interactive: false, startedAt: '2026-08-10T00:00:00.000Z',
    });
    writeMeta(cwd, { ...meta, exitCode: 1, degraded: true });
    expect(readMeta(cwd, meta.id).degraded).toBe(true);
  });
});
