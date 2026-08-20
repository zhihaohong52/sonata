import React from 'react';
import { render } from 'ink';
import { InitWizard, type WizardData } from './app.js';
import type { TuiResult } from './types.js';

export async function runInitTui(data: WizardData): Promise<TuiResult> {
  return new Promise((resolve) => {
    let instance: ReturnType<typeof render> | undefined;
    let finished = false;
    const finish = (result: TuiResult) => {
      if (finished) return;
      finished = true;
      instance?.unmount();
      resolve(result);
    };

    instance = render(React.createElement(InitWizard, { data, onDone: finish }));
    instance.waitUntilExit().then(() => finish({ cancelled: true, state: data.initialState ?? {} }));
  });
}
