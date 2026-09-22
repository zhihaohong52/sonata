import { describe, it, expect } from 'vitest';
import { bar, band, columns, STATE, INK, MIN_BOARD } from '../../src/tui-ink/theme.js';

describe('bar', () => {
  it('draws a shared-scale quantity, half cells included', () => {
    expect(bar(1, 10)).toEqual({ filled: '━'.repeat(10), track: '' });
    expect(bar(0, 10)).toEqual({ filled: '', track: '─'.repeat(10) });
    // 0.55 * 10 = 5.5 -> five full and a half cell, total width preserved.
    const half = bar(0.55, 10);
    expect(half.filled).toBe('━━━━━╸');
    expect(half.filled.length + half.track.length).toBe(10);
  });

  it('keeps total width constant at every fraction', () => {
    // A row whose bar is a column shorter than its neighbour breaks the
    // shared scale the comparison depends on.
    for (let i = 0; i <= 100; i++) {
      const b = bar(i / 100, 14);
      expect(b.filled.length + b.track.length).toBe(14);
    }
  });

  it('clamps rather than throwing on out-of-range input', () => {
    expect(bar(-1, 6).filled).toBe('');
    expect(bar(2, 6).filled).toBe('━'.repeat(6));
  });
});

describe('band', () => {
  it('changes at the thresholds sonata itself acts on', () => {
    expect(band(0.69)).toBe(INK.LOW);
    expect(band(0.7)).toBe(INK.MID);
    expect(band(0.89)).toBe(INK.MID);
    expect(band(0.9)).toBe(INK.HIGH);
  });
});

describe('STATE', () => {
  it('distinguishes every state by its mark alone', () => {
    // The accessibility contract: strip colour and the board still reads.
    const marks = Object.values(STATE).map((s) => s.mark);
    expect(new Set(marks).size).toBe(marks.length);
  });

  it('names every state in a word a stranger can read', () => {
    for (const s of Object.values(STATE)) expect(s.word).toMatch(/^[a-z]+$/);
  });
});

describe('columns', () => {
  it('drops the bar before it would wrap a row', () => {
    expect(columns(MIN_BOARD).showBar).toBe(true);
    expect(columns(MIN_BOARD - 1).showBar).toBe(false);
  });

  it('never lets a row exceed the terminal, at any width', () => {
    // The invariant the whole grammar rests on: one service per line. A row
    // one cell over wraps, and a wrapped row is not a row. Found by rendering
    // — the status column was measured by eye at 10 and is really 13, so
    // every row wrapped and drew a blank line after itself.
    for (let w = 40; w <= 220; w++) {
      const c = columns(w);
      expect(c.total).toBeLessThanOrEqual(Math.max(40, w));
      expect(c.name).toBeGreaterThanOrEqual(10);
      expect(c.bar).toBeGreaterThanOrEqual(0);
    }
  });

  it('holds the widest state mark and word without truncating them', () => {
    const widest = Object.values(STATE).reduce((a, s) => Math.max(a, s.mark.length + 1 + s.word.length), 0);
    const c = columns(120);
    expect(c.total).toBeLessThanOrEqual(120);
    // status = space + mark + space + word; the reserve must cover the worst case.
    expect(120 - c.name - c.bar - 4 - 9).toBeGreaterThanOrEqual(widest);
  });

  it('leaves the terminal foreground unset, so light themes stay readable', () => {
    expect(INK.TEXT).toBeUndefined();
  });
});
