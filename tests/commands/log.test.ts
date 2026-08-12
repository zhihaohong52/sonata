import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdLog } from '../../src/commands/log.js';
import { createRun, appendEvents } from '../../src/store.js';

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
