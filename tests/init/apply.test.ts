import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { apply } from '../../src/init/apply.js';
import { loadConfig } from '../../src/config.js';
import type { InitPlan } from '../../src/init/plan.js';

let home: string;
let cwd: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sonata-apply-home-'));
  cwd = mkdtempSync(join(tmpdir(), 'sonata-apply-cwd-'));
});

const planFor = (): InitPlan => ({
  configScope: 'project',
  configPath: join(cwd, 'sonata.toml'),
  configToml: [
    '[models."acme-fast"]', 'gateway = "acme"', 'id = "fast"', '',
    '[native.gateways."acme"]', 'base_url = "https://acme.example/v1"', '',
    '[tiers.code]', 'simple = ["acme-fast"]', 'complex = ["acme-fast"]', '',
  ].join('\n'),
  keysToStore: [],
  hook: { scope: 'skip' },
  skillPath: join(cwd, '.claude', 'skills', 'sonata-loop', 'SKILL.md'),
  routing: 'skip',
  syncCwd: cwd,
  agentsDir: join(cwd, '.claude', 'agents'),
  chosenNative: [], roles: ['code'], nativeKeys: ['acme-fast'],
  notices: [], summary: [],
});

describe('apply', () => {
  it('writes a config that loads back', async () => {
    await apply(planFor(), { cwd, home, packageRoot: resolve('.') }, { out: () => {}, prune: false });
    expect(loadConfig(cwd, home).tiers?.code.simple).toEqual(['acme-fast']);
  });

  it('installs the loop skill', async () => {
    const p = planFor();
    await apply(p, { cwd, home, packageRoot: resolve('.') }, { out: () => {}, prune: false });
    expect(existsSync(p.skillPath)).toBe(true);
    expect(readFileSync(p.skillPath, 'utf8')).toContain('sonata');
  });

  it('generates one agent file per role and tier', async () => {
    const res = await apply(planFor(), { cwd, home, packageRoot: resolve('.') }, { out: () => {}, prune: false });
    expect(res.agentsWritten.map((p) => p.split('/').pop()).sort()).toEqual(['code.md']);
  });

  it('asks before pruning and honours a refusal', async () => {
    let asked = false;
    const res = await apply(planFor(), { cwd, home, packageRoot: resolve('.') },
      { out: () => {}, prune: async () => { asked = true; return false; } });
    // Nothing stale on a fresh directory, so the callback must not fire.
    expect(asked).toBe(false);
    expect(res.pruned).toEqual([]);
  });
});

describe('apply — the litellm install', () => {
  it('runs the supplied installer when the planned config needs one', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'apply-lite-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'apply-lite-home-'));
    let installed: string | undefined;
    await apply(
      { ...planFor(), installLitellm: true },
      { cwd, home, packageRoot: resolve('.') },
      { out: () => {}, prune: false, installLitellm: async (h) => { installed = h; } },
    );
    expect(installed).toBe(home);
  });

  it('names the command rather than installing when no installer is supplied', async () => {
    // There is deliberately no default: an install is a multi-minute network
    // operation, and defaulting it made it the behaviour of every caller that
    // had not thought about it — 46 init tests reached PyPI that way.
    const cwd = mkdtempSync(join(tmpdir(), 'apply-lite2-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'apply-lite2-home-'));
    const out: string[] = [];
    await apply(
      { ...planFor(), installLitellm: true },
      { cwd, home, packageRoot: resolve('.') },
      { out: (l) => out.push(l), prune: false },
    );
    expect(out.join('\n')).toContain('sonata litellm install');
  });

  it('installs nothing when the planned config needs none', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'apply-lite3-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'apply-lite3-home-'));
    let called = false;
    await apply(
      { ...planFor(), installLitellm: false },
      { cwd, home, packageRoot: resolve('.') },
      { out: () => {}, prune: false, installLitellm: async () => { called = true; } },
    );
    expect(called).toBe(false);
  });
});
