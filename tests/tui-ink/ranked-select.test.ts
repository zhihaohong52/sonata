import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { RankedSelect } from '../../src/tui-ink/components/ranked-select.js';

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
    /** The item labels in draw order, ranked marker included. */
    rows: () => (app.lastFrame() ?? '')
      // eslint-disable-next-line no-control-regex
      .replace(/\u001B\[[0-9;]*m/g, '')
      .split('\n')
      .filter((line) => ITEMS.some((item) => line.endsWith(item.label)))
      .map((line) => line.trim()),
    submitted: () => submitted,
  };
}

describe('RankedSelect', () => {
  it('draws the ranked models first, in rank order', async () => {
    // The bug this fixes: rows were drawn in item order with the rank as a
    // marker, so a real screen read `· · · 1. 5. · · 2. 6. …` and reordering
    // swapped two numbers on rows that were nowhere near each other.
    const ui = renderRanked(['charlie', 'alpha']);
    expect(ui.rows()).toEqual(['1. charlie', '2. alpha', '· bravo', '· delta']);
  });

  it('[ promotes the highlighted row and takes the highlight with it', async () => {
    const ui = renderRanked(['charlie', 'alpha']);
    await ui.press('\x1B[B');   // down onto rank 2 (alpha)
    await ui.press('[');
    expect(ui.rows()).toEqual(['1. alpha', '2. charlie', '· bravo', '· delta']);
    // The cursor moved with the row, so a second press is not a round trip: it
    // is a no-op because alpha is now first.
    await ui.press('[');
    expect(ui.rows()).toEqual(['1. alpha', '2. charlie', '· bravo', '· delta']);
    await ui.press('\r');
    expect(ui.submitted()).toEqual(['alpha', 'charlie']);
  });

  it('] demotes it again', async () => {
    const ui = renderRanked(['charlie', 'alpha']);
    await ui.press(']');        // cursor starts on rank 1
    expect(ui.rows()).toEqual(['1. alpha', '2. charlie', '· bravo', '· delta']);
    await ui.press(']');        // charlie is last-ranked now: no-op
    expect(ui.rows()).toEqual(['1. alpha', '2. charlie', '· bravo', '· delta']);
  });

  it('space lifts a row into the ranked block and the highlight follows it', async () => {
    const ui = renderRanked(['charlie']);
    await ui.press('\x1B[B', '\x1B[B');   // down twice: past alpha, onto bravo
    await ui.press(' ');
    expect(ui.rows()).toEqual(['1. charlie', '2. bravo', '· alpha', '· delta']);
    // Highlight followed bravo up, so `[` reorders what was just picked.
    await ui.press('[');
    expect(ui.rows()).toEqual(['1. bravo', '2. charlie', '· alpha', '· delta']);
  });
});
