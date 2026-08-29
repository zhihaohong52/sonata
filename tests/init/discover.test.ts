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
});