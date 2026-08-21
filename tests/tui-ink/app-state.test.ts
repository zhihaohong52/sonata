import { describe, expect, it } from 'vitest';
import {
  applyStep,
  byokProviderKey,
  byokProviderName,
  candidatesForProviders,
  credentialRowsFor,
  providersForHarnesses,
  reduceInit,
  type CandidateOption,
  type ProviderOption,
} from '../../src/tui-ink/app-state.js';

describe('InitWizard state', () => {
  it('accumulates values from each step without clearing earlier selections', () => {
    let state = {};
    state = applyStep(state, 0, 'project');
    state = applyStep(state, 1, ['opencode', 'pi']);
    state = applyStep(state, 2, ['opencode-openai']);
    state = applyStep(state, 3, ['openai-gpt-5']);
    state = applyStep(state, 4, ['code', 'review']);

    expect(state).toEqual({
      configScope: 'project',
      harnesses: ['opencode', 'pi'],
      providerKeys: ['opencode-openai'],
      nativeKeys: ['openai-gpt-5'],
      roles: ['code', 'review'],
    });
  });

  it('replaces only the field for a revisited step', () => {
    const initial = {
      configScope: 'project' as const,
      harnesses: ['opencode'],
      providerKeys: ['opencode-openai'],
      nativeKeys: ['openai-gpt-5'],
      roles: ['code'],
    };

    expect(applyStep(initial, 1, ['pi'])).toEqual({
      ...initial,
      harnesses: ['pi'],
    });
  });

  it('accumulates per-role selections through a round-trip', () => {
    const code = applyStep({ nativeKeys: ['a', 'b'] }, 5, {
      role: 'code',
      models: ['a'],
    });
    const review = applyStep(code, 5, {
      role: 'review',
      models: ['b'],
    });
    const revisitedCode = applyStep(review, 5, {
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
    const next = applyStep({ nativeKeys: ['a'] }, 6, {
      provider: 'deepseek',
      ids: ['deepseek-v4-flash'],
    });
    expect(next.byokModels).toEqual({ deepseek: ['deepseek-v4-flash'] });
    expect(next.nativeKeys).toEqual(['a', 'deepseek-deepseek-v4-flash']);
  });

  it('does not duplicate a key already in nativeKeys', () => {
    const next = applyStep(
      { nativeKeys: ['deepseek-deepseek-v4-flash'], byokModels: { deepseek: ['deepseek-v4-flash'] } },
      6,
      { provider: 'deepseek', ids: ['deepseek-v4-flash'] },
    );
    expect(next.nativeKeys).toEqual(['deepseek-deepseek-v4-flash']);
  });

  it('drops a deselected model on a revisit', () => {
    // Walking back into the step and unticking a model has to remove its key,
    // or the config is written with a model the user just removed.
    const first = applyStep({}, 6, { provider: 'deepseek', ids: ['a', 'b'] });
    const second = applyStep(first, 6, { provider: 'deepseek', ids: ['b'] });
    expect(second.byokModels).toEqual({ deepseek: ['b'] });
    expect(second.nativeKeys).toEqual(['deepseek-b']);
  });

  it('leaves another provider\'s models alone on a revisit', () => {
    let state = applyStep({}, 6, { provider: 'deepseek', ids: ['a'] });
    state = applyStep(state, 6, { provider: 'groq', ids: ['x'] });
    state = applyStep(state, 6, { provider: 'deepseek', ids: ['b'] });
    expect(state.nativeKeys).toEqual(['groq-x', 'deepseek-b']);
    expect(state.byokModels).toEqual({ deepseek: ['b'], groq: ['x'] });
  });
});

describe('credential source step', () => {
  it('always offers login and api-key, even with no harness credentials', () => {
    const rows = credentialRowsFor('openai', { codex: null, opencode: null, key: null });
    expect(rows.map((r) => r.source)).toEqual(['sonata', 'sonata-key']);
  });

  it('adds an import row only when that credential exists', () => {
    const rows = credentialRowsFor('openai', { codex: { expiresInDays: 6 }, opencode: null, key: null });
    expect(rows.map((r) => r.source)).toContain('codex');
    expect(rows.find((r) => r.source === 'codex')!.detail).toContain('6d');
  });

  it('lists an unhealthy credential with its problem rather than hiding it', () => {
    // "codex has one but it expired" is the answer to a question the user is
    // about to ask.
    const rows = credentialRowsFor('openai', { codex: { expiresInDays: -1 }, opencode: null, key: null });
    expect(rows.find((r) => r.source === 'codex')!.detail).toMatch(/expired/);
  });

  it('distinguishes an unknown expiry from an imminent expiration', () => {
    const rows = credentialRowsFor('openai', { codex: { expiresInDays: null }, opencode: null, key: null });
    expect(rows.find((r) => r.source === 'codex')!.detail).toBe('expiry unknown');
  });

  it('records the chosen source in state and allows going back', () => {
    let state = reduceInit({ step: 3, state: {} }, { type: 'chooseCredentialSource', gateway: 'openai', source: 'codex' });
    expect(state.state.credentialSources).toEqual({ openai: 'codex' });
    state = reduceInit(state, { type: 'back' });
    expect(state.step).toBe(2);
  });
});
