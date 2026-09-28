import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdGc } from '../../src/commands/gc.js';
import { capturePane, hasSession, killSession, newSession, sendKeys } from '../../src/tmux.js';
import { runDir } from '../../src/store.js';

// Real tmux on the suite's private server (TMUX_TMPDIR). Killing a finished
// run's session destroys the only full record of what it printed, so gc
// captures the transcript first.
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

  it('captures a finished run`s transcript before killing its session', async () => {
    await start(finished, 'the finished output', true);
    const killed = await cmdGc({ cwd });
    expect(killed).toEqual([`sonata-${finished}`]);
    expect(await hasSession(`sonata-${finished}`)).toBe(false);
    expect(readFileSync(join(runDir(cwd, finished), 'transcript.txt'), 'utf8')).toContain('the finished output');
  }, 30_000);

  it('leaves a transcript tail already wrote untouched', async () => {
    await start(finished, 'late output', true);
    writeFileSync(join(runDir(cwd, finished), 'transcript.txt'), 'captured at DONE\n');
    await cmdGc({ cwd });
    expect(readFileSync(join(runDir(cwd, finished), 'transcript.txt'), 'utf8')).toBe('captured at DONE\n');
  }, 30_000);

  it('skips a stray directory that is not a run id', async () => {
    mkdirSync(join(cwd, '.sonata', 'runs', 'notes'), { recursive: true });
    await start(finished, 'done', true);
    expect(await cmdGc({ cwd })).toEqual([`sonata-${finished}`]);
  }, 30_000);

  it('neither captures nor kills a run that is still going', async () => {
    await start(live, 'still working', false);
    expect(await cmdGc({ cwd })).toEqual([]);
    expect(await hasSession(`sonata-${live}`)).toBe(true);
    expect(existsSync(join(runDir(cwd, live), 'transcript.txt'))).toBe(false);
  }, 30_000);
});
