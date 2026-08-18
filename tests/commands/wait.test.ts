import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdWait } from '../../src/commands/wait.js';
import type { TailResult } from '../../src/commands/tail.js';

function repo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'sonata-wait-'));
  writeFileSync(join(cwd, 'sonata.toml'), `
[models.m]
harness = "opencode"
id = "p/m"

[generate.roles]
code = ["m"]
`);
  return cwd;
}

/** A scripted cmdTail: returns each result in order, repeating the last. */
function scripted(results: TailResult[]) {
  let i = 0;
  return async () => results[Math.min(i++, results.length - 1)];
}

const PROGRESS: TailResult = { state: 'PROGRESS', lines: [] };

describe('cmdWait', () => {
  it('keeps waiting through PROGRESS and returns the first terminal state', async () => {
    const done: TailResult = { state: 'DONE', lines: [], report: 'the report', exitCode: 0, degraded: false };
    const r = await cmdWait({
      cwd: repo(), id: 'abc123', pollMs: 1,
      tail: scripted([PROGRESS, PROGRESS, done]) as any,
    });
    expect(r.state).toBe('DONE');
    expect(r.report).toBe('the report');
    expect(r.id).toBe('abc123');
  });

  it('returns on PAUSED so a human can answer', async () => {
    const paused: TailResult = { state: 'PAUSED', lines: [], prompt: 'Allow once?' };
    const r = await cmdWait({
      cwd: repo(), id: 'abc123', pollMs: 1,
      tail: scripted([PROGRESS, paused]) as any,
    });
    expect(r.state).toBe('PAUSED');
    expect(r.prompt).toBe('Allow once?');
  });

  it('returns on STALLED rather than blocking to the idle timeout', async () => {
    const stalled: TailResult = { state: 'STALLED', lines: ['nothing since'] };
    const r = await cmdWait({
      cwd: repo(), id: 'abc123', pollMs: 1,
      tail: scripted([stalled]) as any,
    });
    expect(r.state).toBe('STALLED');
  });

  // The window keeps the call inside Claude Code's 30-minute stdio idle
  // window. RUNNING is resumable: the run is untouched and still in tmux.
  it('gives up its window and returns RUNNING, not a failure', async () => {
    let t = 0;
    const r = await cmdWait({
      cwd: repo(), id: 'abc123', pollMs: 1, windowSeconds: 10,
      now: () => (t += 4_000),
      tail: scripted([PROGRESS]) as any,
    });
    expect(r.state).toBe('RUNNING');
    expect(r.id).toBe('abc123');
  });
});
