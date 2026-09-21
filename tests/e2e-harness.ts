/**
 * The fake-harness rig shared by the e2e files.
 *
 * Extracted when `tests/e2e.test.ts` was split so the three timeout-bound
 * tests could run in parallel with the rest (they are bounded by a wall-clock
 * timeout, not by work, so they were ~10s of a ~21s file). Vitest gives each
 * *file* its own module instance, which is what makes the per-file `cwd` and
 * `sessions` below safe to keep at module scope: two files never share them.
 * Marking the tests `concurrent` inside one file would, and that is why the
 * split is by file rather than by annotation.
 */
import { afterEach, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRun, runDir } from '../src/store.js';
import { newSession, runScript, killSession } from '../src/tmux.js';
import { cmdTail } from '../src/commands/tail.js';
import { loadConfig } from '../src/config.js';
import { wrapWithTimeout } from '../src/watchdog.js';

const HARNESS = resolve('tests/fake-harness/harness.sh');
const sessions: string[] = [];

/** The temp project the current test runs in. Reassigned by `beforeEach`. */
export let cwd: string;

/**
 * Writes the fixture config. The stall timeout is generous by default: under
 * parallel test load a harness can take several seconds just to start, and a
 * short timeout misreads that startup latency as a stall. Only the tests that
 * deliberately exercise STALLED shorten it. The run timeout is generous by
 * default too, so only the hang test exercises the watchdog.
 */
export function writeConfig(stallTimeoutSeconds: number, runTimeoutSeconds = 30, harness = 'opencode'): void {
  writeFileSync(join(cwd, 'sonata.toml'), `
[models.fake]
harness = "${harness}"
id = "${harness === 'codex' ? 'fake' : 'fake/fake'}"

[generate.roles]
code = ["fake"]

[run]
stall_timeout_seconds = ${stallTimeoutSeconds}
run_timeout_seconds = ${runTimeoutSeconds}
`);
}

/** Installs the per-test temp project and the tmux session cleanup. */
export function useFakeHarness(): void {
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'sonata-e2e-'));
    writeConfig(30);
  });

  afterEach(async () => {
    for (const s of sessions) await killSession(s);
    sessions.length = 0;
  });
}

export async function launch(scenario: string, interactive: boolean, harness = 'opencode'): Promise<string> {
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

export async function tailUntil(id: string, states: string[], tries = 30): ReturnType<typeof cmdTail> {
  for (let i = 0; i < tries; i++) {
    const r = await cmdTail({ cwd, id, waitSeconds: 1, pollMs: 200 });
    if (states.includes(r.state)) return r;
  }
  throw new Error(`never reached ${states.join('/')}`);
}
