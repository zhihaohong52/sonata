import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import {
  AutoRouteStep, choiceForUrl, initialChoiceFor, keyPromptFor,
} from '../../src/tui-ink/components/auto-route-step.js';
import type { InitState } from '../../src/tui-ink/types.js';
import type { DecisionChoice } from '../../src/native/decision-models.js';
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
  savedModel?: string;
  gateways?: Record<string, { baseUrl: string }>;
  keyBound?: (baseUrl: string) => boolean;
  listModels?: (baseUrl: string, key: string | undefined) => Promise<DecisionChoice | undefined>;
} = {}) {
  let state: InitState = over.state ?? {};
  let done = 0;
  let backed = 0;
  const app = render(React.createElement(AutoRouteStep, {
    state,
    storedKeys: over.storedKeys ?? {},
    savedBaseUrl: over.savedBaseUrl,
    savedModel: over.savedModel,
    gateways: over.gateways,
    keyBound: over.keyBound,
    listModels: over.listModels,
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

  it('matches the canonical endpoints whatever case the host was saved in, and however the path was slashed', () => {
    // `new URL` folds host case, and a trailing slash is not a different
    // server — both are the named row rather than Custom.
    expect(choiceForUrl('https://API.typesafe.ai')).toBe('typesafe');
    expect(choiceForUrl('https://api.typesafe.ai/')).toBe('typesafe');
    expect(choiceForUrl('https://openRouter.ai/api')).toBe('openrouter');
    expect(choiceForUrl('https://openrouter.ai/api/')).toBe('openrouter');
  });

  it('is Custom for anything that is not the canonical endpoint', () => {
    // A named row adopts its canonical URL on confirm, so anything else must
    // stay Custom: a different path, port, query or fragment is a different
    // server, and one this step has no canonical form for.
    expect(choiceForUrl('https://api.typesafe.ai:8443')).toBe('custom');
    expect(choiceForUrl('https://api.typesafe.ai/api/custom')).toBe('custom');
    expect(choiceForUrl('https://openrouter.ai/api/v2')).toBe('custom');
    expect(choiceForUrl('https://openRouter.ai/API')).toBe('custom');
    expect(choiceForUrl('https://api.typesafe.ai?token=abc')).toBe('custom');
    expect(choiceForUrl('https://api.typesafe.ai#frag')).toBe('custom');
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
    expect(w.lastFrame()).toContain('This URL is refused');
    expect(w.done()).toBe(0);
    expect(w.state().autoRoute).toBeUndefined();
    w.unmount();
  });

  it('refuses a custom URL with a query string or fragment', async () => {
    // The rule `parseConfig` enforces, asked first: endpoint suffixes are
    // appended to this string, so a `?…` would swallow them.
    const w = renderStep();
    await w.press(DOWN, DOWN, DOWN, ENTER);
    await until(() => w.lastFrame().includes('Decision server URL'), 'the URL screen');
    await w.type('https://decisions.example.com/v1?token=abc');
    await w.press(ENTER);
    expect(w.lastFrame()).toContain('a query string or fragment is not allowed');
    expect(w.done()).toBe(0);
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

describe('choosing the decision model', () => {
  const ranked: DecisionChoice = {
    model: 'jev-1.13.0',
    reason: 'JevBench capability 80.0',
    ranked: [{ id: 'jev-1.13.0', capability: 80 }, { id: 'cygnet', capability: 79 }, { id: 'mystery' }],
  };

  it('lists the provider\'s models ranked by JevBench and pins the one picked', async () => {
    const asked: Array<[string, string | undefined]> = [];
    const step = renderStep({
      storedKeys: { typesafe: 'sk-ts' },
      listModels: async (baseUrl, key) => { asked.push([baseUrl, key]); return ranked; },
    });
    await step.press(DOWN, ENTER); // TypeSafe — key stored, so straight to the model screen
    await until(() => step.lastFrame().includes('JevBench 80.0'), 'the ranked models');
    expect(step.lastFrame()).toContain('Automatic');
    expect(step.lastFrame()).toContain('now jev-1.13.0');
    expect(step.lastFrame()).toContain('not scored by JevBench');
    expect(asked).toEqual([['https://api.typesafe.ai', 'sk-ts']]);
    await step.press(DOWN, DOWN, ENTER); // cygnet
    expect(step.state().autoRoute).toEqual({ baseUrl: 'https://api.typesafe.ai', model: 'cygnet' });
    expect(step.done()).toBe(1);
  });

  it('records Automatic as an answer that drops a saved pin', async () => {
    const step = renderStep({
      storedKeys: { typesafe: 'sk-ts' },
      savedBaseUrl: 'https://api.typesafe.ai',
      savedModel: 'cygnet',
      listModels: async () => ranked,
    });
    await step.press(ENTER); // the saved TypeSafe row
    await until(() => step.lastFrame().includes('JevBench 80.0'), 'the ranked models');
    // Opens on the saved pin.
    expect(step.lastFrame()).toMatch(/› cygnet/);
    await step.press('\x1B[A', '\x1B[A', ENTER); // past jev-1.13.0 to Automatic
    expect(step.state().autoRoute).toEqual({ baseUrl: 'https://api.typesafe.ai', model: null });
  });

  it('goes on with the model chosen at decision time when the provider lists nothing', async () => {
    const step = renderStep({ storedKeys: { typesafe: 'sk-ts' }, listModels: async () => undefined });
    await step.press(DOWN, ENTER);
    await until(() => step.lastFrame().includes('listed no decision models'), 'the empty listing');
    await step.press(ENTER);
    expect(step.state().autoRoute).toEqual({ baseUrl: 'https://api.typesafe.ai' });
    expect(step.done()).toBe(1);
  });

  it('lists with the key just typed on the key screen', async () => {
    const asked: Array<string | undefined> = [];
    const step = renderStep({ listModels: async (_, key) => { asked.push(key); return ranked; } });
    await step.press(DOWN, DOWN, ENTER); // OpenRouter, no key held
    await step.type('sk-or');
    await step.press(ENTER);
    await until(() => step.lastFrame().includes('JevBench 80.0'), 'the ranked models');
    expect(asked).toEqual(['sk-or']);
  });
});

describe('a configured gateway as the decision provider', () => {
  const gateways = {
    acme: { baseUrl: 'https://gw.acme.example/v1' },
    plain: { baseUrl: 'https://chat.example/v1' },
  };
  const serving: DecisionChoice = { model: 'decider-4b', reason: 'x', ranked: [{ id: 'decider-4b', capability: 70 }] };

  it('offers each gateway that lists decision models, and keys it with its own key', async () => {
    const asked: Array<[string, string | undefined]> = [];
    const step = renderStep({
      storedKeys: { acme: 'sk-acme' },
      gateways,
      keyBound: () => true,
      listModels: async (baseUrl, key) => {
        asked.push([baseUrl, key]);
        return baseUrl === 'https://gw.acme.example' ? serving : undefined;
      },
    });
    await until(() => step.lastFrame().includes('acme (gw.acme.example)'), 'the serving gateway row');
    expect(step.lastFrame()).toContain('1 decision model');
    expect(step.lastFrame()).not.toContain('plain');
    await step.press(DOWN, DOWN, DOWN, ENTER); // Off, TypeSafe, OpenRouter, acme
    await until(() => step.lastFrame().includes('JevBench 70.0'), 'the gateway models');
    await step.press(DOWN, ENTER);
    expect(step.state().autoRoute).toEqual({ baseUrl: 'https://gw.acme.example', model: 'decider-4b' });
    expect(asked).toContainEqual(['https://gw.acme.example', 'sk-acme']);
    expect(step.state().decisionKey).toBeUndefined();
  });

  it('never asks a gateway whose stored key may not go to its host', async () => {
    const asked: string[] = [];
    const step = renderStep({
      storedKeys: { acme: 'sk-acme' },
      gateways: { acme: gateways.acme },
      keyBound: () => false,
      listModels: async (baseUrl) => { asked.push(baseUrl); return serving; },
    });
    await tick(50);
    expect(asked).toEqual([]);
    expect(step.lastFrame()).not.toContain('acme');
  });
});
