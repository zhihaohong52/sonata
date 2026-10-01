/**
 * The Keys screen's auto-route row, and the policy its source comes from.
 *
 * That row is a credential the config can be missing even though it is no
 * gateway's, and it has to agree with what serve and doctor will do: a key
 * held only by another harness is one the router never sends, so the row says
 * "no key" rather than naming a store nothing will read.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';

import { writeSonataKey } from '../../src/native/credentials.js';
import { KeysScreen } from '../../src/tui-ink/screens/keys.js';
import { ThemeProvider } from '../../src/tui-ink/theme-context.js';
import { until } from './ink-wait.js';

const CONFIG = `
[auto_route]
classifier = "jev"

[models."m"]
gateway = "g"
id = "m-1"

[native.gateways."g"]
base_url = "https://g.example/v1"

[tiers.code]
simple = ["m"]
complex = ["m"]
`;

/** A project whose `[auto_route]` points at TypeSafe, under `home`. */
function project(): { cwd: string; home: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'sonata-keys-cwd-'));
  const home = mkdtempSync(join(tmpdir(), 'sonata-keys-home-'));
  writeFileSync(join(cwd, 'sonata.toml'), CONFIG);
  return { cwd, home };
}

/** An opencode `auth.json` under `home` holding `entries`. */
function opencodeAuth(home: string, entries: Record<string, unknown>): void {
  mkdirSync(join(home, '.local/share/opencode'), { recursive: true });
  writeFileSync(join(home, '.local/share/opencode/auth.json'), JSON.stringify(entries));
}

describe('KeysScreen — the auto-route row', () => {
  /** The one row that is not a gateway's, read out of the frame. */
  const autoRouteRow = (frame: string): string =>
    frame.split('\n').find((line) => line.includes('auto-route →')) ?? '';

  it('says "no key" when only opencode holds the TypeSafe key', async () => {
    const { cwd, home } = project();
    opencodeAuth(home, { typesafe: { key: 'oc-ts' } });

    const app = render(React.createElement(ThemeProvider, null,
      React.createElement(KeysScreen, { cwd, home })));
    try {
      await until(() => (app.lastFrame() ?? '').includes('auto-route → api.typesafe.ai'), 'the auto-route row');
      const row = autoRouteRow(app.lastFrame() ?? '');
      expect(row).toContain('no key');
      expect(row).not.toContain('opencode');
    } finally { app.unmount(); }
  });

  it('names the store when sonata holds the key', async () => {
    const { cwd, home } = project();
    writeSonataKey(home, 'typesafe', 'ts-key');
    opencodeAuth(home, { typesafe: { key: 'oc-ts' } });

    const app = render(React.createElement(ThemeProvider, null,
      React.createElement(KeysScreen, { cwd, home })));
    try {
      await until(() => (app.lastFrame() ?? '').includes('auto-route → api.typesafe.ai'), 'the auto-route row');
      const row = autoRouteRow(app.lastFrame() ?? '');
      expect(row).toContain('sonata');
      expect(row).not.toContain('no key');
    } finally { app.unmount(); }
  });
});
