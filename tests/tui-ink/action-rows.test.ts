import { describe, it, expect } from 'vitest';
import { summariseCatalog } from '../../src/tui-ink/screens/action-rows.js';
import { summariseTiers } from '../../src/tui-ink/screens/models-rows.js';
import { gatewaysMissingKeys, keyRows } from '../../src/tui-ink/screens/key-rows.js';

describe('summariseCatalog', () => {
  it('names both sources when both succeed', () => {
    expect(summariseCatalog({ aa: { models: 141 }, modelsDev: { models: 900 } }))
      .toBe('rankings 141 models · prices 900 models');
  });

  it('reports a half that failed beside the half that did not', () => {
    // `cmdCatalogUpdate` returns each outcome rather than throwing, so one
    // source can fail while the other succeeds — a screen that only handled
    // the promise rejection could never report this case at all.
    expect(summariseCatalog({ aa: { error: new Error('no api key') }, modelsDev: { models: 900 } }))
      .toBe('rankings failed — no api key · prices 900 models');
  });

  it('reports both failures rather than the first', () => {
    // The two are not interchangeable — one supplies the ranking and the
    // other the prices — so "it failed" is not enough to act on.
    expect(summariseCatalog({ aa: { error: new Error('a') }, modelsDev: { error: new Error('b') } }))
      .toBe('rankings failed — a · prices failed — b');
  });
});

describe('summariseTiers', () => {
  it('groups roles that share a tier set', () => {
    // The real shape: a model is usually reachable at the same tiers across
    // every role, so twelve alias names collapse to one group.
    expect(summariseTiers([
      'code-simple', 'code-normal', 'code-complex',
      'review-simple', 'review-normal', 'review-complex',
    ])).toBe('simple, normal, complex (2 roles)');
  });

  it('names a single role rather than counting it', () => {
    expect(summariseTiers(['code-normal', 'code-complex'])).toBe('normal, complex (code)');
  });

  it('separates roles reachable at different tiers', () => {
    // The interesting case, and the reason to group rather than truncate:
    // an asymmetry between roles is what a reader is looking for here.
    expect(summariseTiers(['code-simple', 'review-complex']))
      .toBe('simple (code) · complex (review)');
  });

  it('orders tiers by escalation, not alphabetically', () => {
    // Alphabetical would read "complex, normal, simple" — backwards on the
    // one axis these names carry.
    expect(summariseTiers(['code-complex', 'code-simple', 'code-normal']))
      .toBe('simple, normal, complex (code)');
  });

  it('says so when nothing reaches the model', () => {
    expect(summariseTiers([])).toBe('no tier reaches it');
  });
});

describe('keyRows', () => {
  it('reads an OAuth gateway with no stored key as credentialed', () => {
    // `keyReport` answers null truthfully — there is no bearer in the store —
    // and a subscription gateway cannot have one. Reading that as "needs a
    // credential" flagged a working gateway and offered a fix that would not
    // have helped.
    const rows = keyRows([{ gateway: 'codex', auth: 'codex-oauth' }], [{ gateway: 'codex', source: null }]);
    expect(rows[0]).toEqual({ gateway: 'codex', source: 'codex subscription', hasKey: true });
    expect(gatewaysMissingKeys(rows)).toEqual([]);
  });

  it('still reports an api-key gateway with no key as missing one', () => {
    const rows = keyRows([{ gateway: 'acme', auth: 'api-key' }], [{ gateway: 'acme', source: null }]);
    expect(rows[0]!.hasKey).toBe(false);
    expect(gatewaysMissingKeys(rows)).toEqual(['acme']);
  });

  it('keeps a stored source over the auth kind', () => {
    // A key in the store is the stronger fact: it says where the credential
    // actually came from, which is what this screen exists to report.
    const rows = keyRows([{ gateway: 'codex', auth: 'codex-oauth' }], [{ gateway: 'codex', source: 'sonata' }]);
    expect(rows[0]!.source).toBe('sonata');
  });

  it('accepts bare gateway names, as callers with no config still pass', () => {
    expect(keyRows(['acme'], [{ gateway: 'acme', source: null }])[0]!.hasKey).toBe(false);
  });
});
