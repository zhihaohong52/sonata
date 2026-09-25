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

describe('Rank providers in ProvidersStep', () => {
  const DOWN = '\u001B[B';
  const LEFT = '\u001B[D';

  function renderProviders(initial: InitState) {
    let state: InitState = initial;
    let continued = 0;
    const app = render(React.createElement(ProvidersStep, {
      home: '/tmp/sonata-rank-test',
      harnesses: [],
      providers: [],
      byokProviders: [],
      credentialAvailability: {},
      gatewayAuth: {},
      storedKeys: {},
      state,
      onChange: (updater: (current: InitState) => InitState) => { state = updater(state); },
      onContinue: () => { continued += 1; },
      onBack: () => {},
      onCancel: () => {},
    }));
    return {
      app,
      press: async (...keys: string[]) => {
        for (const key of keys) { app.stdin.write(key); await tick(); }
      },
      state: () => state,
      continued: () => continued,
    };
  }

  const two: InitState = {
    providerKeys: ['byok/alpha', 'byok/beta'],
    customProviders: [
      { name: 'alpha', url: 'https://alpha.example/v1' },
      { name: 'beta', url: 'https://beta.example/v1' },
    ],
  };

  it('opens on Continue with two gateways and records the submitted order', async () => {
    const w = renderProviders(two);
    // Nothing importable, so the menu is Add provider / Continue.
    await w.press(DOWN, ENTER);
    expect(w.app.lastFrame()).toContain('Rank providers');
    expect(w.continued()).toBe(0);
    await w.press(ENTER);
    expect(w.state().gatewayOrder).toEqual(['alpha', 'beta']);
    expect(w.continued()).toBe(1);
    w.app.unmount();
  });

  it('opens on the saved ranking, dropping names no longer selected', async () => {
    const w = renderProviders({ ...two, gatewayOrder: ['ghost', 'beta'] });
    await w.press(DOWN, ENTER, ENTER);
    expect(w.state().gatewayOrder).toEqual(['beta', 'alpha']);
    w.app.unmount();
  });

  it('skips the screen with a single gateway and records it', async () => {
    const w = renderProviders({
      providerKeys: ['byok/alpha'],
      customProviders: [{ name: 'alpha', url: 'https://alpha.example/v1' }],
    });
    await w.press(DOWN, ENTER);
    expect(w.app.lastFrame()).not.toContain('Rank providers');
    expect(w.continued()).toBe(1);
    expect(w.state().gatewayOrder).toEqual(['alpha']);
    w.app.unmount();
  });

  it('returns to the providers menu on back', async () => {
    const w = renderProviders(two);
    await w.press(DOWN, ENTER);
    expect(w.app.lastFrame()).toContain('Rank providers');
    await w.press(LEFT);
    expect(w.app.lastFrame()).toContain('Set up providers');
    expect(w.continued()).toBe(0);
    w.app.unmount();
  });
});
