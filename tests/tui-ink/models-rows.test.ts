import { describe, it, expect } from 'vitest';
import { modelRows, modelsUntiered } from '../../src/tui-ink/screens/models-rows.js';
import type { SonataConfig } from '../../src/config.js';

const config = (unifiedModels: SonataConfig['unifiedModels'], tiers: SonataConfig['tiers']): SonataConfig => ({
  models: {}, unifiedModels, tiers,
});

describe('modelRows', () => {
  it('shows native, harness-only, multi-tier, effort-pinned, and untiered models', () => {
    const rows = modelRows(config({
      native: { gateway: 'acme', id: 'model-a', contextWindow: 128000 },
      fallback: { harness: 'opencode', harnessId: 'openrouter/model-b' },
      both: { gateway: 'acme', id: 'model-c', contextWindow: 128000, harness: 'codex', harnessId: 'model-c' },
      unused: { gateway: 'acme', id: 'model-d', contextWindow: 128000 },
    }, {
      code: { simple: ['native', 'both@high'], normal: ['both'], complex: ['fallback'] },
      review: { simple: ['both@low'], complex: ['native'] },
    }));
    expect(rows).toEqual([
      { key: 'native', route: 'acme/model-a', tiers: ['code-simple', 'review-complex'] },
      { key: 'fallback', route: 'opencode/openrouter/model-b', tiers: ['code-complex'] },
      { key: 'both', route: 'acme/model-c', tiers: ['code-simple', 'code-normal', 'review-simple'] },
      { key: 'unused', route: 'acme/model-d', tiers: [] },
    ]);
  });
});

describe('modelsUntiered', () => {
  it('returns only models that no tier can reach', () => {
    expect(modelsUntiered([
      { key: 'a', route: 'gw/a', tiers: [] },
      { key: 'b', route: 'gw/b', tiers: ['code-simple'] },
    ])).toEqual(['a']);
  });
});
