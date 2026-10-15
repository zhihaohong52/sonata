import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../../src/config.js';
import { envVarForGateway } from '../../src/native/gateway-env.js';
import { providerForBaseUrl } from '../../src/native/providers.js';
import { sharedPlanFor } from '../../src/plans.js';
import type { NativeConfig } from '../../src/config.js';
import { resolveKeys, writeSonataKey } from '../../src/native/credentials.js';
import { addTrustBinding, readTrustBindings, seedMarkerPath, seedUpgradeTrust, trustedHostsPath } from '../../src/native/host-bindings.js';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'proto-names-'));
const gwToml = (name: string): string => `[native.gateways."${name}"]\nbase_url = "https://gateway.example/v1"\n`;

describe('gateway names that sonata cannot key by', () => {
  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty', 'seeded', ''])(
    'refuses %j',
    (name) => {
      expect(() => parseConfig(gwToml(name))).toThrow(/name is not allowed/);
    },
  );

  it('refuses a name with a control character', () => {
    expect(() => parseConfig(gwToml('a\tb'))).toThrow(/is not allowed/);
  });

  it.each(['acme', 'github-copilot', 'acme_prod', 'Foo', 'acme-2', 'gw.a', 'bad name', 'a/b'])(
    'accepts %j',
    (name) => {
      expect(parseConfig(gwToml(name)).native?.gateways[name]?.baseUrl).toBe('https://gateway.example/v1');
    },
  );

  it('maps a name with a space to a plain key variable, and refuses two names that fold to one', () => {
    expect(envVarForGateway('bad name')).toBe('SONATA_KEY_BAD_NAME');
    expect(envVarForGateway('a.b')).toBe('SONATA_KEY_A_B');
    expect(envVarForGateway('github-copilot')).toBe('SONATA_KEY_GITHUB_COPILOT');
    expect(() => parseConfig(`${gwToml('bad name')}\n${gwToml('bad_name')}`)).toThrow(/would share the key variable SONATA_KEY_BAD_NAME/);
  });
});

describe('trust file with prototype-named keys', () => {
  it('reads them as ordinary gateways, with no inherited values', () => {
    const home = tmp();
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(trustedHostsPath(home), '{"__proto__":["a.example"],"constructor":["b.example"]}');
    const bindings = readTrustBindings(home);
    expect(Object.getPrototypeOf(bindings)).toBeNull();
    expect(bindings.constructor).toEqual(['b.example']);
    expect(bindings.toString).toBeUndefined();
  });

  it('writes a binding under a prototype-named gateway without throwing', () => {
    const home = tmp();
    addTrustBinding(home, 'constructor', 'b.example');
    expect(readTrustBindings(home).constructor).toEqual(['b.example']);
  });
});

describe('the seed over a prototype-named gateway', () => {
  it('completes, binds the host, and writes the marker', () => {
    const home = tmp();
    writeSonataKey(home, 'constructor', 'sk-proto');
    const gateways = Object.fromEntries([['constructor', { baseUrl: 'https://b.example/v1', auth: 'api-key' as const }]]) as NativeConfig['gateways'];
    const lines = seedUpgradeTrust(home, '0.16.5', [{ configPath: '/p/sonata.toml', gateways }]);
    expect(lines).toHaveLength(1);
    expect(readTrustBindings(home).constructor).toEqual(['b.example']);
    expect(readFileSync(seedMarkerPath(home), 'utf8').trim()).toBe('0.16.5');
  });
});

describe('key lookup for prototype-named gateways', () => {
  it('finds no key for a name only an inherited property would answer', () => {
    expect(resolveKeys(['constructor', 'toString', '__proto__'], tmp())).toEqual([]);
  });

  it('finds a key stored under such a name, and no other', () => {
    const home = tmp();
    writeSonataKey(home, 'constructor', 'sk-proto');
    const found = resolveKeys(['constructor', 'toString'], home);
    expect(found.map((hit) => hit.gateway)).toEqual(['constructor']);
    expect(found[0]?.key).toBe('sk-proto');
  });
});

describe('the tolerant reader on an absent or corrupt file', () => {
  it('answers a null-prototype map, so a prototype name reads as no binding', () => {
    expect(Object.getPrototypeOf(readTrustBindings(tmp()))).toBeNull();
    expect(readTrustBindings(tmp()).constructor).toBeUndefined();
  });
});

describe('name-keyed lookups read own entries only', () => {
  it('refuses a model that names a gateway which does not exist, even one named after an inherited property', () => {
    const toml = `
[models."m-flash"]
gateway = "constructor"
id = "m-flash"
[tiers.code]
simple = ["m-flash"]
complex = ["m-flash"]
[native.gateways."acme"]
base_url = "https://gateway.example/v1"
`;
    expect(() => parseConfig(toml)).toThrow(/constructor/);
  });

  it('answers a host named after an Object.prototype property with no shared plan', () => {
    expect(sharedPlanFor('https://constructor/v1')).toBeUndefined();
    expect(sharedPlanFor('https://toString/v1')).toBeUndefined();
  });

  it('answers a gateway named after an Object.prototype property with the default provider', () => {
    expect(providerForBaseUrl('constructor')).toBe('openai');
    expect(providerForBaseUrl('toString')).toBe('openai');
  });
});
