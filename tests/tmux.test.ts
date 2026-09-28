import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  newSession, hasSession, runScript, capturePane, sendKeys,
  killSession, listSessions, tmuxVersion, retryWhenServerExits,
} from '../src/tmux.js';

const SESSION = 'sonata-test-tmux';

/**
 * The pane once it shows `text`. A generous deadline, as gc.test's: the pane's
 * shell starting is outside the test's control, and a latency bound here only
 * turns a slow machine into a failure.
 */
async function paneShowing(text: string): Promise<string> {
  const deadline = Date.now() + 25_000;
  let pane = await capturePane(SESSION);
  while (!pane.includes(text) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    pane = await capturePane(SESSION);
  }
  return pane;
}

afterEach(async () => {
  await killSession(SESSION);
});

describe('tmux wrapper', () => {
  it('reports a version', async () => {
    expect(await tmuxVersion()).toMatch(/^\d+\.\d+/);
  });

  it('creates, lists and kills a session', async () => {
    await newSession({ session: SESSION, cwd: tmpdir() });
    expect(await hasSession(SESSION)).toBe(true);
    expect(await listSessions()).toContain(SESSION);
    await killSession(SESSION);
    expect(await hasSession(SESSION)).toBe(false);
  });

  it('runs on the suite\'s private server, in a shell with no rc files and no history', async () => {
    // Set up by tests/global-setup.ts before the workers spawn; checked here
    // because a setting that silently failed to reach the workers would put
    // every session back on the user's own server and login shell.
    expect(process.env.TMUX_TMPDIR).toBeTruthy();
    expect(process.env.TMUX).toBeUndefined();
    await newSession({ session: SESSION, cwd: tmpdir() });
    await sendKeys(SESSION, 'echo "HIST=[$HISTFILE] SHELL0=[$0]"');
    await sendKeys(SESSION, 'Enter');
    const pane = await paneShowing('HIST=[/dev/null]');
    expect(pane).toMatch(/SHELL0=\[\/bin\/sh\]/);
  }, 30_000);

  it('keeps the pane alive after the command exits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sonata-'));
    const script = join(dir, 'cmd.sh');
    writeFileSync(script, '#!/bin/bash\necho SENTINEL_LINE\n');

    await newSession({ session: SESSION, cwd: dir });
    await runScript(SESSION, script);

    const pane = await paneShowing('SENTINEL_LINE');

    expect(pane).toContain('SENTINEL_LINE');
    // The critical property: session survives its command finishing.
    expect(await hasSession(SESSION)).toBe(true);
  }, 30_000);

  /**
   * runScript sends `bash <path>` as keystrokes to the pane's INTERACTIVE
   * shell. JSON quoting left `$()`, backticks and history `!` live there, so a
   * script path containing them broke the launch or ran commands. Single-quote
   * wrapping is the only form that suppresses all three in bash and zsh.
   */
  it('runs a script whose path carries quotes, substitutions and a bang', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sonata-'));
    const nasty = join(dir, "it's $(echo pwned) !x");
    mkdirSync(nasty);
    const script = join(nasty, 'cmd.sh');
    writeFileSync(script, '#!/bin/bash\necho SENTINEL_LINE\n');

    await newSession({ session: SESSION, cwd: nasty });
    await runScript(SESSION, script);

    const pane = await paneShowing('SENTINEL_LINE');

    expect(pane).toContain('SENTINEL_LINE');
    // If the quoting broke, the pane would have shown `pwned` from the
    // substitution, or a syntax/history error, instead of the sentinel.
    expect(pane).not.toMatch(/(^|\n)pwned(\n|$)/);
    expect(await hasSession(SESSION)).toBe(true);
  }, 30_000);
});

describe('retryWhenServerExits', () => {
  // A tmux server exits when its last session closes. A `new-session` that
  // connects while it is exiting fails with "server exited unexpectedly" and
  // created nothing — reproduced 3 times in 300 by churning sessions in one
  // process while creating them in another, and seen in CI as a failed e2e
  // launch. Sonata's parallel dispatches share the user's server, so a run
  // ending while another launches hits the same race.
  const serverExited = () => Object.assign(
    new Error('Command failed: tmux new-session -d -s sonata-x\nserver exited unexpectedly\n'),
    { stderr: 'server exited unexpectedly\n' },
  );

  it('retries a launch that raced a server shutting down', async () => {
    let calls = 0;
    const out = await retryWhenServerExits(async () => {
      calls += 1;
      if (calls < 3) throw serverExited();
      return 'ok';
    }, { delayMs: 0 });
    expect(out).toBe('ok');
    expect(calls).toBe(3);
  });

  it('does not retry any other failure', async () => {
    let calls = 0;
    await expect(retryWhenServerExits(async () => {
      calls += 1;
      throw Object.assign(new Error('Command failed'), { stderr: 'duplicate session: sonata-x\n' });
    }, { delayMs: 0 })).rejects.toThrow('Command failed');
    expect(calls).toBe(1);
  });

  it('gives up after its attempts, with the last error', async () => {
    let calls = 0;
    await expect(retryWhenServerExits(async () => {
      calls += 1;
      throw serverExited();
    }, { delayMs: 0, attempts: 3 })).rejects.toThrow('server exited unexpectedly');
    expect(calls).toBe(3);
  });
});
