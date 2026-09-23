import { describe, it, expect } from 'vitest';
import { bar, band, columns, STATE, INK, MIN_BOARD, MAX_BOARD } from '../../src/tui-ink/theme.js';

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
    //
    // It used to sweep from 40 against `max(40, w)`, excusing every narrow
    // terminal — where `columns` really did return a 40-cell row and every
    // row wrapped. It now sweeps from the narrowest width a rank and a stroke
    // can occupy, with no excuse.
    for (let w = 8; w <= 220; w++) {
      const c = columns(w);
      expect(c.total).toBeLessThanOrEqual(w);
      expect(c.bar).toBeGreaterThanOrEqual(0);
    }
    // Where a usable board is possible, the name keeps a usable width.
    for (let w = 40; w <= 220; w++) expect(columns(w).name).toBeGreaterThanOrEqual(10);
  });

  it('stops growing at the measure limit, and sits left', () => {
    // Past MAX_BOARD the name column stretches and the bar drifts away from
    // the model it describes. Measured at 200 columns: a 145-wide name made
    // the row read as two unrelated halves.
    expect(columns(200).total).toBe(columns(MAX_BOARD).total);
    expect(columns(MAX_BOARD).total).toBeLessThanOrEqual(MAX_BOARD);
  });

  it('shows status words only once there is room for them', () => {
    expect(columns(88).showWord).toBe(true);
    expect(columns(87).showWord).toBe(false);
  });

  it('holds the widest state mark and word without truncating them', () => {
    const widest = Object.values(STATE).reduce((a, s) => Math.max(a, s.mark.length + 1 + s.word.length), 0);
    const c = columns(120);
    expect(c.total).toBeLessThanOrEqual(120);
    // status = space + mark + space + word; the reserve must cover the worst case.
    expect(120 - c.name - c.bar - 4 - 9).toBeGreaterThanOrEqual(widest);
  });

  it('resolves a complete pair, ground and foreground both named', () => {
    // `INK` is what non-React callers draw with, so it has to be a usable
    // palette rather than a set of inks hoping the terminal agrees with them.
    expect(INK.BG).toMatch(/^#[0-9a-f]{6}$/);
    expect(INK.TEXT).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('columns — below the old 40-cell floor', () => {
  it('drops the bar, then the word, then the cost, rather than overflowing', () => {
    expect(columns(30).showBar).toBe(false);
    expect(columns(30).showCost).toBe(true);
    // Too narrow for a price beside a usable name: the price goes.
    expect(columns(20).showCost).toBe(false);
    expect(columns(20).total).toBeLessThanOrEqual(20);
  });
});
