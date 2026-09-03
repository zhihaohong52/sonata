import { describe, it, expect } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION,
  SCHEMA_VERSION_KEY,
  applyMigrations,
  readSchemaVersion,
  type Migration,
} from '../src/migrations.js';
import { parseConfig } from '../src/config.js';
import { nativeTomlFor } from '../src/init/toml.js';

describe('readSchemaVersion', () => {
  it('treats an absent stamp as version 0, not an error', () => {
    // Every config written before this feature has no stamp; that is a real
    // version to migrate from, not a malformed file to refuse.
    expect(readSchemaVersion({})).toBe(0);
  });

  it('reads a present stamp', () => {
    expect(readSchemaVersion({ [SCHEMA_VERSION_KEY]: 3 })).toBe(3);
  });

  it('refuses a stamp that is present but not a non-negative integer', () => {
    // Silently reading these as 0 would migrate a file whose author believed
    // it was stamped — the failure would land somewhere far from the typo.
    for (const bad of ['two', 1.5, -1, true, null]) {
      expect(() => readSchemaVersion({ [SCHEMA_VERSION_KEY]: bad }))
        .toThrow(/schema_version must be a non-negative integer/);
    }
  });
});

describe('applyMigrations', () => {
  it('stamps an unstamped config at the current version without changing it', () => {
    const raw = { models: { a: { gateway: 'g', id: 'i' } } };
    expect(applyMigrations(raw)).toEqual({ ...raw, [SCHEMA_VERSION_KEY]: CURRENT_SCHEMA_VERSION });
  });

  it('is a no-op on a config already at the current version', () => {
    const raw = { [SCHEMA_VERSION_KEY]: CURRENT_SCHEMA_VERSION, models: {} };
    expect(applyMigrations(raw)).toEqual(raw);
  });

  it('refuses a config stamped newer than this sonata understands', () => {
    // Best-effort parsing of a future shape does not fail — it succeeds and
    // means something else, which is the failure mode worth refusing.
    expect(() => applyMigrations({ [SCHEMA_VERSION_KEY]: CURRENT_SCHEMA_VERSION + 1 }))
      .toThrow(new RegExp(`is ${CURRENT_SCHEMA_VERSION + 1}, but this sonata understands up to ${CURRENT_SCHEMA_VERSION}`));
  });

  it('composes a chain of steps in order, not just the first', () => {
    // The chain ships empty (v1 needs no transform), so composition is proven
    // against a synthetic chain rather than asserted about an empty list —
    // otherwise the first real migration would be the first one ever run.
    const chain: Migration[] = [
      { from: 0, to: 1, migrate: (raw) => ({ ...raw, steps: [...(raw.steps as string[] ?? []), 'zero-to-one'] }) },
      { from: 1, to: 2, migrate: (raw) => ({ ...raw, steps: [...(raw.steps as string[] ?? []), 'one-to-two'] }) },
    ];
    expect(applyMigrations({}, chain, 2)).toEqual({
      steps: ['zero-to-one', 'one-to-two'],
      [SCHEMA_VERSION_KEY]: 2,
    });
  });

  it('starts the chain at the stamped version, skipping steps already applied', () => {
    const chain: Migration[] = [
      { from: 0, to: 1, migrate: (raw) => ({ ...raw, ranSecond: false, ranFirst: true }) },
      { from: 1, to: 2, migrate: (raw) => ({ ...raw, ranSecond: true }) },
    ];
    expect(applyMigrations({ [SCHEMA_VERSION_KEY]: 1 }, chain, 2))
      .toEqual({ ranSecond: true, [SCHEMA_VERSION_KEY]: 2 });
  });

  it('advances past a version with no step rather than looping forever', () => {
    // v0 → v1 has no step by design. A `find` that returned undefined without
    // advancing would hang the load rather than fail it.
    expect(applyMigrations({}, [{ from: 1, to: 2, migrate: (raw) => ({ ...raw, hit: true }) }], 2))
      .toEqual({ hit: true, [SCHEMA_VERSION_KEY]: 2 });
  });
});

describe('parseConfig — schema version', () => {
  const body = [
    '[native.gateways."gw"]',
    'base_url = "https://gw.example/v1"',
    '',
    '[models."m"]',
    'gateway = "gw"',
    'id = "m"',
    'context_window = 128000',
    '',
    '[tiers.code]',
    'simple = ["m"]',
    'complex = ["m"]',
  ].join('\n');

  it('reports an unstamped config as version 0 while still loading it', () => {
    const config = parseConfig(body);
    expect(config.schemaVersion).toBe(0);
    expect(config.tiers?.code.simple).toEqual(['m']);
  });

  it('reports the on-disk version, not the migrated-to version', () => {
    // The whole point of recording it: migration is in-memory, so a config
    // that loaded fine can still be a file that needs rewriting.
    expect(parseConfig(`${SCHEMA_VERSION_KEY} = ${CURRENT_SCHEMA_VERSION}\n\n${body}`).schemaVersion)
      .toBe(CURRENT_SCHEMA_VERSION);
  });

  it('refuses a config from a newer sonata', () => {
    expect(() => parseConfig(`${SCHEMA_VERSION_KEY} = ${CURRENT_SCHEMA_VERSION + 1}\n\n${body}`))
      .toThrow(/upgrade sonata/);
  });
});

describe('nativeTomlFor — schema stamp', () => {
  const candidate = {
    key: 'gw-m', gateway: 'gw', id: 'm', baseUrl: 'https://gw.example/v1',
    auth: 'api-key' as const, contextWindow: 128000,
  };

  it('writes the current stamp, and the result parses back at that version', () => {
    const toml = nativeTomlFor({ code: [candidate] }, {}, { code: { simple: ['gw-m'], complex: ['gw-m'] } });
    expect(parseConfig(toml).schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('puts the stamp above every table header', () => {
    // A bare key after a table header belongs to that table — the same trap
    // avoid_gateways hit, where parseConfig then never saw the setting at all.
    const toml = nativeTomlFor({ code: [candidate] }, {}, { code: { simple: ['gw-m'], complex: ['gw-m'] } });
    expect(toml.indexOf(SCHEMA_VERSION_KEY)).toBeLessThan(toml.indexOf('['));
  });
});
