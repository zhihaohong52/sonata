import { describe, it, expect } from 'vitest';
import { moveCursor } from '../../src/tui-ink/components/menu.js';
import { resolveThemeName, paletteFor, DARK, LIGHT } from '../../src/tui-ink/theme.js';
import { agoLabel } from '../../src/tui-ink/screens/status-poll.js';

describe('moveCursor', () => {
  it('wraps at both ends', () => {
    // A menu this short is a ring. A cursor that stops dead at the last row
    // makes the reader travel back through every item to reach the one below.
    expect(moveCursor(6, 7, 'down')).toBe(0);
    expect(moveCursor(0, 7, 'up')).toBe(6);
  });

  it('moves one step otherwise', () => {
    expect(moveCursor(2, 7, 'down')).toBe(3);
    expect(moveCursor(2, 7, 'up')).toBe(1);
  });

  it('survives an empty menu rather than dividing by zero', () => {
    expect(moveCursor(0, 0, 'down')).toBe(0);
    expect(moveCursor(0, 0, 'up')).toBe(0);
  });
});

describe('resolveThemeName', () => {
  it('takes an explicit choice over any detection', () => {
    // The user saying so outranks a guess, including a contradicting one.
    expect(resolveThemeName({ SONATA_THEME: 'light', COLORFGBG: '15;0' })).toBe('light');
    expect(resolveThemeName({ SONATA_THEME: 'DARK' })).toBe('dark');
  });

  it('reads COLORFGBG when nothing explicit is set', () => {
    expect(resolveThemeName({ COLORFGBG: '0;15' })).toBe('light');
    expect(resolveThemeName({ COLORFGBG: '0;7' })).toBe('light');
    expect(resolveThemeName({ COLORFGBG: '15;0' })).toBe('dark');
  });

  it('falls back to dark on absent or unreadable evidence', () => {
    // Both mistakes are wrong; only one is recoverable. The dark palette on a
    // light terminal is muted text that is harder to read; the light palette
    // on a dark one is text that vanishes.
    expect(resolveThemeName({})).toBe('dark');
    expect(resolveThemeName({ COLORFGBG: 'nonsense' })).toBe('dark');
    expect(resolveThemeName({ SONATA_THEME: 'solarized' })).toBe('dark');
  });
});

describe('palettes', () => {
  it('never names a foreground, so either terminal theme stays readable', () => {
    expect(DARK.TEXT).toBeUndefined();
    expect(LIGHT.TEXT).toBeUndefined();
  });

  it('gives every role a distinct value in both', () => {
    // Roles that collapse onto one another stop encoding anything: a RULE the
    // same colour as MUTED makes a hairline look like text.
    for (const palette of [DARK, LIGHT]) {
      const inks = [palette.ACCENT, palette.MUTED, palette.RULE, palette.LOW, palette.MID, palette.HIGH];
      expect(new Set(inks).size).toBe(inks.length);
    }
  });

  it('differs everywhere it is set, because a hue that reads on charcoal dies on paper', () => {
    expect(paletteFor('light')).not.toEqual(paletteFor('dark'));
    expect(LIGHT.ACCENT).not.toBe(DARK.ACCENT);
    expect(LIGHT.LOW).not.toBe(DARK.LOW);
  });
});

describe('agoLabel', () => {
  it('says how stale the sample is, shortest true form', () => {
    // Without this a frozen screen and a quiet one look identical, and the
    // screen most worth trusting is the one reached when something is wrong.
    expect(agoLabel(300)).toBe('just now');
    expect(agoLabel(4000)).toBe('4s ago');
    expect(agoLabel(90_000)).toBe('2m ago');
    expect(agoLabel(3_600_000)).toBe('1h ago');
  });
});
