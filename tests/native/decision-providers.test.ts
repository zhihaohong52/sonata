import { describe, expect, it } from 'vitest';
import {
  DECISION_PROVIDERS, autoRoutePin, configuredDecisionGateway, decisionBaseUrlForGateway,
  decisionGatewayCandidates, decisionProviderFor,
} from '../../src/native/decision-providers.js';
import { defaultDecisionModel } from '../../src/native/decision-models.js';

describe('DECISION_PROVIDERS', () => {
  it('drives the named host, its key name and its default model from one row', () => {
    for (const provider of DECISION_PROVIDERS) {
      expect(decisionProviderFor(provider.baseUrl)?.gateway).toBe(provider.gateway);
      expect(defaultDecisionModel(provider.baseUrl)).toBe(provider.defaultModel);
    }
    expect(decisionProviderFor('https://decide.example')).toBeUndefined();
    expect(decisionProviderFor('not a url')).toBeUndefined();
  });
});

describe('a configured gateway as a decision provider', () => {
  const gateways = {
    acme: { baseUrl: 'https://gw.acme.example/v1', auth: 'api-key' as const },
    sub: { baseUrl: 'https://sub.example/v1', auth: 'codex-oauth' as const },
    or: { baseUrl: 'https://openrouter.ai/api/v1', auth: 'api-key' as const },
  };

  it('asks a gateway at its base_url without the trailing /v1', () => {
    expect(decisionBaseUrlForGateway('https://gw.acme.example/v1/')).toBe('https://gw.acme.example');
    expect(decisionBaseUrlForGateway('https://gw.acme.example/proxy')).toBe('https://gw.acme.example/proxy');
  });

  it('offers only api-key gateways whose host no named provider owns', () => {
    expect(decisionGatewayCandidates(gateways)).toEqual([{ gateway: 'acme', baseUrl: 'https://gw.acme.example' }]);
    expect(decisionGatewayCandidates(undefined)).toEqual([]);
  });

  it('matches by host, port included, and refuses an ambiguous host', () => {
    expect(configuredDecisionGateway('https://gw.acme.example', gateways)).toBe('acme');
    expect(configuredDecisionGateway('https://gw.acme.example:8443', gateways)).toBeUndefined();
    expect(configuredDecisionGateway('https://gw.acme.example', {
      ...gateways, twin: { baseUrl: 'https://gw.acme.example/other' },
    })).toBeUndefined();
  });
});

describe('autoRoutePin', () => {
  it('takes the model screen\'s answer, else keeps a saved pin only on its own URL', () => {
    expect(autoRoutePin({ baseUrl: 'https://a', model: 'm2' }, 'https://a', 'm1')).toBe('m2');
    expect(autoRoutePin({ baseUrl: 'https://a', model: null }, 'https://a', 'm1')).toBeUndefined();
    expect(autoRoutePin({ baseUrl: 'https://a' }, 'https://a', 'm1')).toBe('m1');
    expect(autoRoutePin({ baseUrl: 'https://b' }, 'https://a', 'm1')).toBeUndefined();
  });
});
