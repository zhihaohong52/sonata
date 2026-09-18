import { describe, it, expect } from 'vitest';
import { budgetToml } from '../../src/tui-ink/screens/budget-write.js';
import { parseConfig } from '../../src/config.js';

const base = [
  'schema_version = 1',
  '',
  '# a comment the user wrote',
  '[models."m1"]',
  'gateway = "gw"',
  'id = "x-1"',
  '',
  '[native.gateways."gw"]',
  'base_url = "https://example.test/v1"',
  '',
  '[tiers.code]',
  'simple = ["m1"]',
  'complex = ["m1"]',
  '',
].join('\n');

describe('budgetToml', () => {
  it('sets a cap on a config that had none', () => {
    expect(parseConfig(budgetToml(base, 25)).budget).toEqual({ dailyUsd: 25 });
  });

  it('replaces an existing cap without leaving a second table', () => {
    const out = budgetToml(budgetToml(base, 25), 50);
    expect(parseConfig(out).budget).toEqual({ dailyUsd: 50 });
    expect(out.match(/^\[budget\]$/gm)).toHaveLength(1);
  });

  it('removes the cap when given undefined', () => {
    // Not a zero: `costOf` charges an absent dimension at 0, so writing one
    // would turn "no cap" into a cap of $0 and refuse every request.
    const out = budgetToml(budgetToml(base, 25), undefined);
    expect(parseConfig(out).budget).toBeUndefined();
    expect(out).not.toContain('[budget]');
  });

  it('leaves every other byte alone', () => {
    // The whole reason this does not go through nativeTomlFor: a full rewrite
    // deletes what it cannot represent, which once un-priced a gateway.
    const out = budgetToml(base, 25);
    expect(out).toContain('# a comment the user wrote');
    expect(parseConfig(out).tiers?.code.simple).toEqual(['m1']);
    expect(parseConfig(out).unifiedModels?.m1?.id).toBe('x-1');
  });

  it('round-trips a no-op edit byte-identically', () => {
    // Opening a screen and confirming it unchanged must not alter the file.
    const withCap = budgetToml(base, 25);
    expect(budgetToml(withCap, 25)).toBe(withCap);
  });
});
