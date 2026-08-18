import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdTail, decide, harnessOutput } from '../../src/commands/tail.js';
import { tailWaitSeconds } from '../../src/cli.js';
import { capturePane, killSession, newSession, sendKeys } from '../../src/tmux.js';
import { readAnsweredPrompt, readCursor, readEvents, runDir, writeAnsweredPrompt } from '../../src/store.js';
import { cleanPane } from '../../src/normalize.js';
import { codexAdapter } from '../../src/adapters/codex.js';

describe('tailWaitSeconds', () => {
  it('uses the configured window when --wait is absent', () => {
    expect(tailWaitSeconds(undefined, 45)).toBe(45);
  });

  it('lets --wait override it', () => {
    expect(tailWaitSeconds('5', 45)).toBe(5);
  });

  it('falls back to the configured window for a non-numeric flag', () => {
    expect(tailWaitSeconds('soon', 45)).toBe(45);
  });
});

const base = {
  newLines: [] as string[],
  exitCode: null as number | null,
  report: null as string | null,
  promptText: null as string | null,
  msSinceLastChange: 0,
  stallTimeoutMs: 120_000,
  paneTail: ['last', 'lines'],
  timedOut: false,
};

describe('tail decide — runs that cannot write a report', () => {
  const readOnly = { ...base, canWriteReport: false };

  it('does not call a clean read-only run degraded for lacking a report', () => {
    // pi's read-only allowlist removes the write tool, so the model cannot
    // write report.md. Nothing went wrong; the terminal output is the report.
    const r = decide({ ...readOnly, exitCode: 0 });
    expect(r.state).toBe('DONE');
    expect(r.degraded).toBe(false);
    expect(r.report).toContain('cannot write a report file');
    expect(r.report).toContain('last\nlines');
  });

  it('still flags a read-only run that crashed', () => {
    // Only a clean exit is expected to lack a report. A non-zero exit is a
    // real failure and must not be excused by the same rule.
    const r = decide({ ...readOnly, exitCode: 139 });
    expect(r.degraded).toBe(true);
    expect(r.report).toContain('degraded');
  });

  it('still flags a read-only run that timed out', () => {
    const r = decide({ ...readOnly, exitCode: 143, timedOut: true });
    expect(r.degraded).toBe(true);
    expect(r.report).toMatch(/^\[timed out:/);
  });

  it('prefers a real report when one exists anyway', () => {
    const r = decide({ ...readOnly, exitCode: 0, report: 'written after all' });
    expect(r.degraded).toBe(false);
    expect(r.report).toBe('written after all');
  });

  it('leaves write-capable runs degraded when they write nothing', () => {
    const r = decide({ ...base, canWriteReport: true, exitCode: 0 });
    expect(r.degraded).toBe(true);
  });

  // A read-only run was previously accepted on the exit code alone, so a
  // harness that died before saying anything — locked database, expired
  // token, bad model id — reported DONE and not degraded, with the echo of
  // sonata's own launch command standing in for the report.
  const LAUNCH = '/repo/.sonata/runs/abc123/cmd.sh';

  it('flags a read-only run that exited cleanly having said nothing', () => {
    const r = decide({
      ...readOnly,
      exitCode: 0,
      paneTail: [`bash "${LAUNCH}"`, `user@host repo % bash "${LAUNCH}"`, '  '],
      launchMarker: LAUNCH,
    });
    expect(r.degraded).toBe(true);
    expect(r.report).toContain('without producing any output');
  });

  it('accepts a read-only run that produced even one line of its own', () => {
    const r = decide({
      ...readOnly,
      exitCode: 0,
      paneTail: [`bash "${LAUNCH}"`, 'math.js exports add'],
      launchMarker: LAUNCH,
    });
    expect(r.degraded).toBe(false);
    expect(r.report).toContain('cannot write a report file');
  });

  it('does not mistake a blank pane for output when no marker is given', () => {
    const r = decide({ ...readOnly, exitCode: 0, paneTail: ['', '   '] });
    expect(r.degraded).toBe(true);
  });
});

describe('harnessOutput', () => {
  const LAUNCH = '/repo/.sonata/runs/abc123/cmd.sh';

  it('drops blank lines and every echo of the launch command', () => {
    expect(harnessOutput([
      `bash "${LAUNCH}"`,
      '',
      `user@host repo % bash "${LAUNCH}"`,
      '   ',
      'real output',
    ], LAUNCH)).toEqual(['real output']);
  });

  it('keeps output that merely mentions a similar path', () => {
    expect(harnessOutput(['read /repo/.sonata/runs/abc123/report.md'], LAUNCH))
      .toEqual(['read /repo/.sonata/runs/abc123/report.md']);
  });
});

describe('tail decide', () => {
  it('reports DONE with the report when the exit sentinel exists', () => {
    const r = decide({ ...base, exitCode: 0, report: 'all good' });
    expect(r.state).toBe('DONE');
    expect(r.report).toBe('all good');
    expect(r.degraded).toBe(false);
    expect(r.exitCode).toBe(0);
  });

  it('marks DONE degraded when the process exited without a report', () => {
    const r = decide({ ...base, exitCode: 1, report: null });
    expect(r.state).toBe('DONE');
    expect(r.degraded).toBe(true);
    expect(r.report).toContain('last');
  });

  it('prefers DONE over a stale prompt match', () => {
    const r = decide({ ...base, exitCode: 0, report: 'x', promptText: 'Allow? (y/n)' });
    expect(r.state).toBe('DONE');
  });

  it('reports PAUSED when a prompt is pending', () => {
    const r = decide({ ...base, promptText: 'Allow bash rm -rf build? (y/n)' });
    expect(r.state).toBe('PAUSED');
    expect(r.prompt).toContain('rm -rf build');
  });

  it('reports PROGRESS when there are new lines', () => {
    const r = decide({ ...base, newLines: ['reading a.ts'] });
    expect(r.state).toBe('PROGRESS');
    expect(r.lines).toEqual(['reading a.ts']);
  });

  it('reports STALLED after the timeout with no change', () => {
    const r = decide({ ...base, msSinceLastChange: 130_000 });
    expect(r.state).toBe('STALLED');
    expect(r.lines).toEqual(['last', 'lines']);
  });

  it('stays PROGRESS while quiet but under the stall timeout', () => {
    const r = decide({ ...base, msSinceLastChange: 5_000 });
    expect(r.state).toBe('PROGRESS');
    expect(r.lines).toEqual([]);
  });

  it('marks a timed-out finished run DONE degraded with the timeout line', () => {
    const r = decide({ ...base, exitCode: 0, timedOut: true });
    expect(r.state).toBe('DONE');
    expect(r.degraded).toBe(true);
    expect(r.report).toMatch(/^\[timed out: sonata killed the run after the configured run_timeout_seconds\]\n\n/);
  });

  it('still degrades a timed-out run that has a report file', () => {
    const r = decide({ ...base, exitCode: 0, report: 'a complete report', timedOut: true });
    expect(r.state).toBe('DONE');
    expect(r.degraded).toBe(true);
    expect(r.report).toMatch(/^\[timed out: sonata killed the run after the configured run_timeout_seconds\]/);
    expect(r.report).toContain('last');
  });
});

describe('cmdTail answered prompts', () => {
  let cwd: string;
  const session = 'sonata-test-tail-prompt';
  const id = 'abc123';

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), 'sonata-tail-'));
    writeFileSync(join(cwd, 'sonata.toml'), '[run]\nstall_timeout_seconds = 120\n');
    mkdirSync(runDir(cwd, id), { recursive: true });
    writeFileSync(join(runDir(cwd, id), 'meta.json'), JSON.stringify({
      id, role: 'code', model: 'm', harness: 'codex', mode: 'default',
      interactive: true, session, cwd, startedAt: '2026-08-10T00:00:00.000Z',
    }));
    await newSession({ session, cwd });
    await sendKeys(session, "printf 'Would you like to run the following command?\\n$ ls\\nPress Enter to confirm\\n'");
    await sendKeys(session, 'Enter');
    await new Promise((r) => setTimeout(r, 500));
  });

  afterEach(async () => { await killSession(session); });

  async function snapshotPrompt(): Promise<string> {
    const pane = cleanPane(await capturePane(session));
    writeFileSync(join(runDir(cwd, id), 'pane.snapshot'), pane.join('\n'));
    return codexAdapter.describePrompt(pane)!;
  }

  it('does not report a prompt that was already answered', async () => {
    writeAnsweredPrompt(cwd, id, await snapshotPrompt());
    const result = await cmdTail({ cwd, id, waitSeconds: 0 });
    expect(result.state).toBe('PROGRESS');
  });

  it('reports the same prompt after fresh pane output clears the answer record', async () => {
    writeAnsweredPrompt(cwd, id, await snapshotPrompt());
    await sendKeys(session, "printf 'working\\n'");
    await sendKeys(session, 'Enter');
    await new Promise((r) => setTimeout(r, 100));
    const result = await cmdTail({ cwd, id, waitSeconds: 0 });
    expect(result.state).toBe('PAUSED');
    expect(readAnsweredPrompt(cwd, id)).toBeNull();
  });

  it('reports an unanswered prompt', async () => {
    await snapshotPrompt();
    const result = await cmdTail({ cwd, id, waitSeconds: 0 });
    expect(result.state).toBe('PAUSED');
  });

  it('emits persisted new harness output', async () => {
    await snapshotPrompt();
    await sendKeys(session, "printf 'streamed output\\n'");
    await sendKeys(session, 'Enter');
    await new Promise((r) => setTimeout(r, 100));
    let emitted: string[] = [];

    await cmdTail({
      cwd, id, waitSeconds: 0,
      onLines: (lines) => {
        emitted = lines;
        expect(readEvents(cwd, id)).toEqual(expect.arrayContaining(lines));
        expect(readCursor(cwd, id)).toBeGreaterThanOrEqual(lines.length);
      },
    });

    expect(emitted).toContain('streamed output');
  });

  it('continues when the output observer throws', async () => {
    await snapshotPrompt();
    await sendKeys(session, "printf 'streamed output\\n'");
    await sendKeys(session, 'Enter');
    await new Promise((r) => setTimeout(r, 100));

    await expect(cmdTail({
      cwd, id, waitSeconds: 0,
      onLines: () => { throw new Error('notifications unavailable'); },
    })).resolves.toMatchObject({ state: 'PAUSED' });
  });
});
