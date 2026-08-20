import { describe, expect, it } from 'vitest';
import {
  applyStep,
  candidatesForProviders,
  providersForHarnesses,
} from '../../src/tui-ink/app-state.js';

describe('InitWizard state', () => {
  it('accumulates step values without clearing earlier selections', () => {
    let state = applyStep({}, 0, 'project');
    state = applyStep(state, 1, ['opencode']);
    state = applyStep(state, 2, ['openrouter']);
    state = applyStep(state, 3, ['deepseek']);
    state = applyStep(state, 4, ['code', 'review']);

    expect(state).toEqual({
      configScope: 'project',
      harnesses: ['opencode'],
      providerKeys: ['openrouter'],
      nativeKeys: ['deepseek'],
      roles: ['code', 'review'],
    });
  });

  it('replaces only the revisited step field', () => {
    const state = applyStep({
      configScope: 'project',
      harnesses: ['opencode'],
      providerKeys: ['openrouter'],
      nativeKeys: ['first'],
      roles: ['code'],
    }, 3, ['second']);

    expect(state).toEqual({
      configScope: 'project',
      harnesses: ['opencode'],
      providerKeys: ['openrouter'],
      nativeKeys: ['second'],
      roles: ['code'],
    });
  });

  it('accumulates per-role models and retains them through a round-trip', () => {
    let state = applyStep({ nativeKeys: ['a', 'b'], perRoleModels: { code: ['a'] } }, 5, { role: 'review', models: ['b'] });
    state = applyStep(state, 5, { role: 'code', models: ['a', 'b'] });

    expect(state.perRoleModels).toEqual({ code: ['a', 'b'], review: ['b'] });
    expect(state.nativeKeys).toEqual(['a', 'b']);
  });

  it('filters providers by selected harnesses and candidates by selected provider gateways', () => {
    const providers = [
      { key: 'openrouter', harness: 'opencode', provider: 'openrouter', count: 2 },
      { key: 'openai', harness: 'pi', provider: 'openai', count: 1 },
      { key: 'codex', harness: 'codex', provider: 'codex', count: 1 },
    ];
    const candidates = [
      { key: 'one', gateway: 'openrouter', id: 'one', label: 'One' },
      { key: 'two', gateway: 'openai', id: 'two', label: 'Two' },
      { key: 'three', gateway: 'codex', id: 'three', label: 'Three' },
    ];

    const filteredProviders = providersForHarnesses(providers, ['opencode', 'pi']);
    expect(filteredProviders.map((provider) => provider.key)).toEqual(['openrouter', 'openai']);
    expect(candidatesForProviders(candidates, filteredProviders, ['openai']).map((candidate) => candidate.key)).toEqual(['two']);
  });
});
