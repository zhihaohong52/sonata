import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  newSession, hasSession, runScript, capturePane,
  killSession, listSessions, tmuxVersion,
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
