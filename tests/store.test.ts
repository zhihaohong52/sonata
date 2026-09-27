import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  newRunId, runDir, createRun, readMeta, writeMeta,
  readExit, readReport, readCursor, writeCursor,
  appendEvents, readEvents, listRuns, readAnsweredPrompt,
  writeAnsweredPrompt, clearAnsweredPrompt,
} from '../src/store.js';

let cwd: string;
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'sonata-store-')); });

describe('run store', () => {
  it('generates twelve-hex-char ids', () => {
    // Three bytes collided at roughly n^2/33.5M over a project's lifetime, and
    // a collision reused a finished run's directory — its exit sentinel and
    // report.md read back as the new run's instant, trusted result.
    expect(newRunId()).toMatch(/^[0-9a-f]{12}$/);
  });

  it('never reuses an existing run directory', () => {
    const ids = ['aaaaaa111111', 'aaaaaa111111', 'bbbbbb222222'];
    const init = {
      role: 'code', model: 'm', harness: 'opencode',
      mode: 'acceptEdits' as const, interactive: false, startedAt: '2026-08-10T00:00:00.000Z',
    };
    const first = createRun(cwd, init, () => ids.shift()!);
    writeFileSync(join(runDir(cwd, first.id), 'exit'), '0\n');
    const second = createRun(cwd, init, () => ids.shift()!);
    expect(first.id).toBe('aaaaaa111111');
    expect(second.id).toBe('bbbbbb222222');
    expect(readExit(cwd, second.id)).toBeNull();
  });

  it('refuses a run id that is not one sonata could have made', () => {
    // Every CLI entry (`log`, `tail`, `wait`, `approve`, `verify`) takes the id
    // raw; a path segment like `../../x` would read or write outside .sonata.
    for (const bad of ['../../etc', 'abc', '/abs', 'ABCDEF', 'abc123/..', '']) {
      expect(() => runDir(cwd, bad)).toThrow(/not a sonata run id/);
    }
    expect(runDir(cwd, 'abc123')).toBe(join(cwd, '.sonata', 'runs', 'abc123'));
  });

  it('creates a run and reads its meta back', () => {
    const meta = createRun(cwd, {
      role: 'code', model: 'deepseek-v4-flash', harness: 'opencode',
      mode: 'acceptEdits', interactive: false, startedAt: '2026-08-10T00:00:00.000Z',
    });
    expect(meta.id).toMatch(/^[0-9a-f]{12}$/);
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

  it('reads an empty or whitespace-only report.md as no report at all', () => {
    // A zero-length report.md is what a model leaves when it creates the file
    // and never fills it — and the codex/reasonix quit watchers fire on the
    // file merely existing. Read as "", it was trusted as a finished report and
    // hid the harness's own fallback file behind it.
    const meta = createRun(cwd, {
      role: 'code', model: 'm', harness: 'codex',
      mode: 'acceptEdits', interactive: false, startedAt: '2026-08-10T00:00:00.000Z',
    });
    writeFileSync(join(runDir(cwd, meta.id), 'report.md'), '');
    expect(readReport(cwd, meta.id)).toBeNull();
    writeFileSync(join(runDir(cwd, meta.id), 'report.md'), '  \n\t\n');
    expect(readReport(cwd, meta.id)).toBeNull();
  });

  it('persists meta updates', () => {
    const meta = createRun(cwd, {
      role: 'code', model: 'm', harness: 'opencode',
      mode: 'default', interactive: false, startedAt: '2026-08-10T00:00:00.000Z',
    });
    writeMeta(cwd, { ...meta, exitCode: 1, degraded: true });
    expect(readMeta(cwd, meta.id).degraded).toBe(true);
  });

  it('records and clears an answered prompt', () => {
    const meta = createRun(cwd, {
      role: 'code', model: 'm', harness: 'codex',
      mode: 'default', interactive: true, startedAt: '2026-08-10T00:00:00.000Z',
    });
    expect(readAnsweredPrompt(cwd, meta.id)).toBeNull();
    writeAnsweredPrompt(cwd, meta.id, 'Allow ls?');
    expect(readAnsweredPrompt(cwd, meta.id)).toBe('Allow ls?');
    clearAnsweredPrompt(cwd, meta.id);
    expect(readAnsweredPrompt(cwd, meta.id)).toBeNull();
  });
});
