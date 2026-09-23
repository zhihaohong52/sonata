import { describe, it, expect } from 'vitest';
import {
  localTime,
  routesThatFit,
  statusColumns,
} from '../../src/tui-ink/screens/status-poll.js';

describe('localTime', () => {
  it('renders the ledger stamp in local wall-clock time, to the second', () => {
    // Local, not UTC: read by a person at the machine deciding whether the
    // row on screen is the dispatch they just made. Seconds matter because a
    // tier with fallbacks writes several rows inside one minute.
    const ts = '2026-09-23T01:27:56.000Z';
    const at = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, '0');
    expect(localTime(ts)).toBe(`${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`);
  });

  it('shows nothing rather than a wrong time for a missing or unparseable stamp', () => {
    // Rows written before the ledger carried a usable stamp, and anything
    // corrupt. An empty cell is honest; `Invalid Date` is not.
    expect(localTime(undefined)).toBe('');
    expect(localTime('not a date')).toBe('');
  });
});

describe('statusColumns', () => {
  it('drops columns as the terminal narrows, widest-answer last', () => {
    expect(statusColumns(140).tokens).toBe(true);
    expect(statusColumns(80).tokens).toBe(false);
    expect(statusColumns(80).gateway).toBe(true);
    expect(statusColumns(60).gateway).toBe(false);
    expect(statusColumns(60).time).toBe(true);
    expect(statusColumns(44).time).toBe(false);
  });

  it('always leaves both name columns usable', () => {
    // The failure this budget replaces: the alias was padded to a fixed 26
    // and the rest ran free, so a narrow terminal wrapped every row — and a
    // wrapped row is two rows, which scrolled the header away.
    for (const width of [30, 40, 52, 60, 76, 96, 120, 200]) {
      const c = statusColumns(width);
      expect(c.alias).toBeGreaterThanOrEqual(8);
      expect(c.served).toBeGreaterThanOrEqual(8);
    }
  });

  it('keeps the whole row inside the terminal at every width', () => {
    // The property that actually matters. Fixed cells plus both name columns
    // must never exceed the page.
    //
    // This test used to sweep from 40 and compare against `max(width, 40)` —
    // it excused every narrow terminal, which is exactly where the budget's
    // minimums added up to more than the page and every row wrapped. The
    // screen shipped "not rendering below a certain width" twice with this
    // test green. It now sweeps down to a width no one uses, with no excuse.
    for (let width = 12; width <= 200; width += 1) {
      const c = statusColumns(width);
      const fixed = 4 + 4 + (c.time ? 9 : 0) + (c.gateway ? 12 : 0) + (c.tokens ? 20 : 0);
      expect(fixed + c.alias + c.served).toBeLessThanOrEqual(width);
    }
  });
});

describe('routesThatFit', () => {
  it('counts a route plus one line per failed attempt behind it', () => {
    // 24 rows less 9 of chrome leaves 15: three plain routes and one with two
    // attempts is 3 + 3 = 6 lines, so all four fit.
    expect(routesThatFit([1, 1, 1, 3], 24)).toBe(4);
  });

  it('stops before it would push the header off the top', () => {
    expect(routesThatFit([1, 1, 1, 1, 1, 1], 14)).toBe(5);
  });

  it('never shows nothing when there is something to show', () => {
    // Showing none would read as "nothing routed", which is a different and
    // wrong claim — the screen has an empty state that says so properly.
    expect(routesThatFit([4], 6)).toBe(1);
    expect(routesThatFit([1, 1], 2)).toBe(1);
  });

  it('shows nothing when there is nothing', () => {
    expect(routesThatFit([], 24)).toBe(0);
    expect(routesThatFit([], 2)).toBe(0);
  });
});
