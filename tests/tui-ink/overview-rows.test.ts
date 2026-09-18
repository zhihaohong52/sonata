import { describe, it, expect } from 'vitest';
import { overviewRows, summarise } from '../../src/tui-ink/screens/overview-rows.js';

const check = (name: string, ok: boolean, detail = ''): { name: string; ok: boolean; detail: string } =>
  ({ name, ok, detail });

describe('overviewRows', () => {
  it('puts failures first, so the screen opens on what is wrong', () => {
    const rows = overviewRows([check('tmux', true), check('routing', false, 'not routed')]);
    expect(rows.map((r) => r.name)).toEqual(['routing', 'tmux']);
  });

  it('keeps the original order within failures and within passes', () => {
    // Stable, so a check a reader has learned the position of does not move
    // when an unrelated one starts failing.
    const rows = overviewRows([check('a', false), check('b', true), check('c', false), check('d', true)]);
    expect(rows.map((r) => r.name)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('carries each check detail through unchanged', () => {
    // The detail names the fix; a row that drops it sends the reader back to
    // the CLI, which is the flow this screen exists to replace.
    const rows = overviewRows([check('routing', false, 'run sonata route auto')]);
    expect(rows[0]!.detail).toBe('run sonata route auto');
  });
});

describe('summarise', () => {
  it('counts the warnings', () => {
    expect(summarise([check('a', false), check('b', true), check('c', false)])).toBe('2 warnings');
  });

  it('uses the singular for one', () => {
    expect(summarise([check('a', false), check('b', true)])).toBe('1 warning');
  });

  it('says so when everything passes', () => {
    expect(summarise([check('a', true)])).toBe('all checks pass');
  });

  it('says so when there is nothing to report', () => {
    // What a thrown cmdDoctor routes to. Claiming health from an absence of
    // results is the wrong direction to be wrong in.
    expect(summarise([])).toBe('no checks ran');
  });
});
