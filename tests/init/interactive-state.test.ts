/**
 * What the wizard is told it already holds — `WizardData.storedKeys`, the map
 * the Auto-route step consults before asking for a decision key.
 *
 * The decision-server names resolve through `resolveDecisionKey`, the policy
 * serve and doctor share. They used to ride along on the generic lookup, which
 * reads opencode too: a TypeSafe key held only there made Setup skip the
 * prompt, while the router — which never sends another harness's copy — failed
 * every decision open.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { nullInitLog } from '../../src/commands/init-log.js';
import { interactiveState } from '../../src/init/interactive-state.js';
import type { InitEnvironment } from '../../src/init/discover.js';
import { writeSonataKey } from '../../src/native/credentials.js';
import { keyPromptFor } from '../../src/tui-ink/components/auto-route-step.js';
import type { WizardData } from '../../src/tui-ink/app.js';

const env = (over: Partial<InitEnvironment> = {}): InitEnvironment => ({
  cwd: '/tmp/test',
  home: '/home/test',
  tmux: { installed: true, version: '3.4', problems: [] },
  harnesses: [],
  problems: [],
  offered: [],
  allNativeCandidates: [],
  providerBaseUrls: {},
  gatewayAuth: new Map(),
  oauthProviders: new Map(),
  byokProviders: [],
  configsByScope: {},
  existingHookScope: undefined,
  copilotUsable: false,
  ...over,
});

/** An opencode `auth.json` under `home` holding `entries`. */
function opencodeAuth(home: string, entries: Record<string, unknown>): void {
  mkdirSync(join(home, '.local/share/opencode'), { recursive: true });
  writeFileSync(join(home, '.local/share/opencode/auth.json'), JSON.stringify(entries));
}

/** The `WizardData` the front end builds, captured before the wizard draws. */
async function wizardData(home: string, over: Partial<InitEnvironment> = {}): Promise<WizardData> {
  let captured: WizardData | undefined;
  await interactiveState(env(over), {
    cwd: mkdtempSync(join(tmpdir(), 'sonata-interactive-cwd-')),
    home,
    packageRoot: '/pkg',
    host: {
      runTui: async (data) => {
        captured = data;
        return { cancelled: true, state: data.initialState ?? {} };
      },
    },
  }, nullInitLog);
  expect(captured).toBeDefined();
  return captured as WizardData;
}

describe('wizard storedKeys — one decision-key policy', () => {
  it('shows the key prompt when only opencode holds the TypeSafe key', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sonata-interactive-home-'));
    opencodeAuth(home, { typesafe: { key: 'oc-ts' } });

    const data = await wizardData(home);
    expect(data.storedKeys.typesafe).toBeUndefined();
    // What the Auto-route step derives from this map: the prompt has to come
    // up, because the router has no key to send.
    expect(keyPromptFor('https://api.typesafe.ai', data.storedKeys.typesafe !== undefined)).toBeDefined();
  });

  it('skips the prompt when sonata\'s own store holds the key', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sonata-interactive-home-'));
    writeSonataKey(home, 'typesafe', 'ts-key');

    const data = await wizardData(home);
    expect(data.storedKeys.typesafe).toBe('ts-key');
    expect(keyPromptFor('https://api.typesafe.ai', data.storedKeys.typesafe !== undefined)).toBeUndefined();
  });

  it('holds the auto-route key to sonata\'s store too', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sonata-interactive-home-'));
    opencodeAuth(home, { 'auto-route': { key: 'oc-ar' } });

    const data = await wizardData(home);
    expect(data.storedKeys['auto-route']).toBeUndefined();
    expect(keyPromptFor('https://decisions.example.com/v1', data.storedKeys['auto-route'] !== undefined)).toBeDefined();

    writeSonataKey(home, 'auto-route', 'ar-key');
    const held = await wizardData(home);
    expect(held.storedKeys['auto-route']).toBe('ar-key');
  });

  it('still finds an OpenRouter key opencode holds, since the router sends it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sonata-interactive-home-'));
    opencodeAuth(home, { openrouter: { key: 'oc-or' } });

    const data = await wizardData(home);
    expect(data.storedKeys.openrouter).toBe('oc-or');
  });

  it('offers provider gateways whatever store holds their key', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sonata-interactive-home-'));
    opencodeAuth(home, { acme: { key: 'oc-acme' } });

    const data = await wizardData(home, {
      offered: [{ harness: 'opencode', provider: 'acme', key: 'opencode/acme', count: 1 }],
    });
    expect(data.storedKeys.acme).toBe('oc-acme');
  });
});
