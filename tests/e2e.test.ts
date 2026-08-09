import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRun, runDir } from '../src/store.js';
import { newSession, runScript, killSession } from '../src/tmux.js';
import { cmdTail } from '../src/commands/tail.js';

const HARNESS = resolve('tests/fake-harness/harness.sh');
let cwd: string;
const sessions: string[] = [];

/**
 * Writes the fixture config. The stall timeout is generous by default: under
 * parallel test load a harness can take several seconds just to start, and a
 * short timeout misreads that startup latency as a stall. Only the test that
 * deliberately exercises STALLED shortens it.
 */
function writeConfig(stallTimeoutSeconds: number): void {
  writeFileSync(join(cwd, 'sonata.toml'), `
[models.fake]
harness = "opencode"
id = "fake"

[generate]
roles = ["code"]
models = ["fake"]

[run]
stall_timeout_seconds = ${stallTimeoutSeconds}
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

async function launch(scenario: string, interactive: boolean) {
  const meta = createRun(cwd, {
    role: 'code', model: 'fake', harness: 'opencode',
    mode: interactive ? 'default' : 'acceptEdits', interactive,
    startedAt: new Date().toISOString(),
  });
  const dir = runDir(cwd, meta.id);
  const script = join(dir, 'cmd.sh');
  writeFileSync(script, `#!/bin/bash\n${HARNESS} ${scenario} '${dir}'\n`, { mode: 0o755 });
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

  it('detects a pending approval as PAUSED', async () => {
    const id = await launch('prompt', true);
    const r = await tailUntil(id, ['PAUSED']);
    expect(r.prompt).toContain('rm -rf build');
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
});
