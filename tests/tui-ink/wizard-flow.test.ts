import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { InitWizard, type WizardData } from '../../src/tui-ink/app.js';
import type { TuiResult } from '../../src/tui-ink/types.js';

const ENTER = '\r';
const DOWN = '\x1B[B';
const SPACE = ' ';

/** Lets Ink flush a render before the next keystroke is read. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

function renderWizard(data: WizardData) {
  let result: TuiResult | undefined;
  const app = render(React.createElement(InitWizard, {
    data,
    onDone: (r: TuiResult) => { result = r; },
  }));
  return {
    lastFrame: app.lastFrame,
    press: async (...keys: string[]) => {
      for (const key of keys) { app.stdin.write(key); await tick(); }
    },
    result: () => result,
  };
}

/**
 * A first run: no config anywhere, so no `initialState` and no saved tiers.
 * This is the shape two of the three 0.3.x defects needed to reproduce, and
 * the shape no existing user has.
 */
function firstRunData(): WizardData {
  return {
    home: '/tmp/does-not-exist',
    harnesses: [{ name: 'opencode', installed: true }],
    providers: [{ key: 'opencode/acme', harness: 'opencode', provider: 'acme', count: 2 }],
    candidates: [
      { key: 'acme-fast', gateway: 'acme', id: 'fast', label: 'opencode/acme/fast' },
      { key: 'acme-deep', gateway: 'acme', id: 'deep', label: 'opencode/acme/deep' },
    ],
    roles: ['code'],
    byokProviders: [],
    storedKeys: {},
    fetchModels: async () => ({ outcome: 'ok', models: [] }),
  };
}

describe('the wizard on a first run', () => {
  it('renders a non-empty ranking on the complex tier and lets it be submitted', async () => {
    const w = renderWizard(firstRunData());

    // step 0 config scope -> project
    await w.press(ENTER);
    // step 1 providers -> add acme, enter its key, then continue
    await w.press(ENTER, ENTER, 'test-key', ENTER, DOWN, ENTER);
    // step 2 models -> select all, continue
    await w.press(SPACE, ENTER);
    // step 3 roles -> accept the preselected `code`
    await w.press(ENTER);
    // step 4a code:simple -> accept the proposal
    await w.press(ENTER);

    // step 4b code:complex. The regression: this screen rendered with an
    // empty ranking, and RankedSelect refuses to submit one — so the wizard
    // could not be advanced past here at all.
    expect(w.lastFrame()).toContain('code: complex models');
    expect(w.lastFrame()).toMatch(/acme-(fast|deep)/);

    await w.press(ENTER);
    expect(w.lastFrame()).toContain('Summary');
  });
});

const ESC = '\x1B';
const LEFT = '\x1B[D';

describe('the wizard, remaining flow', () => {
  it('returns the full state through the summary screen', async () => {
    const w = renderWizard(firstRunData());

    await w.press(ENTER);
    await w.press(ENTER, ENTER, 'test-key', ENTER, DOWN, ENTER);
    await w.press(SPACE, ENTER);
    await w.press(ENTER, ENTER, ENTER, ENTER);

    const r = w.result();
    expect(r?.cancelled).toBe(false);
    expect(r?.state.configScope).toBe('project');
    expect(r?.state.nativeKeys).toEqual(['acme-fast', 'acme-deep']);
    expect(r?.state.roles).toEqual(['code']);
    expect(r?.state.tiers?.code.simple.length).toBeGreaterThan(0);
    expect(r?.state.tiers?.code.complex.length).toBeGreaterThan(0);
  });

  it('reports a cancel without losing the state gathered so far', async () => {
    const w = renderWizard(firstRunData());

    await w.press(ENTER);
    await w.press(ENTER, ENTER, 'test-key', ENTER, DOWN, ENTER);
    await w.press(ESC);
    // Ink holds a bare escape briefly in case it starts an arrow sequence.
    await tick();

    expect(w.result()?.cancelled).toBe(true);
    expect(w.result()?.state.configScope).toBe('project');
  });

  it('refuses to finish with no models selected', async () => {
    const w = renderWizard(firstRunData());

    await w.press(ENTER);
    await w.press(ENTER, ENTER, 'test-key', ENTER, DOWN, ENTER);
    // Submit the models picker empty, then deselect the preselected role so the
    // empty tier flow reaches Summary without needing a ranked model.
    await w.press(ENTER, SPACE, ENTER);

    expect(w.lastFrame()).toContain('Summary');
    expect(w.lastFrame()).toContain('Select at least one model before continuing.');
    await w.press(ENTER);
    expect(w.result()).toBeUndefined();
  });

  it('walks back from the complex tier to the simple one, not to roles', async () => {
    const w = renderWizard(firstRunData());

    await w.press(ENTER);
    await w.press(ENTER, ENTER, 'test-key', ENTER, DOWN, ENTER);
    await w.press(SPACE, ENTER);
    await w.press(ENTER, ENTER);

    expect(w.lastFrame()).toContain('code: complex models');
    await w.press(LEFT);
    expect(w.lastFrame()).toContain('code: simple models');
  });
});
