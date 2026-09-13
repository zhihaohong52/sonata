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

describe('tail decide — worktree delta', () => {
  const finished = { ...base, exitCode: 0, report: 'I fixed the bug.' };

  it('annotates a trusted run that changed nothing', () => {
    // The false success this check exists for: a confident report from a run
    // that never touched the tree.
    const r = decide({ ...finished, worktreeUnchanged: true });
    expect(r.report).toMatch(/^\[no worktree change:/);
    expect(r.report).toContain('I fixed the bug.');
  });

  it('does not degrade a run merely for changing nothing', () => {
    // Annotation, not verdict. A run that correctly concluded no change was
    // needed is a legitimate outcome; degrading it would trade false successes
    // for false alarms rather than removing either.
    const r = decide({ ...finished, worktreeUnchanged: true });
    expect(r.state).toBe('DONE');
    expect(r.degraded).toBe(false);
    expect(r.worktreeUnchanged).toBe(true);
  });

  it('leaves a run that changed something unannotated', () => {
    const r = decide({ ...finished, worktreeUnchanged: false });
    expect(r.report).toBe('I fixed the bug.');
    expect(r.worktreeUnchanged).toBe(false);
  });

  it('says nothing when the comparison was unavailable', () => {
    // Not a git repository, a read-only role, or a run predating the field.
    // Unknown must read as unknown, never as "changed nothing".
    const r = decide(finished);
    expect(r.report).toBe('I fixed the bug.');
    expect(r.worktreeUnchanged).toBeUndefined();
  });

  it('does not stack the note onto a degraded run', () => {
    // A degraded report already opens by saying why it cannot be believed;
    // "it also changed nothing" adds nothing to that.
    const r = decide({ ...base, exitCode: 1, worktreeUnchanged: true });
    expect(r.degraded).toBe(true);
    expect(r.report).toMatch(/^\[degraded:/);
    expect(r.report).not.toContain('no worktree change');
  });

  it('does not stack the note onto a timed-out run', () => {
    const r = decide({ ...finished, timedOut: true, worktreeUnchanged: true });
    expect(r.report).toMatch(/^\[timed out:/);
    expect(r.report).not.toContain('no worktree change');
  });
});

describe('tail decide — effort a harness could not honour', () => {
  const finished = { ...base, exitCode: 0, report: 'I fixed the bug.' };

  it('annotates a trusted run that ran at the harness default', () => {
    // The candidate was ranked at xhigh and dispatched to a harness sonata
    // cannot set a level on, so the run is not the model that was ranked. The
    // report is still trustworthy; the reader just needs to know which model
    // produced it.
    const r = decide({ ...finished, effort: 'xhigh', effortHonoured: false, harness: 'reasonix' });
    expect(r.report).toMatch(/^\[effort xhigh not honoured: sonata has no effort control for reasonix\]/);
    expect(r.report).toContain('I fixed the bug.');
  });

  it('does not degrade such a run', () => {
    // Effort is a preference, not a safety boundary, so the permission-mode
    // precedent — refuse rather than downgrade — deliberately does not apply.
    const r = decide({ ...finished, effort: 'xhigh', effortHonoured: false, harness: 'reasonix' });
    expect(r.state).toBe('DONE');
    expect(r.degraded).toBe(false);
  });

  it('says nothing when the harness did send the level', () => {
    const r = decide({ ...finished, effort: 'xhigh', effortHonoured: true, harness: 'codex' });
    expect(r.report).toBe('I fixed the bug.');
  });

  it('says nothing when no level was asked for', () => {
    // A bare candidate runs at the harness default by design; there is no
    // mismatch to report, whatever the harness can or cannot do.
    const r = decide({ ...finished, effortHonoured: false, harness: 'reasonix' });
    expect(r.report).toBe('I fixed the bug.');
  });

  it('annotates a read-only run, whose report is trusted too', () => {
    // `[read-only run: …]` does NOT say the report cannot be believed — it says
    // the terminal output IS the report, and the run is not degraded. So it is
    // a trusted branch and the note belongs on it. This is the branch a
    // reasonix review run takes, and reasonix is the one harness sonata has no
    // effort control for, so dropping it here would silence the annotation in
    // precisely the case it exists for.
    const r = decide({
      ...base, exitCode: 0, canWriteReport: false, report: null,
      paneTail: ['the model said this'], effort: 'xhigh', effortHonoured: false, harness: 'reasonix',
    });
    expect(r.degraded).toBe(false);
    expect(r.report).toMatch(/^\[effort xhigh not honoured: sonata has no effort control for reasonix\]/);
    expect(r.report).toContain('[read-only run:');
  });

  it('does not stack the note onto a degraded run', () => {
    const r = decide({ ...base, exitCode: 1, effort: 'xhigh', effortHonoured: false, harness: 'reasonix' });
    expect(r.report).toMatch(/^\[degraded:/);
    expect(r.report).not.toContain('not honoured');
  });

  it('carries both notes when the run also changed nothing', () => {
    const r = decide({
      ...finished, effort: 'max', effortHonoured: false, harness: 'reasonix', worktreeUnchanged: true,
    });
    expect(r.report).toMatch(/^\[effort max not honoured:/);
    expect(r.report).toContain('[no worktree change:');
    expect(r.report).toContain('I fixed the bug.');
  });
});

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

  it('never reports STALLED for a silent-until-exit harness', () => {
    const r = decide({ ...base, silentUntilExit: true, msSinceLastChange: 130_000 });
    expect(r.state).toBe('PROGRESS');
    expect(r.lines).toEqual([]);
  });

  it('a silent-until-exit run still finishes DONE on the exit sentinel', () => {
    const r = decide({ ...base, silentUntilExit: true, exitCode: 0, report: 'all good' });
    expect(r.state).toBe('DONE');
    expect(r.degraded).toBe(false);
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
    await waitForPane('Press Enter to confirm');
  });

  afterEach(async () => { await killSession(session); });

  async function snapshotPrompt(): Promise<string> {
    const pane = cleanPane(await capturePane(session));
    writeFileSync(join(runDir(cwd, id), 'pane.snapshot'), pane.join('\n'));
    return codexAdapter.describePrompt(pane)!;
  }

  /**
   * Waits until the pane actually shows the text, rather than assuming a fixed
   * delay is long enough for tmux to render it.
   *
   * The `setTimeout(100)` calls this replaces blocked an `npm publish` on
   * 2026-08-31: the test passed three times in isolation and failed inside the
   * full suite, where the machine is loaded enough that 100 ms sometimes is not
   * enough. A gate that fails on timing rather than on correctness is worse
   * than no gate — it teaches you to re-run a red suite instead of read it —
   * and this one sits in the release path, since `prepublishOnly` runs it.
   */
  async function waitForPane(text: string, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      // A whole line, not a substring. tmux echoes the command being typed, so
      // `printf 'streamed output\n'` puts the expected text on screen *before*
      // the command runs — a substring match returns on the echo and the test
      // then asserts against output that has not been produced yet. That is
      // the same race as the fixed sleep, just harder to see.
      const lines = (await capturePane(session)).split('\n').map((l) => l.trim());
      if (lines.includes(text)) return;
      if (Date.now() > deadline) {
        throw new Error(`pane never showed a line ${JSON.stringify(text)} within ${timeoutMs}ms`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
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
    await waitForPane('working');
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
    await waitForPane('streamed output');
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
    await waitForPane('streamed output');

    await expect(cmdTail({
      cwd, id, waitSeconds: 0,
      onLines: () => { throw new Error('notifications unavailable'); },
    })).resolves.toMatchObject({ state: 'PAUSED' });
  });
});

/**
 * `fg` in the watchdog echoes the job command line. That arrived after the
 * SIGTTIN fix and nothing filtered it, so sonata's own shell plumbing streamed
 * to the user as harness output — and counted as evidence the harness had
 * spoken, which is what the degraded check depends on.
 */
describe('harnessOutput — the watchdog fg echo', () => {
  it('drops the job line fg prints', () => {
    expect(harnessOutput([
      "bash '/repo/.sonata/runs/abc123/harness.sh'",
      'Refactored the parser',
    ])).toEqual(['Refactored the parser']);
  });

  it('still reports nothing spoken when only the echo is present', () => {
    expect(harnessOutput(["bash '/repo/.sonata/runs/abc123/harness.sh'"])).toEqual([]);
  });

  it('keeps a model line that merely mentions a harness path', () => {
    const line = 'I inspected bash scripts including /repo/.sonata/runs/abc123/harness.sh';
    expect(harnessOutput([line])).toEqual([line]);
  });
});

describe('cmdTail composes the effort annotation from the run`s own meta', () => {
  // The `decide` tests above cover the composition; this covers the WIRING.
  // Without it the three lines that read `meta.effort` / `meta.effortHonoured`
  // / `meta.harness` into `decide` could be deleted with the suite green, and
  // spec §7 asks for the annotation "through `tail`", not one layer below it.
  let cwd: string;
  const session = 'sonata-test-tail-effort';
  const id = 'eff123';

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), 'sonata-tail-effort-'));
    writeFileSync(join(cwd, 'sonata.toml'), '[run]\nstall_timeout_seconds = 120\n');
    mkdirSync(runDir(cwd, id), { recursive: true });
    writeFileSync(join(runDir(cwd, id), 'meta.json'), JSON.stringify({
      id, role: 'code', model: 'kimi', harness: 'reasonix', mode: 'acceptEdits',
      interactive: false, session, cwd, startedAt: '2026-09-14T00:00:00.000Z',
      effort: 'xhigh', effortHonoured: false,
    }));
    writeFileSync(join(runDir(cwd, id), 'report.md'), 'I fixed the bug.');
    writeFileSync(join(runDir(cwd, id), 'exit'), '0\n');
    await newSession({ session, cwd });
  });

  afterEach(async () => { await killSession(session); });

  it('annotates a finished run the harness could not honour the level for', async () => {
    const r = await cmdTail({ cwd, id, waitSeconds: 0, settleMs: 0 });

    expect(r.state).toBe('DONE');
    expect(r.degraded).toBe(false);
    expect(r.report).toMatch(/^\[effort xhigh not honoured: sonata has no effort control for reasonix\]/);
    expect(r.report).toContain('I fixed the bug.');
  });
});
