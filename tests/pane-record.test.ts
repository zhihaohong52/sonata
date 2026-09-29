import { describe, it, expect } from 'vitest';
import { recordPane, type PaneSource, type RecorderState } from '../src/pane-record.js';
import { newLines } from '../src/normalize.js';

/**
 * A terminal as tmux presents it to the recorder: a screen of fixed height
 * whose rows only move up, an append-only scrollback trimmed at its limit,
 * and an alternate screen that writes no history.
 */
class Term {
  history: string[] = [];
  screen: string[];
  cursor = 0;
  alternate = false;
  private saved?: { screen: string[]; cursor: number };

  constructor(readonly height = 5, readonly limit = 10_000) {
    this.screen = Array.from({ length: height }, () => '');
  }

  write(...lines: string[]): this {
    for (const line of lines) {
      if (this.cursor === this.height) {
        const top = this.screen.shift()!;
        if (!this.alternate) {
          this.history.push(top);
          if (this.history.length > this.limit) this.history.shift();
        }
        this.screen.push('');
        this.cursor = this.height - 1;
      }
      this.screen[this.cursor] = line;
      this.cursor += 1;
    }
    return this;
  }

  set(row: number, text: string): this {
    this.screen[row] = text;
    return this;
  }

  enterAlternate(): this {
    this.saved = { screen: [...this.screen], cursor: this.cursor };
    this.screen = Array.from({ length: this.height }, () => '');
    this.cursor = 0;
    this.alternate = true;
    return this;
  }

  exitAlternate(): this {
    this.screen = this.saved!.screen;
    this.cursor = this.saved!.cursor;
    this.alternate = false;
    return this;
  }

  source(): PaneSource {
    return {
      info: async () => ({
        historySize: this.history.length, historyLimit: this.limit, alternate: this.alternate, height: this.height,
      }),
      screen: async () => [...this.screen],
      history: async (count) => this.history.slice(-count),
    };
  }
}

/** A tail that keeps its state between polls, as cmdTail does on disk. */
function poller(term: Term, initial?: RecorderState) {
  let state = initial;
  const all: string[] = [];
  return {
    all,
    async poll(legacy?: string[]): Promise<string[]> {
      const result = await recordPane(term.source(), state, legacy === undefined ? undefined : { snapshot: legacy, diff: newLines });
      if (result === null) throw new Error('unreadable');
      state = result.state;
      all.push(...result.events);
      return result.events;
    },
  };
}

const lines = (from: number, to: number, prefix = 'line-') =>
  Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`);

describe('recordPane', () => {
  it('records plain output once, as it appears', async () => {
    const term = new Term();
    const p = poller(term);
    term.write('a', 'b');
    expect(await p.poll()).toEqual(['a', 'b']);
    term.write('c');
    expect(await p.poll()).toEqual(['c']);
    expect(await p.poll()).toEqual([]);
  });

  it('keeps a burst larger than the screen, in order, with nothing twice', async () => {
    const term = new Term(5);
    const p = poller(term);
    term.write('a', 'b', 'c');
    await p.poll();
    term.write(...lines(1, 23));
    expect(await p.poll()).toEqual(lines(1, 23));
    expect(p.all).toEqual(['a', 'b', 'c', ...lines(1, 23)]);
  });

  it('keeps output that filled blank rows and scrolled before it was seen', async () => {
    // Blank rows below the last content are not "seen": what is written into
    // them and scrolls away between two polls is fetched from history.
    const term = new Term(5);
    const p = poller(term);
    term.write('r0', 'r1');
    await p.poll();
    term.write('n1', 'n2', 'n3', 'n4', 'n5', 'n6');
    await p.poll();
    expect(p.all).toEqual(['r0', 'r1', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6']);
  });

  it('records only the redrawn row when a status line changes, not the history', async () => {
    // The reviewer's case: a long run, then a status line and a composer. The
    // scrollback diff re-emitted all ~1500 lines when the status line changed.
    const term = new Term(50);
    const p = poller(term);
    term.write(...lines(1, 1500), 'Working 1s', 'composer>');
    expect(await p.poll()).toHaveLength(1502);
    term.set(48, 'Working 2s');
    expect(await p.poll()).toEqual(['Working 2s']);
    expect(await p.poll()).toEqual([]);
  });

  it('records a redrawn two-line composer as just those rows', async () => {
    const term = new Term(10);
    const p = poller(term);
    term.write(...lines(1, 30), '> draft', '  more');
    await p.poll();
    term.set(8, '> draft two').set(9, '  more two');
    expect(await p.poll()).toEqual(['> draft two', '  more two']);
  });

  it('records a full-screen TUI on the alternate screen, and nothing twice when it exits', async () => {
    const term = new Term(5);
    const p = poller(term);
    term.write('$ harness');
    await p.poll();
    term.enterAlternate().write('┌ harness ┐', 'thinking');
    expect(await p.poll()).toEqual(['┌ harness ┐', 'thinking']);
    term.set(1, 'done: fixed it');
    expect(await p.poll()).toEqual(['done: fixed it']);
    term.exitAlternate();
    // The normal screen comes back exactly as it was; nothing on it is new.
    expect(await p.poll()).toEqual([]);
    term.write('$');
    expect(await p.poll()).toEqual(['$']);
  });

  it('records a scrolling TUI on the alternate screen by its shift, not its whole screen', async () => {
    const term = new Term(5);
    const p = poller(term);
    term.enterAlternate().write('m1', 'm2', 'm3', 'm4', 'm5');
    await p.poll();
    term.write('m6', 'm7');
    expect(await p.poll()).toEqual(['m6', 'm7']);
  });

  it('keeps the whole scrollback for a run tailed only once it has finished', async () => {
    const term = new Term(50);
    term.write(...lines(1, 3000), '$');
    const p = poller(term);
    await p.poll();
    expect(p.all).toEqual([...lines(1, 3000), '$']);
  });

  it('keeps up to history-limit rows for a run tailed only at the end', async () => {
    const term = new Term(50, 10_000);
    term.write(...lines(1, 12_000));
    const p = poller(term);
    await p.poll();
    // 10000 in scrollback, 50 on screen; the first 1950 were gone from tmux
    // before anything looked.
    expect(p.all).toEqual(lines(1951, 12_000));
  });

  it('finds growth by the anchor once history is full', async () => {
    // At history-limit the count stops moving while rows still enter.
    const term = new Term(5, 100);
    const p = poller(term);
    term.write(...lines(1, 300));
    await p.poll();
    term.write(...lines(301, 340));
    expect(await p.poll()).toEqual(lines(301, 340));
    expect(await p.poll()).toEqual([]);
    expect(new Set(p.all).size).toBe(p.all.length);
  });

  it('does not backfill history for a run recorded before the recorder existed', async () => {
    // Its events already hold what the old visible diff saw; backfilling the
    // scrollback would record all of that again.
    const term = new Term(5);
    term.write(...lines(1, 20));
    const p = poller(term);
    const events = await p.poll(lines(15, 19));
    expect(events).toEqual(['line-20']);
    term.write('next');
    expect(await p.poll()).toEqual(['next']);
  });
});
