import { describe, it, expect } from 'vitest';
import { parseConfig, AUTO_ROUTE_DEFAULT_MIN_CONFIDENCE } from '../src/config.js';
import { nativeTomlFor } from '../src/init/toml.js';

const BASE = `
[models."m"]
gateway = "g"
id = "m-1"

[native.gateways."g"]
base_url = "https://g.example/v1"

[tiers.code]
simple = ["m"]
complex = ["m"]
`;

describe('[auto_route]', () => {
  it('is absent by default', () => {
    expect(parseConfig(BASE).autoRoute).toBeUndefined();
  });

  it('reads classifier and defaults min_confidence to 0.5', () => {
    const c = parseConfig(`[auto_route]\nclassifier = "jev"\n${BASE}`);
    expect(c.autoRoute).toEqual({ classifier: 'jev', provider: 'typesafe', minConfidence: AUTO_ROUTE_DEFAULT_MIN_CONFIDENCE });
    expect(AUTO_ROUTE_DEFAULT_MIN_CONFIDENCE).toBe(0.5);
  });

  it('reads an explicit min_confidence', () => {
    const c = parseConfig(`[auto_route]\nclassifier = "jev"\nmin_confidence = 0.3\n${BASE}`);
    expect(c.autoRoute?.minConfidence).toBe(0.3);
  });

  it.each([
    ['an unknown classifier', 'classifier = "gpt"'],
    ['a missing classifier', 'min_confidence = 0.5'],
    ['min_confidence above 1', 'classifier = "jev"\nmin_confidence = 1.5'],
    ['min_confidence below 0', 'classifier = "jev"\nmin_confidence = -0.1'],
    ['a string min_confidence', 'classifier = "jev"\nmin_confidence = "0.5"'],
    ['an unknown key', 'classifier = "jev"\nthreshold = 0.5'],
  ])('refuses %s', (_label, body) => {
    expect(() => parseConfig(`[auto_route]\n${body}\n${BASE}`)).toThrow(/\[auto_route\]/);
  });

  it('round-trips through nativeTomlFor', () => {
    const candidate = { key: 'g-m', gateway: 'g', id: 'm-1', contextWindow: 128000, baseUrl: 'https://g.example/v1', auth: 'api-key' as const };
    const toml = nativeTomlFor(
      { code: [candidate] }, {}, { code: { simple: ['g-m'], complex: ['g-m'] } },
      undefined, undefined, undefined, [], undefined, undefined, [],
      { classifier: 'jev', provider: 'typesafe', minConfidence: 0.4 },
    );
    expect(parseConfig(toml).autoRoute).toEqual({ classifier: 'jev', provider: 'typesafe', minConfidence: 0.4 });
  });

  it('writes nothing when absent', () => {
    const candidate = { key: 'g-m', gateway: 'g', id: 'm-1', contextWindow: 128000, baseUrl: 'https://g.example/v1', auth: 'api-key' as const };
    const toml = nativeTomlFor({ code: [candidate] }, {}, { code: { simple: ['g-m'], complex: ['g-m'] } });
    expect(toml).not.toContain('[auto_route]');
  });
});

describe('[auto_route] decision provider', () => {
  it('defaults to the typesafe provider with no model', () => {
    const c = parseConfig(`[auto_route]\nclassifier = "jev"\n${BASE}`);
    expect(c.autoRoute?.provider).toBe('typesafe');
    expect(c.autoRoute?.model).toBeUndefined();
  });

  it('reads the openrouter provider, defaulting its model to the jev-latest alias', () => {
    const c = parseConfig(`[auto_route]\nclassifier = "jev"\nprovider = "openrouter"\n${BASE}`);
    expect(c.autoRoute).toMatchObject({ provider: 'openrouter', model: '~typesafe/jev-latest' });
  });

  it('reads an explicit openrouter decision model', () => {
    const c = parseConfig(`[auto_route]\nclassifier = "jev"\nprovider = "openrouter"\nmodel = "typesafe/jev-1.13"\n${BASE}`);
    expect(c.autoRoute?.model).toBe('typesafe/jev-1.13');
  });

  it.each([
    ['an unknown provider', 'classifier = "jev"\nprovider = "acme"'],
    ['a model with the typesafe provider', 'classifier = "jev"\nprovider = "typesafe"\nmodel = "x"'],
    ['an empty model', 'classifier = "jev"\nprovider = "openrouter"\nmodel = ""'],
  ])('refuses %s', (_label, body) => {
    expect(() => parseConfig(`[auto_route]\n${body}\n${BASE}`)).toThrow(/\[auto_route\]/);
  });

  it('round-trips the openrouter provider and model through nativeTomlFor', () => {
    const c = parseConfig(`[auto_route]\nclassifier = "jev"\nprovider = "openrouter"\nmodel = "typesafe/jev-1.13"\n${BASE}`);
    const candidate = { key: 'g-m', gateway: 'g', id: 'm-1', contextWindow: 128000, baseUrl: 'https://g.example/v1', auth: 'api-key' as const };
    const toml = nativeTomlFor(
      { code: [candidate] }, {}, { code: { simple: ['g-m'], complex: ['g-m'] } },
      undefined, undefined, undefined, [], undefined, undefined, [],
      c.autoRoute,
    );
    expect(parseConfig(toml).autoRoute).toEqual(c.autoRoute);
  });

  it('writes no provider or model for the typesafe default', () => {
    const c = parseConfig(`[auto_route]\nclassifier = "jev"\n${BASE}`);
    const candidate = { key: 'g-m', gateway: 'g', id: 'm-1', contextWindow: 128000, baseUrl: 'https://g.example/v1', auth: 'api-key' as const };
    const toml = nativeTomlFor(
      { code: [candidate] }, {}, { code: { simple: ['g-m'], complex: ['g-m'] } },
      undefined, undefined, undefined, [], undefined, undefined, [],
      c.autoRoute,
    );
    expect(toml).not.toMatch(/^provider =|^model =/m);
  });
});
