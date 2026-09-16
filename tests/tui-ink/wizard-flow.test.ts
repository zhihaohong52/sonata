import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { InitWizard, type WizardData } from '../../src/tui-ink/app.js';
import { aaCatalogPath, loadAaCatalog } from '../../src/catalog.js';
import { parseConfig } from '../../src/config.js';
import { rankableCandidates } from '../../src/commands/agents.js';
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
  it('names models excluded for lacking an AA task cost', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sonata-wizard-task-cost-'));
    const path = aaCatalogPath(home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      fetchedAt: '2026-09-15T00:00:00Z',
      models: {
        fast: { codingIndex: 60, blendedPriceUsd: 0.2, costPerTask: 0.1 },
        deep: { codingIndex: 70, blendedPriceUsd: 0.5 },
      },
    }));
    const w = renderWizard({
      ...firstRunData(),
      home,
      candidates: [
        { key: 'acme-fast', gateway: 'acme', id: 'fast', label: 'opencode/acme/fast' },
        { key: 'acme-deep', gateway: 'acme', id: 'deep', label: 'opencode/acme/deep' },
      ],
    });
    await w.press(ENTER);
    await w.press(ENTER, ENTER, 'test-key', ENTER, DOWN, ENTER);
    expect(w.lastFrame()).toContain('excluded acme-deep');
    expect(w.lastFrame()).toContain('AA publishes no cost-per-task');
    expect(w.lastFrame()).toContain('opencode/acme/fast');
  });

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

/**
 * The candidate rows a ranking screen is offering, in screen order: the
 * marker stripped, the score columns dropped (a different concern from which
 * rows exist at all), and the label's `key @effort` respelled as the candidate
 * key it expands to, so the set can be compared with `rankableCandidates`.
 */
function offeredRows(frame: string): string[] {
  return frame
    .split('\n')
    .map((line) => line.replace(/\u001b\[[0-9;]*m/g, '').trim())
    .filter((line) => /^(?:\d+\.|·)\s/.test(line))
    .map((line) => line
      .replace(/^(?:\d+\.|·)\s+/, '')
      .split(/\s{2,}/)[0]!
      .replace(' @', '@'));
}

/** Scope → providers → roles → the first (simple) tier screen. */
async function walkToFirstTier(w: ReturnType<typeof renderWizard>): Promise<void> {
  await w.press(ENTER); // config scope -> project
  await w.press(DOWN, ENTER); // providers menu -> the "Continue" row
  await w.press(ENTER); // roles -> the saved role
}

describe('a tier screen for a config whose gateway this session never offered', () => {
  // A saved key can name a gateway no candidate in this session belongs to:
  // the harness that used to discover it is uninstalled, or this run never
  // offered it. The key is still in the config, and `sonata agents` still
  // ranks it through `[native.gateways]` — so the wizard has to offer the same
  // rows. It did not: with the gateway name missing, `<gateway>-<id>` never
  // loses its prefix, the catalog lookup misses, and a model AA scores at
  // several efforts collapses to the bare key the editor would refuse.
  const toml = [
    'schema_version = 1',
    '',
    '[native.gateways."acme"]',
    'base_url = "https://acme.example/v1"',
    '',
    '[models."acme-big"]',
    'gateway = "acme"',
    'id = "big"',
    'context_window = 1000000',
    '',
    '[tiers.code]',
    'simple = ["acme-big@max"]',
    'complex = ["acme-big@max"]',
    '',
  ].join('\n');

  let home: string;

  function savedConfigData(): WizardData {
    return {
      home,
      harnesses: [{ name: 'opencode', installed: true }],
      // The provider row survives; its models do not. That is the case: a
      // gateway the config declares, with no candidate to explain it.
      providers: [{ key: 'opencode/acme', harness: 'opencode', provider: 'acme', count: 2 }],
      candidates: [],
      roles: ['code'],
      byokProviders: [],
      storedKeys: {},
      fetchModels: async () => ({ outcome: 'ok', models: [] }),
      declaredGatewayNames: { project: ['acme'] },
      initialStateByScope: {
        project: {
          configScope: 'project',
          providerKeys: ['opencode/acme'],
          nativeKeys: ['acme-big'],
          roles: ['code'],
          tiers: { code: { simple: ['acme-big@max'], complex: ['acme-big@max'] } },
        },
      },
    };
  }

  it('offers the same rows as the rankable set, not the bare key', async () => {
    home = mkdtempSync(join(tmpdir(), 'sonata-wizard-home-'));
    const path = aaCatalogPath(home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      fetchedAt: '2026-09-13T00:00:00Z',
      models: {
        big: { codingIndex: 71, blendedPriceUsd: 0.45, agenticIndex: 42, costPerTask: 0.18, family: 'big', effort: 'max' },
        'big-high': { codingIndex: 60, blendedPriceUsd: 0.45, agenticIndex: 36, costPerTask: 0.04, family: 'big', effort: 'high' },
      },
    }));

    const w = renderWizard(savedConfigData());
    await walkToFirstTier(w);
    expect(w.lastFrame()).toContain('code: simple models');

    // The editor's own expansion of the same config is the parity target: it
    // reads the gateway names from `[native.gateways]`, not from a candidate
    // set. Asserted, so the fixture cannot quietly stop proving anything.
    const catalog = loadAaCatalog(home)!;
    const expected = rankableCandidates(parseConfig(toml), catalog);
    expect(expected).toEqual(['acme-big@high', 'acme-big@max']);
    expect([...offeredRows(w.lastFrame()!)].sort()).toEqual([...expected].sort());
  });

  it('loses the second effort level without the declared name, which is the bug', async () => {
    home = mkdtempSync(join(tmpdir(), 'sonata-wizard-home-'));
    const path = aaCatalogPath(home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      fetchedAt: '2026-09-13T00:00:00Z',
      models: {
        big: { codingIndex: 71, blendedPriceUsd: 0.45, agenticIndex: 42, costPerTask: 0.18, family: 'big', effort: 'max' },
        'big-high': { codingIndex: 60, blendedPriceUsd: 0.45, agenticIndex: 36, costPerTask: 0.04, family: 'big', effort: 'high' },
      },
    }));

    // The control: the same screen with no declared names, which is the
    // behaviour before the union. Without it the test above could pass on a
    // fixture whose gateway name was recoverable anyway.
    const w = renderWizard({ ...savedConfigData(), declaredGatewayNames: {} });
    await walkToFirstTier(w);

    const rows = offeredRows(w.lastFrame()!);
    expect(rows).toEqual(['acme-big@max']);
  });
});

describe('a tier screen for a harness-only config entry', () => {
  it("offers the tier editor effort variants", async () => {
    const home = mkdtempSync(join(tmpdir(), 'sonata-wizard-harness-only-'));
    const path = aaCatalogPath(home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      fetchedAt: '2026-09-13T00:00:00Z',
      models: {
        'gpt-5.6-luna': { codingIndex: 80, blendedPriceUsd: 1, agenticIndex: 55, costPerTask: 0.2, family: 'luna', effort: 'max' },
        'gpt-5.6-luna-high': { codingIndex: 70, blendedPriceUsd: 0.8, agenticIndex: 45, costPerTask: 0.1, family: 'luna', effort: 'high' },
      },
    }));
    const toml = [
      'schema_version = 1',
      '',
      '[native.gateways."acme"]',
      'base_url = "https://acme.example/v1"',
      '',
      '[models."acme-fast"]',
      'gateway = "acme"',
      'id = "fast"',
      'context_window = 128000',
      '',
      '[models."alias"]',
      'harness = "codex"',
      'id = "gpt-5.6-luna"',
      '',
      '[tiers.code]',
      'simple = ["alias@high"]',
      'complex = ["alias@max"]',
      '',
    ].join('\n');
    const config = parseConfig(toml);
    const w = renderWizard({
      home,
      harnesses: [{ name: 'opencode', installed: true }],
      providers: [{ key: 'opencode/acme', harness: 'opencode', provider: 'acme', count: 1 }],
      candidates: [],
      roles: ['code'],
      byokProviders: [],
      storedKeys: {},
      fetchModels: async () => ({ outcome: 'ok', models: [] }),
      declaredGatewayNames: { project: ['acme'] },
      harnessOnlyUpstreams: { project: { alias: 'gpt-5.6-luna' } },
      initialStateByScope: {
        project: {
          configScope: 'project',
          providerKeys: ['opencode/acme'],
          nativeKeys: ['acme-fast'],
          roles: ['code'],
          tiers: config.tiers,
        },
      },
    });

    await walkToFirstTier(w);
    const expected = rankableCandidates(config, loadAaCatalog(home)!);
    expect(expected).toContain('alias@high');
    expect(expected).toContain('alias@max');
    expect([...offeredRows(w.lastFrame()!)].sort()).toEqual([...expected].sort());
  });
});

describe('a tier screen for a gateway whose slug is a versionless alias', () => {
  // DeepSeek serves V4.1 Flash as `deepseek-flash`, which AA files under the
  // versioned `deepseek-v4-1-flash`; models.dev names the slug, and the
  // wizard has to rank through that name or the model is offered unscored
  // and bare — measured on a BYOK DeepSeek gateway, both of its models were.
  it('offers the effort variants the models.dev name resolves to', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sonata-wizard-alias-'));
    const path = aaCatalogPath(home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      fetchedAt: '2026-09-13T00:00:00Z',
      models: {
        'deepseek-v4-1-flash': { codingIndex: 60, blendedPriceUsd: 0.5, agenticIndex: 40, costPerTask: 0.2, family: 'deepseek-v4-1-flash', effort: 'max' },
        'deepseek-v4-1-flash-high': { codingIndex: 55, blendedPriceUsd: 0.5, agenticIndex: 36, costPerTask: 0.1, family: 'deepseek-v4-1-flash', effort: 'high' },
        'deepseek-v4-pro': { codingIndex: 59, blendedPriceUsd: 0.54, agenticIndex: 28, costPerTask: 0.12, family: 'deepseek-v4-pro', effort: 'max' },
        'deepseek-v4-pro-high': { codingIndex: 58, blendedPriceUsd: 0.54, agenticIndex: 27, costPerTask: 0.11, family: 'deepseek-v4-pro', effort: 'high' },
      },
    }));
    writeFileSync(join(dirname(path), 'models-dev.json'), JSON.stringify({
      fetchedAt: '2026-09-13T00:00:00Z',
      providers: { deepseek: { 'deepseek-flash': { input: 0.15, output: 0.6 } } },
      names: { deepseek: { 'deepseek-flash': 'DeepSeek V4.1 Flash' } },
    }));

    const w = renderWizard({
      home,
      harnesses: [{ name: 'opencode', installed: true }],
      providers: [{ key: 'byok/deepseek', harness: 'byok', provider: 'deepseek', count: 2 }],
      candidates: [
        { key: 'deepseek-deepseek-flash', gateway: 'deepseek', id: 'deepseek-flash', label: 'deepseek/deepseek-flash' },
        { key: 'deepseek-deepseek-v4-pro', gateway: 'deepseek', id: 'deepseek-v4-pro', label: 'deepseek/deepseek-v4-pro' },
      ],
      roles: ['code'],
      byokProviders: [],
      storedKeys: {},
      gatewayAuth: { deepseek: 'api-key' },
      fetchModels: async () => ({ outcome: 'ok', models: [] }),
      initialStateByScope: {
        project: {
          configScope: 'project',
          providerKeys: ['byok/deepseek'],
          nativeKeys: ['deepseek-deepseek-flash', 'deepseek-deepseek-v4-pro'],
          roles: ['code'],
        },
      },
    });
    await w.press(ENTER); // config scope -> project
    await w.press(DOWN, ENTER); // providers menu -> the "Continue" row
    await w.press(ENTER); // models -> the saved selection
    await w.press(ENTER); // roles -> the saved role
    expect(w.lastFrame()).toContain('code: simple models');
    expect([...offeredRows(w.lastFrame()!)].sort()).toEqual([
      'deepseek-deepseek-flash@high', 'deepseek-deepseek-flash@max',
      'deepseek-deepseek-v4-pro@high', 'deepseek-deepseek-v4-pro@max',
    ]);
  });
});
