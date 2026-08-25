import { describe, it, expect } from 'vitest';
import { rsInitial, rsReduce } from '../../src/tui-ink/components/ranked-select-state.js';

describe('rsReduce', () => {
  it('toggle appends to the end of the ranking and removes on re-toggle', () => {
    let s = rsInitial(3, []);
    s = rsReduce({ ...s, cursor: 1 }, { type: 'toggle' }, 3);
    s = rsReduce({ ...s, cursor: 0 }, { type: 'toggle' }, 3);
    expect(s.ranked).toEqual([1, 0]);          // selection order = ranking
    s = rsReduce({ ...s, cursor: 1 }, { type: 'toggle' }, 3);
    expect(s.ranked).toEqual([0]);
  });

  it('moveUp/moveDown reposition the item under the cursor within the ranking', () => {
    let s = { cursor: 2, ranked: [0, 1, 2] };
    s = rsReduce(s, { type: 'moveUp' }, 3);
    expect(s.ranked).toEqual([0, 2, 1]);
    s = rsReduce(s, { type: 'moveUp' }, 3);
    expect(s.ranked).toEqual([2, 0, 1]);
    s = rsReduce(s, { type: 'moveUp' }, 3);   // already first: no-op
    expect(s.ranked).toEqual([2, 0, 1]);
    s = rsReduce(s, { type: 'moveDown' }, 3);
    expect(s.ranked).toEqual([0, 2, 1]);
  });

  it('move actions ignore an unselected cursor item', () => {
    const s = rsReduce({ cursor: 2, ranked: [0] }, { type: 'moveUp' }, 3);
    expect(s.ranked).toEqual([0]);
  });

  it('cursor movement clamps to the item count', () => {
    expect(rsReduce({ cursor: 0, ranked: [] }, { type: 'up' }, 3).cursor).toBe(0);
    expect(rsReduce({ cursor: 2, ranked: [] }, { type: 'down' }, 3).cursor).toBe(2);
  });

  it('rsInitial preserves a stored ranking order', () => {
    expect(rsInitial(4, [2, 0]).ranked).toEqual([2, 0]);
  });
});
