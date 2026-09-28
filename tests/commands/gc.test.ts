import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdGc } from '../../src/commands/gc.js';
import { capturePane, hasSession, killSession, newSession, sendKeys } from '../../src/tmux.js';
import { runDir } from '../../src/store.js';

// Real tmux on the suite's private server (TMUX_TMPDIR).
describe('cmdGc', () => {
  let cwd: string;
  const finished = 'abc001';
  const live = 'abc002';

  async function start(id: string, text: string, done: boolean): Promise<void> {
    mkdirSync(runDir(cwd, id), { recursive: true });
    writeFileSync(join(runDir(cwd, id), 'meta.json'), JSON.stringify({ id, session: `sonata-${id}`, cwd }));
    if (done) writeFileSync(join(runDir(cwd, id), 'exit'), '0\n');
    await newSession({ session: `sonata-${id}`, cwd });
    await sendKeys(`sonata-${id}`, `echo '${text}'`);
    await sendKeys(`sonata-${id}`, 'Enter');
    const deadline = Date.now() + 25_000;
    while (!(await capturePane(`sonata-${id}`)).split('\n').some((l) => l.trim() === text)) {
      if (Date.now() > deadline) throw new Error(`pane never showed ${text}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  beforeEach(() => {
    delete process.env.TMUX;
    cwd = mkdtempSync(join(tmpdir(), 'sonata-gc-'));
  });

  afterEach(async () => {
    await killSession(`sonata-${finished}`);
    await killSession(`sonata-${live}`);
  });

  it('kills a finished run`s session', async () => {
    await start(finished, 'the finished output', true);
    expect(await cmdGc({ cwd })).toEqual([`sonata-${finished}`]);
    expect(await hasSession(`sonata-${finished}`)).toBe(false);
  }, 30_000);

  it('skips a stray directory that is not a run id', async () => {
    mkdirSync(join(cwd, '.sonata', 'runs', 'notes'), { recursive: true });
    await start(finished, 'done', true);
    expect(await cmdGc({ cwd })).toEqual([`sonata-${finished}`]);
  }, 30_000);

  it('does not kill a run that is still going', async () => {
    await start(live, 'still working', false);
    expect(await cmdGc({ cwd })).toEqual([]);
    expect(await hasSession(`sonata-${live}`)).toBe(true);
  }, 30_000);
});
