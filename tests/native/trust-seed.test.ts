import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NativeConfig } from '../../src/config.js';
import { writeSonataKey } from '../../src/native/credentials.js';
import {
  addTrustBinding, readTrustBindings, seedUpgradeTrust, trustedHostsPath,
} from '../../src/native/host-bindings.js';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'sonata-seed-'));
const gw = (baseUrl: string, auth: 'api-key' = 'api-key'): NativeConfig['gateways'][string] => ({ baseUrl, auth });

describe('seedUpgradeTrust', () => {
  it('binds each keyed https gateway to its URL host, and records the marker', () => {
    const home = tmp();
    writeSonataKey(home, 'acme', 'sk-acme');
    const lines = seedUpgradeTrust(home, '0.16.5', [
      { configPath: '/work/sonata.toml', gateways: { acme: gw('https://proxy.example/v1') } },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('/work/sonata.toml');
    expect(readTrustBindings(home)).toEqual({ acme: ['proxy.example'] });
    expect(JSON.parse(readFileSync(trustedHostsPath(home), 'utf8'))).toMatchObject({ seeded: '0.16.5' });
  });

  it('seeds nothing for a gateway with no key, a plain-http URL, or a non-key auth', () => {
    const home = tmp();
    writeSonataKey(home, 'plain', 'sk-plain');
    writeSonataKey(home, 'insecure', 'sk-insecure');
    const lines = seedUpgradeTrust(home, '0.16.5', [{
      configPath: '/work/sonata.toml',
      gateways: {
        nokey: gw('https://nokey.example/v1'),
        plain: gw('https://plain.example/v1'),
        insecure: gw('http://insecure.example/v1'),
        session: { baseUrl: 'https://api.anthropic.com/v1', auth: 'session' },
      },
    }]);
    expect(lines.map((line) => line.split(' ')[1])).toEqual(['plain.example']);
    expect(readTrustBindings(home)).toEqual({ plain: ['plain.example'] });
  });

  it('seeds once: a config first seen after the marker is never seeded', () => {
    const home = tmp();
    writeSonataKey(home, 'acme', 'sk-acme');
    seedUpgradeTrust(home, '0.16.5', [{ configPath: '/a/sonata.toml', gateways: { acme: gw('https://first.example/v1') } }]);
    const again = seedUpgradeTrust(home, '0.16.6', [
      { configPath: '/a/sonata.toml', gateways: { acme: gw('https://first.example/v1') } },
      { configPath: '/b/sonata.toml', gateways: { acme: gw('https://later.example/v1') } },
    ]);
    expect(again).toEqual([]);
    expect(readTrustBindings(home)).toEqual({ acme: ['first.example'] });
  });

  it('keeps the marker through later trust writes, so the seed never reruns', () => {
    const home = tmp();
    writeSonataKey(home, 'acme', 'sk-acme');
    seedUpgradeTrust(home, '0.16.5', [{ configPath: '/a/sonata.toml', gateways: { acme: gw('https://first.example/v1') } }]);
    addTrustBinding(home, 'acme', 'manual.example');
    expect(JSON.parse(readFileSync(trustedHostsPath(home), 'utf8'))).toMatchObject({ seeded: '0.16.5' });
    expect(seedUpgradeTrust(home, '0.16.6', [{ configPath: '/b/sonata.toml', gateways: { acme: gw('https://later.example/v1') } }])).toEqual([]);
  });

  it('refuses a corrupt trust file, naming it, and leaves it as it was', () => {
    const home = tmp();
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(trustedHostsPath(home), '{torn');
    expect(() => seedUpgradeTrust(home, '0.16.5', [])).toThrow(/trusted-hosts\.json is not valid JSON/);
    expect(readFileSync(trustedHostsPath(home), 'utf8')).toBe('{torn');
  });

  it('keeps the marker out of the bindings a reader sees', () => {
    const home = tmp();
    seedUpgradeTrust(home, '0.16.5', []);
    expect(readTrustBindings(home)).toEqual({});
  });
});

describe('the seed marker name', () => {
  it('is reserved: no gateway may be trusted under it', () => {
    expect(() => addTrustBinding(tmp(), 'seeded', 'proxy.example')).toThrow(/reserved/);
  });
});

describe('seedTrustOnUpgrade', () => {
  it('seeds nothing on a fresh install, and the marker keeps a later key from being seeded', async () => {
    const { seedTrustOnUpgrade } = await import('../../src/native/trust-seed.js');
    const { TenantRegistry } = await import('../../src/native/tenants.js');
    const home = tmp();
    const cwd = tmp();
    writeFileSync(join(cwd, 'sonata.toml'), '[native.gateways.acme]\nbase_url = "https://attacker.example/v1"\n');
    const registry = new TenantRegistry(home);
    registry.noteProject(cwd);
    // First run on a fresh machine: no sonata state yet, so nothing predates it.
    expect(seedTrustOnUpgrade(home, registry)).toEqual([]);
    // The key and the repo's config arrive afterwards: the marker is already there.
    writeSonataKey(home, 'acme', 'sk-acme');
    expect(seedTrustOnUpgrade(home, registry)).toEqual([]);
    expect(readTrustBindings(home)).toEqual({});
    expect(JSON.parse(readFileSync(trustedHostsPath(home), 'utf8'))).toHaveProperty('seeded');
  });
});
