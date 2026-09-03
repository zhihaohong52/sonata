import { describe, it, expect } from 'vitest';
import { rsInitial, rsOrder, rsReduce } from '../../src/tui-ink/components/ranked-select-state.js';

describe('rsOrder', () => {
  it('draws the ranked block first, in rank order, then the rest in item order', () => {
    expect(rsOrder({ cursor: 0, ranked: [3, 1] }, 5)).toEqual([3, 1, 0, 2, 4]);
  });

  it('is item order when nothing is ranked', () => {
    expect(rsOrder({ cursor: 0, ranked: [] }, 3)).toEqual([0, 1, 2]);
  });
});

describe('rsReduce', () => {
  it('toggle appends to the end of the ranking and removes on re-toggle', () => {
    // The cursor is a *display* position, so with nothing ranked it still
    // addresses items directly.
    let s = rsInitial(3, []);
    s = rsReduce({ ...s, cursor: 1 }, { type: 'toggle' }, 3);
    expect(s.ranked).toEqual([1]);
    // Display order is now [1, 0, 2]; item 0 sits at position 1.
    s = rsReduce({ ...s, cursor: 1 }, { type: 'toggle' }, 3);
    expect(s.ranked).toEqual([1, 0]);          // selection order = ranking
    s = rsReduce(s, { type: 'toggle' }, 3);    // same row, still item 0
    expect(s.ranked).toEqual([1]);
  });

  it('the cursor follows the item a toggle moved, not the position', () => {
    // Ranking a row lifts it into the numbered block; the highlight goes with
    // it, so `[` next reorders the row the user just picked rather than
    // whichever one slid into the vacated slot.
    const s = rsReduce({ cursor: 3, ranked: [0] }, { type: 'toggle' }, 4);
    expect(s).toEqual({ cursor: 1, ranked: [0, 3] });
    // And back out again, to its place in item order.
    expect(rsReduce(s, { type: 'toggle' }, 4)).toEqual({ cursor: 3, ranked: [0] });
  });

  it('moveUp/moveDown reposition the row under the cursor and take it with them', () => {
    // Reported as "[ and ] does not work": the cursor used to stay put while
    // two rank numbers swapped on rows that could be far apart, so a keypress
    // was often invisible and two were a round trip.
    let s: { cursor: number; ranked: number[] } = { cursor: 2, ranked: [0, 1, 2] };
    s = rsReduce(s, { type: 'moveUp' }, 3);
    expect(s).toEqual({ cursor: 1, ranked: [0, 2, 1] });
    s = rsReduce(s, { type: 'moveUp' }, 3);
    expect(s).toEqual({ cursor: 0, ranked: [2, 0, 1] });
    s = rsReduce(s, { type: 'moveUp' }, 3);   // already first: no-op
    expect(s).toEqual({ cursor: 0, ranked: [2, 0, 1] });
    s = rsReduce(s, { type: 'moveDown' }, 3);
    expect(s).toEqual({ cursor: 1, ranked: [0, 2, 1] });
  });

  it('move actions ignore a cursor below the ranked block', () => {
    // An unranked row has no rank to move. It now sits visibly beneath the
    // numbered rows, which is why doing nothing here reads as correct.
    const s = rsReduce({ cursor: 2, ranked: [0] }, { type: 'moveUp' }, 3);
    expect(s.ranked).toEqual([0]);
    const down = rsReduce({ cursor: 2, ranked: [0] }, { type: 'moveDown' }, 3);
    expect(down.ranked).toEqual([0]);
  });

  it('moveDown at the bottom rank is a no-op', () => {
    const s = rsReduce({ cursor: 2, ranked: [0, 1, 2] }, { type: 'moveDown' }, 3);
    expect(s).toEqual({ cursor: 2, ranked: [0, 1, 2] });
  });

  it('cursor movement clamps to the item count', () => {
    expect(rsReduce({ cursor: 0, ranked: [] }, { type: 'up' }, 3).cursor).toBe(0);
    expect(rsReduce({ cursor: 2, ranked: [] }, { type: 'down' }, 3).cursor).toBe(2);
  });

  it('rsInitial preserves a stored ranking order', () => {
    expect(rsInitial(4, [2, 0]).ranked).toEqual([2, 0]);
  });
});
