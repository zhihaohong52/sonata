import { describe, expect, it } from 'vitest';
import { addedGatewayNames, hasModelsToPick, modelsStepCandidates, modelsStepSelection, stepBeforeRoles } from '../../src/tui-ink/app-state.js';
import type { CandidateOption } from '../../src/tui-ink/app-state.js';

const startup: CandidateOption[] = [
  { key: 'acme-fast', gateway: 'acme', id: 'fast', label: 'acme/fast' },
];

describe('addedGatewayNames', () => {
  it('names a BYOK gateway whose key was typed this run', () => {
    expect(addedGatewayNames({ byokKeys: { mylab: 'sk-x' } })).toEqual(['mylab']);
  });

  it('names a custom provider added this run', () => {
    expect(addedGatewayNames({ customProviders: [{ name: 'mylab', url: 'https://x.invalid/v1' }] })).toEqual(['mylab']);
  });

  it('names a gateway once when it is both', () => {
    expect(addedGatewayNames({
      byokKeys: { mylab: 'sk-x' },
      customProviders: [{ name: 'mylab', url: 'https://x.invalid/v1' }],
    })).toEqual(['mylab']);
  });

  it('is empty for a run that added nothing', () => {
    expect(addedGatewayNames({})).toEqual([]);
  });
});

describe('hasModelsToPick — whether the wizard may skip the models step', () => {
  // The blocking case: a custom or BYOK provider has no rows in
  // `data.candidates` *by design*, since that set is computed at startup. The
  // wizard decided whether to mount the models step from that set alone, so
  // when such a provider was the only one selected the step was skipped
  // entirely — the gateway was never asked what it serves, and wiring the
  // refresh into the step could not help because the step never ran.
  it('enters the step for an added gateway with no startup candidates', () => {
    expect(hasModelsToPick([], ['mylab'])).toBe(true);
  });

  it('enters the step for ordinary harness candidates', () => {
    expect(hasModelsToPick(startup, [])).toBe(true);
  });

  it('skips only when there is genuinely nothing to pick', () => {
    expect(hasModelsToPick([], [])).toBe(false);
  });
});

describe('stepBeforeRoles — Back from the Roles screen', () => {
  // Third place the same predicate was spelled out by hand, and the third to
  // drift: the wizard correctly *entered* the models step for an added-only
  // provider, but Back from Roles skipped over it to the providers screen,
  // because this call site still asked `candidates.length > 0`. Naming the
  // decision is what stops a fourth copy.
  it('returns to the models step when an added gateway supplied the models', () => {
    expect(stepBeforeRoles([], ['mylab'])).toBe(2);
  });

  it('returns to the models step for ordinary harness candidates', () => {
    expect(stepBeforeRoles(startup, [])).toBe(2);
  });

  it('skips back to providers only when the models step was never shown', () => {
    expect(stepBeforeRoles([], [])).toBe(1);
  });
});

describe('modelsStepCandidates — rows the models step draws', () => {
  it('adds the models picked on a session provider\'s own screen', () => {
    const rows = modelsStepCandidates(startup, { byokModels: { claude: ['claude-opus-5-5'] } }, { claude: 'session' });
    expect(rows.map((row) => row.key)).toEqual(['acme-fast', 'claude-claude-opus-5-5']);
  });

  it('adds an OAuth provider\'s picks too, since the /models refresh skips it', () => {
    const rows = modelsStepCandidates([], { byokModels: { codex: ['gpt-6-luna'] } }, { codex: 'codex-oauth' });
    expect(rows.map((row) => row.gateway)).toEqual(['codex']);
  });

  it('leaves an API-key provider to the /models refresh', () => {
    expect(modelsStepCandidates(startup, { byokModels: { mylab: ['m1'] } }, { mylab: 'api-key' })).toEqual(startup);
    expect(modelsStepCandidates(startup, { byokModels: { mylab: ['m1'] } }, {})).toEqual(startup);
  });

  it('does not repeat a model the startup list already has', () => {
    const existing = [{ key: 'claude-claude-opus-5-5', gateway: 'claude', id: 'claude-opus-5-5', label: 'claude/claude-opus-5-5' }];
    expect(modelsStepCandidates(existing, { byokModels: { claude: ['claude-opus-5-5'] } }, { claude: 'session' })).toEqual(existing);
  });

  it('does not repeat a model the startup list already holds under a different key', () => {
    // A codex harness row is keyed by bare id, while the pick on the OAuth
    // screen mints `codex-gpt-6-luna` — same (gateway, id), two keys.
    const existing = [{ key: 'gpt-6-luna', gateway: 'codex', id: 'gpt-6-luna', label: 'codex/gpt-6-luna' }];
    expect(modelsStepCandidates(existing, { byokModels: { codex: ['gpt-6-luna'] } }, { codex: 'codex-oauth' })).toEqual(existing);
  });

  it('makes the wizard enter the models step for a session provider alone', () => {
    const rows = modelsStepCandidates([], { byokModels: { claude: ['claude-opus-5-5'] } }, { claude: 'session' });
    expect(hasModelsToPick(rows, [])).toBe(true);
  });
});

describe('modelsStepSelection — a pick drawn under a different key follows its checkbox', () => {
  // The blocking case: the codex harness row is keyed by bare id `gpt-6-luna`,
  // while the pick minted on the OAuth screen is `codex-gpt-6-luna`. Matching
  // by key left the drawn row unchecked and kept the pick under its own key no
  // matter what the user did to the checkbox — one uncheck was ignored, one
  // check wrote the model to the config twice. Matching (gateway, id) lets the
  // row carry the pick either way.
  const codexRow: CandidateOption = { key: 'gpt-6-luna', gateway: 'codex', id: 'gpt-6-luna', label: 'codex/gpt-6-luna' };
  const codexPick = { nativeKeys: ['codex-gpt-6-luna'], byokModels: { codex: ['gpt-6-luna'] } };

  const submitted = (keys: string[], offered: CandidateOption[], state = codexPick) => {
    const kept = modelsStepSelection(state, offered).keptFor(offered);
    return [...new Set([...keys, ...kept])];
  };

  it('starts the drawn row checked when its pick was chosen under another key', () => {
    const selection = modelsStepSelection(codexPick, [codexRow]);
    expect(selection.initialSelected.has('gpt-6-luna')).toBe(true);
  });

  it('submit checked keeps the drawn key, not the pick key', () => {
    const result = submitted(['gpt-6-luna'], [codexRow]);
    expect(result).toContain('gpt-6-luna');
    expect(result).not.toContain('codex-gpt-6-luna');
  });

  it('submit unchecked drops both keys', () => {
    expect(submitted([], [codexRow])).toEqual([]);
  });

  it('keeps a pick the step never drew', () => {
    // The catalog filter hid it, or the gateway's live list omitted it: not
    // drawn either way, so it is kept as chosen on its provider's screen.
    const selection = modelsStepSelection(codexPick, []);
    expect(selection.keptFor([])).toEqual(['codex-gpt-6-luna']);
    expect(selection.keptFor([startup[0]!])).toEqual(['codex-gpt-6-luna']);
  });

  it('leaves a pick drawn under its own key to follow that checkbox', () => {
    // Unchanged behaviour for the ordinary case: checked keeps the pick's own
    // key, unchecked drops it — nothing is kept on the side.
    const claudeRow: CandidateOption = { key: 'claude-claude-opus-5-5', gateway: 'claude', id: 'claude-opus-5-5', label: 'claude/claude-opus-5-5' };
    const state = { nativeKeys: ['claude-claude-opus-5-5'], byokModels: { claude: ['claude-opus-5-5'] } };
    const selection = modelsStepSelection(state, [claudeRow]);
    expect(selection.initialSelected.has('claude-claude-opus-5-5')).toBe(true);
    expect(selection.keptFor([claudeRow])).toEqual([]);
  });
});
