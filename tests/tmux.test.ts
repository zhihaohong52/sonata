import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  newSession, hasSession, runScript, capturePane,
  killSession, listSessions, tmuxVersion, retryWhenServerExits,
} from '../src/tmux.js';

const SESSION = 'sonata-test-tmux';

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

  it('keeps the pane alive after the command exits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sonata-'));
    const script = join(dir, 'cmd.sh');
    writeFileSync(script, '#!/bin/bash\necho SENTINEL_LINE\n');

    await newSession({ session: SESSION, cwd: dir });
    await runScript(SESSION, script);

    let pane = '';
    for (let i = 0; i < 40; i++) {
      pane = await capturePane(SESSION);
      if (pane.includes('SENTINEL_LINE')) break;
      await new Promise((r) => setTimeout(r, 250));
    }

    expect(pane).toContain('SENTINEL_LINE');
    // The critical property: session survives its command finishing.
    expect(await hasSession(SESSION)).toBe(true);
  });
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
