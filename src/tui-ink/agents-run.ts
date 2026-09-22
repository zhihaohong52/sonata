import React from 'react';
import { render } from 'ink';
import { AgentsApp, type Tiers } from './agents-app.js';
import { Ground, ThemeProvider } from './theme-context.js';
import type { CandidateFacts } from '../catalog.js';
import type { SonataConfig, TierLists } from '../config.js';

/**
 * Render the agents browser and resolve only once Ink has released stdin.
 *
 * `waitUntilExit()` for the same reason `runInitTui` waits on it: `unmount()`
 * starts a teardown that finishes asynchronously, and anything that reads
 * stdin before it completes has the stream pulled out from under it.
 */
export async function runAgentsTui(input: {
  config: SonataConfig;
  initialTiers: Tiers;
  items: Array<{ value: string; label: string }>;
  factsFor?: (candidate: string, tier: keyof TierLists) => CandidateFacts;
}): Promise<Tiers | undefined> {
  let outcome: Tiers | undefined;
  // Themed and grounded like the shell, because this renders the same
  // component the shell does: a screen that looked different depending on
  // which entry point opened it would be two designs wearing one name.
  const instance = render(React.createElement(
    ThemeProvider,
    null,
    React.createElement(
      Ground,
      null,
      React.createElement(AgentsApp, {
        ...input,
        onDone: (tiers: Tiers | undefined) => {
          outcome = tiers;
          instance.unmount();
        },
      }),
    ),
  ));
  await instance.waitUntilExit();
  return outcome;
}
