import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { RankedSelect } from '../../src/tui-ink/components/ranked-select.js';
import { dominatedRows } from '../../src/tui-ink/components/ranked-select-state.js';

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
     */
    rows: () => (app.lastFrame() ?? '')
      // eslint-disable-next-line no-control-regex
      .replace(/\u001B\[[0-9;]*m/g, '')
      .split('\n')
      .flatMap((line) => {
        const m = /^\s*(\d+|·)\s+(\S+)/.exec(line);
        return m !== null && ITEMS.some((item) => item.label === m[2]) ? [`${m[1]} ${m[2]}`] : [];
      }),
    submitted: () => submitted,
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
