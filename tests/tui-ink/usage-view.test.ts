import { describe, it, expect } from 'vitest';
import React from 'react';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'ink-testing-library';
import {
  bucketsThatFit, compactCount, nextDimension, nextWindow, usageColumns, USAGE_CELL, windowLabel,
} from '../../src/tui-ink/screens/usage-view.js';
import { UsageScreen } from '../../src/tui-ink/screens/usage.js';
import { appendRow, type LedgerRow } from '../../src/ledger.js';
import { ThemeProvider } from '../../src/tui-ink/theme-context.js';

describe('usage screen axes', () => {
  it('cycles the window through the presets, and off a custom one onto the first', () => {
    expect(nextWindow('1h')).toBe('24h');
    expect(nextWindow('30d')).toBe('1h');
    expect(nextWindow('12h')).toBe('1h');
  });

  it('cycles every --by dimension and wraps', () => {
    const seen = ['model'];
    let d = nextDimension('model');
    while (d !== 'model') { seen.push(d); d = nextDimension(d); }
    expect(seen).toEqual(['model', 'role', 'tier', 'effort', 'gateway', 'lane', 'session', 'project']);
  });

  it('names a window the way a reader says it', () => {
    expect(windowLabel('7d')).toBe('last 7 days');
    expect(windowLabel('1h')).toBe('last hour');
    expect(windowLabel('30m')).toBe('last 30 minutes');
  });
});

describe('compactCount', () => {
  it('fits a count into a few cells at every scale', () => {
    expect(compactCount(812)).toBe('812');
    expect(compactCount(1234)).toBe('1.2k');
    expect(compactCount(123_456)).toBe('123k');
    expect(compactCount(3_100_000)).toBe('3.1M');
    expect(compactCount(4_200_000_000)).toBe('4.2B');
  });
});

describe('usageColumns', () => {
  it('keeps the whole row inside the terminal at every width', () => {
    // Swept down to the one fixed column, the spend, with no excuse for
    // narrow widths: that is where the status board's budget broke, twice.
    for (const covered of [false, true]) {
      for (let width = USAGE_CELL.spent + 1; width <= 200; width += 1) {
        const c = usageColumns(width, covered);
        const total = c.label + USAGE_CELL.spent
          + (c.requests ? USAGE_CELL.requests : 0)
          + (c.tokens ? USAGE_CELL.tokens : 0)
          + (c.covered ? USAGE_CELL.covered : 0);
        expect(total).toBeLessThanOrEqual(width);
      }
    }
  });

  it('drops tokens, then requests, then covered, and never the spend', () => {
    expect(usageColumns(120, true)).toMatchObject({ requests: true, tokens: true, covered: true });
    expect(usageColumns(60, true)).toMatchObject({ requests: true, tokens: false, covered: true });
    // Covered outlives the count: an all-subscription bucket's spend is `—`.
    expect(usageColumns(45, true)).toMatchObject({ requests: false, tokens: false, covered: true });
    expect(usageColumns(25, true)).toMatchObject({ requests: false, tokens: false, covered: false });
  });

  it('shows no covered column when no work was covered', () => {
    expect(usageColumns(200, false).covered).toBe(false);
  });
});

describe('bucketsThatFit', () => {
  it('shows every bucket when there is room', () => {
    expect(bucketsThatFit(3, 24, 10)).toBe(3);
  });
  it('holds a line back for "N more" when there is not', () => {
    expect(bucketsThatFit(30, 24, 10)).toBe(13);
  });
  it('never shows nothing when there is something to show', () => {
    expect(bucketsThatFit(5, 4, 10)).toBe(1);
    expect(bucketsThatFit(0, 24, 10)).toBe(0);
  });
});

const tick = (ms = 50): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function row(over: Partial<LedgerRow> = {}): LedgerRow {
  return {
    ts: new Date().toISOString(), ms: 5,
    alias: 'sonata-code-simple', role: 'code', tier: 'simple',
    key: 'flash', gateway: 'acme', upstream: 'litellm',
    status: 200, complete: true, session: 's1', project: '/nowhere',
    tokens: { input: 1200, output: 80, cacheRead: 0, cacheCreation: 0 },
    price: { source: 'model', totalUsd: 0.5 }, attempts: [],
    ...over,
  };
}

describe('UsageScreen', () => {
  it('renders the report with its total and caveats, and d changes the breakdown', async () => {
    const home = mkdtempSync(join(tmpdir(), 'usage-screen-'));
    appendRow(home, row());
    appendRow(home, row({ key: 'terra', role: 'review', price: { source: 'none' } }));
    const app = render(React.createElement(ThemeProvider, null,
      React.createElement(UsageScreen, { cwd: home, home })));
    await tick(200);
    let frame = app.lastFrame() ?? '';
    expect(frame).toContain('every project');
    expect(frame).toContain('flash');
    expect(frame).toContain('$0.5000');
    // Unpriced volume is beside the total, never folded into it.
    expect(frame).toMatch(/unpriced\s+1 requests/);
    expect(frame).toContain('dispatch runs counted when they finish');

    app.stdin.write('d');
    await tick(200);
    frame = app.lastFrame() ?? '';
    expect(frame).toContain('by role');
    expect(frame).toContain('review');
    app.unmount();
  });

  it('scopes to this project on g, and says so when nothing is there', async () => {
    const home = mkdtempSync(join(tmpdir(), 'usage-screen-'));
    appendRow(home, row());
    const app = render(React.createElement(ThemeProvider, null,
      React.createElement(UsageScreen, { cwd: home, home })));
    await tick(200);
    app.stdin.write('g');
    await tick(200);
    const frame = app.lastFrame() ?? '';
    expect(frame).toContain('this project');
    expect(frame).toContain('Nothing routed from this project');
    app.unmount();
  });
});
