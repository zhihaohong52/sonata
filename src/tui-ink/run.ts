import React from 'react';
import { render } from 'ink';
import { InitWizard, type WizardData } from './app.js';
import type { TuiResult } from './types.js';

/**
 * Runs the Ink wizard and returns only once Ink has released stdin.
 *
 * The wait is the whole point. `unmount()` starts a teardown that finishes
 * asynchronously — Ink restores raw mode, detaches its own reader and pauses
 * the stream after it returns. Resolving straight after calling it therefore
 * handed control back to `cmdInit` mid-teardown: the next prompt (`Install the
 * permission hook`) attached its iterator to stdin, Ink's cleanup then ran and
 * pulled the stream out from under it, and the prompt ended without ever
 * receiving a keystroke. The run exited with the prompt still on screen and
 * nothing written — which is what "sonata init never saves the config" was.
 *
 * `waitUntilExit()` resolves after that cleanup, so stdin is quiet and
 * unclaimed by the time the next prompt asks for it.
 */
export async function runInitTui(
  data: WizardData,
  log: (line: string) => void = () => {},
): Promise<TuiResult> {
  let outcome: TuiResult | undefined;

  const instance = render(React.createElement(InitWizard, {
    data,
    onDone: (result: TuiResult) => {
      outcome ??= result;
      instance.unmount();
    },
  }));

  await instance.waitUntilExit();

  if (outcome === undefined) {
    // Ink ended without the wizard reporting anything — Ctrl-C, a signal, or a
    // closed stream. Indistinguishable from a deliberate cancel in the result,
    // and very distinguishable in a bug report, so say which one happened.
    log('wizard: ink exited without a result (interrupt, signal or closed stdin)');
    return { cancelled: true, state: data.initialState ?? {} };
  }
  return outcome;
}
