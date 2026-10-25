import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cmdInit } from '../../src/commands/init.js';
import { discover } from '../../src/init/discover.js';
import type { Detector } from '../../src/init/discover.js';
import { scriptedState } from '../../src/init/scripted-state.js';
import { plan } from '../../src/init/plan.js';
import { loadConfig } from '../../src/config.js';
import { CURRENT_SCHEMA_VERSION } from '../../src/migrations.js';
import { nullInitLog } from '../../src/commands/init-log.js';

let home: string;
let cwd: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sonata-run-home-'));
  cwd = mkdtempSync(join(tmpdir(), 'sonata-run-cwd-'));
});

const detect: Detector = async () => ({
  tmux: { installed: true, version: '3.4', problems: [] },
  harnesses: [{
    name: 'opencode', installed: true, version: '1.18.16', supported: true, problems: [],
    refs: [{ harness: 'opencode', provider: 'acme', id: 'fast', ref: 'acme/fast' }],
    authedProviders: ['acme'],
    providerBaseUrls: { acme: 'https://acme.example/v1' },
  }],
});

const base = () => ({
  // Never reach PyPI from the suite.
  installLitellm: async (): Promise<void> => {},
  cwd, home, packageRoot: resolve('.'), detect, yes: true,
  providers: ['opencode/acme'], models: ['acme-fast'], roles: ['code'],
  configScope: 'project' as const, scope: 'skip' as const, routing: 'skip' as const,
  log: nullInitLog, write: () => {},
});

describe('a stranger’s first run', () => {
  it('writes a config that loads, plus agents and no hook', async () => {
    const res = await cmdInit(base());
    expect(existsSync(join(cwd, 'sonata.toml'))).toBe(true);
    expect(loadConfig(cwd, home).tiers?.code.simple).toEqual(['acme-fast']);
    expect(res.agentsWritten.length).toBeGreaterThan(0);
    expect(res.hookChanged).toBe(false);
  });

  it('is idempotent — a second run keeps the saved tiers', async () => {
    await cmdInit(base());
    const first = loadConfig(cwd, home).tiers;
    await cmdInit(base());
    expect(loadConfig(cwd, home).tiers).toEqual(first);
  });
});

describe('an unreadable existing config', () => {
  it('--yes refuses and writes nothing, naming the file and the error', async () => {
    // A parse failure is not a default to start from: rewriting it would
    // silently replace the user's tiers, prices and [budget] with a proposal.
    const before = 'avoid_gateways = ["ghost"]\n\n[budget]\ndaily_usd = 25\n';
    writeFileSync(join(cwd, 'sonata.toml'), before);
    await expect(cmdInit(base())).rejects.toThrow(/cannot be read/);
    // The file is untouched — and the refusal names both the file and why.
    expect(readFileSync(join(cwd, 'sonata.toml'), 'utf8')).toBe(before);
    try {
      await cmdInit(base());
    } catch (err) {
      expect(String(err)).toMatch(/sonata\.toml/);
      expect(String(err)).toMatch(/unknown gateway/);
    }
  });

  it('--yes refuses a newer-schema config rather than replacing it', async () => {
    // A stamp from the future is refused by applyMigrations on purpose — a
    // newer sonata may have moved a field this one still reads, so rewriting
    // it from defaults would delete work this sonata cannot even understand.
    const before = `schema_version = ${CURRENT_SCHEMA_VERSION + 1}\n`;
    writeFileSync(join(cwd, 'sonata.toml'), before);
    await expect(cmdInit(base())).rejects.toThrow(/cannot be read/);
    expect(readFileSync(join(cwd, 'sonata.toml'), 'utf8')).toBe(before);
  });

  it('--yes at the healthy scope proceeds when the other scope is broken', async () => {
    // The refusal is scoped to the file being written: a broken project
    // config must not block a global init, and vice versa. The broken file
    // is left untouched, and the healthy scope gets a working config.
    const brokenProject = 'avoid_gateways = ["ghost"]\n';
    writeFileSync(join(cwd, 'sonata.toml'), brokenProject);
    const lines: string[] = [];
    const res = await cmdInit({ ...base(), configScope: 'global', write: (l: string) => lines.push(l) });
    expect(res.configPath).toBe(join(home, '.config', 'sonata', 'sonata.toml'));
    // configPath prefers the project file, which is still broken — so read
    // the written file directly rather than through loadConfig.
    const { parseConfig } = await import('../../src/config.js');
    expect(parseConfig(readFileSync(join(home, '.config', 'sonata', 'sonata.toml'), 'utf8')).tiers?.code.simple)
      .toEqual(['acme-fast']);
    // The broken project file is never rewritten.
    expect(readFileSync(join(cwd, 'sonata.toml'), 'utf8')).toBe(brokenProject);
    expect(lines.join('\n')).toMatch(/not reading/);
  });

  it('--yes refuses when the broken file is at the chosen scope', async () => {
    // Mirror of the above: a broken global config blocks a global init but
    // not a project one.
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    const brokenGlobal = 'avoid_gateways = ["ghost"]\n';
    writeFileSync(join(home, '.config', 'sonata', 'sonata.toml'), brokenGlobal);
    await expect(cmdInit({ ...base(), configScope: 'global' })).rejects.toThrow(/cannot be read/);
    expect(readFileSync(join(home, '.config', 'sonata', 'sonata.toml'), 'utf8')).toBe(brokenGlobal);
    // And the project lane still proceeds.
    const res = await cmdInit(base());
    expect(res.configPath).toBe(join(cwd, 'sonata.toml'));
    expect(existsSync(join(cwd, 'sonata.toml'))).toBe(true);
    expect(readFileSync(join(home, '.config', 'sonata', 'sonata.toml'), 'utf8')).toBe(brokenGlobal);
  });
});

describe('front-end parity', () => {
  it('produces an identical InitPlan from the wizard state and the flag state', async () => {
    // The duplication this refactor removed arose by drift between the two
    // branches. Asserting the two plans are equal is what notices drift.
    //
    // The wizard state is written out as a literal on purpose. Deriving it
    // from `scripted` — even by spreading it — compares a value to a copy of
    // itself and passes no matter how far the two front ends diverge.
    const env = await discover({ cwd, home, packageRoot: resolve('.'), detect }, () => {});
    const opts = { cwd, home, packageRoot: resolve('.') };
    const credentials = {
      hasKey: () => false, hasOauthCredential: () => false,
      autoSource: () => null, copilotUsable: false,
    };

    const scripted = scriptedState(env, base()).state;

    // What the Ink wizard returns for the same choices: project scope, the one
    // provider ticked, the one model ticked, the `code` role, both tiers
    // ranked to that model, hook skipped, routing skipped.
    const fromWizard = {
      configScope: 'project' as const,
      harnesses: ['opencode'],
      providerKeys: ['opencode/acme'],
      nativeKeys: ['acme-fast'],
      roles: ['code'],
      tiers: { code: { simple: ['acme-fast'], complex: ['acme-fast'] } },
      perRoleModels: { code: ['acme-fast'] },
      credentialSources: {},
      // The wizard records the provider ranking in selection order — the same
      // choice `--providers` makes, since both front ends answer "which
      // providers, in what order".
      gatewayOrder: ['acme'],
      hookScope: 'skip' as const,
      routing: 'skip' as const,
    };

    // Guard the guard: if the two states already differ, the plan comparison
    // below is testing something other than what it claims.
    expect(fromWizard.nativeKeys).toEqual(scripted.nativeKeys);
    expect(fromWizard.roles).toEqual(scripted.roles);

    expect(plan(env, fromWizard, credentials, opts))
      .toEqual(plan(env, scripted, credentials, opts));
  });
});

describe('--auto-route and --auto-route-model', () => {
  it('writes, re-pins, keeps and removes [auto_route] the way the wizard would', async () => {
    await cmdInit({ ...base(), autoRoute: 'acme', autoRouteModel: 'decider-4b' });
    expect(loadConfig(cwd, home).autoRoute).toEqual({
      classifier: 'jev', baseUrl: 'https://acme.example', model: 'decider-4b', minConfidence: 0.5,
    });

    // `auto` drops the pin and keeps the provider.
    await cmdInit({ ...base(), autoRouteModel: 'auto' });
    expect(loadConfig(cwd, home).autoRoute).toEqual({ classifier: 'jev', baseUrl: 'https://acme.example', minConfidence: 0.5 });

    // No flag: the saved table is carried forward untouched.
    await cmdInit(base());
    expect(loadConfig(cwd, home).autoRoute?.baseUrl).toBe('https://acme.example');

    await cmdInit({ ...base(), autoRoute: 'off' });
    expect(loadConfig(cwd, home).autoRoute).toBeUndefined();
  });

  it('refuses a named provider with no stored key and writes nothing', async () => {
    await expect(cmdInit({ ...base(), autoRoute: 'typesafe' })).rejects.toThrow(/sonata auth add typesafe/);
    expect(existsSync(join(cwd, 'sonata.toml'))).toBe(false);
  });
});
