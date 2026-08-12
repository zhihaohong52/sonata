import { describe, it, expect } from 'vitest';
import { parseKey, reduce, renderList } from '../src/tui.js';
import { previousAskedStep } from '../src/commands/init.js';

const LEFT = '[D';
const UP = '[A';
const DOWN = '[B';

const choices = [
  { value: 'a', label: 'a' },
  { value: 'b', label: 'b' },
];
const start = { cursor: 0, checked: new Set<number>(), filter: '', done: false, cancelled: false };

describe('going back a screen', () => {
  it('reads Left as back, in both plain and filterable lists', () => {
    expect(parseKey(LEFT, false)).toEqual({ kind: 'back' });
    expect(parseKey(LEFT, true)).toEqual({ kind: 'back' });
  });

  // The filter is append-only, so Left is free to claim: no keystroke that
  // used to edit text is being taken away.
  it('still reads the other arrows as movement', () => {
    expect(parseKey(UP, true)).toEqual({ kind: 'up' });
    expect(parseKey(DOWN, true)).toEqual({ kind: 'down' });
  });

  it('finishes the list marked back, not cancelled', () => {
    const s = reduce(start, { kind: 'back' }, choices, true);
    expect(s.done).toBe(true);
    expect(s.back).toBe(true);
    expect(s.cancelled).toBe(false);
  });

  it('offers back in the footer only where a previous screen exists', () => {
    expect(renderList('t', choices, start, true, 15, true)).toContain('back');
    expect(renderList('t', choices, start, true, 15, false)).not.toContain('back');
    expect(renderList('t', choices, start, false, 15, true)).toContain('back');
  });

  it('keeps a selection made before going back, so the screen is re-shown as left', () => {
    const picked = reduce(start, { kind: 'space' }, choices, true);
    const gone = reduce(picked, { kind: 'back' }, choices, true);
    expect([...gone.checked]).toEqual([0]);
  });
});

describe('previousAskedStep', () => {
  const all = [true, true, true, true, true];

  it('steps back one screen when every screen is shown', () => {
    expect(previousAskedStep(all, 3)).toBe(2);
  });

  // A step answered by a flag is never displayed, so stopping on it would make
  // Left look like it did nothing.
  it('skips screens answered by a flag', () => {
    expect(previousAskedStep([true, false, false, true, true], 3)).toBe(0);
  });

  it('returns the step itself when nothing earlier was asked', () => {
    expect(previousAskedStep([false, false, true], 2)).toBe(2);
    expect(previousAskedStep(all, 0)).toBe(0);
  });
});
