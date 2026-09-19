// probe

import { describe, expect, it } from 'vitest';
import { editorCandidates, itemLabel } from '../../src/commands/agents.js';

describe('tiers screen candidates', () => {
  it('builds items from configured candidates', () => {
    const config = {
      unifiedModels: {
        flash: { gateway: 'acme', id: 'flash', contextWindow: 1000 },
        local: { harness: 'opencode', harnessId: 'local' },
      },
      native: { gateways: { acme: { baseUrl: 'https://example.test' } } },
      tiers: { code: { simple: ['flash'], complex: ['local'] } },
    } as any;
    const candidates = editorCandidates(config);
    const items = candidates.map((candidate) => ({ value: candidate, label: itemLabel(config, candidate) }));
    expect(items.map((item) => item.value)).toEqual(['flash', 'local']);
  });
});
