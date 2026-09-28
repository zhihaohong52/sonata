import { describe, it, expect, beforeAll } from 'vitest';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProbe } from '../src/version-probe.js';
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
