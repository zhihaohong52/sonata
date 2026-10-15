import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NativeConfig } from '../../src/config.js';
import { writeSonataKey } from '../../src/native/credentials.js';
import { sessionsPath } from '../../src/sessions.js';
import { seedTrustOnUpgrade } from '../../src/native/trust-seed.js';
import {
  addTrustBinding, readTrustBindings, seedMarkerPath, seedUpgradeTrust, trustedHostsPath,
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
    expect(readFileSync(seedMarkerPath(home), 'utf8').trim()).toBe('0.16.5');
  });

  it('seeds an existing loopback http gateway, port-aware, and never a non-loopback http one', () => {
    const home = tmp();
    writeSonataKey(home, 'local', 'sk-local');
    writeSonataKey(home, 'remote', 'sk-remote');
    const lines = seedUpgradeTrust(home, '0.16.5', [{
      configPath: '/p/sonata.toml',
      gateways: {
        local: gw('http://localhost:4000/v1'),
        remote: gw('http://remote.example/v1'),
      },
    }]);
    expect(lines).toHaveLength(1);
    expect(readTrustBindings(home)).toEqual({ local: ['localhost:4000'] });
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
    expect(readFileSync(seedMarkerPath(home), 'utf8').trim()).toBe('0.16.5');
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

describe('seedTrustOnUpgrade — what predates the install', () => {
  const INSTALL = Date.parse('2026-01-01T00:00:00.000Z');
  const BEFORE = '2025-12-01T00:00:00.000Z';
  const AFTER = '2026-02-01T00:00:00.000Z';
  const OLD_FILE = new Date('2025-11-30T00:00:00.000Z');

  /** A project directory whose sonata.toml names `url`, its mtime set to `mtime` when given. */
  const project = (url: string, mtime?: Date): string => {
    const dir = tmp();
    const file = join(dir, 'sonata.toml');
    writeFileSync(file, `[native.gateways.acme]\nbase_url = "${url}"\n`);
    if (mtime !== undefined) utimesSync(file, mtime, mtime);
    return dir;
  };
  /** sessions.json with the given session records, keyed by session id. */
  const recordSessions = (home: string, records: Record<string, { cwd: string; started?: string }>): void => {
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    const doc = Object.fromEntries(Object.entries(records).map(([id, record]) => [id, { session: id, ...record }]));
    writeFileSync(sessionsPath(home), JSON.stringify(doc));
  };

  it('seeds a project a session recorded before the install ran in, when its config predates it', () => {
    const home = tmp();
    writeSonataKey(home, 'acme', 'sk-acme');
    const dir = project('https://proxy.example/v1', OLD_FILE);
    recordSessions(home, { s1: { cwd: dir, started: BEFORE } });
    expect(seedTrustOnUpgrade(home, INSTALL)).toHaveLength(1);
    expect(readTrustBindings(home)).toEqual({ acme: ['proxy.example'] });
  });

  it('does not seed a project first run after the install', () => {
    const home = tmp();
    writeSonataKey(home, 'acme', 'sk-acme');
    const dir = project('https://attacker.example/v1', OLD_FILE);
    recordSessions(home, { s1: { cwd: dir, started: AFTER } });
    expect(seedTrustOnUpgrade(home, INSTALL)).toEqual([]);
    expect(readTrustBindings(home)).toEqual({});
  });

  it('does not seed a config edited since the install, even under a pre-install session', () => {
    const home = tmp();
    writeSonataKey(home, 'acme', 'sk-acme');
    const dir = project('https://attacker.example/v1');
    recordSessions(home, { s1: { cwd: dir, started: BEFORE } });
    expect(seedTrustOnUpgrade(home, INSTALL)).toEqual([]);
    expect(readTrustBindings(home)).toEqual({});
  });

  it('never seeds a project with no readable session start time', () => {
    const home = tmp();
    writeSonataKey(home, 'acme', 'sk-acme');
    const dir = project('https://proxy.example/v1', OLD_FILE);
    recordSessions(home, { s1: { cwd: dir } });
    expect(seedTrustOnUpgrade(home, INSTALL)).toEqual([]);
  });

  it('never seeds the directory a command runs in, when no session recorded it', () => {
    const home = tmp();
    writeSonataKey(home, 'acme', 'sk-acme');
    project('https://attacker.example/v1', OLD_FILE);
    expect(seedTrustOnUpgrade(home, INSTALL)).toEqual([]);
    expect(readTrustBindings(home)).toEqual({});
  });

  it('seeds the machine config, which is trusted by definition', () => {
    const home = tmp();
    writeSonataKey(home, 'acme', 'sk-acme');
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(join(home, '.config', 'sonata', 'sonata.toml'), '[native.gateways.acme]\nbase_url = "https://machine.example/v1"\n');
    expect(seedTrustOnUpgrade(home, INSTALL)).toHaveLength(1);
    expect(readTrustBindings(home)).toEqual({ acme: ['machine.example'] });
  });

  it('writes the marker with no keys stored, so the seed runs exactly once', () => {
    const home = tmp();
    expect(seedTrustOnUpgrade(home, INSTALL)).toEqual([]);
    expect(existsSync(seedMarkerPath(home))).toBe(true);
  });

  it('seeds nothing on a fresh install, and a later install never seeds what it finds', () => {
    const home = tmp();
    const dir = project('https://attacker.example/v1', OLD_FILE);
    expect(seedTrustOnUpgrade(home, INSTALL)).toEqual([]);
    // A session recorded after the marker is written is never seeded later.
    writeSonataKey(home, 'acme', 'sk-acme');
    recordSessions(home, { s1: { cwd: dir, started: BEFORE } });
    expect(seedTrustOnUpgrade(home, INSTALL)).toEqual([]);
    expect(readTrustBindings(home)).toEqual({});
  });
});

describe('the seed marker is its own file', () => {
  it('does not re-seed after the trust file is deleted', () => {
    const home = tmp();
    writeSonataKey(home, 'acme', 'sk-acme');
    seedUpgradeTrust(home, '0.16.5', [{ configPath: '/a/sonata.toml', gateways: { acme: gw('https://first.example/v1') } }]);
    rmSync(trustedHostsPath(home));
    expect(seedUpgradeTrust(home, '0.16.6', [{ configPath: '/b/sonata.toml', gateways: { acme: gw('https://later.example/v1') } }])).toEqual([]);
    expect(readTrustBindings(home)).toEqual({});
  });

  it('migrates a legacy in-file marker, without seeding', () => {
    const home = tmp();
    writeSonataKey(home, 'acme', 'sk-acme');
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(trustedHostsPath(home), JSON.stringify({ seeded: '0.16.4' }));
    expect(seedUpgradeTrust(home, '0.16.5', [{ configPath: '/a/sonata.toml', gateways: { acme: gw('https://first.example/v1') } }])).toEqual([]);
    expect(existsSync(seedMarkerPath(home))).toBe(true);
    expect(readTrustBindings(home)).toEqual({});
  });

  it('never seeds over bindings already on disk, even with no marker', () => {
    const home = tmp();
    writeSonataKey(home, 'acme', 'sk-acme');
    addTrustBinding(home, 'other', 'manual.example');
    expect(seedUpgradeTrust(home, '0.16.5', [{ configPath: '/a/sonata.toml', gateways: { acme: gw('https://first.example/v1') } }])).toEqual([]);
    expect(readTrustBindings(home)).toEqual({ other: ['manual.example'] });
    expect(existsSync(seedMarkerPath(home))).toBe(true);
  });
});
