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
