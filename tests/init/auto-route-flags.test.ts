import { describe, expect, it } from 'vitest';
import { autoRouteFromFlags } from '../../src/init/auto-route-flags.js';

const saved = { classifier: 'jev' as const, baseUrl: 'https://api.typesafe.ai', model: 'jev-1.13', minConfidence: 0.5 };
const gateways = { acme: { baseUrl: 'https://gw.acme.example/v1', auth: 'api-key' as const } };
const ctx = (over: Partial<Parameters<typeof autoRouteFromFlags>[1]> = {}) => ({
  saved: undefined, gateways, keyFor: (gateway: string) => ({ typesafe: 'ts', openrouter: 'or' } as Record<string, string>)[gateway], ...over,
});

describe('autoRouteFromFlags', () => {
  it('leaves the saved table alone when neither flag is passed', () => {
    expect(autoRouteFromFlags({}, ctx({ saved }))).toBeUndefined();
  });

  it('turns auto-route off, and refuses a model alongside off', () => {
    expect(autoRouteFromFlags({ autoRoute: 'off' }, ctx({ saved }))).toBeNull();
    expect(() => autoRouteFromFlags({ autoRoute: 'off', autoRouteModel: 'x' }, ctx())).toThrow(/cannot be used with --auto-route off/);
  });

  it('names a provider by its key name, a configured gateway by its name, or a URL', () => {
    expect(autoRouteFromFlags({ autoRoute: 'openrouter' }, ctx())).toEqual({ baseUrl: 'https://openrouter.ai/api' });
    expect(autoRouteFromFlags({ autoRoute: 'TypeSafe' }, ctx())).toEqual({ baseUrl: 'https://api.typesafe.ai' });
    expect(autoRouteFromFlags({ autoRoute: 'acme' }, ctx())).toEqual({ baseUrl: 'https://gw.acme.example' });
    expect(autoRouteFromFlags({ autoRoute: 'http://localhost:8000/' }, ctx())).toEqual({ baseUrl: 'http://localhost:8000' });
  });

  it('refuses an unknown name and a URL the config parser would refuse', () => {
    expect(() => autoRouteFromFlags({ autoRoute: 'nope' }, ctx())).toThrow(/known: off, typesafe, openrouter, acme/);
    expect(() => autoRouteFromFlags({ autoRoute: 'https://decide.example?x=1' }, ctx())).toThrow(/query string/);
  });

  it('refuses a named provider with no stored key, naming the command that stores one', () => {
    expect(() => autoRouteFromFlags({ autoRoute: 'openrouter' }, ctx({ keyFor: () => undefined })))
      .toThrow(/sonata auth add openrouter/);
    // A self-hosted or gateway URL may need no key.
    expect(autoRouteFromFlags({ autoRoute: 'acme' }, ctx({ keyFor: () => undefined }))).toEqual({ baseUrl: 'https://gw.acme.example' });
  });

  it('pins a model, or answers auto to drop a saved pin', () => {
    expect(autoRouteFromFlags({ autoRoute: 'openrouter', autoRouteModel: '~typesafe/jev-1.14' }, ctx()))
      .toEqual({ baseUrl: 'https://openrouter.ai/api', model: '~typesafe/jev-1.14' });
    expect(autoRouteFromFlags({ autoRouteModel: 'auto' }, ctx({ saved })))
      .toEqual({ baseUrl: 'https://api.typesafe.ai', model: null });
  });

  it('needs a provider for a model: the flag or a saved table', () => {
    expect(() => autoRouteFromFlags({ autoRouteModel: 'x' }, ctx())).toThrow(/needs a decision provider/);
    expect(() => autoRouteFromFlags({ autoRoute: 'openrouter', autoRouteModel: ' ' }, ctx())).toThrow(/must name a model/);
  });
});
