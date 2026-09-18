import { describe, expect, it } from 'vitest';
import { gatewaysMissingKeys, keyRows } from '../../src/tui-ink/screens/key-rows.js';

describe('keyRows', () => {
  it('preserves source names and marks credentials', () => {
    expect(keyRows(['alpha'], [{ gateway: 'alpha', source: 'sonata store' }])).toEqual([
      { gateway: 'alpha', source: 'sonata store', hasKey: true },
    ]);
  });

  it('labels missing credentials without exposing values', () => {
    const rows = keyRows(
      ['alpha', 'beta'],
      [{ gateway: 'alpha', source: 'keychain' }, { gateway: 'beta', source: null }],
    );
    expect(rows[1]).toEqual({ gateway: 'beta', source: 'no key', hasKey: false });
    expect(rows.every((row) => Object.keys(row).sort().join(',') === 'gateway,hasKey,source')).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('sk-secret-looking-value');
  });

  it('keeps gateway order and reports only missing keys', () => {
    const rows = keyRows(
      ['third', 'first', 'second'],
      [{ gateway: 'first', source: 'store' }, { gateway: 'second', source: null }, { gateway: 'third', source: null }],
    );
    expect(rows.map((row) => row.gateway)).toEqual(['third', 'first', 'second']);
    expect(gatewaysMissingKeys(rows)).toEqual(['third', 'second']);
  });
});
