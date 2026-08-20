import { describe, expect, it } from 'vitest';
import { msInitial, msReduce, msVisible } from '../../src/tui-ink/components/multi-select-state.js';

const labels = ['Alpha', 'Beta', 'Gamma', 'Delta'];

describe('MultiSelect state', () => {
  it('selects and deselects all visible items from the toggle row', () => {
    const initial = msInitial(labels.length, new Set());
    const selected = msReduce(initial, { kind: 'space' }, labels);
    const deselected = msReduce(selected, { kind: 'space' }, labels);

    expect(selected.selected).toEqual(new Set([0, 1, 2, 3]));
    expect(deselected.selected).toEqual(new Set());
  });

  it('toggles only the item under the cursor', () => {
    const initial = { ...msInitial(labels.length, new Set()), cursor: 2 };
    const selected = msReduce(initial, { kind: 'space' }, labels);
    const deselected = msReduce(selected, { kind: 'space' }, labels);

    expect(selected.selected).toEqual(new Set([1]));
    expect(deselected.selected).toEqual(new Set());
  });

  it('filters visible items and toggles only filtered items from the toggle row', () => {
    const filtered = msReduce(msInitial(labels.length, new Set([1])), { kind: 'char', value: 'm' }, labels);
    const selected = msReduce(filtered, { kind: 'space' }, labels);

    expect(msVisible(labels, filtered.filter)).toEqual([2]);
    expect(selected.selected).toEqual(new Set([1, 2]));

    const deselected = msReduce(selected, { kind: 'space' }, labels);
    expect(deselected.selected).toEqual(new Set([1]));
  });

  it('preserves matching initial selections', () => {
    const state = msInitial(labels.length, new Set([0, 2, 99, -1]));

    expect(state.selected).toEqual(new Set([0, 2]));
  });

  it('wraps the cursor at both ends including the toggle row', () => {
    const initial = msInitial(labels.length, new Set());
    const fromTop = msReduce(initial, { kind: 'up' }, labels);
    const fromBottom = msReduce(fromTop, { kind: 'down' }, labels);

    expect(fromTop.cursor).toBe(4);
    expect(fromBottom.cursor).toBe(0);
  });
});
