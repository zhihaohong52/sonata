import { describe, expect, it } from 'vitest';
import { autoRouteKeyRow, gatewaysMissingKeys, keyRows } from '../../src/tui-ink/screens/key-rows.js';

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

describe('autoRouteKeyRow', () => {
  it('reports a required credential as missing when there is none', () => {
    expect(autoRouteKeyRow('https://api.typesafe.ai', null)).toEqual({
      gateway: 'auto-route → api.typesafe.ai', source: 'no key', hasKey: false,
    });
    expect(autoRouteKeyRow('https://openrouter.ai/api', null).hasKey).toBe(false);
  });

  it('calls a loopback or self-hosted URL’s absence "no key needed", not a fault', () => {
    expect(autoRouteKeyRow('http://localhost:8000', null)).toEqual({
      gateway: 'auto-route → localhost', source: 'no key needed', hasKey: true,
    });
    expect(autoRouteKeyRow('https://decisions.example.com', null).hasKey).toBe(true);
    expect(gatewaysMissingKeys([autoRouteKeyRow('http://localhost:8000', null)])).toEqual([]);
    expect(gatewaysMissingKeys([autoRouteKeyRow('https://api.typesafe.ai', null)])).toEqual([
      'auto-route → api.typesafe.ai',
    ]);
  });

  it('names the host a key was filed under, whatever its source', () => {
    expect(autoRouteKeyRow('https://openrouter.ai/api', 'sonata store')).toEqual({
      gateway: 'auto-route → openrouter.ai', source: 'sonata store', hasKey: true,
    });
  });
});
