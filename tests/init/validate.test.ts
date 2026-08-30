import { describe, it, expect } from 'vitest';
import { validate } from '../../src/init/validate.js';
import type { InitEnvironment } from '../../src/init/discover.js';
import type { InitState } from '../../src/tui-ink/types.js';
import { byokProviderKey } from '../../src/tui-ink/app-state.js';

function makeEnv(overrides: Partial<InitEnvironment> = {}): InitEnvironment {
  return {
    cwd: '/tmp/test',
    home: '/home/test',
    tmux: { installed: true, version: '3.4', problems: [] },
    harnesses: [],
    problems: [],
    offered: [
      { harness: 'opencode', provider: 'openrouter', key: 'opencode/openrouter', count: 5 },
      { harness: 'opencode', provider: 'deepseek', key: 'opencode/deepseek', count: 3 },
    ],
    allNativeCandidates: [
      { key: 'openrouter-kimi-k3', gateway: 'openrouter', id: 'kimi-k3', contextWindow: 128000, auth: 'api-key' },
      { key: 'deepseek-deepseek-v4-flash', gateway: 'deepseek', id: 'deepseek-v4-flash', contextWindow: 128000, auth: 'api-key' },
    ],
    providerBaseUrls: { openrouter: 'https://openrouter.ai/v1', deepseek: 'https://api.deepseek.com' },
    gatewayAuth: new Map([['openrouter', 'api-key'], ['deepseek', 'api-key']]),
    oauthProviders: new Map(),
    byokProviders: [
      { name: 'openrouter', url: 'https://openrouter.ai/v1' },
      { name: 'deepseek', url: 'https://api.deepseek.com' },
    ],
    configsByScope: {},
    existingHookScope: undefined,
    copilotUsable: true,
    ...overrides,
  };
}

function makeState(overrides: Partial<InitState> = {}): InitState {
  return {
    configScope: 'project',
    providerKeys: ['opencode/openrouter'],
    nativeKeys: ['openrouter-kimi-k3'],
    roles: ['code', 'review', 'explore', 'plan'],
    credentialSources: {},
    routing: 'project',
    ...overrides,
  };
}

describe('validate', () => {
  it('excludes custom providers from unknown-providers check', () => {
    const env = makeEnv();
    const state = makeState({
      providerKeys: ['opencode/openrouter', byokProviderKey('my-proxy')],
      customProviders: [{ name: 'my-proxy', url: 'https://custom.example/v1' }],
    });
    const problems = validate(env, state);
    expect(problems).toHaveLength(0);
  });

  it('reports unknown providers before BYOK missing-key check', () => {
    const env = makeEnv();
    const state = makeState({
      providerKeys: ['opencode/unknown-provider'],
      nativeKeys: [],
    });
    const problems = validate(env, state);
    // unknown-providers runs first; no-models-selected runs after
    expect(problems.length).toBeGreaterThanOrEqual(1);
    expect(problems[0].message).toContain('no harness offers opencode/unknown-provider');
  });

  it('reports unknown model when selected model not offered by chosen providers', () => {
    const env = makeEnv();
    const state = makeState({
      providerKeys: ['opencode/openrouter'],
      nativeKeys: ['deepseek-deepseek-v4-flash'], // deepseek not selected
    });
    const problems = validate(env, state);
    expect(problems).toHaveLength(1);
    expect(problems[0].message).toContain('do not offer deepseek-deepseek-v4-flash');
  });

  it('reports error when no models selected', () => {
    const env = makeEnv();
    const state = makeState({
      nativeKeys: [],
    });
    const problems = validate(env, state);
    expect(problems).toHaveLength(1);
    expect(problems[0].message).toContain('no models selected');
  });

  it('reports --routing global conflict with project-scoped config', () => {
    const env = makeEnv();
    const state = makeState({
      configScope: 'project',
      routing: 'global',
    });
    const problems = validate(env, state);
    expect(problems).toHaveLength(1);
    expect(problems[0].message).toContain('--routing global routes every project through the machine config');
  });
});