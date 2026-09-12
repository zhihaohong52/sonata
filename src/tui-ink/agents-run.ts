import React from 'react';
import { render } from 'ink';
import { AgentsApp, type Tiers } from './agents-app.js';
import type { SonataConfig } from '../config.js';

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
}): Promise<Tiers | undefined> {
  let outcome: Tiers | undefined;
  const instance = render(React.createElement(AgentsApp, {
    ...input,
    onDone: (tiers: Tiers | undefined) => {
      outcome = tiers;
      instance.unmount();
    },
  }));
  await instance.waitUntilExit();
  return outcome;
}
