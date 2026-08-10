import { describe, it, expect } from 'vitest';
import {
  parseKey, initialState, reduce, renderList, type Choice,
} from '../src/tui.js';

const CHOICES: Choice<string>[] = [
  { value: 'a', label: 'alpha' },
  { value: 'b', label: 'beta', checked: true },
  { value: 'c', label: 'gamma' },
];

describe('parseKey', () => {
  it('maps arrow keys', () => {
    expect(parseKey('\u001b[A')).toBe('up');
    expect(parseKey('\u001b[B')).toBe('down');
  });

  it('maps vim keys', () => {
    expect(parseKey('k')).toBe('up');
    expect(parseKey('j')).toBe('down');
  });

  it('maps space, enter and cancel', () => {
    expect(parseKey(' ')).toBe('space');
    expect(parseKey('\r')).toBe('enter');
    expect(parseKey('\u0003')).toBe('cancel');
    expect(parseKey('\u001b')).toBe('cancel');
  });

  it('treats anything else as other', () => {
    expect(parseKey('z')).toBe('other');
  });
});

describe('initialState', () => {
  it('pre-checks options marked checked', () => {
    expect([...initialState(CHOICES).checked]).toEqual([1]);
  });

  it('starts the cursor on the first enabled option', () => {
    const withDisabled: Choice<string>[] = [
      { value: 'x', label: 'x', disabled: true },
      { value: 'y', label: 'y' },
    ];
    expect(initialState(withDisabled).cursor).toBe(1);
  });
});

describe('reduce', () => {
  it('wraps the cursor at both ends', () => {
    let s = initialState(CHOICES);
    s = reduce(s, 'up', CHOICES, true);
    expect(s.cursor).toBe(2);
    s = reduce(s, 'down', CHOICES, true);
    expect(s.cursor).toBe(0);
  });

  it('skips disabled options', () => {
    const c: Choice<string>[] = [
      { value: 'a', label: 'a' },
      { value: 'b', label: 'b', disabled: true },
      { value: 'c', label: 'c' },
    ];
    const s = reduce(initialState(c), 'down', c, true);
    expect(s.cursor).toBe(2);
  });

  it('toggles on space in multi mode only', () => {
    const multi = reduce(initialState(CHOICES), 'space', CHOICES, true);
    expect(multi.checked.has(0)).toBe(true);

    const single = reduce(initialState(CHOICES), 'space', CHOICES, false);
    expect(single.checked.has(0)).toBe(false);
  });

  it('untoggles a checked option', () => {
    let s = initialState(CHOICES);
    s = reduce(s, 'down', CHOICES, true); // cursor -> 1, which is checked
    s = reduce(s, 'space', CHOICES, true);
    expect(s.checked.has(1)).toBe(false);
  });

  it('enter in single mode selects exactly the cursor', () => {
    let s = initialState(CHOICES); // index 1 pre-checked
    s = reduce(s, 'down', CHOICES, false); // cursor -> 1
    s = reduce(s, 'down', CHOICES, false); // cursor -> 2
    s = reduce(s, 'enter', CHOICES, false);
    expect([...s.checked]).toEqual([2]);
    expect(s.done).toBe(true);
  });

  it('enter in multi mode keeps every checked option', () => {
    const s = reduce(initialState(CHOICES), 'enter', CHOICES, true);
    expect([...s.checked]).toEqual([1]);
    expect(s.done).toBe(true);
  });

  it('cancel sets both cancelled and done', () => {
    const s = reduce(initialState(CHOICES), 'cancel', CHOICES, true);
    expect(s.cancelled).toBe(true);
    expect(s.done).toBe(true);
  });

  it('ignores unknown keys', () => {
    const before = initialState(CHOICES);
    expect(reduce(before, 'other', CHOICES, true)).toEqual(before);
  });
});

describe('renderList', () => {
  it('marks the cursor and checkboxes in multi mode', () => {
    const out = renderList('Pick', CHOICES, initialState(CHOICES), true);
    expect(out).toContain('❯ ○ alpha');
    expect(out).toContain('◉ beta');
    expect(out).toContain('space toggle');
  });

  it('omits checkboxes in single mode', () => {
    const out = renderList('Pick', CHOICES, initialState(CHOICES), false);
    expect(out).not.toContain('○');
    expect(out).toContain('enter select');
  });

  it('labels disabled options', () => {
    const c: Choice<string>[] = [{ value: 'a', label: 'a', disabled: true }];
    expect(renderList('t', c, initialState(c), false)).toContain('(unavailable)');
  });

  it('renders hints', () => {
    const c: Choice<string>[] = [{ value: 'a', label: 'a', hint: 'fast' }];
    expect(renderList('t', c, initialState(c), false)).toContain('· fast');
  });
});
