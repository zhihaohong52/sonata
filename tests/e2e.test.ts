import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRun, runDir } from '../src/store.js';
import { newSession, runScript, killSession } from '../src/tmux.js';
import { cmdTail } from '../src/commands/tail.js';
import { loadConfig } from '../src/config.js';
import { wrapWithTimeout } from '../src/watchdog.js';

const HARNESS = resolve('tests/fake-harness/harness.sh');
let cwd: string;
const sessions: string[] = [];

/**
 * Writes the fixture config. The stall timeout is generous by default: under
 * parallel test load a harness can take several seconds just to start, and a
 * short timeout misreads that startup latency as a stall. Only the test that
 * deliberately exercises STALLED shortens it. The run timeout is generous by
 * default too, so only the hang test exercises the watchdog.
 */
function writeConfig(stallTimeoutSeconds: number, runTimeoutSeconds = 30, harness = 'opencode'): void {
  writeFileSync(join(cwd, 'sonata.toml'), `
[models.fake]
harness = "${harness}"
id = "fake"

[generate]
roles = ["code"]
models = ["fake"]

[run]
stall_timeout_seconds = ${stallTimeoutSeconds}
run_timeout_seconds = ${runTimeoutSeconds}
`);
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'sonata-e2e-'));
  writeConfig(30);
});

afterEach(async () => {
  for (const s of sessions) await killSession(s);
  sessions.length = 0;
});

async function launch(scenario: string, interactive: boolean, harness = 'opencode') {
  const meta = createRun(cwd, {
    role: 'code', model: 'fake', harness,
    mode: interactive ? 'default' : 'acceptEdits', interactive,
    startedAt: new Date().toISOString(),
  });
  const dir = runDir(cwd, meta.id);
  const harnessScript = join(dir, 'harness.sh');
  writeFileSync(harnessScript, `#!/bin/bash\n${HARNESS} ${scenario} '${dir}'\n`, { mode: 0o755 });
  const script = join(dir, 'cmd.sh');
  writeFileSync(script, wrapWithTimeout({
    harnessScriptPath: harnessScript,
    runDir: dir,
    timeoutSeconds: loadConfig(cwd).run.runTimeoutSeconds,
  }), { mode: 0o755 });
  await newSession({ session: meta.session, cwd });
  sessions.push(meta.session);
  await runScript(meta.session, script);
  return meta.id;
}

async function tailUntil(id: string, states: string[], tries = 30) {
  for (let i = 0; i < tries; i++) {
    const r = await cmdTail({ cwd, id, waitSeconds: 1, pollMs: 200 });
    if (states.includes(r.state)) return r;
  }
  throw new Error(`never reached ${states.join('/')}`);
}

describe('end to end against the fake harness', () => {
  it('reaches DONE and returns the report', async () => {
    const id = await launch('normal', false);
    const r = await tailUntil(id, ['DONE']);
    expect(r.report).toContain('Refactored the parser');
    expect(r.degraded).toBe(false);
    expect(r.exitCode).toBe(0);
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

[generate]
roles = ["code"]
models = ["fake"]

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

  it('falls back to STALLED when a prompt is not recognised', async () => {
    writeConfig(3); // only this test wants a short stall timeout
    const id = await launch('prompt', false); // interactive=false → no prompt detection
    const r = await tailUntil(id, ['STALLED'], 60);
    expect(r.lines.join('\n')).toContain('scenario=prompt');
  });

  it('keeps the pane alive after the command exits', async () => {
    const id = await launch('normal', false);
    await tailUntil(id, ['DONE']);
    const { hasSession } = await import('../src/tmux.js');
    expect(await hasSession(`sonata-${id}`)).toBe(true);
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
