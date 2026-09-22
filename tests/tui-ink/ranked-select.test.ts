import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { RankedSelect } from '../../src/tui-ink/components/ranked-select.js';
import { boardWindow, dominatedRows } from '../../src/tui-ink/components/ranked-select-state.js';

/** Lets Ink flush a render before the next keystroke is read. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

const ITEMS = ['alpha', 'bravo', 'charlie', 'delta'].map((value) => ({ value, label: value }));

function renderRanked(initialRanked?: string[]) {
  let submitted: string[] | undefined;
  const app = render(React.createElement(RankedSelect<string>, {
    title: 'code: simple models',
    items: ITEMS,
    initialRanked,
    onSubmit: (ranked: string[]) => { submitted = ranked; },
  }));
  return {
    app,
    press: async (...keys: string[]) => {
      for (const key of keys) { app.stdin.write(key); await tick(); }
    },
    /**
     * The rank marker and name of each board row, in draw order.
     *
     * A row no longer ENDS with its name — it carries a bar, a cost and a
     * status column after it — so this reads the two leading fields rather
     * than matching the line's tail. What these tests assert is the ORDER and
     * which rows are ranked; the columns after the name are the board's
     * business and have their own tests.
     *
     * The optional `▌` is the cursor's accent edge, which replaced Ink's
     * `inverse` so the board highlights the way the menu does. It changes the
     * line's leading character, where `inverse` changed only its colour.
     */
    rows: () => (app.lastFrame() ?? '')
      // eslint-disable-next-line no-control-regex
      .replace(/\u001B\[[0-9;]*m/g, '')
      .split('\n')
      .flatMap((line) => {
        const m = /^\s*▌?\s*(\d+|·)\s+(\S+)/.exec(line);
        return m !== null && ITEMS.some((item) => item.label === m[2]) ? [`${m[1]} ${m[2]}`] : [];
      }),
    submitted: () => submitted,
    /** The name on the row carrying the cursor's accent edge. */
    cursorRow: () => (app.lastFrame() ?? '')
      // eslint-disable-next-line no-control-regex
      .replace(/\u001B\[[0-9;]*m/g, '')
      .split('\n')
      .flatMap((line) => {
        const m = /^\s*▌\s*(?:\d+|·)\s+(\S+)/.exec(line);
        return m !== null ? [m[1]!] : [];
      })[0],
  };
}

describe('RankedSelect', () => {
  it('draws the ranked models first, in rank order', async () => {
    // The bug this fixes: rows were drawn in item order with the rank as a
    // marker, so a real screen read `· · · 1. 5. · · 2. 6. …` and reordering
    // swapped two numbers on rows that were nowhere near each other.
    const ui = renderRanked(['charlie', 'alpha']);
    expect(ui.rows()).toEqual(['1 charlie', '2 alpha', '· bravo', '· delta']);
  });

  it('marks the cursor with an accent edge, as the menu does', async () => {
    // The board used Ink's `inverse` — a reversed block sharing nothing with
    // the menu's highlight, so one app highlighted two different ways
    // depending on which screen you were on. `▌` plus a band is claude-swap's
    // `border-left: thick $primary` over `background: $surface`, and it is
    // what `menu.tsx` already drew.
    const ui = renderRanked(['charlie', 'alpha']);
    expect(ui.cursorRow()).toBe('charlie');
    await ui.press('\x1B[B');
    expect(ui.cursorRow()).toBe('alpha');
  });

  it('[ promotes the highlighted row and takes the highlight with it', async () => {
    const ui = renderRanked(['charlie', 'alpha']);
    await ui.press('\x1B[B');   // down onto rank 2 (alpha)
    await ui.press('[');
    expect(ui.rows()).toEqual(['1 alpha', '2 charlie', '· bravo', '· delta']);
    // The cursor moved with the row, so a second press is not a round trip: it
    // is a no-op because alpha is now first.
    await ui.press('[');
    expect(ui.rows()).toEqual(['1 alpha', '2 charlie', '· bravo', '· delta']);
    await ui.press('\r');
    expect(ui.submitted()).toEqual(['alpha', 'charlie']);
  });

  it('] demotes it again', async () => {
    const ui = renderRanked(['charlie', 'alpha']);
    await ui.press(']');        // cursor starts on rank 1
    expect(ui.rows()).toEqual(['1 alpha', '2 charlie', '· bravo', '· delta']);
    await ui.press(']');        // charlie is last-ranked now: no-op
    expect(ui.rows()).toEqual(['1 alpha', '2 charlie', '· bravo', '· delta']);
  });

  it('space lifts a row into the ranked block and the highlight follows it', async () => {
    const ui = renderRanked(['charlie']);
    await ui.press('\x1B[B', '\x1B[B');   // down twice: past alpha, onto bravo
    await ui.press(' ');
    expect(ui.rows()).toEqual(['1 charlie', '2 bravo', '· alpha', '· delta']);
    // Highlight followed bravo up, so `[` reorders what was just picked.
    await ui.press('[');
    expect(ui.rows()).toEqual(['1 bravo', '2 charlie', '· alpha', '· delta']);
  });
});

describe('dominatedRows', () => {
  const row = (capability: number, costPerTask: number) => ({ capability, costPerTask });

  it('marks a row beaten on both axes', () => {
    // luna@none vs luna@low on a real catalog: cheaper AND more capable.
    const out = dominatedRows([row(21.0, 0.0098), row(15.5, 0.0101)]);
    expect([...out]).toEqual([1]);
  });

  it('does not mark a row that is merely unranked', () => {
    // The bug this replaces: the board called EVERY unranked row `dominated`,
    // whose stated meaning is "something better and cheaper exists". It had
    // never checked. A row nothing beats is `held` — kept out by hand.
    const out = dominatedRows([row(20, 0.10), row(40, 0.50)]);
    expect(out.size).toBe(0);
  });

  it('does not mark a row that is dearer but more capable', () => {
    expect(dominatedRows([row(30, 0.10), row(50, 0.90)]).size).toBe(0);
  });

  it('marks a tie on capability at a higher price', () => {
    // Equal capability, strictly more money: nothing to gain by choosing it.
    expect([...dominatedRows([row(30, 0.10), row(30, 0.20)])]).toEqual([1]);
  });

  it('leaves unscored rows out entirely, in both directions', () => {
    // An unscored row cannot dominate (nothing is known) and cannot be
    // dominated (there is nothing to compare) — it has its own state.
    const out = dominatedRows([undefined, { capability: 5 }, row(50, 0.01), row(10, 0.90)]);
    expect([...out]).toEqual([3]);
  });

  it('is empty for a single row', () => {
    expect(dominatedRows([row(30, 0.10)]).size).toBe(0);
  });
});

describe('boardWindow', () => {
  it('draws everything when it fits', () => {
    expect(boardWindow(0, 5, 10)).toEqual({ start: 0, end: 5 });
  });

  it('never draws more rows than the room, markers included', () => {
    // The overflow this prevents: twelve candidates plus chrome outgrew a
    // 22-row window and the TITLE scrolled off. The two `more` markers cost a
    // line each and are budgeted, since forgetting them overflows by two.
    for (let cursor = 0; cursor < 30; cursor += 1) {
      const { start, end } = boardWindow(cursor, 30, 10);
      const markers = (start > 0 ? 1 : 0) + (end < 30 ? 1 : 0);
      expect(end - start + markers).toBeLessThanOrEqual(10);
    }
  });

  it('keeps the cursor on screen wherever it goes', () => {
    // `[` and `]` carry a row through the list; a window that did not follow
    // would move the row being ranked out of sight.
    for (let cursor = 0; cursor < 30; cursor += 1) {
      const { start, end } = boardWindow(cursor, 30, 10);
      expect(cursor).toBeGreaterThanOrEqual(start);
      expect(cursor).toBeLessThan(end);
    }
  });

  it('shows at least three rows on a very short terminal', () => {
    const { start, end } = boardWindow(5, 30, 1);
    expect(end - start).toBe(3);
  });
});
