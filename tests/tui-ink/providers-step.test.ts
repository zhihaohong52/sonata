import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { OAuthModelsStep, ProvidersStep, oauthModelIds, parseOAuthModelIds } from '../../src/tui-ink/components/providers-step.js';
import type { ModelsDevCache } from '../../src/modelsdev.js';
import type { LoginResult } from '../../src/native/oauth-login.js';
import type { InitState } from '../../src/tui-ink/types.js';

const ENTER = '\r';
const SPACE = ' ';
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

const cache: ModelsDevCache = {
  fetchedAt: '2026-09-21T00:00:00Z',
  providers: {
    openai: {
      'gpt-5.6-luna': { input: 1 },
      'claude-sonnet-4.6': { input: 1 },
    },
  },
};

describe('oauthModelIds', () => {
  it('returns model ids from the models.dev provider for an OAuth gateway', () => {
    expect(oauthModelIds(cache, 'openai', 'codex-oauth')).toEqual(['gpt-5.6-luna']);
  });

  it('filters claude-prefixed ids before they reach the config picker', () => {
    const copilot: ModelsDevCache = {
      fetchedAt: cache.fetchedAt,
      providers: {
        'github-copilot': {
          'gpt-5.6-luna': { input: 1 },
          'claude-opus-5': { input: 1 },
          'claude-sonnet-4.6': { input: 1 },
        },
      },
    };
    expect(oauthModelIds(copilot, 'github-copilot', 'copilot-oauth')).toEqual(['gpt-5.6-luna']);
  });

  it('returns no ids when the cache or provider entry is missing', () => {
    expect(oauthModelIds(undefined, 'openai', 'codex-oauth')).toEqual([]);
    expect(oauthModelIds(cache, 'github-copilot', 'copilot-oauth')).toEqual([]);
  });
});

describe('OAuthModelsStep', () => {
  it('keeps manual entry usable while filtering reserved ids', () => {
    expect(parseOAuthModelIds('claude-opus-5, gpt-5.6-luna, gpt-5.6-luna')).toEqual(['gpt-5.6-luna']);
  });

  it('offers manual model entry when the catalog has no usable ids', async () => {
    let submitted: string[] | undefined;
    const app = render(React.createElement(OAuthModelsStep, {
      provider: 'openai',
      modelIds: [],
      onSubmit: (ids: string[]) => { submitted = ids; },
      onBack: () => {},
      onCancel: () => {},
    }));
    for (const char of 'gpt-5.6-luna') app.stdin.write(char);
    await tick();
    app.stdin.write(ENTER);
    await tick();
    expect(submitted).toEqual(['gpt-5.6-luna']);
    app.unmount();
  });
});

describe('OAuth login in ProvidersStep', () => {
  it('records selected catalog ids in byokModels after successful login', async () => {
    let state: InitState = {};
    const app = render(React.createElement(ProvidersStep, {
      home: '/tmp/sonata-oauth-test',
      harnesses: [],
      providers: [{ key: 'byok/openai', harness: 'byok', provider: 'openai', count: 1 }],
      byokProviders: [{ name: 'openai', url: 'https://api.openai.com/v1' }],
      credentialAvailability: { openai: { codex: null, opencode: null, key: null, keyEntryAvailable: false } },
      gatewayAuth: { openai: 'codex-oauth' },
      storedKeys: {},
      modelsDevCache: cache,
      loginGateway: async () => ({ ok: true } as LoginResult),
      state,
      onChange: (updater: (current: InitState) => InitState) => { state = updater(state); },
      onContinue: () => {},
      onBack: () => {},
      onCancel: () => {},
    }));

    app.stdin.write(ENTER); // menu -> add provider
    await tick();
    app.stdin.write('openai');
    app.stdin.write(ENTER); // provider picker -> login
    await tick();
    await tick(); // let LoginScreen's effect complete
    expect(app.lastFrame()).toContain('Models for openai');
    app.stdin.write(SPACE); // select the first catalog row
    await tick();
    app.stdin.write(ENTER);
    await tick();

    expect(state.providerKeys).toEqual(['byok/openai']);
    expect(state.credentialSources).toEqual({ openai: 'sonata' });
    expect(state.byokModels).toEqual({ openai: ['gpt-5.6-luna'] });
    app.unmount();
  });
});
