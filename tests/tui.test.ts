import { describe, it, expect } from 'vitest';
import {
  parseKey, initialState, reduce, renderList, type Choice,
  parseTextKey, initialTextState, reduceText, renderText,
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

// ---- text input ---------------------------------------------------------

const ESC = '\u001b';

/** Types a string one keystroke at a time, as a terminal delivers it. */
function type(text: string, start = '') {
  return [...text].reduce(
    (s, ch) => reduceText(s, parseTextKey(ch)),
    initialTextState(start),
  );
}

describe('parseTextKey', () => {
  it('treats letters as text, not as list navigation', () => {
    // The list widget binds j/k to movement. In a text field they are letters,
    // which is the whole reason text input needs its own key parser.
    expect(parseTextKey('j')).toEqual({ kind: 'char', value: 'j' });
    expect(parseTextKey('k')).toEqual({ kind: 'char', value: 'k' });
    expect(parseTextKey(' ')).toEqual({ kind: 'char', value: ' ' });
  });

  it('recognises editing keys', () => {
    expect(parseTextKey('\u007f').kind).toBe('backspace');
    expect(parseTextKey('\b').kind).toBe('backspace');
    expect(parseTextKey(`${ESC}[D`).kind).toBe('left');
    expect(parseTextKey(`${ESC}[C`).kind).toBe('right');
    expect(parseTextKey('\u0001').kind).toBe('home');
    expect(parseTextKey('\u0005').kind).toBe('end');
    expect(parseTextKey('\r').kind).toBe('enter');
    expect(parseTextKey('\u0003').kind).toBe('cancel');
    expect(parseTextKey(ESC).kind).toBe('cancel');
  });

  it('accepts a pasted chunk as a single insertion', () => {
    expect(parseTextKey('gpt-5.6-sol')).toEqual({ kind: 'char', value: 'gpt-5.6-sol' });
  });

  it('ignores sequences carrying control characters', () => {
    // An unhandled escape sequence must never reach the value, where it would
    // be invisible on screen and corrupt the result.
    expect(parseTextKey(`${ESC}[5~`).kind).toBe('ignore');
    expect(parseTextKey(`a${ESC}bc`).kind).toBe('ignore');
  });
});

describe('reduceText', () => {
  it('inserts typed characters', () => {
    const s = type('gpt-5');
    expect(s.value).toBe('gpt-5');
    expect(s.cursor).toBe(5);
  });

  it('inserts at the cursor, not the end', () => {
    let s = type('ac');
    s = reduceText(s, { kind: 'left' });
    s = reduceText(s, { kind: 'char', value: 'b' });
    expect(s.value).toBe('abc');
    expect(s.cursor).toBe(2);
  });

  it('backspaces at the cursor and stops at the start', () => {
    let s = type('abc');
    s = reduceText(s, { kind: 'backspace' });
    expect(s.value).toBe('ab');
    s = reduceText(s, { kind: 'home' });
    s = reduceText(s, { kind: 'backspace' });
    expect(s.value).toBe('ab');
    expect(s.cursor).toBe(0);
  });

  it('clamps cursor movement at both ends', () => {
    let s = type('ab');
    s = reduceText(s, { kind: 'right' });
    expect(s.cursor).toBe(2);
    for (let i = 0; i < 5; i++) s = reduceText(s, { kind: 'left' });
    expect(s.cursor).toBe(0);
  });

  it('refuses to submit an empty or blank value', () => {
    // Returning "" would be written into sonata.toml as a model id.
    expect(reduceText(initialTextState(''), { kind: 'enter' }).done).toBe(false);
    expect(reduceText(type('   '), { kind: 'enter' }).done).toBe(false);
  });

  it('submits a non-empty value', () => {
    const s = reduceText(type('gpt-5.6-sol'), { kind: 'enter' });
    expect(s.done).toBe(true);
    expect(s.cancelled).toBe(false);
  });

  it('cancels without submitting', () => {
    const s = reduceText(type('half-typed'), { kind: 'cancel' });
    expect(s.cancelled).toBe(true);
    expect(s.done).toBe(true);
  });

  it('starts with the cursor after any initial value', () => {
    expect(initialTextState('gpt-5.6-sol').cursor).toBe('gpt-5.6-sol'.length);
  });
});

describe('renderText', () => {
  const plain = (s: string) => s.replace(/\u001b\[\d+m/g, '');

  it('shows the title and the typed value', () => {
    const out = renderText('Codex model id', type('gpt-5.6-sol'));
    expect(out).toContain('Codex model id');
    // The caret is a reverse-video cell, so strip styling before comparing.
    expect(plain(out)).toContain('gpt-5.6-sol');
  });

  it('marks the cursor position', () => {
    expect(renderText('t', type('ab'))).toContain('\u001b[7m');
  });

  it('uses a custom hint when given, and a default otherwise', () => {
    expect(renderText('t', type('x'), 'unknown model')).toContain('unknown model');
    expect(renderText('t', type('x'))).toContain('enter confirm');
  });
});
