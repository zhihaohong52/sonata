import { describe, it, expect } from 'vitest';
import { overviewRows, summarise } from '../../src/tui-ink/screens/overview-rows.js';

const check = (name: string, ok: boolean, detail = ''): { name: string; ok: boolean; detail: string } =>
  ({ name, ok, detail });

describe('overviewRows', () => {
  it('shows only what is wrong', () => {
    // A passing check is reassurance, not information, and a wall of it is
    // where the one row that matters goes to hide. `sonata doctor` still
    // prints everything; this is a screen someone glances at.
    const rows = overviewRows([check('tmux', true), check('routing', false, 'not routed')]);
    expect(rows.map((r) => r.name)).toEqual(['routing']);
  });

  it('keeps doctor\'s own order among the failures', () => {
    // Failures were once sorted above the passes. With the passes gone there
    // is nothing to sort them above, and doctor groups related checks — an
    // order a re-sort would discard.
    const rows = overviewRows([check('a', false), check('b', true), check('c', false), check('d', true)]);
    expect(rows.map((r) => r.name)).toEqual(['a', 'c']);
  });

  it('draws nothing at all on a healthy machine', () => {
    expect(overviewRows([check('a', true), check('b', true)])).toEqual([]);
  });

  it('carries each check detail through unchanged', () => {
    // The detail names the fix; a row that drops it sends the reader back to
    // the CLI, which is the flow this screen exists to replace.
    const rows = overviewRows([check('routing', false, 'run sonata route auto')]);
    expect(rows[0]!.detail).toBe('run sonata route auto');
  });
});

describe('summarise', () => {
  it('says how many of how many need attention', () => {
    // The denominator matters now that passing rows are not drawn: "2 of 14"
    // tells a reader the check ran and most of it is fine, where a bare "2
    // warnings" beside an otherwise empty screen reads as a partial result.
    expect(summarise([check('a', false), check('b', true), check('c', false)]))
      .toBe('2 of 3 checks need attention');
  });

  it('reports the count that passed when nothing is wrong', () => {
    expect(summarise([check('a', true), check('b', true)])).toBe('2 checks pass');
  });

  it('says so when there is nothing to report', () => {
    // What a thrown cmdDoctor routes to. Claiming health from an absence of
    // results is the wrong direction to be wrong in.
    expect(summarise([])).toBe('no checks ran');
  });
});
