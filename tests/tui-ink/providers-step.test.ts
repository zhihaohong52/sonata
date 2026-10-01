import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { OAuthModelsStep, ProvidersStep, oauthModelIds, parseOAuthModelIds, providersNeedingChatgptChoice } from '../../src/tui-ink/components/providers-step.js';
import type { AvailableCredentials } from '../../src/tui-ink/app-state.js';
import type { ModelsDevCache } from '../../src/modelsdev.js';
import type { LoginResult } from '../../src/native/oauth-login.js';
import type { InitState } from '../../src/tui-ink/types.js';
import { settle, tick, until } from './ink-wait.js';

const ENTER = '\r';
const SPACE = ' ';

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

    const frame = () => app.lastFrame() ?? '';
    await settle();
    app.stdin.write(ENTER); // menu -> add provider
    await until(() => frame().includes('Add a custom provider'), 'the provider picker');
    app.stdin.write('openai');
    app.stdin.write(ENTER); // provider picker -> login
    // The models screen mounts from LoginScreen's effect once the login
    // resolves, so it is waited for rather than assumed after a fixed sleep.
    await until(() => frame().includes('Models for openai') && frame().includes('gpt-5.6-luna'), 'the models screen');
    app.stdin.write(SPACE); // select the first catalog row
    await until(() => frame().includes('1 selected'), 'the row to be selected');
    app.stdin.write(ENTER);
    await until(() => state.byokModels !== undefined, 'the selection to be recorded');

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

describe('ChatGPT login source in ProvidersStep', () => {
  const DOWN = '\u001B[B';
  const LEFT = '\u001B[D';

  /** `null` is "not signed in there"; `expiresInDays: null` is "signed in, expiry unknown". */
  function logins(
    codex: { expiresInDays: number | null } | null,
    opencode: { expiresInDays: number | null } | null,
  ): AvailableCredentials {
    return { codex, opencode, key: null, keyEntryAvailable: false };
  }

  /**
   * Each onChange re-renders with the new state, the way the wizard does —
   * without it the choice screen's `initial` would read the state the run
   * started on rather than what this run has since recorded.
   */
  function renderFlow(availability: Record<string, AvailableCredentials>, initial: InitState = {}) {
    let state: InitState = { harnesses: ['codex', 'opencode'], ...initial };
    const element = () => React.createElement(ProvidersStep, {
      home: '/tmp/sonata-chatgpt-source-test',
      harnesses: [
        { name: 'codex', installed: true },
        { name: 'opencode', installed: true },
      ],
      providers: Object.keys(availability).map((name) => ({
        key: `codex/${name}`, harness: 'codex', provider: name, count: 1,
      })),
      byokProviders: [],
      credentialAvailability: availability,
      gatewayAuth: { chatgpt: 'codex-oauth' },
      storedKeys: {},
      state,
      onChange: (updater: (current: InitState) => InitState) => {
        state = updater(state);
        app.rerender(element());
      },
      onContinue: () => {},
      onBack: () => {},
      onCancel: () => {},
    });
    const app = render(element());
    return {
      app,
      state: () => state,
      frame: () => app.lastFrame() ?? '',
      press: async (...keys: string[]) => {
        for (const key of keys) { app.stdin.write(key); await tick(); }
      },
    };
  }

  /** menu -> harness picker -> import list, with every row checked and the list submitted. */
  async function toImport(w: ReturnType<typeof renderFlow>, rows = 1) {
    await settle();
    await w.press(ENTER); // menu: Import from other harnesses
    await until(() => w.frame().includes('Import from which harnesses?'), 'the harness picker');
    await w.press(ENTER); // both harnesses pre-checked
    await until(() => w.frame().includes('via codex'), 'the import list');
    for (let row = 0; row < rows; row += 1) await w.press(DOWN, SPACE); // check each row
    await w.press(ENTER); // submit
  }

  it('asks which login to use when codex and opencode both hold one', async () => {
    const w = renderFlow({ chatgpt: logins({ expiresInDays: 3 }, { expiresInDays: null }) });
    await toImport(w);
    await until(() => w.frame().includes('ChatGPT login for chatgpt'), 'the ChatGPT login choice');
    expect(w.frame()).toContain('codex — expires in 3d');
    expect(w.frame()).toContain('opencode — expiry unknown');
    await w.press(DOWN, ENTER); // choose opencode
    await until(() => w.frame().includes('Set up providers'), 'the providers menu');
    expect(w.state().credentialSources).toEqual({ chatgpt: 'opencode' });
    w.app.unmount();
  });

  it('keeps codex when the default choice is accepted as-is', async () => {
    const w = renderFlow({ chatgpt: logins({ expiresInDays: -2 }, { expiresInDays: 5 }) });
    await toImport(w);
    await until(() => w.frame().includes('ChatGPT login for chatgpt'), 'the ChatGPT login choice');
    expect(w.frame()).toContain('codex — expired — re-login in that tool');
    expect(w.frame()).toContain('opencode — expires in 5d');
    await w.press(ENTER); // accept the codex default
    await until(() => w.frame().includes('Set up providers'), 'the providers menu');
    expect(w.state().credentialSources).toEqual({ chatgpt: 'codex' });
    w.app.unmount();
  });

  it('skips the choice when only one tool holds a login', async () => {
    const w = renderFlow({ chatgpt: logins(null, { expiresInDays: 12 }) });
    await toImport(w);
    await until(() => w.frame().includes('Set up providers'), 'the providers menu');
    expect(w.frame()).not.toContain('ChatGPT login for chatgpt');
    expect(w.state().credentialSources).toEqual({ chatgpt: 'opencode' });
    w.app.unmount();
  });

  it('opens on a source a previous run chose, and enter keeps it', async () => {
    const w = renderFlow(
      { chatgpt: logins({ expiresInDays: 3 }, { expiresInDays: 5 }) },
      { credentialSources: { chatgpt: 'opencode' } },
    );
    await toImport(w);
    await until(() => w.frame().includes('ChatGPT login for chatgpt'), 'the ChatGPT login choice');
    expect(w.frame()).toContain('› opencode — expires in 5d');
    await w.press(ENTER); // keep the seeded source
    await until(() => w.frame().includes('Set up providers'), 'the providers menu');
    expect(w.state().credentialSources).toEqual({ chatgpt: 'opencode' });
    w.app.unmount();
  });

  it('keeps a picked source across a back to import and a re-submit', async () => {
    const w = renderFlow({
      chatgpt: logins({ expiresInDays: 3 }, { expiresInDays: 5 }),
      grok: logins({ expiresInDays: 3 }, { expiresInDays: 5 }),
    });
    await toImport(w, 2);
    await until(() => w.frame().includes('ChatGPT login for chatgpt'), 'the chatgpt choice');
    await w.press(DOWN, ENTER); // pick opencode for chatgpt
    await until(() => w.frame().includes('ChatGPT login for grok'), 'the grok choice');
    await w.press(LEFT); // back to the import list
    await until(() => w.frame().includes('via codex'), 'the import list');
    await w.press(ENTER); // re-submit
    await until(() => w.frame().includes('ChatGPT login for chatgpt'), 'the chatgpt choice again');
    expect(w.frame()).toContain('› opencode — expires in 5d');
    await w.press(ENTER); // enter keeps opencode
    await until(() => w.frame().includes('ChatGPT login for grok'), 'the grok choice again');
    await w.press(ENTER); // enter keeps grok's codex default
    await until(() => w.frame().includes('Set up providers'), 'the providers menu');
    expect(w.state().credentialSources).toEqual({ chatgpt: 'opencode', grok: 'codex' });
    w.app.unmount();
  });

  it('asks one provider after another and records each answer under its own name', async () => {
    const w = renderFlow({
      chatgpt: logins({ expiresInDays: 3 }, { expiresInDays: 5 }),
      grok: logins({ expiresInDays: 3 }, { expiresInDays: 5 }),
    });
    await toImport(w, 2);
    await until(() => w.frame().includes('ChatGPT login for chatgpt'), 'the chatgpt choice');
    await w.press(ENTER); // chatgpt keeps its codex default
    await until(() => w.frame().includes('ChatGPT login for grok'), 'the grok choice');
    await w.press(DOWN, ENTER); // grok picks opencode
    await until(() => w.frame().includes('Set up providers'), 'the providers menu');
    expect(w.state().credentialSources).toEqual({ chatgpt: 'codex', grok: 'opencode' });
    w.app.unmount();
  });

  it('removes the credential source of an unchecked provider', async () => {
    const w = renderFlow({ chatgpt: logins({ expiresInDays: 3 }, null) }); // codex only: no choice screen
    await toImport(w);
    await until(() => w.frame().includes('Set up providers'), 'the providers menu');
    expect(w.state().credentialSources).toEqual({ chatgpt: 'codex' });
    await w.press(ENTER); // menu: Import from other harnesses
    await until(() => w.frame().includes('Import from which harnesses?'), 'the harness picker');
    await w.press(ENTER); // both harnesses pre-checked
    await until(() => w.frame().includes('via codex'), 'the import list');
    await w.press(DOWN, SPACE, ENTER); // uncheck the row, submit
    await until(() => w.frame().includes('Set up providers'), 'the providers menu');
    expect(w.state().credentialSources).toEqual({});
    expect(w.state().providerKeys).toEqual([]);
    w.app.unmount();
  });

  it('lists only the providers whose credential exists twice', () => {
    const providers = [
      { key: 'codex/chatgpt', harness: 'codex', provider: 'chatgpt', count: 1 },
      { key: 'codex/copilot', harness: 'codex', provider: 'copilot', count: 1 },
      { key: 'codex/grok', harness: 'codex', provider: 'grok', count: 1 },
    ];
    const availability = {
      chatgpt: logins({ expiresInDays: 3 }, { expiresInDays: 3 }),
      copilot: logins({ expiresInDays: 3 }, null),
      grok: logins({ expiresInDays: 3 }, { expiresInDays: 3 }),
    };
    expect(providersNeedingChatgptChoice([providers[0], providers[1], providers[2]], availability))
      .toEqual(['chatgpt', 'grok']);
  });
});
