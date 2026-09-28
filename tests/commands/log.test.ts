import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdLog } from '../../src/commands/log.js';
import { createRun, appendEvents, runDir } from '../../src/store.js';

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'sonata-log-'));
});

function newRun(): string {
  return createRun(cwd, {
    role: 'explore', model: 'fake', harness: 'opencode',
    mode: 'acceptEdits', interactive: false,
    startedAt: new Date().toISOString(),
  }).id;
}

describe('cmdLog', () => {
  it('returns every recorded line, not just the newest', () => {
    const id = newRun();
    appendEvents(cwd, id, ['reading a.ts', 'reading b.ts']);
    appendEvents(cwd, id, ['done']);

    const res = cmdLog({ cwd, id });
    expect(res.ok).toBe(true);
    expect(res.text).toContain('reading a.ts');
    expect(res.text).toContain('reading b.ts');
    expect(res.text).toContain('done');
  });

  it('carries the same provenance line a finished report does', () => {
    const id = newRun();
    appendEvents(cwd, id, ['output']);
    expect(cmdLog({ cwd, id }).text).toContain(`— sonata ${id}: explore on fake via opencode`);
  });

  it('prints the event log exactly as recorded', () => {
    const id = newRun();
    appendEvents(cwd, id, ['live line']);
    expect(cmdLog({ cwd, id }).text).toMatch(/^live line\n\n— sonata /);
  });

  it('prints a non-interactive run`s own harness log, cleaned, in place of the event log', () => {
    const id = newRun();
    appendEvents(cwd, id, ['line 9']);
    writeFileSync(join(runDir(cwd, id), 'harness.log'), 'line 1\n\u001b[32mline 2\u001b[0m\nline 9\n');
    expect(cmdLog({ cwd, id }).text).toMatch(/^line 1\nline 2\nline 9\n\n— sonata /);
  });

  it('prints the event log when harness.log is empty', () => {
    const id = newRun();
    appendEvents(cwd, id, ['live line']);
    writeFileSync(join(runDir(cwd, id), 'harness.log'), '  \n');
    expect(cmdLog({ cwd, id }).text).toMatch(/^live line\n\n— sonata /);
  });

  it('says so plainly when a run recorded nothing', () => {
    const id = newRun();
    const res = cmdLog({ cwd, id });
    expect(res.ok).toBe(true);
    expect(res.text).toContain('no output was recorded');
  });

  // A transcript for a run that never happened would be a fabrication with
  // sonata's name on it.
  it('refuses an unknown run rather than printing an empty transcript', () => {
    const res = cmdLog({ cwd, id: 'nosuch' });
    expect(res.ok).toBe(false);
    expect(res.text).toContain('no run "nosuch"');
  });
});
