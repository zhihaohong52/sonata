import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseOpenCodeModels, parseAuthedProviders, staleAgents } from '../src/detect.js';
import { cmdInit } from '../src/commands/init.js';
import { readSettings } from '../src/settings.js';
import { parseConfig } from '../src/config.js';

// Shape taken verbatim from a real ~/.config/opencode/opencode.json.
const OC_CONFIG = JSON.stringify({
  provider: {
    opencode: {
      name: 'OpenCode Go',
      models: {
        'deepseek-v4-flash': { name: 'DeepSeek V4 Flash' },
        'kimi-k3': { name: 'Kimi K3' },
        // Real model ids carry version dots, which are TOML key separators.
        'grok-4.5': { name: 'Grok-4.5' },
      },
    },
  },
});

describe('parseOpenCodeModels', () => {
  it('extracts models with their provider and display name', () => {
    expect(parseOpenCodeModels(OC_CONFIG)).toEqual([
      { provider: 'opencode', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
      { provider: 'opencode', id: 'kimi-k3', name: 'Kimi K3' },
      { provider: 'opencode', id: 'grok-4.5', name: 'Grok-4.5' },
    ]);
  });

  it('returns nothing for malformed or empty config', () => {
    expect(parseOpenCodeModels('not json')).toEqual([]);
    expect(parseOpenCodeModels('{}')).toEqual([]);
  });
});

describe('parseAuthedProviders', () => {
  it('lists provider keys', () => {
    expect(parseAuthedProviders('{"opencode-go":{"key":"x"}}')).toEqual(['opencode-go']);
  });

  it('tolerates malformed auth files', () => {
    expect(parseAuthedProviders('¯\\_(ツ)_/¯')).toEqual([]);
  });
});

describe('staleAgents', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agents-'));
    const marker = 'forwarding wrapper around the sonata runtime';
    writeFileSync(join(dir, 'code-old.md'), marker);
    writeFileSync(join(dir, 'code-keep.md'), marker);
    writeFileSync(join(dir, 'someone-elses-agent.md'), 'unrelated agent');
  });

  it('reports sonata agents no longer in the config', () => {
    expect(staleAgents(dir, ['code-keep'])).toEqual(['code-old.md']);
  });

  it('never touches agents sonata did not write', () => {
    expect(staleAgents(dir, [])).not.toContain('someone-elses-agent.md');
  });

  it('handles a missing directory', () => {
    expect(staleAgents(join(dir, 'nope'), [])).toEqual([]);
  });
});

describe('cmdInit (non-interactive)', () => {
  let cwd: string;
  let home: string;
  let lines: string[];
  let authed: string[];

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'init-cwd-'));
    home = mkdtempSync(join(tmpdir(), 'init-home-'));
    lines = [];
    authed = ['opencode-go'];
  });

  const write = (l: string) => { lines.push(l); };

  // Detection shells out to real binaries, so it is injected here to keep
  // these tests hermetic and independent of the developer's machine.
  const detect = async () => ({
    tmux: { installed: true, version: '3.7b', problems: [] },
    oc: {
      name: 'opencode',
      installed: true,
      version: '1.18.15',
      supported: true,
      binPath: '/fake/opencode',
      models: parseOpenCodeModels(OC_CONFIG),
      authedProviders: authed,
      problems: authed.length === 0
        ? [{
            severity: 'error' as const,
            message: 'opencode has models configured but no authenticated provider',
            fix: 'opencode auth login',
          }]
        : [],
    },
  });

  it('writes config, installs the hook and generates agents', async () => {
    const res = await cmdInit({
      cwd, home, packageRoot: '/pkg', yes: true, detect,
      models: ['deepseek-v4-flash'], roles: ['code'], scope: 'project', write,
    });

    expect(res.models).toEqual(['deepseek-v4-flash']);
    expect(res.agentsWritten).toHaveLength(1);
    expect(res.hookChanged).toBe(true);

    const toml = readFileSync(join(cwd, 'sonata.toml'), 'utf8');
    expect(toml).toContain('[models."deepseek-v4-flash"]');
    expect(toml).toContain('harness = "opencode"');

    const settings = readSettings(join(cwd, '.claude', 'settings.json'));
    expect(settings.hooks!.PreToolUse[0].hooks[0].command)
      .toBe('node "/pkg/hooks/capture-mode.mjs"');

    expect(existsSync(join(cwd, '.claude', 'agents', 'code-deepseek-v4-flash.md'))).toBe(true);
  });

  it('is idempotent across repeated runs', async () => {
    const args = {
      cwd, home, packageRoot: '/pkg', yes: true, detect,
      models: ['deepseek-v4-flash'], roles: ['code'], scope: 'project' as const, write,
    };
    await cmdInit(args);
    const second = await cmdInit(args);

    expect(second.hookChanged).toBe(false);
    const settings = readSettings(join(cwd, '.claude', 'settings.json'));
    expect(settings.hooks!.PreToolUse).toHaveLength(1);
  });

  it('can skip hook installation entirely', async () => {
    const res = await cmdInit({
      cwd, home, packageRoot: '/pkg', yes: true, detect,
      models: ['kimi-k3'], roles: ['review'], scope: 'skip', write,
    });
    expect(res.hookChanged).toBe(false);
    expect(existsSync(join(cwd, '.claude', 'settings.json'))).toBe(false);
  });

  it('rejects a model opencode does not offer', async () => {
    await expect(cmdInit({
      cwd, home, packageRoot: '/pkg', yes: true, detect,
      models: ['gpt-9'], roles: ['code'], scope: 'skip', write,
    })).rejects.toThrow(/does not offer gpt-9/);
  });

  it('rejects an unknown role', async () => {
    await expect(cmdInit({
      cwd, home, packageRoot: '/pkg', yes: true, detect,
      models: ['kimi-k3'], roles: ['dance'], scope: 'skip', write,
    })).rejects.toThrow(/unknown role/);
  });

  // A model id like `grok-4.5` is not a plain TOML key: the dot nests it, so
  // `[models.grok-4.5]` parses as models -> "grok-4" -> "5" and the config no
  // longer describes the model it names.
  it('writes a model id containing dots as one quoted key', async () => {
    await cmdInit({
      cwd, home, packageRoot: '/pkg', yes: true, detect,
      models: ['grok-4.5'], roles: ['code'], scope: 'skip', write,
    });

    const config = parseConfig(readFileSync(join(cwd, 'sonata.toml'), 'utf8'));
    expect(Object.keys(config.models)).toEqual(['grok-4.5']);
    expect(config.models['grok-4.5']).toEqual({ harness: 'opencode', id: 'grok-4.5' });
  });

  it('pre-selects a dotted model id already in sonata.toml', async () => {
    const args = {
      cwd, home, packageRoot: '/pkg', yes: true, detect,
      roles: ['code'], scope: 'skip' as const, write,
    };
    await cmdInit({ ...args, models: ['grok-4.5'] });
    // With no --models, a re-run carries over what the file already enables.
    const second = await cmdInit(args);

    expect(second.models).toEqual(['grok-4.5']);
  });

  it('reports blocking problems and writes nothing when a provider is unauthed', async () => {
    authed = [];
    const res = await cmdInit({
      cwd, home, packageRoot: '/pkg', yes: true, detect,
      models: ['kimi-k3'], roles: ['code'], scope: 'skip', write,
    });

    expect(res.problems.some((p) => p.severity === 'error')).toBe(true);
    expect(res.agentsWritten).toEqual([]);
    expect(existsSync(join(cwd, 'sonata.toml'))).toBe(false);
    expect(lines.join('\n')).toContain('opencode auth login');
  });
});
