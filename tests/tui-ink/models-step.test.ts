import { describe, expect, it } from 'vitest';
import { refreshableGateways } from '../../src/tui-ink/components/models-step.js';
import type { CandidateOption } from '../../src/tui-ink/app-state.js';

const candidates: CandidateOption[] = [
  { key: 'acme-a', gateway: 'acme', id: 'a', label: 'acme/a' },
  { key: 'chatgpt-b', gateway: 'chatgpt', id: 'b', label: 'chatgpt/b' },
  { key: 'nokey-c', gateway: 'nokey', id: 'c', label: 'nokey/c' },
  { key: 'nourl-d', gateway: 'nourl', id: 'd', label: 'nourl/d' },
];

const baseUrls = {
  acme: 'https://acme.example/v1',
  chatgpt: 'https://chatgpt.example/v1',
  nokey: 'https://nokey.example/v1',
};

const keys = { acme: 'sk-a', chatgpt: 'sk-b', nourl: 'sk-d' };

describe('refreshableGateways', () => {
  it('queries a gateway with both a base URL and a key', () => {
    expect(refreshableGateways(candidates, baseUrls, {}, keys)).toContain('acme');
  });

  it('skips an OAuth gateway, whose credential is not a bearer key', () => {
    // A subscription credential cannot authenticate GET /models, and these
    // gateways do not serve an OpenAI-shaped one anyway.
    const auth = { chatgpt: 'codex-oauth' as const };
    expect(refreshableGateways(candidates, baseUrls, auth, keys)).not.toContain('chatgpt');
  });

  it('skips a gateway with no resolvable key', () => {
    expect(refreshableGateways(candidates, baseUrls, {}, keys)).not.toContain('nokey');
  });

  it('skips a gateway with no known base URL', () => {
    expect(refreshableGateways(candidates, baseUrls, {}, keys)).not.toContain('nourl');
  });

  it('returns each gateway once even when it serves many models', () => {
    const many: CandidateOption[] = [
      { key: 'acme-a', gateway: 'acme', id: 'a', label: 'acme/a' },
      { key: 'acme-b', gateway: 'acme', id: 'b', label: 'acme/b' },
    ];
    expect(refreshableGateways(many, baseUrls, {}, keys)).toEqual(['acme']);
  });
});

describe('refreshableGateways — a provider added during this run', () => {
  // The defect this exists to prevent, reported from a real wizard run: after
  // adding a provider and typing its key, models could be chosen on that
  // provider's own screen, and then were "not available for selection" on the
  // models step. `candidates` is `allNativeCandidates`, computed at startup,
  // so a gateway that did not exist then contributes no rows — and deriving
  // the refreshable set from it excluded exactly the provider whose key the
  // user had just typed. The gateway was never asked what it serves, so the
  // picker had nothing to show.
  const added = { ...baseUrls, mylab: 'https://mylab.example/v1' };
  const withKey = { ...keys, mylab: 'sk-just-typed' };

  it('queries a gateway that has a key and a base URL but no startup candidates', () => {
    expect(refreshableGateways(candidates, added, {}, withKey, ['mylab'])).toContain('mylab');
  });

  it('still queries the gateways the harness listed', () => {
    expect(refreshableGateways(candidates, added, {}, withKey, ['mylab'])).toContain('acme');
  });

  it('never lists a gateway twice when it is both listed and named', () => {
    const out = refreshableGateways(candidates, added, {}, withKey, ['acme']);
    expect(out.filter((g) => g === 'acme')).toHaveLength(1);
  });

  // The existing exclusions are not weakened: an added gateway still has to
  // clear them, or the wizard asks an endpoint that cannot answer.
  it('excludes an added gateway with no resolvable key', () => {
    expect(refreshableGateways(candidates, added, {}, keys, ['mylab'])).not.toContain('mylab');
  });

  it('excludes an added gateway with no base URL', () => {
    expect(refreshableGateways(candidates, baseUrls, {}, withKey, ['mylab'])).not.toContain('mylab');
  });

  it('excludes an added OAuth gateway, whose credential is not a bearer key', () => {
    expect(refreshableGateways(candidates, added, { mylab: 'codex-oauth' }, withKey, ['mylab'])).not.toContain('mylab');
  });
});
