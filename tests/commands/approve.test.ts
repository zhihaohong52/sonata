import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdApprove } from '../../src/commands/approve.js';
import { capturePane, newSession, killSession } from '../../src/tmux.js';
import { runDir } from '../../src/store.js';

let cwd: string;
const SESSION = 'sonata-test-approve';

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'sonata-approve-'));
  mkdirSync(runDir(cwd, 'abc123'), { recursive: true });
  writeFileSync(join(runDir(cwd, 'abc123'), 'meta.json'), JSON.stringify({
    id: 'abc123', role: 'code', model: 'm', harness: 'opencode',
    mode: 'default', interactive: true, session: SESSION, cwd,
    startedAt: '2026-08-10T00:00:00.000Z',
  }));
});

afterEach(async () => { await killSession(SESSION); });

describe('cmdApprove', () => {
  it('sends the yes key into the live pane', async () => {
    await newSession({ session: SESSION, cwd });
    await cmdApprove({ cwd, id: 'abc123', yes: true });
    await new Promise((r) => setTimeout(r, 500));
    expect(await capturePane(SESSION)).toContain('y');
  });

  it('fails clearly when the session is gone', async () => {
    await expect(cmdApprove({ cwd, id: 'abc123', yes: true }))
      .rejects.toThrow(/no live tmux session/i);
  });
});
