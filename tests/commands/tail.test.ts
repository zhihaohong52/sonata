import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdTail, decide, harnessOutput } from '../../src/commands/tail.js';
import { tailWaitSeconds } from '../../src/cli.js';
import { capturePane, killSession, newSession, sendKeys, tryCapturePaneHistory } from '../../src/tmux.js';
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

  it('still degrades a timed-out run that has a report file, and keeps its text', () => {
    // The report is what the run got as far as — degraded, since the work was
    // cut short, but it is the evidence the reader needs, not the pane tail.
    const r = decide({ ...base, exitCode: 0, report: 'a partial report', timedOut: true });
    expect(r.state).toBe('DONE');
    expect(r.degraded).toBe(true);
    expect(r.report).toBe('[timed out: sonata killed the run after the configured run_timeout_seconds]\n\na partial report');
  });

  it('keeps a fallback report`s text when the run timed out', () => {
    // claude sends all of its stdout to last-message.txt and leaves the pane
    // empty, so without this nothing but the bracket line survived.
    const r = decide({
      ...base, exitCode: 143, report: 'claude got this far', reportFromFallback: true, timedOut: true,
    });
    expect(r.degraded).toBe(true);
    expect(r.report).toMatch(/^\[timed out:/);
    expect(r.report).toContain('claude got this far');
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
  }, 30_000);

  afterEach(async () => { await killSession(session); });

  async function snapshotPrompt(): Promise<string> {
    // Stands in for an earlier poll, which leaves both captures behind: the
    // visible one prompts are read from, and the scrollback one new output is
    // diffed from.
    const pane = cleanPane(await capturePane(session));
    writeFileSync(join(runDir(cwd, id), 'pane.snapshot'), pane.join('\n'));
    const history = cleanPane((await tryCapturePaneHistory(session)) ?? '');
    writeFileSync(join(runDir(cwd, id), 'pane-history.snapshot'), history.join('\n'));
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
  async function waitForPane(text: string, timeoutMs = 20_000): Promise<void> {
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
/**
 * The pane is a live shell: once the wrapper exits, the shell prints its
 * prompt again, and that prompt is not the harness speaking. The shape below
 * is a real capture (zsh, 2026-09-27) of a harness that printed nothing and
 * exited 0 — which read as a read-only run that had answered, with the prompt
 * as its report.
 */
describe('tail decide — a read-only run whose terminal output is the report', () => {
  const long = Array.from({ length: 60 }, (_, i) => `finding ${i + 1}`);
  const readOnly = {
    ...base, exitCode: 0, canWriteReport: false, paneTail: long.slice(-20),
  };

  it('uses the whole harness log rather than the last 20 pane lines', () => {
    const r = decide({ ...readOnly, terminalLog: long.join('\n') });
    expect(r.degraded).toBe(false);
    expect(r.report).toContain('finding 1\n');
    expect(r.report).toContain('finding 60');
  });

  it('keeps the log`s paragraph breaks and drops its escapes', () => {
    const r = decide({ ...readOnly, terminalLog: '\u001b[1mSummary\u001b[0m\n\nAll clear.\n' });
    expect(r.report).toContain('Summary\n\nAll clear.');
  });

  it('falls back to the pane when the log is empty or absent', () => {
    expect(decide({ ...readOnly, terminalLog: ' \n' }).report).not.toContain('finding 40\n');
    expect(decide(readOnly).report).toContain('finding 60');
  });
});

describe('harnessOutput — the shell prompt around the run', () => {
  const marker = '/r/.sonata/runs/abc123/cmd.sh';
  const prompt = 'james@Zhis-MacBook-Air r1 %';
  const pane = [`${prompt} bash '${marker}'`, prompt];

  it('drops a line the pane already showed before launch', () => {
    expect(harnessOutput(pane, marker, [prompt])).toEqual([]);
  });

  it('drops every line of a multi-line prompt', () => {
    const two = ['╭─ ~/proj  main', '╰─ ❯'];
    expect(harnessOutput([...two, `╰─ ❯ bash '${marker}'`, 'answer', ...two], marker, two))
      .toEqual(['answer']);
  });

  it('does not degrade a run without the snapshot differently than before', () => {
    expect(harnessOutput(pane, marker)).toEqual([prompt]);
  });

  it('flags a silent read-only run that exited 0 as having said nothing', () => {
    const r = decide({
      ...base, exitCode: 0, canWriteReport: false, paneTail: pane,
      launchMarker: marker, preLaunchPane: [prompt],
    });
    expect(r.degraded).toBe(true);
    expect(r.report).toMatch(/nothing ran/);
  });

  it('still accepts a read-only run that spoke between the prompts', () => {
    const r = decide({
      ...base, exitCode: 0, canWriteReport: false,
      paneTail: [pane[0], 'No defects found.', prompt],
      launchMarker: marker, preLaunchPane: [prompt],
    });
    expect(r.degraded).toBe(false);
  });
});

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

describe('tail decide — a fallback report from a failed harness', () => {
  // The fallback file (codex/claude `last-message.txt`) is the harness's
  // account, not the model's report: claude writes its own error output into
  // it, so a crash fills it as readily as a final message does. Treating it as
  // trusted after a failed exit is how a 404 became a clean DONE.
  it('degrades a fallback report when the harness exited non-zero', () => {
    const r = decide({
      ...base,
      exitCode: 1,
      report: 'API Error: 404 model not found',
      reportFromFallback: true,
    });
    expect(r.state).toBe('DONE');
    expect(r.degraded).toBe(true);
  });

  it('says why a fallback report cannot be trusted and keeps its text', () => {
    const r = decide({
      ...base,
      exitCode: 1,
      report: 'API Error: 404 model not found',
      reportFromFallback: true,
    });
    expect(r.report).toMatch(/^\[degraded:/);
    expect(r.report).toContain('fallback');
    expect(r.report).toContain('API Error: 404 model not found');
  });

  it('still trusts a fallback report from a clean exit', () => {
    const r = decide({
      ...base,
      exitCode: 0,
      report: 'I fixed the bug.',
      reportFromFallback: true,
    });
    expect(r.state).toBe('DONE');
    expect(r.degraded).toBe(false);
    expect(r.report).toBe('I fixed the bug.');
  });

  it("still trusts the model's own report.md even when the exit is non-zero", () => {
    // The model wrote report.md itself; a non-zero exit alone must not
    // demote a report the model produced.
    const r = decide({ ...base, exitCode: 1, report: 'I fixed the bug.' });
    expect(r.state).toBe('DONE');
    expect(r.degraded).toBe(false);
    expect(r.report).toBe('I fixed the bug.');
  });

  it('leaves a run with no report at all to the existing verdict', () => {
    const r = decide({ ...base, exitCode: 1, report: null });
    expect(r.degraded).toBe(true);
    expect(r.report).toContain('without writing a report');
  });
});

describe('cmdTail reads a read-only run`s report from its harness log', () => {
  // The wiring: the decide test above covers the choice, this covers that
  // cmdTail actually reads harness.log into it.
  let cwd: string;
  const session = 'sonata-test-tail-readonly';
  const id = 'aaa111';

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), 'sonata-tail-ro-'));
    writeFileSync(join(cwd, 'sonata.toml'), '[run]\nstall_timeout_seconds = 120\n');
    mkdirSync(runDir(cwd, id), { recursive: true });
    writeFileSync(join(runDir(cwd, id), 'meta.json'), JSON.stringify({
      id, role: 'review', model: 'm', harness: 'pi', mode: 'plan',
      interactive: false, session, cwd, startedAt: '2026-09-27T00:00:00.000Z',
      canWriteReport: false,
    }));
    const log = Array.from({ length: 60 }, (_, i) => `finding ${i + 1}`).join('\n');
    writeFileSync(join(runDir(cwd, id), 'harness.log'), `${log}\n`);
    writeFileSync(join(runDir(cwd, id), 'exit'), '0\n');
    await newSession({ session, cwd });
    await sendKeys(session, "printf 'finding 60\\n'");
    await sendKeys(session, 'Enter');
  });

  afterEach(async () => { await killSession(session); });

  it('returns every line the harness printed', async () => {
    const r = await cmdTail({ cwd, id, waitSeconds: 0, settleMs: 200 });
    expect(r.state).toBe('DONE');
    expect(r.report).toContain('finding 1\n');
    expect(r.report).toContain('finding 59');
  });
});

describe('cmdTail waits for the worktree capture the exit sentinel outruns', () => {
  // harness.sh writes the exit sentinel before the wrapper's capture runs, so
  // a finished run can be seen before its closing sample exists. Deciding then
  // compared against a live sample of a tree that may already have moved.
  let cwd: string;
  const session = 'sonata-test-tail-capture';
  const id = 'ccc111';

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), 'sonata-tail-capture-'));
    writeFileSync(join(cwd, 'sonata.toml'), '[run]\nstall_timeout_seconds = 120\n');
    mkdirSync(runDir(cwd, id), { recursive: true });
    writeFileSync(join(runDir(cwd, id), 'meta.json'), JSON.stringify({
      id, role: 'code', model: 'm', harness: 'opencode', mode: 'acceptEdits',
      interactive: false, session, cwd, startedAt: '2026-09-27T00:00:00.000Z',
      worktreeAtLaunch: 'launch-fingerprint',
    }));
    writeFileSync(join(runDir(cwd, id), 'report.md'), 'I fixed the bug.');
    writeFileSync(join(runDir(cwd, id), 'exit'), '0\n');
    await newSession({ session, cwd });
  });

  afterEach(async () => { await killSession(session); });

  it('keeps reporting PROGRESS while the capture has not landed', async () => {
    const r = await cmdTail({ cwd, id, waitSeconds: 0, settleMs: 0 });
    expect(r.state).toBe('PROGRESS');
  });

  it('finishes once the capture appears', async () => {
    writeFileSync(join(runDir(cwd, id), 'worktree-capture'), 'x');
    const r = await cmdTail({ cwd, id, waitSeconds: 0, settleMs: 0 });
    expect(r.state).toBe('DONE');
  });

  it('does not wait on an exit sentinel dated in the future', async () => {
    // A skewed clock or a restored run directory can leave the mtime ahead of
    // now; "within ten seconds" must not include every moment before it.
    const future = new Date(Date.now() + 3_600_000);
    utimesSync(join(runDir(cwd, id), 'exit'), future, future);
    const r = await cmdTail({ cwd, id, waitSeconds: 0, settleMs: 0 });
    expect(r.state).toBe('DONE');
  });

  it('gives up waiting ten seconds after the exit sentinel', async () => {
    const old = new Date(Date.now() - 11_000);
    utimesSync(join(runDir(cwd, id), 'exit'), old, old);
    const r = await cmdTail({ cwd, id, waitSeconds: 0, settleMs: 0 });
    expect(r.state).toBe('DONE');
  });
});

describe('cmdTail records output that scrolled past the visible pane', () => {
  // `sonata log` prints events.jsonl, which was diffed from a visible-only
  // capture: anything more than one screen (50 rows) between polls was never
  // recorded, and a run nobody tailed kept only its last screen.
  let cwd: string;
  const session = 'sonata-test-tail-scroll';
  const id = 'ddd111';

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), 'sonata-tail-scroll-'));
    writeFileSync(join(cwd, 'sonata.toml'), '[run]\nstall_timeout_seconds = 120\n');
    mkdirSync(runDir(cwd, id), { recursive: true });
    writeFileSync(join(runDir(cwd, id), 'meta.json'), JSON.stringify({
      id, role: 'code', model: 'm', harness: 'opencode', mode: 'acceptEdits',
      interactive: false, session, cwd, startedAt: '2026-09-27T00:00:00.000Z',
    }));
    await newSession({ session, cwd });
    await sendKeys(session, "seq -f 'row-%g' 1 150");
    await sendKeys(session, 'Enter');
    // The pane's shell is the user's own login shell, whose startup under a
    // loaded full-suite run took past the old silent 5s deadline — the test
    // then tailed a pane holding only the typed command. Wait long enough,
    // and fail here, legibly, rather than in the assertion.
    const deadline = Date.now() + 25_000;
    while (!(await capturePane(session)).includes('row-150')) {
      if (Date.now() > deadline) throw new Error('seq never printed row-150 in the pane');
      await new Promise((r) => setTimeout(r, 25));
    }
  }, 30_000);

  afterEach(async () => { await killSession(session); });

  it('keeps every line in the event log, not just the last screen', async () => {
    await cmdTail({ cwd, id, waitSeconds: 0 });
    const events = readEvents(cwd, id);
    expect(events).toContain('row-1');
    expect(events).toContain('row-150');
  });

  it('does not record a line twice across polls', async () => {
    await cmdTail({ cwd, id, waitSeconds: 0 });
    await sendKeys(session, "echo 'after'");
    await sendKeys(session, 'Enter');
    const deadline = Date.now() + 20_000;
    while (!(await capturePane(session)).split('\n').some((l) => l.trim() === 'after')) {
      if (Date.now() > deadline) throw new Error("echo never printed 'after' in the pane");
      await new Promise((r) => setTimeout(r, 25));
    }
    await cmdTail({ cwd, id, waitSeconds: 0 });
    const events = readEvents(cwd, id);
    expect(events.filter((l) => l === 'row-1')).toHaveLength(1);
    expect(events.filter((l) => l === 'after')).toHaveLength(1);
  });
});

describe('cmdTail degrades a fallback report from a failed run', () => {
  // The `decide` tests above cover the predicate; this covers the WIRING —
  // that cmdTail threads reportFromFallback from the adapter's fallback file
  // when report.md is absent. Without it the threading could be deleted with
  // the suite green.
  let cwd: string;
  const session = 'sonata-test-tail-fallback';
  const id = 'fb1234';

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), 'sonata-tail-fallback-'));
    writeFileSync(join(cwd, 'sonata.toml'), '[run]\nstall_timeout_seconds = 120\n');
    mkdirSync(runDir(cwd, id), { recursive: true });
    writeFileSync(join(runDir(cwd, id), 'meta.json'), JSON.stringify({
      id, role: 'code', model: 'gpt-5.6-luna', harness: 'codex', mode: 'acceptEdits',
      interactive: false, session, cwd, startedAt: '2026-09-27T00:00:00.000Z',
    }));
    writeFileSync(join(runDir(cwd, id), 'last-message.txt'), 'API Error: 404 model not found');
    writeFileSync(join(runDir(cwd, id), 'exit'), '1\n');
    await newSession({ session, cwd });
  });

  afterEach(async () => { await killSession(session); });

  it('threads reportFromFallback through to the degraded verdict', async () => {
    const r = await cmdTail({ cwd, id, waitSeconds: 0, settleMs: 0 });

    expect(r.state).toBe('DONE');
    expect(r.degraded).toBe(true);
    expect(r.report).toMatch(/^\[degraded:/);
    expect(r.report).toContain('API Error: 404 model not found');
  });

  it('reads the fallback file when report.md exists but is empty', async () => {
    // An empty report.md used to shadow last-message.txt and be trusted as a
    // finished, un-degraded report of nothing.
    writeFileSync(join(runDir(cwd, id), 'report.md'), '');
    const r = await cmdTail({ cwd, id, waitSeconds: 0, settleMs: 0 });

    expect(r.degraded).toBe(true);
    expect(r.report).toContain('API Error: 404 model not found');
  });

  it('does not flag a run whose model wrote report.md itself', async () => {
    writeFileSync(join(runDir(cwd, id), 'report.md'), 'I fixed the bug.');
    const r = await cmdTail({ cwd, id, waitSeconds: 0, settleMs: 0 });

    expect(r.state).toBe('DONE');
    expect(r.degraded).toBe(false);
    expect(r.report).toContain('I fixed the bug.');
  });
});
