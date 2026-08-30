import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discover } from '../../src/init/discover.js';

let home: string;
let cwd: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sonata-disc-home-'));
  cwd = mkdtempSync(join(tmpdir(), 'sonata-disc-cwd-'));
});

const detector = async () => ({
  tmux: { installed: true, version: '3.4', problems: [] },
  harnesses: [],
});

describe('discover', () => {
  it('warns rather than errors when no harness offers a provider', async () => {
    const env = await discover({ cwd, home, packageRoot: cwd, detect: detector }, () => {});
    expect(env.problems.every((p) => p.severity !== 'error')).toBe(true);
    expect(env.problems.map((p) => p.message)).toContain('no harness reported a usable model provider');
  });

  it('offers a gateway named only by the config as a config/ provider', async () => {
    writeFileSync(join(cwd, 'sonata.toml'), [
      '[models."acme-fast"]',
      'gateway = "acme"',
      'id = "fast"',
      '',
      '[native.gateways."acme"]',
      'base_url = "https://gateway.acme.example/v1"',
      '',
      '[tiers.code]',
      'simple = ["acme-fast"]',
      'complex = ["acme-fast"]',
    ].join('\n'));
    const env = await discover({ cwd, home, packageRoot: cwd, detect: detector }, () => {});
    expect(env.offered.map((p) => p.key)).toContain('config/acme');
  });

  it('reports no existing hook scope on a machine with no settings', async () => {
    const env = await discover({ cwd, home, packageRoot: cwd, detect: detector }, () => {});
    expect(env.existingHookScope).toBeUndefined();
  });

  const twoHarnessDetector = async () => ({
    tmux: { installed: true, version: '3.4', problems: [] },
    harnesses: [
      {
        name: 'opencode', installed: true, version: '1.18.16', problems: [],
        refs: [{ harness: 'opencode', provider: 'shared-gw', id: 'a', ref: 'shared-gw/a' }],
        authedProviders: ['shared-gw'],
        providerBaseUrls: { 'shared-gw': 'https://shared.example/v1' },
      },
      {
        name: 'pi', installed: true, version: '0.9.0', problems: [],
        refs: [{ harness: 'pi', provider: 'shared-gw', id: 'a', ref: 'shared-gw/a' }],
        authedProviders: ['shared-gw'],
        providerBaseUrls: { 'shared-gw': 'https://shared.example/v1' },
      },
    ],
  });

  it('offers a config/ provider for a gateway two harnesses both catalogue', async () => {
    // deriveInitState emits `config/<gateway>` for an ambiguous gateway, so
    // `offered` must contain that key or the --yes path rejects a config it
    // just derived from the user's own sonata.toml.
    //
    // The config write is load-bearing: `configuredGateways` is built from the
    // loaded configs, so a gateway only earns a `config/` row if sonata.toml
    // names it. Without this the test would fail for the wrong reason.
    writeFileSync(join(cwd, 'sonata.toml'), [
      '[models."shared-gw-a"]',
      'gateway = "shared-gw"',
      'id = "a"',
      '',
      '[native.gateways."shared-gw"]',
      'base_url = "https://shared.example/v1"',
      '',
      '[tiers.code]',
      'simple = ["shared-gw-a"]',
      'complex = ["shared-gw-a"]',
    ].join('\n'));

    const env = await discover(
      { cwd, home, packageRoot: cwd, detect: twoHarnessDetector }, () => {});
    expect(env.offered.map((p) => p.key)).toContain('config/shared-gw');
    // The harness rows survive alongside it — they are what the picker shows.
    expect(env.offered.map((p) => p.key)).toEqual(
      expect.arrayContaining(['opencode/shared-gw', 'pi/shared-gw']));
  });
});
