/**
 * The e2e tests whose duration is a configured timeout rather than work.
 *
 * Split out of `e2e.test.ts` measured 2026-09-21: these three cost ~10.7s of
 * that file's ~21.4s, and every second of it is a deliberate wall-clock wait
 * for `stall_timeout_seconds` or `run_timeout_seconds` to expire. Nothing in
 * them can be made faster without shortening the very timeout under test, so
 * the only lever left is running them beside the rest instead of after it —
 * which is a file boundary, because vitest parallelises files and the rig's
 * `cwd`/`sessions` are per-module.
 */
import { describe, it, expect } from 'vitest';
import { cwd, launch, tailUntil, useFakeHarness, writeConfig } from './e2e-harness.js';

useFakeHarness();

describe('end to end — runs bounded by a configured timeout', () => {
  it('cmdWait returns STALLED rather than blocking on a silent run', async () => {
    writeConfig(3);
    const id = await launch('prompt', false);
    const { cmdWait } = await import('../src/commands/wait.js');
    const r = await cmdWait({ cwd, id, pollMs: 200, windowSeconds: 30 });
    expect(r.state).toBe('STALLED');
  });

  it('falls back to STALLED when a prompt is not recognised', async () => {
    writeConfig(3); // only this test wants a short stall timeout
    const id = await launch('prompt', false); // interactive=false → no prompt detection
    const r = await tailUntil(id, ['STALLED'], 60);
    expect(r.lines.join('\n')).toContain('scenario=prompt');
  });

  it('kills a hung run at the run timeout and marks it degraded', async () => {
    writeConfig(30, 3); // generous stall timeout, short run timeout
    const id = await launch('hang', false);
    const r = await tailUntil(id, ['DONE'], 60);
    expect(r.degraded).toBe(true);
    expect(r.report).toMatch(/^\[timed out: sonata killed the run after the configured run_timeout_seconds\]\n\n/);
    expect(r.report).toContain('scenario=hang');
  });
});
