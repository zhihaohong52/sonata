import { describe, expect, it } from 'vitest';
import { addedGatewayNames, hasModelsToPick, modelsStepCandidates, stepBeforeRoles } from '../../src/tui-ink/app-state.js';
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
