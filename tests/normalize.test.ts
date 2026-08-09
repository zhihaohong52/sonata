import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripAnsi, cleanPane, newLines } from '../src/normalize.js';

describe('stripAnsi', () => {
  it('removes colour and cursor sequences', () => {
    expect(stripAnsi('\u001b[0mhello\u001b[1;32m world\u001b[K')).toBe('hello world');
  });
});

describe('cleanPane', () => {
  it('drops blank and spinner-only lines and trims trailing space', () => {
    const raw = '\u001b[0m\nfoo   \n⠋\n⠙ thinking\n\nbar\n\n\n';
    expect(cleanPane(raw)).toEqual(['foo', '⠙ thinking', 'bar']);
  });

  it('normalises a real opencode pane', () => {
    const raw = readFileSync('tests/fixtures/opencode-pane.txt', 'utf8');
    expect(cleanPane(raw)).toEqual(['> build · deepseek-v4-flash', 'CTRL_OK']);
  });
});

describe('newLines', () => {
  it('returns everything when there is no previous state', () => {
    expect(newLines([], ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('returns only the appended tail', () => {
    expect(newLines(['a', 'b'], ['a', 'b', 'c'])).toEqual(['c']);
  });

  it('returns nothing when unchanged', () => {
    expect(newLines(['a', 'b'], ['a', 'b'])).toEqual([]);
  });

  it('handles scrolled-off content via suffix overlap', () => {
    expect(newLines(['a', 'b', 'c'], ['b', 'c', 'd'])).toEqual(['d']);
  });

  it('returns everything when there is no overlap at all', () => {
    expect(newLines(['a'], ['x', 'y'])).toEqual(['x', 'y']);
  });
});
