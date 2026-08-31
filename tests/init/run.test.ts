import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cmdInit } from '../../src/commands/init.js';
import { discover } from '../../src/init/discover.js';
import { scriptedState } from '../../src/init/scripted-state.js';
import { plan } from '../../src/init/plan.js';
import { loadConfig } from '../../src/config.js';
import { nullInitLog } from '../../src/commands/init-log.js';

let home: string;
let cwd: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sonata-run-home-'));
  cwd = mkdtempSync(join(tmpdir(), 'sonata-run-cwd-'));
});

const detect = async () => ({
  tmux: { installed: true, version: '3.4', problems: [] },
  harnesses: [{
    name: 'opencode', installed: true, version: '1.18.16', problems: [],
    refs: [{ harness: 'opencode', provider: 'acme', id: 'fast', ref: 'acme/fast' }],
    authedProviders: ['acme'],
    providerBaseUrls: { acme: 'https://acme.example/v1' },
  }],
});

const base = () => ({
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
