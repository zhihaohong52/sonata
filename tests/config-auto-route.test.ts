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
    expect(c.autoRoute).toEqual({ classifier: 'jev', baseUrl: 'https://api.typesafe.ai', minConfidence: AUTO_ROUTE_DEFAULT_MIN_CONFIDENCE });
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
      { classifier: 'jev', baseUrl: 'https://api.typesafe.ai', minConfidence: 0.4 },
    );
    expect(parseConfig(toml).autoRoute).toEqual({ classifier: 'jev', baseUrl: 'https://api.typesafe.ai', minConfidence: 0.4 });
  });

  it('writes nothing when absent', () => {
    const candidate = { key: 'g-m', gateway: 'g', id: 'm-1', contextWindow: 128000, baseUrl: 'https://g.example/v1', auth: 'api-key' as const };
    const toml = nativeTomlFor({ code: [candidate] }, {}, { code: { simple: ['g-m'], complex: ['g-m'] } });
    expect(toml).not.toContain('[auto_route]');
  });
});

describe('[auto_route] base_url and model', () => {
  it('defaults base_url to TypeSafe and leaves model unset', () => {
    const c = parseConfig(`[auto_route]\nclassifier = "jev"\n${BASE}`);
    expect(c.autoRoute).toEqual({ classifier: 'jev', baseUrl: 'https://api.typesafe.ai', minConfidence: 0.5 });
  });

  it('reads any http(s) base_url, without a trailing slash, and a pinned model', () => {
    const c = parseConfig(`[auto_route]\nclassifier = "jev"\nbase_url = "http://localhost:8000/"\nmodel = "bosun-v3.1-1.7b"\n${BASE}`);
    expect(c.autoRoute).toMatchObject({ baseUrl: 'http://localhost:8000', model: 'bosun-v3.1-1.7b' });
  });

  it.each([
    ['provider (removed)', 'classifier = "jev"\nprovider = "openrouter"'],
    ['a relative base_url', 'classifier = "jev"\nbase_url = "openrouter.ai/api"'],
    ['a non-http base_url', 'classifier = "jev"\nbase_url = "ftp://x.example"'],
    ['a non-string base_url', 'classifier = "jev"\nbase_url = 5'],
    ['an empty model', 'classifier = "jev"\nmodel = ""'],
  ])('refuses %s', (_label, body) => {
    expect(() => parseConfig(`[auto_route]\n${body}\n${BASE}`)).toThrow(/\[auto_route\]/);
  });

  const candidate = { key: 'g-m', gateway: 'g', id: 'm-1', contextWindow: 128000, baseUrl: 'https://g.example/v1', auth: 'api-key' as const };
  const write = (autoRoute: ReturnType<typeof parseConfig>['autoRoute']) => nativeTomlFor(
    { code: [candidate] }, {}, { code: { simple: ['g-m'], complex: ['g-m'] } },
    undefined, undefined, undefined, [], undefined, undefined, [], autoRoute,
  );

  it('round-trips base_url and model', () => {
    const c = parseConfig(`[auto_route]\nclassifier = "jev"\nbase_url = "https://openrouter.ai/api"\nmodel = "typesafe/jev-1.13"\n${BASE}`);
    expect(parseConfig(write(c.autoRoute)).autoRoute).toEqual(c.autoRoute);
  });

  it('writes a 0.15.0 config back without base_url or model', () => {
    const c = parseConfig(`[auto_route]\nclassifier = "jev"\nmin_confidence = 0.5\n${BASE}`);
    const toml = write(c.autoRoute);
    expect(toml).toContain('[auto_route]\nclassifier = "jev"\nmin_confidence = 0.5\n');
    const section = toml.slice(toml.indexOf('[auto_route]'), toml.indexOf('\n\n', toml.indexOf('[auto_route]')));
    expect(section).not.toMatch(/^(base_url|model|provider) =/m);
  });
});
