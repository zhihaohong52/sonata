import { describe, it, expect } from 'vitest';
import { cmdLog } from '../src/commands/log.js';
import { readEvents } from '../src/store.js';
import { cwd, launch, tailUntil, useFakeHarness } from './e2e-harness.js';

// Real tmux on the suite's private server, through the fake harness.
useFakeHarness();

const burst = Array.from({ length: 3000 }, (_, i) => `burst-${i + 1}`);

describe('sonata log', () => {
  it('prints all of a non-interactive run`s output once, from its own log', async () => {
    // 3000 lines in one burst: the live event log, one screen per poll, keeps
    // only the last screen of it. The harness's own log keeps everything.
    const id = await launch('burst', false);
    await tailUntil(id, ['DONE']);
    expect(readEvents(cwd, id)).not.toContain('burst-1');

    const text = cmdLog({ cwd, id }).text;
    const lines = text.split('\n');
    expect(lines.filter((l) => l.startsWith('burst-'))).toEqual(burst);
    expect(lines).toContain('bold summary');
    expect(text).not.toContain('\u001b');
    expect(text).toMatch(/\n\n— sonata /);
  }, 60_000);

  it('prints the live event log for an interactive run, as before', async () => {
    const id = await launch('burst', true);
    await tailUntil(id, ['DONE']);
    // Its harness.log is a TUI's redraws, not lines; the screen diff is the
    // record, exactly as before.
    const text = cmdLog({ cwd, id }).text;
    expect(text.startsWith(`${readEvents(cwd, id).join('\n')}\n\n— sonata `)).toBe(true);
    expect(text.split('\n')).not.toContain('burst-1');
  }, 60_000);
});
