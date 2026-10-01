import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import {
  AutoRouteStep, choiceForUrl, initialChoiceFor, keyPromptFor,
} from '../../src/tui-ink/components/auto-route-step.js';
import type { InitState } from '../../src/tui-ink/types.js';
import { tick, until } from './ink-wait.js';

const ENTER = '\r';
const DOWN = '\x1B[B';

/**
 * The step with its answers captured. `onChange` is folded into the same
 * state object `app.tsx` keeps, so the assertions read what the wizard would
 * hand `plan()` — not what the component meant to say.
 */
function renderStep(over: {
  state?: InitState;
  storedKeys?: Record<string, string>;
  savedBaseUrl?: string;
} = {}) {
  let state: InitState = over.state ?? {};
  let done = 0;
  let backed = 0;
  const app = render(React.createElement(AutoRouteStep, {
    state,
    storedKeys: over.storedKeys ?? {},
    savedBaseUrl: over.savedBaseUrl,
    onChange: (update) => { state = update(state); },
    onDone: () => { done += 1; },
    onBack: () => { backed += 1; },
    onCancel: () => {},
  }));
  return {
    lastFrame: () => app.lastFrame() ?? '',
    press: async (...keys: string[]) => {
      for (const key of keys) { app.stdin.write(key); await tick(); }
    },
    type: async (text: string) => {
      for (const char of text) { app.stdin.write(char); await tick(); }
    },
    state: () => state,
    done: () => done,
    backed: () => backed,
    unmount: app.unmount,
  };
}

describe('keyPromptFor', () => {
  it('demands a key for the two hosted servers and skips a host that already has one', () => {
    expect(keyPromptFor('https://api.typesafe.ai', false)).toEqual({
      gateway: 'typesafe', host: 'api.typesafe.ai', required: true,
    });
    expect(keyPromptFor('https://openrouter.ai/api', false)).toEqual({
      gateway: 'openrouter', host: 'openrouter.ai', required: true,
    });
    expect(keyPromptFor('https://api.typesafe.ai', true)).toBeUndefined();
    expect(keyPromptFor('https://openrouter.ai/api', true)).toBeUndefined();
  });

  it('offers an optional key for any other host, and none at all for loopback', () => {
    expect(keyPromptFor('https://decisions.example.com/v1', false)).toEqual({
      gateway: 'auto-route', host: 'decisions.example.com', required: false,
    });
    expect(keyPromptFor('http://localhost:8000', false)).toBeUndefined();
    expect(keyPromptFor('http://127.0.0.1:8080', false)).toBeUndefined();
  });
});

describe('the choice a URL opens on', () => {
  it('names the two hosts, Custom for anything else, Off for nothing', () => {
    expect(choiceForUrl(undefined)).toBe('off');
    expect(choiceForUrl(null)).toBe('off');
    expect(choiceForUrl('https://api.typesafe.ai')).toBe('typesafe');
    expect(choiceForUrl('https://openrouter.ai/api')).toBe('openrouter');
    expect(choiceForUrl('https://decisions.example.com')).toBe('custom');
    expect(initialChoiceFor(undefined, undefined)).toBe('off');
    expect(initialChoiceFor(undefined, 'https://openrouter.ai/api')).toBe('openrouter');
    // This run's answer is an answer — including the one that turns it off.
    expect(initialChoiceFor(null, 'https://api.typesafe.ai')).toBe('off');
    expect(initialChoiceFor({ baseUrl: 'https://decisions.example.com' }, 'https://api.typesafe.ai')).toBe('custom');
  });

  it('recognises a named host whatever case the URL was saved in', () => {
    // `new URL` folds hostname case, so a hand-edited config must open on the
    // named row rather than on Custom.
    expect(choiceForUrl('https://API.typesafe.ai')).toBe('typesafe');
    expect(choiceForUrl('https://openRouter.ai/API')).toBe('openrouter');
  });
});

describe('AutoRouteStep', () => {
  it('records an explicit Off and drops any key gathered on the way', async () => {
    const w = renderStep({ state: { decisionKey: { gateway: 'typesafe', key: 'sk-stale' } } });
    await w.press(ENTER);
    expect(w.done()).toBe(1);
    expect(w.state().autoRoute).toBeNull();
    expect(w.state().decisionKey).toBeUndefined();
    w.unmount();
  });

  it('asks TypeSafe for a masked key and stores it under its own gateway', async () => {
    const w = renderStep();
    await w.press(DOWN, ENTER);
    await until(() => w.lastFrame().includes('Key for api.typesafe.ai'), 'the TypeSafe key screen');
    await w.type('sk-decision');
    // The terminal is not a private surface: the value is bullets on screen.
    expect(w.lastFrame()).toContain('•'.repeat('sk-decision'.length));
    expect(w.lastFrame()).not.toContain('sk-decision');
    await w.press(ENTER);
    expect(w.done()).toBe(1);
    expect(w.state().autoRoute).toEqual({ baseUrl: 'https://api.typesafe.ai' });
    expect(w.state().decisionKey).toEqual({ gateway: 'typesafe', key: 'sk-decision' });
    w.unmount();
  });

  it('refuses an empty key where the host requires one', async () => {
    const w = renderStep();
    await w.press(DOWN, ENTER);
    await until(() => w.lastFrame().includes('Key for api.typesafe.ai'), 'the TypeSafe key screen');
    await w.press(ENTER);
    expect(w.lastFrame()).toContain('A key is required.');
    expect(w.done()).toBe(0);
    w.unmount();
  });

  it('skips the key screen when the store already holds one for TypeSafe', async () => {
    const w = renderStep({ storedKeys: { typesafe: 'sk-stored' } });
    await w.press(DOWN, ENTER);
    expect(w.lastFrame()).not.toContain('Key for');
    expect(w.done()).toBe(1);
    expect(w.state().autoRoute).toEqual({ baseUrl: 'https://api.typesafe.ai' });
    // Nothing typed, so nothing to store over the key already there.
    expect(w.state().decisionKey).toBeUndefined();
    w.unmount();
  });

  it('counts a provider key typed this run for OpenRouter', async () => {
    const w = renderStep({ state: { byokKeys: { openrouter: 'sk-or' } } });
    await w.press(DOWN, DOWN, ENTER);
    expect(w.lastFrame()).not.toContain('Key for');
    expect(w.done()).toBe(1);
    expect(w.state().autoRoute).toEqual({ baseUrl: 'https://openrouter.ai/api' });
    w.unmount();
  });

  it('refuses a relative custom URL', async () => {
    const w = renderStep();
    await w.press(DOWN, DOWN, DOWN, ENTER);
    await until(() => w.lastFrame().includes('Decision server URL'), 'the URL screen');
    await w.type('openrouter.ai/api');
    await w.press(ENTER);
    expect(w.lastFrame()).toContain('Enter an absolute http(s) URL');
    expect(w.done()).toBe(0);
    expect(w.state().autoRoute).toBeUndefined();
    w.unmount();
  });

  it('takes a loopback URL without its trailing slash and asks for no key', async () => {
    const w = renderStep();
    await w.press(DOWN, DOWN, DOWN, ENTER);
    await until(() => w.lastFrame().includes('Decision server URL'), 'the URL screen');
    await w.type('http://localhost:8000/');
    await w.press(ENTER);
    expect(w.done()).toBe(1);
    expect(w.state().autoRoute).toEqual({ baseUrl: 'http://localhost:8000' });
    expect(w.state().decisionKey).toBeUndefined();
    w.unmount();
  });

  it('accepts a blank key where the host does not require one, and stores none', async () => {
    const w = renderStep();
    await w.press(DOWN, DOWN, DOWN, ENTER);
    await until(() => w.lastFrame().includes('Decision server URL'), 'the URL screen');
    await w.type('https://decisions.example.com/v1');
    await w.press(ENTER);
    await until(() => w.lastFrame().includes('Key for decisions.example.com'), 'the optional key screen');
    await w.press(ENTER);
    expect(w.done()).toBe(1);
    expect(w.state().autoRoute).toEqual({ baseUrl: 'https://decisions.example.com/v1' });
    expect(w.state().decisionKey).toBeUndefined();
    w.unmount();
  });

  it('goes back to the tier screens from the choice screen', async () => {
    const w = renderStep();
    await w.press('\x1B[D');
    expect(w.backed()).toBe(1);
    w.unmount();
  });

  it('keeps a key already typed when the step is walked back into', async () => {
    const w = renderStep();
    await w.press(DOWN, ENTER);
    await until(() => w.lastFrame().includes('Key for api.typesafe.ai'), 'the TypeSafe key screen');
    await w.type('sk-decision');
    await w.press(ENTER);
    const gathered = w.state();
    expect(gathered.decisionKey).toEqual({ gateway: 'typesafe', key: 'sk-decision' });
    w.unmount();

    // Back to the summary and forward again, the same state the wizard holds.
    // The key screen must not reopen empty: a required host would demand a key
    // just typed, and a blank submit would erase one.
    const again = renderStep({ state: gathered });
    await until(() => again.lastFrame().includes('Auto-route subagent tiers?'), 'the choice screen');
    // The cursor opens on the URL this run already chose.
    await again.press(ENTER);
    expect(again.lastFrame()).not.toContain('Key for');
    expect(again.done()).toBe(1);
    expect(again.state().decisionKey).toEqual({ gateway: 'typesafe', key: 'sk-decision' });
    again.unmount();
  });

  it('keeps an optional custom key the same way', async () => {
    const w = renderStep();
    await w.press(DOWN, DOWN, DOWN, ENTER);
    await until(() => w.lastFrame().includes('Decision server URL'), 'the URL screen');
    await w.type('https://decisions.example.com/v1');
    await w.press(ENTER);
    await until(() => w.lastFrame().includes('Key for decisions.example.com'), 'the optional key screen');
    await w.type('sk-self');
    await w.press(ENTER);
    const gathered = w.state();
    expect(gathered.decisionKey).toEqual({ gateway: 'auto-route', key: 'sk-self' });
    w.unmount();

    const again = renderStep({ state: gathered });
    await until(() => again.lastFrame().includes('Auto-route subagent tiers?'), 'the choice screen');
    await again.press(ENTER); // Custom — the cursor opens on the URL it already chose
    await until(() => again.lastFrame().includes('Decision server URL'), 'the URL screen');
    await again.press(ENTER); // the URL it already holds
    expect(again.lastFrame()).not.toContain('Key for');
    expect(again.done()).toBe(1);
    // The key survives, rather than being erased by the blank submit an
    // optional screen would have offered.
    expect(again.state().decisionKey).toEqual({ gateway: 'auto-route', key: 'sk-self' });
    again.unmount();
  });

  it('re-picks a saved TypeSafe URL without asking for the key it has', async () => {
    const w = renderStep({
      savedBaseUrl: 'https://api.typesafe.ai',
      storedKeys: { typesafe: 'sk-stored' },
    });
    await until(() => w.lastFrame().includes('Auto-route subagent tiers?'), 'the choice screen');
    expect(w.lastFrame()).toContain('› TypeSafe'); // opens on the saved URL
    await w.press(ENTER);
    expect(w.lastFrame()).not.toContain('Key for');
    expect(w.done()).toBe(1);
    expect(w.state().autoRoute).toEqual({ baseUrl: 'https://api.typesafe.ai' });
    expect(w.state().decisionKey).toBeUndefined();
    w.unmount();
  });
});
