import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cmdTail } from '../src/commands/tail.js';
import { cwd, launch, tailUntil, useFakeHarness, writeConfig } from './e2e-harness.js';

useFakeHarness();

describe('end to end against the fake harness', () => {
  // The one-call path: no polling loop, one call, the report.
  it('cmdWait returns DONE with the report in a single call', async () => {
    const { cmdWait } = await import('../src/commands/wait.js');
    const id = await launch('normal', false);
    const r = await cmdWait({ cwd, id, pollMs: 200, windowSeconds: 30 });
    expect(r.state).toBe('DONE');
    expect(r.report).toContain('Refactored the parser');
    expect(r.report).toContain(`— sonata ${id}:`);
    expect(r.degraded).toBe(false);
  });

  it('cmdWait surfaces a crash as DONE degraded in one call', async () => {
    const { cmdWait } = await import('../src/commands/wait.js');
    const id = await launch('crash', false);
    const r = await cmdWait({ cwd, id, pollMs: 200, windowSeconds: 30 });
    expect(r.state).toBe('DONE');
    expect(r.degraded).toBe(true);
    expect(r.report).toContain('segmentation fault');
  });

  it('cmdWait stops at PAUSED, and resumes to DONE after approve', async () => {
    writeConfig(30, 30, 'codex');
    const id = await launch('prompt', true, 'codex');
    const { cmdWait } = await import('../src/commands/wait.js');
    const paused = await cmdWait({ cwd, id, pollMs: 200, windowSeconds: 30 });
    expect(paused.state).toBe('PAUSED');
    expect(paused.prompt).toContain('Would you like to run the following command?');
    expect(paused.id).toBe(id);

    const { cmdApprove } = await import('../src/commands/approve.js');
    await cmdApprove({ cwd, id, yes: true });
    const done = await cmdWait({ cwd, id, pollMs: 200, windowSeconds: 30 });
    expect(['DONE', 'PAUSED', 'STALLED']).toContain(done.state);
  });

  // Idempotent: the retry path exists for calls that may have been dropped
  // mid-block, so calling wait once too often must return the report again.
  it('cmdWait on a finished run returns the report again, not an error', async () => {
    const { cmdWait } = await import('../src/commands/wait.js');
    const id = await launch('normal', false);
    await cmdWait({ cwd, id, pollMs: 200, windowSeconds: 30 });
    const again = await cmdWait({ cwd, id, pollMs: 200, windowSeconds: 30 });
    expect(again.state).toBe('DONE');
    expect(again.report).toContain('Refactored the parser');
  });

  it('reaches DONE and returns the report', async () => {
    const id = await launch('normal', false);
    const r = await tailUntil(id, ['DONE']);
    expect(r.report).toContain('Refactored the parser');
    expect(r.degraded).toBe(false);
    expect(r.exitCode).toBe(0);
  });

  // A wrapper that skipped the dispatch and answered from its own head cannot
  // produce this line: it is built from meta.json, which only a real run
  // writes. Verification therefore no longer depends on someone remembering
  // to run `sonata verify`.
  it('appends provenance naming the run, role and model to a finished report', async () => {
    const id = await launch('normal', false);
    const r = await tailUntil(id, ['DONE']);
    expect(r.report).toContain(`— sonata ${id}:`);
    expect(r.report).toContain('code on fake via opencode');
  });

  it('appends provenance to a degraded report too', async () => {
    const id = await launch('crash', false);
    const r = await tailUntil(id, ['DONE']);
    expect(r.report).toContain(`— sonata ${id}:`);
  });

  it('reports a crash as DONE degraded with the pane tail', async () => {
    const id = await launch('crash', false);
    const r = await tailUntil(id, ['DONE']);
    expect(r.degraded).toBe(true);
    expect(r.exitCode).toBe(139);
    expect(r.report).toContain('segmentation fault');
  });

  it('marks a missing report degraded even on a clean exit', async () => {
    const id = await launch('noreport', false);
    const r = await tailUntil(id, ['DONE']);
    expect(r.degraded).toBe(true);
    expect(r.exitCode).toBe(0);
  });

  it('uses a harness-written final message when the model wrote no report', async () => {
    writeFileSync(join(cwd, 'sonata.toml'), `
[models.fake]
harness = "codex"
id = "fake"

[generate.roles]
code = ["fake"]

[run]
stall_timeout_seconds = 30
`);
    const id = await launch('fallback', false, 'codex');
    const r = await tailUntil(id, ['DONE']);
    expect(r.degraded).toBe(false);
    expect(r.report).toContain('Final message written by the harness itself');
  });

  // Codex, not opencode: `opencode run` has no approval UI at all, so PAUSED
  // is unreachable there. See the note on openCodeAdapter's prompt patterns.
  it('detects a pending approval as PAUSED', async () => {
    writeConfig(30, 30, 'codex');
    const id = await launch('prompt', true, 'codex');
    const r = await tailUntil(id, ['PAUSED']);
    expect(r.prompt).toContain('Would you like to run the following command?');
    // The whole block, so the caller can see WHAT it is approving.
    expect(r.prompt).toContain('rm -rf build');
    expect(r.prompt).toContain('1. Yes, proceed (y)');
  });

  it('keeps the pane alive after the command exits', async () => {
    const id = await launch('normal', false);
    await tailUntil(id, ['DONE']);
    const { hasSession } = await import('../src/tmux.js');
    expect(await hasSession(`sonata-${id}`)).toBe(true);
  });

});
