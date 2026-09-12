import { describe, expect, it } from 'vitest';
import { knownCandidates } from '../../src/tui-ink/app-state.js';
import { byokCandidateKey } from '../../src/native/models.js';
import { proposeTiers } from '../../src/catalog.js';
import type { CandidateOption } from '../../src/tui-ink/app-state.js';

const startup: CandidateOption[] = [
  { key: 'acme-fast', gateway: 'acme', id: 'fast', label: 'acme/fast' },
];

describe('knownCandidates', () => {
  // `data.candidates` is `allNativeCandidates`, computed once at startup, so a
  // provider added in the wizard is missing from it. Every consumer that
  // derived gateway names from it therefore could not recover the upstream id
  // of a run-added model — and a model whose id cannot be recovered misses its
  // catalog entry entirely.
  it('includes a BYOK provider added this run', () => {
    const out = knownCandidates(startup, { byokModels: { mylab: ['gpt-5.6-luna'] } });
    expect(out.map((c) => c.gateway)).toContain('mylab');
    expect(out.map((c) => c.key)).toContain(byokCandidateKey('mylab', 'gpt-5.6-luna'));
  });

  it('includes a model only the gateway’s own /models answer knew about', () => {
    const out = knownCandidates(startup, { liveModels: { acme: ['fast', 'brand-new'] } });
    expect(out.map((c) => c.id)).toContain('brand-new');
  });

  it('keeps the startup candidates', () => {
    expect(knownCandidates(startup, {}).map((c) => c.key)).toContain('acme-fast');
  });

  // A live refresh replaces a gateway's list, and the same model can arrive
  // from both sources; a duplicated key would be written to the config twice.
  it('never emits the same key twice', () => {
    const out = knownCandidates(startup, {
      liveModels: { acme: ['fast'] },
      byokModels: { acme: ['fast'] },
    });
    expect(out.filter((c) => c.key === 'acme-fast')).toHaveLength(1);
  });

  it('is just the startup set when nothing was added', () => {
    expect(knownCandidates(startup, {})).toHaveLength(1);
  });
});

describe('ranking a model added by key', () => {
  // The reported symptom: "adding models by key doesn't get ranked
  // automatically". Measured — without its gateway name, `mylab-gpt-5.6-luna`
  // normalizes to itself, misses the catalog, scores as the `default` entry
  // (capable, *not* cheap), and `proposeTiers`' fallback makes simple mirror
  // complex, so the tier stops discriminating at all.
  const keys = ['mylab-gpt-5.6-luna', 'acme-fast'];

  it('discriminates the tiers once the gateway name is recoverable', () => {
    const state = { byokModels: { mylab: ['gpt-5.6-luna'] } };
    const gateways = [...new Set(knownCandidates(startup, state).map((c) => c.gateway))];
    const ranked = proposeTiers(keys, undefined, gateways, new Set());
    expect(ranked.simple).not.toEqual(ranked.complex);
  });

  it('collapses when the gateway name is missing — the bug this fixes', () => {
    const stale = [...new Set(startup.map((c) => c.gateway))];
    const ranked = proposeTiers(keys, undefined, stale, new Set());
    expect(ranked.simple).toEqual(ranked.complex);
  });
});
