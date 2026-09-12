import { describe, it, expect } from 'vitest';
import { replaceTiersBlock } from '../../src/init/toml.js';
import { parseConfig } from '../../src/config.js';

const config = [
  'schema_version = 1',
  'avoid_gateways = ["flaky"]',
  '',
  '[native.gateways."acme"]',
  'base_url = "https://acme.example/v1"',
  'pricing_provider = ["openrouter"]',
  '',
  '[native.gateways."acme".price]',
  'input = 1.5',
  'output = 3',
  '',
  '[native.gateways."flaky"]',
  'base_url = "https://flaky.example/v1"',
  '',
  '[models."acme-fast"]',
  'gateway = "acme"',
  'id = "fast"',
  'context_window = 1000000',
  '',
  '[models."acme-slow"]',
  'gateway = "acme"',
  'id = "slow"',
  'context_window = 128000',
  '',
  '[tiers.code]',
  'simple = ["acme-fast"]',
  'complex = ["acme-fast", "acme-slow"]',
  '',
  '[tiers.review]',
  'simple = ["acme-slow"]',
  'complex = ["acme-slow"]',
  '',
  '[run]',
  'tail_window_seconds = 20',
  '',
].join('\n');

describe('replaceTiersBlock', () => {
  it('writes the new ranking', () => {
    const next = replaceTiersBlock(config, {
      code: { simple: ['acme-slow'], complex: ['acme-fast'] },
      review: { simple: ['acme-slow'], complex: ['acme-slow'] },
    });
    expect(parseConfig(next).tiers?.code).toEqual({ simple: ['acme-slow'], complex: ['acme-fast'] });
  });

  // The whole reason this edits text rather than round-tripping through
  // `nativeTomlFor`: everything it does not replace is preserved by
  // construction, rather than by a list of fields kept in step with the parser.
  it('preserves every other setting, including the ones a rewrite has dropped before', () => {
    const before = parseConfig(config);
    const after = parseConfig(replaceTiersBlock(config, {
      code: { simple: ['acme-slow'], complex: ['acme-slow'] },
      review: { simple: ['acme-fast'], complex: ['acme-fast'] },
    }));
    expect(after.native?.gateways?.acme.pricingProvider).toEqual(['openrouter']);
    expect(after.native?.gateways?.acme.price).toEqual(before.native?.gateways?.acme.price);
    expect(after.avoidGateways).toEqual(['flaky']);
    expect(after.unifiedModels).toEqual(before.unifiedModels);
    expect(after.run).toEqual(before.run);
  });

  it('leaves the bytes outside [tiers] untouched', () => {
    const next = replaceTiersBlock(config, {
      code: { simple: ['acme-fast'], complex: ['acme-fast', 'acme-slow'] },
      review: { simple: ['acme-slow'], complex: ['acme-slow'] },
    });
    // Same tiers back in: only the formatting of the block itself may differ,
    // so everything before and after it must survive verbatim.
    expect(next.split('[tiers.')[0]).toBe(config.split('[tiers.')[0]);
    expect(next.slice(next.indexOf('[run]'))).toBe(config.slice(config.indexOf('[run]')));
  });

  it('drops a role that is no longer tiered', () => {
    const next = replaceTiersBlock(config, { code: { simple: ['acme-fast'], complex: ['acme-fast'] } });
    expect(Object.keys(parseConfig(next).tiers ?? {})).toEqual(['code']);
  });

  it('appends when the config has no [tiers] yet, without capturing another table\'s keys', () => {
    const bare = ['schema_version = 1', '', '[models."acme-fast"]', 'gateway = "acme"', 'id = "fast"', '',
      '[native.gateways."acme"]', 'base_url = "https://acme.example/v1"', ''].join('\n');
    const next = replaceTiersBlock(bare, { code: { simple: ['acme-fast'], complex: ['acme-fast'] } });
    const parsed = parseConfig(next);
    expect(parsed.tiers?.code.simple).toEqual(['acme-fast']);
    expect(parsed.native?.gateways?.acme.baseUrl).toBe('https://acme.example/v1');
  });

  // A multiline string can hold a line that looks like a table header. Read as
  // structure, it starts a drop and the replacement is spliced into the middle
  // of the string — `parseConfig` then refuses the result, so the visible
  // symptom is being unable to save at all.
  it('does not read a table header inside a multiline string as structure', () => {
    const withString = config.replace('[run]', [
      '[models."acme-big"]',
      'gateway = "acme"',
      'id = "big"',
      'notes = """',
      '[tiers.code] used to list acme-fast first — kept here as a note',
      '"""',
      '',
      '[run]',
    ].join('\n'));
    const next = replaceTiersBlock(withString, { code: { simple: ['acme-fast'], complex: ['acme-fast'] } });
    expect(next).toContain('[tiers.code] used to list acme-fast first — kept here as a note');
    expect(parseConfig(next).unifiedModels['acme-big'].id).toBe('big');
    expect(parseConfig(next).tiers?.code.simple).toEqual(['acme-fast']);
  });

  // `["tiers".code]` names the same table as `[tiers.code]`. Missed, the new
  // block defines it a second time and TOML refuses a redefined table.
  it('replaces a tier table whose segment is quoted', () => {
    const quoted = config.replace('[tiers.code]', '["tiers".code]');
    const next = replaceTiersBlock(quoted, {
      code: { simple: ['acme-fast'], complex: ['acme-fast'] },
      review: { simple: ['acme-slow'], complex: ['acme-slow'] },
    });
    expect(next).not.toContain('["tiers".code]');
    expect(parseConfig(next).tiers?.code.simple).toEqual(['acme-fast']);
  });

  it('is idempotent — replacing with what is already there parses back the same', () => {
    const same = replaceTiersBlock(config, parseConfig(config).tiers!);
    expect(parseConfig(same).tiers).toEqual(parseConfig(config).tiers);
    expect(replaceTiersBlock(same, parseConfig(same).tiers!)).toBe(same);
  });
});
