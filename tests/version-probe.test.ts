import { describe, it, expect, beforeAll } from 'vitest';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROBE_MAX_BUFFER, runProbe } from '../src/version-probe.js';
import { probeVersion } from '../src/detect.js';

// A bound that fires is only half of a bound: the probe also has to SETTLE.
// execFile's timeout sends SIGTERM to the direct child and then waits for its
// stdio to close — so a binary that ignores TERM, or leaves a grandchild
// holding stdout, kept a "bounded" probe hanging past its bound.
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
    expect((await runProbe(join(bin, 'works'), ['--version'], { timeoutMs: 5_000 })).stdout.trim()).toBe('works 1.2.3');
  });

  it('settles a binary that traps TERM and sleeps, and reports it killed', async () => {
    const probe = runProbe(join(bin, 'stubborn'), ['--version'], { timeoutMs: 300 });
    await expect(probe).rejects.toMatchObject({ killed: true });
    await settlesWithin(runProbe(join(bin, 'stubborn'), ['--version'], { timeoutMs: 300 }), 3_000);
  });

  it('settles when a grandchild still holds stdout', async () => {
    // The bound is long, so settling fast proves it settled on the child's
    // exit — not on the timeout killing the group.
    const start = Date.now();
    const result = await runProbe(join(bin, 'leaves-child'), ['--version'], { timeoutMs: 20_000 });
    expect(Date.now() - start).toBeLessThan(3_000);
    expect(result.stdout.trim()).toBe('hi');
  });

  it('reports a missing binary as ENOENT', async () => {
    await expect(runProbe(join(bin, 'nope'), [], { timeoutMs: 1_000 })).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports a non-zero exit with its code and stderr', async () => {
    await expect(runProbe(join(bin, 'fails'), [], { timeoutMs: 1_000 }))
      .rejects.toMatchObject({ code: 3, stderr: expect.stringContaining('Error: boom') });
  });
});

describe('probeVersion settles a stubborn binary', () => {
  it('answers broken within the bound', async () => {
    const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin` };
    const start = Date.now();
    const probe = await probeVersion('stubborn', env, 300);
    expect(probe.state).toBe('broken');
    expect(Date.now() - start).toBeLessThan(3_000);
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

describe('runProbe — Ctrl-C reaches the probe', () => {
  it('forwards SIGINT to the probe group, then lets the parent exit as it would have', async () => {
    const { spawn } = await import('node:child_process');
    const { existsSync, readFileSync } = await import('node:fs');
    const pidFile = join(bin, 'sleeper.pid');
    const sleeper = stub('sleeper', `echo $$ > ${pidFile}\nsleep 30`);
    const script = join(bin, 'run-probe.mts');
    writeFileSync(script, `
import { runProbe } from ${JSON.stringify(join(process.cwd(), 'src/version-probe.ts'))};
await runProbe(${JSON.stringify(sleeper)}, [], { timeoutMs: 30_000 }).catch(() => {});
`);
    const parent = spawn(join(process.cwd(), 'node_modules/.bin/tsx'), [script], { stdio: 'ignore' });
    const until = Date.now() + 15_000;
    while (!existsSync(pidFile) || readFileSync(pidFile, 'utf8').trim() === '') {
      if (Date.now() > until) throw new Error('probe never started');
      await new Promise((r) => setTimeout(r, 50));
    }
    const probePid = Number(readFileSync(pidFile, 'utf8').trim());
    const exited = new Promise<number | null>((resolve) => parent.on('exit', (_code, signal) => resolve(signal === null ? 0 : 1)));
    // tsx runs the script in a child node; signal the whole tree's leader.
    parent.kill('SIGINT');
    await exited;
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const deadline = Date.now() + 3_000;
    while (alive(probePid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(alive(probePid)).toBe(false);
  }, 30_000);
});
