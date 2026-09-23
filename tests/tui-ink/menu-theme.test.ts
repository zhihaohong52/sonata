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

/** Relative luminance, per WCAG 2.1. */
function luminance(hex: string): number {
  const channel = (v: number): number => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(hex.slice(i, i + 2), 16) / 255));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** WCAG contrast ratio between two hex colours, 1 (identical) to 21 (black on white). */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe('palettes', () => {
  it('names both a ground and a foreground, in both themes', () => {
    // The rule this replaces was "never name a foreground, so either terminal
    // theme stays readable". It was wrong, and it made light mode impossible:
    // with no ground of its own the app could only darken ink on a still-dark
    // terminal. Worse, `BAND` was a named near-white while `TEXT` inherited
    // the terminal's foreground, so on a dark terminal the selected row drew
    // light grey on white and disappeared. A palette that asserts a
    // background must own the foreground that lands on it.
    for (const palette of [DARK, LIGHT]) {
      expect(palette.BG).toMatch(/^#[0-9a-f]{6}$/);
      expect(palette.TEXT).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('keeps text legible on the ground AND on the selected band', () => {
    // The band is the worst case, not the typical one — it is the only place
    // the background changes under the same text — and it is exactly where
    // the original palette failed. Checked as a real contrast ratio so the
    // next palette edit cannot quietly reintroduce it.
    for (const palette of [DARK, LIGHT]) {
      for (const ground of [palette.BG, palette.BAND]) {
        expect(contrast(palette.TEXT, ground)).toBeGreaterThanOrEqual(4.5);
        // Secondary text may be quieter, but it still has to be readable.
        expect(contrast(palette.MUTED, ground)).toBeGreaterThanOrEqual(3);
        // The accent marks the lead row and the committing key; it lands on
        // the band whenever the lead row is also the selected one.
        expect(contrast(palette.ACCENT, ground)).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('elevates the band away from the ground in the direction the theme runs', () => {
    // On dark an elevated surface is lighter than the page; on light it must
    // be darker, or the selected row is a paler smear on an already pale
    // page. Inverting one and not the other is how a "light theme" ends up
    // being the dark theme with different numbers.
    expect(luminance(DARK.BAND)).toBeGreaterThan(luminance(DARK.BG));
    expect(luminance(LIGHT.BAND)).toBeLessThan(luminance(LIGHT.BG));
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
