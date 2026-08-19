import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import {
  parseKey, initialState, reduce, renderList, viewport, listHeight, type Choice,
  type ListState, visibleIndices,
  parseTextKey, initialTextState, reduceText, renderText,
  readKeys, redraw, banner,
} from '../src/tui.js';

const CHOICES: Choice<string>[] = [
  { value: 'a', label: 'alpha' },
  { value: 'b', label: 'beta', checked: true },
  { value: 'c', label: 'gamma' },
];

describe('parseKey', () => {
  it('maps arrow keys', () => {
    expect(parseKey('\u001b[A', false)).toEqual({ kind: 'up' });
    expect(parseKey('\u001b[B', false)).toEqual({ kind: 'down' });
  });

  it('maps vim keys when filtering is off', () => {
    expect(parseKey('k', false)).toEqual({ kind: 'up' });
    expect(parseKey('j', false)).toEqual({ kind: 'down' });
  });

  it('maps space, enter and cancel', () => {
    expect(parseKey(' ', false)).toEqual({ kind: 'space' });
    expect(parseKey('\r', false)).toEqual({ kind: 'enter' });
    expect(parseKey('\u0003', false)).toEqual({ kind: 'cancel' });
    expect(parseKey('\u001b', false)).toEqual({ kind: 'cancel' });
  });

  it('treats anything else as ignore', () => {
    expect(parseKey('z', false)).toEqual({ kind: 'ignore' });
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
    s = reduce(s, { kind: 'up' }, CHOICES, true);
    expect(s.cursor).toBe(2);
    s = reduce(s, { kind: 'down' }, CHOICES, true);
    expect(s.cursor).toBe(0);
  });

  it('skips disabled options', () => {
    const c: Choice<string>[] = [
      { value: 'a', label: 'a' },
      { value: 'b', label: 'b', disabled: true },
      { value: 'c', label: 'c' },
    ];
    const s = reduce(initialState(c), { kind: 'down' }, c, true);
    expect(s.cursor).toBe(2);
  });

  it('toggles on space in multi mode only', () => {
    const multi = reduce(initialState(CHOICES), { kind: 'space' }, CHOICES, true);
    expect(multi.checked.has(0)).toBe(true);

    const single = reduce(initialState(CHOICES), { kind: 'space' }, CHOICES, false);
    expect(single.checked.has(0)).toBe(false);
  });

  it('untoggles a checked option', () => {
    let s = initialState(CHOICES);
    s = reduce(s, { kind: 'down' }, CHOICES, true); // cursor -> 1, which is checked
    s = reduce(s, { kind: 'space' }, CHOICES, true);
    expect(s.checked.has(1)).toBe(false);
  });

  it('enter in single mode selects exactly the cursor', () => {
    let s = initialState(CHOICES); // index 1 pre-checked
    s = reduce(s, { kind: 'down' }, CHOICES, false); // cursor -> 1
    s = reduce(s, { kind: 'down' }, CHOICES, false); // cursor -> 2
    s = reduce(s, { kind: 'enter' }, CHOICES, false);
    expect([...s.checked]).toEqual([2]);
    expect(s.done).toBe(true);
  });

  it('enter in multi mode keeps every checked option', () => {
    const s = reduce(initialState(CHOICES), { kind: 'enter' }, CHOICES, true);
    expect([...s.checked]).toEqual([1]);
    expect(s.done).toBe(true);
  });

  it('cancel sets both cancelled and done', () => {
    const s = reduce(initialState(CHOICES), { kind: 'cancel' }, CHOICES, true);
    expect(s.cancelled).toBe(true);
    expect(s.done).toBe(true);
  });

  it('ignores unknown keys', () => {
    const before = initialState(CHOICES);
    expect(reduce(before, { kind: 'ignore' }, CHOICES, true)).toEqual(before);
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

describe('readKeys', () => {
  /**
   * stdin is shared across every prompt in a run, and `sonata init` shows four
   * in a row. Destroying it on the way out, or leaving it flowing, breaks the
   * prompt *after* this one rather than this one — so one read proves nothing.
   */
  it('leaves the stream usable for the prompts that follow', async () => {
    const stdin = new PassThrough();
    const seen: string[] = [];
    const readOne = () => readKeys(stdin, (chunk) => {
      seen.push(chunk);
      return true;
    });

    for (const key of ['a', 'b', 'c']) {
      setTimeout(() => stdin.write(key), 0);
      await readOne();
    }

    expect(seen).toEqual(['a', 'b', 'c']);
    expect(stdin.destroyed).toBe(false);
  });

  it('keeps reading until the handler reports done', async () => {
    const stdin = new PassThrough();
    const seen: string[] = [];
    const done = readKeys(stdin, (chunk) => {
      seen.push(chunk);
      return chunk === '\r';
    });

    // One keystroke per tick: a stream coalesces writes made in the same tick
    // into a single chunk, which a terminal would not do.
    for (const key of ['j', ' ', '\r']) {
      stdin.write(key);
      await new Promise((r) => setImmediate(r));
    }
    await done;

    expect(seen).toEqual(['j', ' ', '\r']);
  });
});

describe('viewport', () => {
  it('shows the top of the list when the cursor is at the top', () => {
    expect(viewport(0, 100, 10)).toEqual({ start: 0, end: 10, above: 0, below: 90 });
  });

  it('shows the bottom when the cursor is at the end', () => {
    expect(viewport(99, 100, 10)).toEqual({ start: 90, end: 100, above: 90, below: 0 });
  });

  it('centres the cursor in the middle of a long list', () => {
    const w = viewport(50, 100, 10);
    expect(w.start).toBe(45);
    expect(w.end).toBe(55);
  });

  it('shows everything when the list is shorter than the window', () => {
    expect(viewport(1, 3, 10)).toEqual({ start: 0, end: 3, above: 0, below: 0 });
  });

  it('handles an empty list without going out of range', () => {
    expect(viewport(0, 0, 10)).toEqual({ start: 0, end: 0, above: 0, below: 0 });
  });
});

describe('listHeight', () => {
  it('leaves room for the title, filter, counts and hint', () => {
    expect(listHeight(30)).toBe(15);
    expect(listHeight(20)).toBe(12);
  });

  it('never returns less than three rows', () => {
    expect(listHeight(5)).toBe(3);
  });
});

describe('renderList — windowing', () => {
  const many: Choice<number>[] = Array.from({ length: 50 }, (_, i) => ({ value: i, label: `m${i}` }));

  it('draws only the window, with overflow counts', () => {
    const out = renderList('Pick', many, initialState(many), true, 5);
    expect(out).toContain('m0');
    expect(out).not.toContain('m40');
    expect(out).toContain('↓ 45 more');
  });

  it('keeps the block short enough to redraw', () => {
    // The redraw moves the cursor up by the block height; a block taller than
    // the terminal cannot be redrawn correctly.
    const out = renderList('Pick', many, initialState(many), true, 5);
    expect(out.split('\n').length).toBeLessThan(15);
  });
});

describe('parseKey — filterable lists', () => {
  it('treats letters as filter text when filtering is on', () => {
    expect(parseKey('j', true)).toEqual({ kind: 'char', value: 'j' });
    expect(parseKey('k', true)).toEqual({ kind: 'char', value: 'k' });
  });

  it('keeps vim keys when filtering is off', () => {
    expect(parseKey('j', false)).toEqual({ kind: 'down' });
    expect(parseKey('k', false)).toEqual({ kind: 'up' });
  });

  it('keeps space as a toggle, since no ref contains a space', () => {
    expect(parseKey(' ', true)).toEqual({ kind: 'space' });
  });

  it('maps arrows, enter, cancel and backspace in both modes', () => {
    expect(parseKey('\u001b[A', true)).toEqual({ kind: 'up' });
    expect(parseKey('\u001b[B', true)).toEqual({ kind: 'down' });
    expect(parseKey('\r', true)).toEqual({ kind: 'enter' });
    expect(parseKey('\u001b', true)).toEqual({ kind: 'cancel' });
    expect(parseKey('\u007f', true)).toEqual({ kind: 'backspace' });
  });
});

describe('visibleIndices', () => {
  const choices: Choice<string>[] = [
    { value: 'a', label: 'openrouter/deepseek-v4-flash' },
    { value: 'b', label: 'openrouter/kimi-k3' },
    { value: 'c', label: 'openrouter/deepseek/deepseek-v4-pro' },
  ];

  it('returns every index when the filter is empty', () => {
    expect(visibleIndices(choices, '')).toEqual([0, 1, 2]);
  });

  it('matches a substring, case-insensitively', () => {
    expect(visibleIndices(choices, 'DEEPSEEK')).toEqual([0, 2]);
  });

  it('returns nothing when nothing matches', () => {
    expect(visibleIndices(choices, 'zzz')).toEqual([]);
  });
});

describe('reduce — filtering', () => {
  const choices: Choice<string>[] = [
    { value: 'a', label: 'openrouter/deepseek-v4-flash' },
    { value: 'b', label: 'openrouter/kimi-k3' },
    { value: 'c', label: 'openrouter/deepseek/deepseek-v4-pro' },
  ];
  const type = (s: ListState, text: string) =>
    [...text].reduce((acc, ch) => reduce(acc, { kind: 'char', value: ch }, choices, true), s);

  it('narrows the list as the user types', () => {
    const s = type(initialState(choices), 'kimi');
    expect(visibleIndices(choices, s.filter)).toEqual([1]);
  });

  it('widens again on backspace', () => {
    let s = type(initialState(choices), 'kimi');
    s = reduce(s, { kind: 'backspace' }, choices, true);
    expect(s.filter).toBe('kim');
  });

  it('keeps a checked model checked after it is filtered away', () => {
    // checked holds original indices, so a filter change cannot disturb it.
    let s = reduce(initialState(choices), { kind: 'space' }, choices, true); // checks index 0
    s = type(s, 'kimi');
    expect(s.checked.has(0)).toBe(true);
    s = reduce(s, { kind: 'enter' }, choices, true);
    expect([...s.checked].sort()).toEqual([0]);
  });

  it('toggles the model under the cursor in the filtered view, not the raw list', () => {
    let s = type(initialState(choices), 'kimi'); // view is [1]
    s = reduce(s, { kind: 'space' }, choices, true);
    expect(s.checked.has(1)).toBe(true);
    expect(s.checked.has(0)).toBe(false);
  });

  it('confirms what is checked even when the filter matches nothing', () => {
    let s = reduce(initialState(choices), { kind: 'space' }, choices, true);
    s = type(s, 'zzz');
    s = reduce(s, { kind: 'enter' }, choices, true);
    expect(s.done).toBe(true);
    expect([...s.checked]).toEqual([0]);
  });

  it('ignores filter keys in single-select mode', () => {
    const s = reduce(initialState(choices), { kind: 'char', value: 'z' }, choices, false);
    expect(s.filter).toBe('');
  });
});

describe('redraw', () => {
  it('does not clear-screen on the first draw', () => {
    const first = redraw('a\nb\nc', 0);
    expect(first.height).toBe(3);
    expect(first.out).not.toContain('\u001b[2J');
  });

  it('clear-screens on subsequent draws so the block is fully replaced', () => {
    const first = redraw('a\nb\nc', 0);
    const second = redraw('a\nb\nc\nd', first.height);
    expect(second.out).toContain('\u001b[2J');
    expect(second.out).toContain('\u001b[H');
    expect(second.height).toBe(4);
  });

  it('tracks height correctly across draws of different sizes', () => {
    const first = redraw('a\nb\nc', 0);
    expect(first.height).toBe(3);
    const grown = redraw('a\nb\nc\nd', first.height);
    expect(grown.height).toBe(4);
    const shrunk = redraw('a', grown.height);
    expect(shrunk.height).toBe(1);
  });
});

describe('banner', () => {
  it('renders the wordmark', () => {
    const lines = banner().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(6);
    expect(banner()).toContain('foreign-model subagents');
  });

  it('fits an 80-column terminal', () => {
    // The banner is decoration; wrapping it would look worse than not having it.
    for (const line of banner().split('\n')) {
      expect([...line].length).toBeLessThanOrEqual(80);
    }
  });

  it('leaves no trailing whitespace', () => {
    for (const line of banner().split('\n')) {
      expect(line).toBe(line.replace(/\s+$/, ''));
    }
  });
});
