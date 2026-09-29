import { describe, it, expect, beforeAll } from 'vitest';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROBE_MAX_BUFFER, VERSION_PROBE_TIMEOUT_MS, runProbe } from '../src/version-probe.js';
import { probeVersion } from '../src/detect.js';

// A bound that fires is only half of a bound: the probe also has to SETTLE.
// execFile's timeout sends SIGTERM to the direct child and then waits for its
// stdio to close — so a binary that ignores TERM, or leaves a grandchild
// holding stdout, kept a "bounded" probe hanging past its bound.
//
// Wall-clock bounds here are proofs, not latency checks: each one sits far
// below what the bug would cost (the stubs' `sleep 30`, or a timeout set well
// above the bound), so it can be generous without losing what it proves. A
// probe that merely has to answer gets the real default bound, not a tight one
// that turns a loaded machine into a failure.
let bin: string;
const stub = (name: string, body: string) => {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
  return join(bin, name);
};

beforeAll(() => {
  bin = mkdtempSync(join(tmpdir(), 'probe-stub-'));
  // Traps TERM, and `sleep` is a grandchild holding the stdout pipe.
  stub('stubborn', "trap '' TERM\necho starting\nsleep 30\necho never");
  // Backgrounds a grandchild that inherits (and so holds) stdout, prints, and
  // exits at once — no `wait`. The direct child is gone; the pipe is not.
  stub('leaves-child', 'sleep 30 &\necho hi');
  stub('works', 'echo "works 1.2.3"');
  stub('fails', 'echo "Error: boom" >&2\nexit 3');
});

const settlesWithin = async <T>(promise: Promise<T>, ms: number): Promise<number> => {
  const start = Date.now();
  await promise.catch(() => undefined);
  const took = Date.now() - start;
  expect(took).toBeLessThan(ms);
  return took;
};

describe('runProbe', () => {
  it('returns stdout from a binary that answers', async () => {
    // `resolves` rather than awaiting: a rejection is reported with its own
    // message (killed, code, stderr), not as a TypeError on `.stdout`.
    await expect(runProbe(join(bin, 'works'), ['--version'], { timeoutMs: VERSION_PROBE_TIMEOUT_MS }))
      .resolves.toMatchObject({ stdout: 'works 1.2.3\n' });
  });

  it('settles a binary that traps TERM and sleeps, and reports it killed', async () => {
    const probe = runProbe(join(bin, 'stubborn'), ['--version'], { timeoutMs: 300 });
    await expect(probe).rejects.toMatchObject({ killed: true });
    // A probe that waited on the grandchild would take its `sleep 30`.
    await settlesWithin(runProbe(join(bin, 'stubborn'), ['--version'], { timeoutMs: 300 }), 10_000);
  });

  it('settles when a grandchild still holds stdout', async () => {
    // The timeout (60 s) and the grandchild's `sleep 30` are both far past the
    // bound (15 s), so settling within it proves it settled on the child's
    // exit plus the stdio grace (PROBE_STDIO_GRACE_MS) — not on the pipe
    // closing, nor on the timeout killing the group.
    const start = Date.now();
    const result = await runProbe(join(bin, 'leaves-child'), ['--version'], { timeoutMs: 60_000 });
    expect(Date.now() - start).toBeLessThan(15_000);
    expect(result.stdout.trim()).toBe('hi');
  });

  // 'exit' is not "the output is in": Node emits it once the process is
  // reaped, and the pipe's last bytes can be read in a later loop turn.
  // Measured in the suite: exit at 3.1 ms, the old "one turn" wait over at
  // 3.8 ms, "works 1.2.3" read at 5.4 ms — so the probe resolved with '' and
  // `sonata doctor` reported a harness with no version (~1 in 600 probes, the
  // first spawn of a busy worker). These make the late bytes deterministic: the
  // command exits at once and its output lands 300 ms later, then EOF.
  it('keeps output that arrives after the command has exited', async () => {
    const late = stub('late-output', '(sleep 0.3; echo "late 1.0") &\nexit 0');
    await expect(runProbe(late, ['--version'], { timeoutMs: VERSION_PROBE_TIMEOUT_MS }))
      .resolves.toMatchObject({ stdout: 'late 1.0\n' });
  });

  it('keeps stderr that arrives after a failing command has exited', async () => {
    const late = stub('late-error', '(sleep 0.3; echo "Error: late boom" >&2) &\nexit 3');
    await expect(runProbe(late, [], { timeoutMs: VERSION_PROBE_TIMEOUT_MS }))
      .rejects.toMatchObject({ code: 3, stderr: expect.stringContaining('Error: late boom') });
  });

  // A command that answered inside its bound has answered: the bound must not
  // keep running through the stdio grace and relabel it a timeout because a
  // grandchild still holds the pipe.
  it('does not report a timeout for a command that exited inside its bound', async () => {
    // It answers and exits at once, leaving a grandchild on the pipe, so the
    // probe sits in its stdio grace; the bound falls inside that grace. The
    // gap is seconds wide on both sides, so load cannot move the command's
    // exit past the bound (a 0.8 s sleep against a 1.2 s bound could).
    const answered = stub('answers-then-lingers', 'echo "v9"\n(sleep 10 &)\nexit 0');
    await expect(runProbe(answered, ['--version'], { timeoutMs: 2_000, graceMs: 6_000 }))
      .resolves.toMatchObject({ stdout: 'v9\n' });
  });

  it('reports a missing binary as ENOENT', async () => {
    await expect(runProbe(join(bin, 'nope'), [], { timeoutMs: VERSION_PROBE_TIMEOUT_MS })).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports a non-zero exit with its code and stderr', async () => {
    await expect(runProbe(join(bin, 'fails'), [], { timeoutMs: VERSION_PROBE_TIMEOUT_MS }))
      .rejects.toMatchObject({ code: 3, stderr: expect.stringContaining('Error: boom') });
  });
});

describe('probeVersion settles a stubborn binary', () => {
  it('answers broken within the bound', async () => {
    const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin` };
    const start = Date.now();
    const probe = await probeVersion('stubborn', env, 300);
    expect(probe.state).toBe('broken');
    // Far below the stub's `sleep 30`, which is what not settling would cost.
    expect(Date.now() - start).toBeLessThan(10_000);
  });
});

describe('runProbe — output cap', () => {
  it('kills the group and rejects once output passes the cap', async () => {
    const noisy = stub('noisy', 'yes 0123456789abcdef');
    const probe = runProbe(noisy, [], { timeoutMs: 10_000, maxBuffer: 64 * 1024 });
    await expect(probe).rejects.toMatchObject({
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      message: expect.stringMatching(/stdout maxBuffer length exceeded/),
    });
  });

  it('caps at 16 MB by default', () => {
    expect(PROBE_MAX_BUFFER).toBe(16 * 1024 * 1024);
  });
});

/**
 * The three Ctrl-C tests run a real parent — Node with the tsx loader — and
 * wait for its probe to start before signalling it. That start is a latency,
 * not a behaviour: measured beside a full suite, median 1.1 s and max 7.3 s,
 * and a heavier run passed the 15 s this used to allow. So the wait is long
 * (60 s), and a parent that dies before its probe starts fails at once with
 * its own stderr instead of a bare timeout.
 */
const PARENT_START_MS = 60_000;
const startParent = async (script: string) => {
  const { spawn } = await import('node:child_process');
  // Node with the tsx loader, not the tsx CLI: the CLI relays SIGINT to its
  // child and SIGKILLs it if its event loop has not answered within ~60 ms,
  // which under load killed the parent before runProbe could forward the
  // signal — orphaning the probe group, a harness flake rather than a bug.
  const parent = spawn(process.execPath, ['--import', 'tsx', script], { stdio: ['ignore', 'ignore', 'pipe'], cwd: process.cwd() });
  let stderr = '';
  parent.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  let ended: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    parent.on('exit', (code, signal) => { ended = { code, signal }; resolve(ended); }));
  /** Polls until `file` has content; fails with the parent's stderr if it exits first. */
  const waitForFile = async (file: string, what: string) => {
    const { existsSync, readFileSync } = await import('node:fs');
    const until = Date.now() + PARENT_START_MS;
    while (!existsSync(file) || readFileSync(file, 'utf8').trim() === '') {
      if (ended !== undefined) throw new Error(`the parent exited (${JSON.stringify(ended)}) before ${what}: ${stderr}`);
      if (Date.now() > until) throw new Error(`${what} did not happen within ${PARENT_START_MS / 1000}s: ${stderr}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    return readFileSync(file, 'utf8').trim();
  };
  return { parent, exited, waitForFile };
};

describe('runProbe — Ctrl-C reaches the probe', () => {
  it('forwards SIGINT to the probe group, then lets the parent exit as it would have', async () => {
    const pidFile = join(bin, 'sleeper.pid');
    const sleeper = stub('sleeper', `echo $$ > ${pidFile}\nsleep 30`);
    const script = join(bin, 'run-probe.mts');
    writeFileSync(script, `
import { runProbe } from ${JSON.stringify(join(process.cwd(), 'src/version-probe.ts'))};
await runProbe(${JSON.stringify(sleeper)}, [], { timeoutMs: 30_000 }).catch(() => {});
`);
    const { parent, exited, waitForFile } = await startParent(script);
    const probePid = Number(await waitForFile(pidFile, 'the probe started'));
    parent.kill('SIGINT');
    await exited;
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    // A latency bound: the probe group is signalled, and dies well before its `sleep 30`.
    const deadline = Date.now() + 10_000;
    while (alive(probePid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(alive(probePid)).toBe(false);
  }, 120_000);
});

describe('runProbe — a parent that handles SIGINT itself', () => {
  it('does not re-raise when the parent had its own listener, even a once() one', async () => {
    const { readFileSync } = await import('node:fs');
    const pidFile = join(bin, 'sleeper2.pid');
    const doneFile = join(bin, 'parent.done');
    const sleeper = stub('sleeper2', `echo $$ > ${pidFile}\nsleep 30`);
    const script = join(bin, 'run-probe-once.mts');
    writeFileSync(script, `
import { writeFileSync } from 'node:fs';
import { runProbe } from ${JSON.stringify(join(process.cwd(), 'src/version-probe.ts'))};
process.once('SIGINT', () => { /* the parent's own handling: carry on */ });
await runProbe(${JSON.stringify(sleeper)}, [], { timeoutMs: 30_000 }).catch(() => {});
writeFileSync(${JSON.stringify(doneFile)}, 'survived');
`);
    const { parent, exited, waitForFile } = await startParent(script);
    await waitForFile(pidFile, 'the probe started');
    parent.kill('SIGINT');
    const outcome = await exited;
    expect(outcome).toEqual({ code: 0, signal: null });
    expect(readFileSync(doneFile, 'utf8')).toBe('survived');
  }, 120_000);
});

describe('runProbe — concurrent probes', () => {
  it('re-raises SIGINT when only other probes were listening, even after one of them has finished', async () => {
    // `detectHarnesses` probes concurrently. Counting listeners at probe start
    // counted a sibling probe's own forwarder as "the parent handles SIGINT",
    // so once the fast probe had finished, Ctrl-C killed the slow probe and
    // the parent carried on instead of exiting.
    const { existsSync } = await import('node:fs');
    const pidFile = join(bin, 'sleeper3.pid');
    const doneFile = join(bin, 'parent3.done');
    const fastDone = join(bin, 'fast3.done');
    const fast = stub('fast3', 'sleep 0.2\necho ok');
    const slow = stub('sleeper3', `echo $$ > ${pidFile}\nsleep 30`);
    const script = join(bin, 'run-probe-concurrent.mts');
    writeFileSync(script, `
import { writeFileSync } from 'node:fs';
import { runProbe } from ${JSON.stringify(join(process.cwd(), 'src/version-probe.ts'))};
await Promise.all([
  runProbe(${JSON.stringify(fast)}, [], { timeoutMs: 30_000 }).catch(() => {})
    .then(() => writeFileSync(${JSON.stringify(fastDone)}, 'finished')),
  runProbe(${JSON.stringify(slow)}, [], { timeoutMs: 30_000 }).catch(() => {}),
]);
writeFileSync(${JSON.stringify(doneFile)}, 'continued after Ctrl-C');
`);
    const { parent, exited, waitForFile } = await startParent(script);
    await waitForFile(pidFile, 'the slow probe started');
    // The fast probe must have finished first — waited for, not assumed
    // from a fixed pause, which a loaded machine can outlast.
    await waitForFile(fastDone, 'the fast probe finished');
    parent.kill('SIGINT');
    const outcome = await exited;
    expect(outcome).toEqual({ code: null, signal: 'SIGINT' });
    expect(existsSync(doneFile)).toBe(false);
  }, 120_000);
});
