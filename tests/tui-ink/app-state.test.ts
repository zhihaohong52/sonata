import { describe, expect, it } from 'vitest';
import {
  applyStep,
  candidatesForProviders,
  providersForHarnesses,
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
