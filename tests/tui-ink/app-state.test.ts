import { describe, expect, it } from 'vitest';
import {
  alreadyImportedKeys,
  applyStep,
  byokProviderKey,
  byokProviderName,
  candidatesForProviders,
  mergeLiveCandidates,
  addProviderCatalog,
  configuredProviderNames,
  importableProviders,
  initialRankedFor,
  acceptRemainingTiers,
  importHint,
  validateCustomProviderName,
  validateProviderUrl,
  providersForHarnesses,
  reduceInit,
  tierPickerKeys,
  type CandidateOption,
  type ProviderOption,
} from '../../src/tui-ink/app-state.js';

describe('InitWizard state', () => {
  it('accumulates values from each step without clearing earlier selections', () => {
    let state = {};
    state = applyStep(state, 0, 'project');
    state = applyStep(state, 1, ['opencode-openai']);
    state = applyStep(state, 2, ['openai-gpt-5']);
    state = applyStep(state, 3, ['code', 'review']);

    expect(state).toEqual({
      configScope: 'project',
      providerKeys: ['opencode-openai'],
      nativeKeys: ['openai-gpt-5'],
      roles: ['code', 'review'],
    });
  });

  it('replaces only the field for a revisited step', () => {
    const initial = {
      configScope: 'project' as const,
      providerKeys: ['opencode-openai'],
      nativeKeys: ['openai-gpt-5'],
      roles: ['code'],
    };

    expect(applyStep(initial, 1, ['pi-openai'])).toEqual({
      ...initial,
      providerKeys: ['pi-openai'],
    });
  });

  it('accumulates per-role selections through a round-trip', () => {
    const code = applyStep({ nativeKeys: ['a', 'b'] }, 4, {
      role: 'code',
      models: ['a'],
    });
    const review = applyStep(code, 4, {
      role: 'review',
      models: ['b'],
    });
    const revisitedCode = applyStep(review, 4, {
      role: 'code',
      models: ['a', 'b'],
    });

    expect(revisitedCode).toEqual({
      nativeKeys: ['a', 'b'],
      perRoleModels: {
        code: ['a', 'b'],
        review: ['b'],
      },
    });
  });

  it('stores a tier ranking payload into state.tiers without disturbing other roles', () => {
    const codeSimple = applyStep({}, 4, { role: 'code', tier: 'simple', ranked: ['flash'] });
    const codeComplex = applyStep(codeSimple, 4, { role: 'code', tier: 'complex', ranked: ['terra', 'flash'] });
    const reviewSimple = applyStep(codeComplex, 4, { role: 'review', tier: 'simple', ranked: ['sol'] });

    expect(reviewSimple).toEqual({
      tiers: {
        code: { simple: ['flash'], complex: ['terra', 'flash'] },
        review: { simple: ['sol'], complex: [] },
      },
    });
  });

  it('filters providers by selected harnesses and candidates by selected providers', () => {
    const providers: ProviderOption[] = [
      { key: 'opencode-openai', harness: 'opencode', provider: 'openai', count: 2 },
      { key: 'pi-openai', harness: 'pi', provider: 'openai', count: 1 },
      { key: 'pi-anthropic', harness: 'pi', provider: 'anthropic', count: 1 },
    ];
    const candidates: CandidateOption[] = [
      { key: 'openai-gpt-5', gateway: 'openai', id: 'gpt-5', label: 'GPT-5' },
      { key: 'anthropic-claude', gateway: 'anthropic', id: 'claude', label: 'Claude' },
    ];

    const availableProviders = providersForHarnesses(providers, ['pi']);
    expect(availableProviders).toEqual([providers[1], providers[2]]);
    expect(candidatesForProviders(candidates, availableProviders, ['pi-anthropic'])).toEqual([
      candidates[1],
    ]);
  });
});

describe('BYOK providers', () => {
  const providers: ProviderOption[] = [
    { key: 'byok/deepseek', harness: 'byok', provider: 'deepseek', count: 0 },
    { key: 'config/moonshot', harness: 'config', provider: 'moonshot', count: 1 },
    { key: 'opencode-groq', harness: 'opencode', provider: 'groq', count: 3 },
  ];

  it('keeps byok providers when no harness is selected', () => {
    // The whole point of BYOK is the zero-harness case, so the harness filter
    // must not be what removes it.
    expect(providersForHarnesses(providers, []).map((p) => p.key))
      .toEqual(['byok/deepseek', 'config/moonshot']);
  });

  it('keeps byok providers alongside a selected harness', () => {
    expect(providersForHarnesses(providers, ['opencode']).map((p) => p.key))
      .toEqual(['byok/deepseek', 'config/moonshot', 'opencode-groq']);
  });

  it('round-trips the byok picker key', () => {
    expect(byokProviderKey('deepseek')).toBe('byok/deepseek');
    expect(byokProviderName('byok/deepseek')).toBe('deepseek');
    expect(byokProviderName('opencode-groq')).toBeUndefined();
  });

  it('records byok models into byokModels and nativeKeys', () => {
    const next = applyStep({ nativeKeys: ['a'] }, 5, {
      provider: 'deepseek',
      ids: ['deepseek-v4-flash'],
    });
    expect(next.byokModels).toEqual({ deepseek: ['deepseek-v4-flash'] });
    expect(next.nativeKeys).toEqual(['a', 'deepseek-deepseek-v4-flash']);
  });

  it('does not duplicate a key already in nativeKeys', () => {
    const next = applyStep(
      { nativeKeys: ['deepseek-deepseek-v4-flash'], byokModels: { deepseek: ['deepseek-v4-flash'] } },
      5,
      { provider: 'deepseek', ids: ['deepseek-v4-flash'] },
    );
    expect(next.nativeKeys).toEqual(['deepseek-deepseek-v4-flash']);
  });

  it('drops a deselected model on a revisit', () => {
    // Walking back into the step and unticking a model has to remove its key,
    // or the config is written with a model the user just removed.
    const first = applyStep({}, 5, { provider: 'deepseek', ids: ['a', 'b'] });
    const second = applyStep(first, 5, { provider: 'deepseek', ids: ['b'] });
    expect(second.byokModels).toEqual({ deepseek: ['b'] });
    expect(second.nativeKeys).toEqual(['deepseek-b']);
  });

  it('leaves another provider\'s models alone on a revisit', () => {
    let state = applyStep({}, 5, { provider: 'deepseek', ids: ['a'] });
    state = applyStep(state, 5, { provider: 'groq', ids: ['x'] });
    state = applyStep(state, 5, { provider: 'deepseek', ids: ['b'] });
    expect(state.nativeKeys).toEqual(['groq-x', 'deepseek-b']);
    expect(state.byokModels).toEqual({ deepseek: ['b'], groq: ['x'] });
  });
});

describe('importableProviders', () => {
  const providers: ProviderOption[] = [
    { key: 'opencode-openai', harness: 'opencode', provider: 'openai', count: 2 },
    { key: 'codex-codex', harness: 'codex', provider: 'codex', count: 1 },
    { key: 'byok/groq', harness: 'byok', provider: 'groq', count: 0 },
  ];

  it('keeps only providers with a detected codex or opencode credential', () => {
    const availability = {
      openai: { codex: { expiresInDays: 5 }, opencode: null, key: null, keyEntryAvailable: true },
      codex: { codex: null, opencode: null, key: null, keyEntryAvailable: true },
      groq: { codex: null, opencode: { expiresInDays: 3 }, key: null, keyEntryAvailable: true },
    };
    expect(importableProviders(providers, availability).map((p) => p.provider)).toEqual(['openai', 'groq']);
  });

  it('includes a provider already configured in this run — the list doubles as an unimport toggle', () => {
    const availability = {
      openai: { codex: { expiresInDays: 5 }, opencode: null, key: null, keyEntryAvailable: true },
      groq: { codex: null, opencode: { expiresInDays: 3 }, key: null, keyEntryAvailable: true },
    };
    expect(importableProviders(providers, availability).map((p) => p.provider)).toEqual(['openai', 'groq']);
  });

  it('is empty when nothing has a detected credential', () => {
    const availability = {
      openai: { codex: null, opencode: null, key: null, keyEntryAvailable: true },
    };
    expect(importableProviders(providers, availability)).toEqual([]);
  });

  it('includes a provider whose only credential is a plain API key', () => {
    const availability = {
      openai: { codex: null, opencode: null, key: { source: 'opencode' }, keyEntryAvailable: true },
      codex: { codex: null, opencode: null, key: null, keyEntryAvailable: true },
      groq: { codex: null, opencode: null, key: null, keyEntryAvailable: true },
    };
    expect(importableProviders(providers, availability).map((p) => p.provider)).toEqual(['openai']);
  });

  it('dedupes by provider name across multiple harness entries', () => {
    const dup: ProviderOption[] = [
      { key: 'opencode-openai', harness: 'opencode', provider: 'openai', count: 2 },
      { key: 'pi-openai', harness: 'pi', provider: 'openai', count: 1 },
    ];
    const availability = { openai: { codex: { expiresInDays: 5 }, opencode: null, key: null, keyEntryAvailable: true } };
    expect(importableProviders(dup, availability).map((p) => p.key)).toEqual(['opencode-openai']);
  });
});

describe('addProviderCatalog', () => {
  const providers: ProviderOption[] = [
    { key: 'opencode-openai', harness: 'opencode', provider: 'openai', count: 2 },
    { key: 'codex-codex', harness: 'codex', provider: 'codex', count: 1 },
    { key: 'byok/groq', harness: 'byok', provider: 'groq', count: 0 },
  ];

  it('excludes already-configured gateways', () => {
    expect(addProviderCatalog(providers, ['openai']).map((p) => p.provider)).toEqual(['codex', 'groq']);
  });

  it('dedupes by provider name and sorts alphabetically', () => {
    const dup: ProviderOption[] = [...providers, { key: 'pi-openai', harness: 'pi', provider: 'openai', count: 3 }];
    expect(addProviderCatalog(dup, []).map((p) => p.provider)).toEqual(['codex', 'groq', 'openai']);
  });
});

describe('configuredProviderNames', () => {
  const providers: ProviderOption[] = [
    { key: 'opencode-openai', harness: 'opencode', provider: 'openai', count: 2 },
  ];

  it('resolves a catalogued key through the provider list', () => {
    expect(configuredProviderNames(['opencode-openai'], providers)).toEqual(['openai']);
  });

  it('resolves a byok/custom key through byokProviderName', () => {
    expect(configuredProviderNames(['byok/my-proxy'], providers)).toEqual(['my-proxy']);
  });

  it('drops a key matching neither', () => {
    expect(configuredProviderNames(['config/ghost'], providers)).toEqual([]);
  });
});

describe('alreadyImportedKeys', () => {
  // Two harnesses can list the same provider NAME — a hand-configured or
  // opencode-imported "google" gateway, and Pi's own catalogue also
  // offering "google" as a separate importable row with a different key.
  const importable: ProviderOption[] = [
    { key: 'opencode/google', harness: 'opencode', provider: 'google', count: 1 },
    { key: 'pi/google', harness: 'pi', provider: 'google', count: 1 },
  ];

  it('pre-ticks only the row whose exact key is stored, not every same-named row', () => {
    // The bug this exists for: matching by provider name alone (as
    // `configuredProviderNames` does, for other callers where that is the
    // right question) pre-ticked Pi's row too, even though only opencode's
    // key was ever stored — reappearing on every wizard run with no way to
    // make it stick unticked.
    expect(alreadyImportedKeys(['opencode/google'], importable)).toEqual(new Set(['opencode/google']));
  });

  it('pre-ticks nothing when the stored key belongs to a harness not shown here', () => {
    expect(alreadyImportedKeys(['config/google'], importable)).toEqual(new Set());
  });

  it('pre-ticks both rows when both keys are genuinely stored', () => {
    expect(alreadyImportedKeys(['opencode/google', 'pi/google'], importable)).toEqual(
      new Set(['opencode/google', 'pi/google']),
    );
  });
});

describe('validateCustomProviderName', () => {
  it('requires a non-empty name', () => {
    expect(validateCustomProviderName('  ', [])).toMatch(/required/);
  });

  it('rejects a name colliding case-insensitively with an existing provider', () => {
    expect(validateCustomProviderName('OpenAI', ['openai'])).toMatch(/already a provider/);
  });

  it('accepts a unique name', () => {
    expect(validateCustomProviderName('my-proxy', ['openai', 'codex'])).toBeUndefined();
  });
});

describe('validateProviderUrl', () => {
  it('requires a non-empty URL', () => {
    expect(validateProviderUrl('')).toMatch(/required/);
  });

  it('rejects a non-URL string', () => {
    expect(validateProviderUrl('not a url')).toMatch(/https:\/\//);
  });

  it('rejects a non-http(s) scheme', () => {
    expect(validateProviderUrl('ftp://example.com')).toMatch(/http:\/\/ or https:\/\//);
  });

  it('accepts a well-formed https URL', () => {
    expect(validateProviderUrl('https://example.com/v1')).toBeUndefined();
  });
});

describe('tierPickerKeys', () => {
  it('keeps native keys in order when nothing is missing', () => {
    expect(tierPickerKeys(['a', 'b'], ['b', 'a'])).toEqual(['a', 'b']);
  });

  it('appends a saved ranking key that has no native route, so it survives a no-op confirm', () => {
    // RankedSelect's initialIndices silently drops any initialRanked value
    // missing from items — a harness-only fallback preserved in state.tiers
    // but absent from nativeKeys must still appear here or merely confirming
    // the screen would rewrite the tier without it.
    expect(tierPickerKeys(['a', 'b'], ['harness-only', 'a'])).toEqual(['a', 'b', 'harness-only']);
  });

  it('is empty when there are no native keys and nothing saved', () => {
    expect(tierPickerKeys([], [])).toEqual([]);
  });

  it('does not resurrect a natively-routable key the user deselected this session', () => {
    // The harness-only preservation above must not overcorrect: a key that
    // DOES have a native route (present in the full candidate universe) but
    // isn't in the freshly-selected nativeKeys was deliberately dropped by
    // the user this run (e.g. its provider was deselected) and must not come
    // back just because an old saved tier list still names it.
    expect(tierPickerKeys(['a'], ['a', 'removed-model'], ['a', 'removed-model'])).toEqual(['a']);
  });
});

describe('mergeLiveCandidates', () => {
  const candidates: CandidateOption[] = [
    { key: 'acme-old-model', gateway: 'acme', id: 'old-model', label: 'acme/old-model' },
    { key: 'acme-kept', gateway: 'acme', id: 'kept', label: 'acme/kept' },
    { key: 'other-x', gateway: 'other', id: 'x', label: 'other/x' },
  ];

  it('retires a model the gateway no longer serves', () => {
    const merged = mergeLiveCandidates(candidates, { acme: ['kept'] });
    expect(merged.map((c) => c.key)).toEqual(['acme-kept', 'other-x']);
  });

  it('keeps the existing key for a model the harness already listed', () => {
    // The key addresses nativeKeys and the written config: minting a new one
    // would silently deselect a model the user had already chosen.
    const merged = mergeLiveCandidates(candidates, { acme: ['kept'] });
    expect(merged.find((c) => c.id === 'kept')!.key).toBe('acme-kept');
  });

  it('adds a model the harness catalogue had not caught up to', () => {
    const merged = mergeLiveCandidates(candidates, { acme: ['kept', 'brand-new'] });
    expect(merged.find((c) => c.id === 'brand-new')).toEqual({
      key: 'acme-brand-new', gateway: 'acme', id: 'brand-new', label: 'acme/brand-new',
    });
  });

  it('leaves a gateway that did not answer entirely untouched', () => {
    const merged = mergeLiveCandidates(candidates, { acme: ['kept'] });
    expect(merged.filter((c) => c.gateway === 'other')).toEqual([candidates[2]]);
  });

  it('is a no-op when nothing was refreshed', () => {
    expect(mergeLiveCandidates(candidates, {})).toEqual(candidates);
  });

  it('emits a refreshed gateway where it first appeared, not at the end', () => {
    const merged = mergeLiveCandidates(candidates, { acme: ['kept'] });
    expect(merged[0]!.gateway).toBe('acme');
  });

  it('contributes models for a gateway the harness listed nothing for', () => {
    const merged = mergeLiveCandidates(candidates, { fresh: ['a'] });
    expect(merged.map((c) => c.key)).toContain('fresh-a');
  });
});

describe('importHint', () => {
  const noCred = { codex: null, opencode: null, key: null, keyEntryAvailable: true };

  it('names the harness that catalogued the provider, not just the credential', () => {
    // Two different "where from"s meet on this row: the harness whose
    // catalogue produced the provider, and where its credential lives.
    expect(importHint('opencode', { ...noCred, key: { source: 'sonata' } }))
      .toBe('via opencode · key from sonata');
  });

  it('reports OAuth expiry alongside the harness', () => {
    expect(importHint('codex', { ...noCred, codex: { expiresInDays: 7 } }))
      .toBe('via codex · expires in 7d');
  });

  it('calls out an expired credential and where to fix it', () => {
    expect(importHint('codex', { ...noCred, codex: { expiresInDays: -1 } }))
      .toBe('via codex · expired — re-login in that tool');
  });

  it('says so when an expiry is unknown', () => {
    expect(importHint('opencode', { ...noCred, opencode: { expiresInDays: null } }))
      .toBe('via opencode · expiry unknown');
  });
});

describe('acceptRemainingTiers', () => {
  const roles = ['review', 'code'];
  const proposal = { simple: ['cheap', 'mid'], complex: ['mid', 'cheap'] };

  it('fills every remaining role and tier, so the summary is reachable in one keypress', () => {
    const state = acceptRemainingTiers({ roles }, roles, 0, proposal);
    expect(state.tiers).toEqual({
      review: { simple: ['cheap', 'mid'], complex: ['mid', 'cheap'] },
      code: { simple: ['cheap', 'mid'], complex: ['mid', 'cheap'] },
    });
  });

  it('leaves screens before the start index untouched', () => {
    // The caller has already applied the current screen with whatever the user
    // ranked on it; accepting the rest must not overwrite that with the seed.
    const ranked = { roles, tiers: { review: { simple: ['mid'], complex: [] } } };
    const state = acceptRemainingTiers(ranked, roles, 1, proposal);
    expect(state.tiers?.review.simple).toEqual(['mid']);
  });

  it('keeps a ranking already saved for a later role rather than resetting it to the proposal', () => {
    const saved = { roles, tiers: { code: { simple: ['mid'], complex: ['cheap'] } } };
    const state = acceptRemainingTiers(saved, roles, 0, proposal);
    expect(state.tiers?.code).toEqual({ simple: ['mid'], complex: ['cheap'] });
  });

  it('is indistinguishable from pressing enter through every remaining screen', () => {
    // The guarantee that makes the shortcut safe to offer at all.
    let stepped: ReturnType<typeof applyStep> = { roles };
    for (let index = 0; index < roles.length * 2; index++) {
      const role = roles[Math.floor(index / 2)];
      const tier = index % 2 === 0 ? 'simple' : 'complex';
      stepped = applyStep(stepped, 4, {
        role, tier, ranked: initialRankedFor(stepped.tiers?.[role]?.[tier], proposal[tier]),
      });
    }
    expect(acceptRemainingTiers({ roles }, roles, 0, proposal)).toEqual(stepped);
  });
});

describe('initialRankedFor', () => {
  it('falls back to the proposal for a tier saved as an empty list', () => {
    // Regression: applyStep seeds a role's other tier as [] the moment either
    // is confirmed, so `saved ?? proposal` kept [] and the second tier screen
    // of every role rendered unranked — and RankedSelect refuses to submit an
    // empty ranking, so the wizard could not be advanced at all.
    expect(initialRankedFor([], ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('falls back to the proposal when nothing is saved', () => {
    expect(initialRankedFor(undefined, ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('keeps a real saved ranking over the proposal', () => {
    // A ranking the user actually chose must never be silently re-proposed.
    expect(initialRankedFor(['b'], ['a', 'b'])).toEqual(['b']);
  });
});
