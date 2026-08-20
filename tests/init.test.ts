import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseOpenCodeModels, parseAuthedProviders, staleAgents, parseOpenCodeRefs, offerableProviders } from '../src/detect.js';
import { parsePiRefs } from '../src/adapters/pi.js';
import {
  cmdInit, duplicateKeys, previousAskedStep, nativeCandidatesFrom,
  nativeTomlFor, preTickedNative, configPathFor, agentsDirFor,
  deriveInitState, configNativeCandidates,
  type NativeCandidate,
} from '../src/commands/init.js';
import { providersForHarnesses } from '../src/tui-ink/app-state.js';
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

// Helper: a detection fixture that reports opencode with providerBaseUrls.
function makeDetect(opts?: { authed?: string[]; extraRefs?: string; providerBaseUrls?: Record<string, string> }) {
  const authed = opts?.authed ?? ['opencode-go'];
  const refsStr = opts?.extraRefs ?? 'opencode/deepseek-v4-flash\nopencode/kimi-k3\nopencode/grok-4.5\n';
  const pvUrls = opts?.providerBaseUrls ?? { opencode: 'https://opencode.ai/api/v1' };
  return async () => ({
    tmux: { installed: true, version: '3.7b', problems: [] },
    harnesses: [{
      name: 'opencode',
      installed: true,
      version: '1.18.15',
      supported: true,
      binPath: '/fake/opencode',
      refs: parseOpenCodeRefs(refsStr),
      authedProviders: authed,
      providerBaseUrls: pvUrls,
      problems: authed.length === 0
        ? [{
            severity: 'error' as const,
            message: 'opencode has models configured but no authenticated provider',
            fix: 'opencode auth login',
          }]
        : [],
    }],
  });
}

describe('cmdInit (non-interactive)', () => {
  let cwd: string;
  let home: string;
  let lines: string[];

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'init-cwd-'));
    home = mkdtempSync(join(tmpdir(), 'init-home-'));
    lines = [];
  });

  const write = (l: string) => { lines.push(l); };
  const detect = makeDetect();

  it('writes native config, installs the hook and generates agents', async () => {
    const res = await cmdInit({
      cwd, home, packageRoot: '/pkg', yes: true, detect,
      providers: ['opencode/opencode'], models: ['opencode-deepseek-v4-flash'],
      roles: ['code'], scope: 'project', write,
    });

    expect(res.models).toEqual(['opencode-deepseek-v4-flash']);
    expect(res.agentsWritten.length).toBeGreaterThanOrEqual(1);
    expect(res.hookChanged).toBe(true);

    const toml = readFileSync(join(cwd, 'sonata.toml'), 'utf8');
    expect(toml).toContain('[native.models."opencode-deepseek-v4-flash"]');
    expect(toml).toContain('[native.gateways."opencode"]');
    expect(toml).not.toContain('[models.');
    expect(toml).not.toContain('[generate.roles]');

    const settings = readSettings(join(cwd, '.claude', 'settings.json'));
    expect(settings.hooks!.PreToolUse[0].hooks[0].command)
      .toBe('node "/pkg/hooks/capture-mode.mjs"');
  });

  it('is idempotent across repeated runs', async () => {
    const args = {
      cwd, home, packageRoot: '/pkg', yes: true, detect,
      providers: ['opencode/opencode'],
      models: ['opencode-deepseek-v4-flash'], roles: ['code'], scope: 'project' as const, write,
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
      providers: ['opencode/opencode'], models: ['opencode-kimi-k3'],
      roles: ['review'], scope: 'skip', write,
    });
    expect(res.hookChanged).toBe(false);
    expect(existsSync(join(cwd, '.claude', 'settings.json'))).toBe(false);
  });

  it('rejects a model the selected providers do not offer', async () => {
    await expect(cmdInit({
      cwd, home, packageRoot: '/pkg', yes: true, detect,
      providers: ['opencode/opencode'], models: ['gpt-9'], roles: ['code'], scope: 'skip', write,
    })).rejects.toThrow(/not offer gpt-9/);
  });

  it('rejects an unknown role', async () => {
    await expect(cmdInit({
      cwd, home, packageRoot: '/pkg', yes: true, detect,
      providers: ['opencode/opencode'], models: ['opencode-kimi-k3'],
      roles: ['dance'], scope: 'skip', write,
    })).rejects.toThrow(/unknown role/);
  });

  it('writes a model id containing dots as one quoted key', async () => {
    await cmdInit({
      cwd, home, packageRoot: '/pkg', yes: true, detect,
      providers: ['opencode/opencode'], models: ['opencode-grok-4.5'],
      roles: ['code'], scope: 'skip', write,
    });

    const config = parseConfig(readFileSync(join(cwd, 'sonata.toml'), 'utf8'));
    expect(config.native?.models['opencode-grok-4.5']).toBeDefined();
    expect(config.native?.models['opencode-grok-4.5'].id).toBe('grok-4.5');
  });

  it('reports blocking problems and writes nothing when a provider is unauthed', async () => {
    const noAuth = makeDetect({ authed: [] });
    const res = await cmdInit({
      cwd, home, packageRoot: '/pkg', yes: true, detect: noAuth,
      models: ['opencode-kimi-k3'], roles: ['code'], scope: 'skip', write,
    });

    expect(res.problems.some((p) => p.severity === 'error')).toBe(true);
    expect(res.agentsWritten).toEqual([]);
    expect(existsSync(join(cwd, 'sonata.toml'))).toBe(false);
    expect(lines.join('\n')).toContain('opencode auth login');
  });
});

describe('cmdInit — provider selection', () => {
  let cwd: string;
  let home: string;
  let lines: string[];

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'init-provider-cwd-'));
    home = mkdtempSync(join(tmpdir(), 'init-provider-home-'));
    lines = [];
  });

  const write = (l: string) => { lines.push(l); };

  const detect = async () => ({
    tmux: { installed: true, version: '3.7b', problems: [] },
    harnesses: [
      {
        name: 'opencode', installed: true, version: '1.18.16', supported: true,
        refs: parseOpenCodeRefs('openrouter/grok-4.5\nopencode-go/grok-4.5\n'),
        authedProviders: ['openrouter', 'opencode-go'], problems: [],
        providerBaseUrls: { openrouter: 'https://openrouter.ai/api/v1', 'opencode-go': 'https://opencode.ai/api/v1' },
      },
      {
        name: 'pi', installed: true, version: '0.84.0', supported: true,
        refs: parsePiRefs('provider  model\nopencode-go  grok-4.5\n'),
        authedProviders: [], problems: [],
      },
    ],
  });

  it('enables the chosen provider and writes a native model', async () => {
    const res = await cmdInit({
      cwd, home, packageRoot: '/pkg', yes: true, detect,
      providers: ['opencode/openrouter'], models: ['openrouter-grok-4.5'],
      roles: ['code'], scope: 'skip', write,
    });

    expect(res.models).toEqual(['openrouter-grok-4.5']);
    const cfg = parseConfig(readFileSync(join(cwd, 'sonata.toml'), 'utf8'));
    expect(cfg.native?.models['openrouter-grok-4.5'].id).toBe('grok-4.5');
    expect(cfg.native?.models['openrouter-grok-4.5'].gateway).toBe('openrouter');
  });

  it('deduplicates the same provider/model across harnesses for native', async () => {
    // opencode and pi both offer opencode-go/grok-4.5; native shows it once.
    await cmdInit({
      cwd, home, packageRoot: '/pkg', yes: true, detect,
      providers: ['opencode/opencode-go', 'pi/opencode-go'],
      models: ['opencode-go-grok-4.5'],
      roles: ['code'], scope: 'skip', write,
    });

    const cfg = parseConfig(readFileSync(join(cwd, 'sonata.toml'), 'utf8'));
    expect(cfg.native?.models['opencode-go-grok-4.5']).toBeDefined();
    // Only one entry — not two harness-qualified entries.
    expect(Object.keys(cfg.native?.models ?? {})).toEqual(['opencode-go-grok-4.5']);
  });

  it('rejects a model no offered provider serves', async () => {
    await expect(cmdInit({
      cwd, home, packageRoot: '/pkg', yes: true, detect,
      providers: ['opencode/openrouter'], models: ['nope'], roles: ['code'], scope: 'skip', write,
    })).rejects.toThrow(/not offer nope/);
  });
});

describe('parseOpenCodeRefs', () => {
  it('splits a ref on the first slash only', () => {
    expect(parseOpenCodeRefs('openrouter/deepseek/deepseek-v4-flash\n')).toEqual([
      {
        harness: 'opencode',
        provider: 'openrouter',
        id: 'deepseek/deepseek-v4-flash',
        ref: 'openrouter/deepseek/deepseek-v4-flash',
      },
    ]);
  });

  it('reads every line of a listing', () => {
    const out = ['opencode-go/deepseek-v4-flash', 'openrouter/deepseek-v4-flash'].join('\n');
    expect(parseOpenCodeRefs(out).map((r) => r.provider)).toEqual(['opencode-go', 'openrouter']);
  });

  it('ignores blanks and lines that are not refs', () => {
    expect(parseOpenCodeRefs('')).toEqual([]);
    expect(parseOpenCodeRefs('\n   \n')).toEqual([]);
    expect(parseOpenCodeRefs('noslash\n')).toEqual([]);
    expect(parseOpenCodeRefs('/leading\n')).toEqual([]);
    expect(parseOpenCodeRefs('trailing/\n')).toEqual([]);
  });
});

describe('offerableProviders', () => {
  const refs = [
    { harness: 'opencode' as const, provider: 'openrouter', id: 'a', ref: 'openrouter/a' },
    { harness: 'opencode' as const, provider: 'openrouter', id: 'b', ref: 'openrouter/b' },
    { harness: 'opencode' as const, provider: 'agnes', id: 'c', ref: 'agnes/c' },
    { harness: 'opencode' as const, provider: 'opencode', id: 'free', ref: 'opencode/free' },
    { harness: 'pi' as const, provider: 'openrouter', id: 'a', ref: 'openrouter/a' },
  ];

  it('drops opencode providers with no auth entry', () => {
    const got = offerableProviders(refs, ['openrouter']);
    expect(got.some((p) => p.provider === 'agnes')).toBe(false);
  });

  it('keeps the free opencode tier, which needs no auth entry', () => {
    const got = offerableProviders(refs, ['openrouter']);
    expect(got.find((p) => p.harness === 'opencode' && p.provider === 'opencode')?.count).toBe(1);
  });

  it('never applies the auth filter to pi, which lists only usable models', () => {
    const got = offerableProviders(refs, []);
    expect(got.map((p) => p.key)).toEqual(['opencode/opencode', 'pi/openrouter']);
  });

  it('keeps one provider under two harnesses as two rows', () => {
    const got = offerableProviders(refs, ['openrouter']);
    expect(got.filter((p) => p.provider === 'openrouter').map((p) => p.key).sort())
      .toEqual(['opencode/openrouter', 'pi/openrouter']);
  });

  it('counts the models behind each row', () => {
    const got = offerableProviders(refs, ['openrouter']);
    expect(got.find((p) => p.key === 'opencode/openrouter')?.count).toBe(2);
  });
});

describe('duplicateKeys', () => {
  it('is empty when every key is distinct', () => {
    expect(duplicateKeys(['a', 'b', 'c'])).toEqual([]);
  });

  it('reports each colliding key once', () => {
    expect(duplicateKeys(['a', 'a', 'a', 'b'])).toEqual(['a']);
  });
});

describe('preTickedNative', () => {
  const candidates: NativeCandidate[] = [
    { key: 'opencode-deepseek-v4-flash', gateway: 'opencode', id: 'deepseek-v4-flash', contextWindow: 128000, baseUrl: 'https://opencode.ai/api/v1' },
    { key: 'anexto-grok-4.5', gateway: 'anexto', id: 'grok-4.5', contextWindow: 128000, baseUrl: 'https://bifrost.advai.net/v1' },
  ];

  it('ticks a candidate whose key matches an existing native model', () => {
    const toml = `
[native.models."opencode-deepseek-v4-flash"]
gateway = "opencode"
id = "deepseek-v4-flash"
context_window = 128000
[native.gateways."opencode"]
base_url = "https://opencode.ai/api/v1"
`;
    expect(preTickedNative(toml, candidates)).toEqual(new Set(['opencode-deepseek-v4-flash']));
  });

  it('is empty for an unparseable or empty config', () => {
    expect(preTickedNative('', candidates)).toEqual(new Set());
    expect(preTickedNative('not toml {{{', candidates)).toEqual(new Set());
  });

  it('is empty when the config has no native table', () => {
    expect(preTickedNative(`
[models."x"]
harness = "codex"
id = "gpt"
`, candidates)).toEqual(new Set());
  });
});

describe('nativeTomlFor', () => {
  const cand = (gw: string, id: string): NativeCandidate => ({
    key: `${gw}-${id}`, gateway: gw, id, contextWindow: 128000, baseUrl: `https://${gw}.example/v1`,
  });

  it('writes native gateways, models, and generate.native', () => {
    const out = nativeTomlFor({ code: [cand('opencode', 'deepseek-v4-flash')] });
    expect(out).toContain('[native.gateways."opencode"]');
    expect(out).toContain('[native.models."opencode-deepseek-v4-flash"]');
    expect(out).toContain('[generate.native]');
    expect(out).not.toContain('[models.');
    expect(out).not.toContain('[generate.roles]');

    const cfg = parseConfig(out);
    expect(cfg.native?.models['opencode-deepseek-v4-flash']).toEqual({
      gateway: 'opencode', id: 'deepseek-v4-flash', contextWindow: 128000,
    });
    expect(cfg.native?.generate.code).toEqual(['opencode-deepseek-v4-flash']);
  });

  it('defines a model once even when several roles use it', () => {
    const c = cand('opencode', 'kimi-k3');
    const out = nativeTomlFor({ code: [c], plan: [c] });
    expect(out.match(/\[native\.models\./g)).toHaveLength(1);
    expect(parseConfig(out).native?.generate.plan).toEqual(['opencode-kimi-k3']);
  });

  it('writes each role with its own models', () => {
    const out = nativeTomlFor({
      code: [cand('opencode', 'kimi-k3')],
      review: [cand('opencode', 'kimi-k3'), cand('opencode', 'grok-4.5')],
    });
    const cfg = parseConfig(out);
    expect(cfg.native?.generate.code).toEqual(['opencode-kimi-k3']);
    expect(cfg.native?.generate.review?.sort()).toEqual(['opencode-grok-4.5', 'opencode-kimi-k3']);
  });
});

describe('HarnessStatus.refs', () => {
  it('carries refs rather than bare model ids', async () => {
    const status = {
      name: 'opencode', installed: true, supported: true,
      refs: parseOpenCodeRefs('openrouter/kimi-k3\n'),
      authedProviders: ['openrouter'], problems: [],
    };
    expect(status.refs[0].ref).toBe('openrouter/kimi-k3');
  });
});

describe('configPathFor / agentsDirFor', () => {
  it('puts a project config and its agents beside the repo', () => {
    expect(configPathFor('project', '/repo', '/home')).toBe(join('/repo', 'sonata.toml'));
    expect(agentsDirFor('project', '/repo', '/home')).toBe(join('/repo', '.claude', 'agents'));
  });

  it('puts a global config and its agents under home', () => {
    expect(configPathFor('global', '/repo', '/home'))
      .toBe(join('/home', '.config', 'sonata', 'sonata.toml'));
    expect(agentsDirFor('global', '/repo', '/home')).toBe(join('/home', '.claude', 'agents'));
  });
});

describe('cmdInit — config scope', () => {
  let cwd: string;
  let home: string;
  let lines: string[];

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'init-scope-cwd-'));
    home = mkdtempSync(join(tmpdir(), 'init-scope-home-'));
    lines = [];
  });

  const write = (l: string) => { lines.push(l); };

  const detect = async () => ({
    tmux: { installed: true, version: '3.7b', problems: [] },
    harnesses: [{
      name: 'opencode', installed: true, version: '1.18.16', supported: true,
      refs: parseOpenCodeRefs('openrouter/kimi-k3\n'),
      authedProviders: ['openrouter'], problems: [],
      providerBaseUrls: { openrouter: 'https://openrouter.ai/api/v1' },
    }],
  });

  const args = {
    packageRoot: '/pkg', yes: true, detect,
    providers: ['opencode/openrouter'], models: ['openrouter-kimi-k3'],
    roles: ['code'], scope: 'skip' as const,
  };

  it('writes a global config and global agents, and nothing in the repo', async () => {
    const res = await cmdInit({ ...args, cwd, home, configScope: 'global', write });

    expect(res.configPath).toBe(join(home, '.config', 'sonata', 'sonata.toml'));
    expect(existsSync(join(home, '.config', 'sonata', 'sonata.toml'))).toBe(true);
    expect(existsSync(join(cwd, 'sonata.toml'))).toBe(false);
    expect(existsSync(join(cwd, '.claude', 'agents'))).toBe(false);
  });

  it('defaults to the project scope', async () => {
    const res = await cmdInit({ ...args, cwd, home, write, mcpRunner: () => ({ ok: true, output: 'Added' }) });
    expect(res.configPath).toBe(join(cwd, 'sonata.toml'));
  });

  it('pre-ticks from the machine config when the repo has none', async () => {
    await cmdInit({ ...args, cwd, home, configScope: 'global', write });
    const second = await cmdInit({
      packageRoot: '/pkg', yes: true, detect, cwd, home,
      roles: ['code'], scope: 'skip' as const, configScope: 'global' as const, write,
    });
    expect(second.models).toEqual(['openrouter-kimi-k3']);
  });

  it('pre-ticks from the machine native config, not the repo one, in global scope', async () => {
    // Write a local native config that won't be read in global scope.
    writeFileSync(join(cwd, 'sonata.toml'), `
[native.models."openrouter-kimi-k3"]
gateway = "openrouter"
id = "kimi-k3"
context_window = 128000
[native.gateways."openrouter"]
base_url = "https://openrouter.ai/api/v1"
[generate.native]
code = ["openrouter-kimi-k3"]
`);

    // No --models: selection comes from the config being edited (global = empty).
    await expect(cmdInit({
      packageRoot: '/pkg', yes: true, detect, cwd, home,
      providers: ['opencode/openrouter'], roles: ['code'],
      scope: 'skip' as const, configScope: 'global' as const, write,
    })).rejects.toThrow(/no models selected/);
  });
});

describe('cmdInit — per-role models', () => {
  let cwd: string;
  let home: string;
  let lines: string[];

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'init-rolemodels-cwd-'));
    home = mkdtempSync(join(tmpdir(), 'init-rolemodels-home-'));
    lines = [];
  });

  const write = (l: string) => { lines.push(l); };

  const detect = async () => ({
    tmux: { installed: true, version: '3.7b', problems: [] },
    harnesses: [{
      name: 'opencode', installed: true, version: '1.18.16', supported: true,
      refs: parseOpenCodeRefs('openrouter/kimi-k3\nopenrouter/grok-4.5\n'),
      authedProviders: ['openrouter'], problems: [],
      providerBaseUrls: { openrouter: 'https://openrouter.ai/api/v1' },
    }],
  });

  it('flags mean every listed role gets every listed model', async () => {
    const res = await cmdInit({
      cwd, home, packageRoot: '/pkg', yes: true, detect,
      providers: ['opencode/openrouter'],
      models: ['openrouter-kimi-k3', 'openrouter-grok-4.5'],
      roles: ['code', 'review'], scope: 'skip', configScope: 'project', write,
    });

    const cfg = parseConfig(readFileSync(join(cwd, 'sonata.toml'), 'utf8'));
    expect(cfg.native?.generate.code?.sort()).toEqual(['openrouter-grok-4.5', 'openrouter-kimi-k3']);
    expect(cfg.native?.generate.review).toHaveLength(2);
    expect(res.agentsWritten.length).toBeGreaterThanOrEqual(4);
  });
});

describe('cmdInit — MCP and pruning', () => {
  let cwd: string;
  let home: string;
  const write = (_line: string) => {};

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'init-mcp-cwd-'));
    home = mkdtempSync(join(tmpdir(), 'init-mcp-home-'));
  });

  const detect = async () => ({
    tmux: { installed: true, version: '3.7b', problems: [] },
    harnesses: [{
      name: 'opencode', installed: true, version: '1.18.16', supported: true,
      refs: parseOpenCodeRefs('openrouter/kimi-k3\n'),
      authedProviders: ['openrouter'], problems: [],
      providerBaseUrls: { openrouter: 'https://openrouter.ai/api/v1' },
    }],
  });
  const args = {
    packageRoot: '/pkg', yes: true, detect,
    providers: ['opencode/openrouter'], models: ['openrouter-kimi-k3'],
    roles: ['code'], scope: 'skip' as const, configScope: 'project' as const,
  };

  it('asks the claude CLI to register the server at the config\'s scope', async () => {
    const calls: string[][] = [];
    const res = await cmdInit({
      ...args, cwd, home, write,
      mcpRunner: (_cmd, a) => { calls.push(a); return { ok: true, output: 'Added' }; },
    });

    expect(res.mcpChanged).toBe(true);
    expect(calls[0].slice(0, 5)).toEqual(['mcp', 'add', '--scope', 'project', 'sonata']);
  });

  it('uses the user scope when the config is machine-scoped', async () => {
    const calls: string[][] = [];
    await cmdInit({
      ...args, cwd, home, write, configScope: 'global',
      mcpRunner: (_cmd, a) => { calls.push(a); return { ok: true, output: 'Added' }; },
    });
    expect(calls[0].slice(0, 4)).toEqual(['mcp', 'add', '--scope', 'user']);
  });

  it('does not delete stale agents unless asked', async () => {
    await cmdInit({ ...args, cwd, home, write, mcpRunner: () => ({ ok: true, output: 'Added' }) });
    const dir = join(cwd, '.claude', 'agents');
    writeFileSync(join(dir, 'code-gone.md'), 'forwarding wrapper around the sonata runtime');

    const res = await cmdInit({ ...args, cwd, home, write, mcpRunner: () => ({ ok: true, output: 'Added' }) });
    expect(res.pruned).toEqual([]);
    expect(existsSync(join(dir, 'code-gone.md'))).toBe(true);
  });

  it('deletes them when --prune is given', async () => {
    await cmdInit({ ...args, cwd, home, write, mcpRunner: () => ({ ok: true, output: 'Added' }) });
    const dir = join(cwd, '.claude', 'agents');
    writeFileSync(join(dir, 'code-gone.md'), 'forwarding wrapper around the sonata runtime');

    const res = await cmdInit({ ...args, cwd, home, prune: true, write });
    expect(res.pruned).toEqual(['code-gone.md']);
    expect(existsSync(join(dir, 'code-gone.md'))).toBe(false);
  });
});

describe('nativeCandidatesFrom', () => {
  const refs = [
    { harness: 'opencode' as const, provider: 'anexto', id: 'deepseek-v4-flash-0731', ref: 'anexto/deepseek-v4-flash-0731' },
    { harness: 'opencode' as const, provider: 'opencode', id: 'kimi-k3', ref: 'opencode/kimi-k3' },
    { harness: 'pi' as const, provider: 'anexto', id: 'deepseek-v4-flash-0731', ref: 'anexto/deepseek-v4-flash-0731' },
  ];

  it('keeps refs whose provider has a known base URL, deduplicating across harnesses', () => {
    const got = nativeCandidatesFrom(refs, { anexto: 'https://bifrost.advai.net/v1' });
    expect(got).toEqual([{
      key: 'anexto-deepseek-v4-flash-0731',
      gateway: 'anexto',
      id: 'deepseek-v4-flash-0731',
      contextWindow: 128000,
      baseUrl: 'https://bifrost.advai.net/v1',
    }]);
  });

  it('is empty when no provider has a known base URL', () => {
    expect(nativeCandidatesFrom(refs, {})).toEqual([]);
  });
});

describe('cmdInit — key check', () => {
  let cwd: string;
  let home: string;
  let lines: string[];

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'init-native-cwd-'));
    home = mkdtempSync(join(tmpdir(), 'init-native-home-'));
    lines = [];
  });

  const write = (l: string) => { lines.push(l); };

  const detect = async () => ({
    tmux: { installed: true, version: '3.7b', problems: [] },
    harnesses: [{
      name: 'opencode', installed: true, version: '1.18.16', supported: true,
      refs: parseOpenCodeRefs('anexto/deepseek-v4-flash-0731\n'),
      authedProviders: ['anexto'],
      providerBaseUrls: { anexto: 'https://bifrost.advai.net/v1' },
      problems: [],
    }],
  });

  it('prints a key-source line for a chosen gateway with no discovered key', async () => {
    await cmdInit({
      cwd, home, packageRoot: '/pkg', yes: true, detect,
      providers: ['opencode/anexto'], models: ['anexto-deepseek-v4-flash-0731'],
      roles: ['code'], scope: 'skip', write,
    });
    expect(lines.some((l) => l.includes('anexto') && l.includes('sonata auth add anexto'))).toBe(true);
  });

  it('prints a key-source line naming the source when a key is discovered', async () => {
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(join(home, '.config', 'sonata', 'keys.json'), JSON.stringify({ anexto: 'sk-test' }));

    await cmdInit({
      cwd, home, packageRoot: '/pkg', yes: true, detect,
      providers: ['opencode/anexto'], models: ['anexto-deepseek-v4-flash-0731'],
      roles: ['code'], scope: 'skip', write,
    });
    expect(lines.some((l) => l.includes('anexto') && l.includes('key from sonata'))).toBe(true);
  });
});

describe('cmdInit — re-init from existing config', () => {
  let cwd: string;
  let home: string;
  const lines: string[] = [];
  const write = (l: string) => { lines.push(l); };
  const detect = makeDetect();

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'ws-cwd-'));
    home = mkdtempSync(join(tmpdir(), 'ws-home-'));
    lines.length = 0;
  });

  it('round-trips the selected config on a second run', async () => {
    await cmdInit({
      cwd, home, packageRoot: '/pkg', yes: true, detect,
      providers: ['opencode/opencode'], models: ['opencode-deepseek-v4-flash'],
      roles: ['code'], scope: 'skip', write,
    });
    const toml1 = readFileSync(join(cwd, 'sonata.toml'), 'utf8');
    await cmdInit({ cwd, home, packageRoot: '/pkg', yes: true, detect, scope: 'skip', write });
    expect(readFileSync(join(cwd, 'sonata.toml'), 'utf8')).toBe(toml1);
  });

  it('second run with the same flags produces identical config', async () => {
    const args = {
      cwd, home, packageRoot: '/pkg', yes: true, detect,
      providers: ['opencode/opencode'], models: ['opencode-deepseek-v4-flash'],
      roles: ['code'], scope: 'skip' as const, write,
    };
    await cmdInit(args);
    const toml1 = readFileSync(join(cwd, 'sonata.toml'), 'utf8');
    await cmdInit(args);
    const toml2 = readFileSync(join(cwd, 'sonata.toml'), 'utf8');
    expect(toml2).toBe(toml1);
  });

  it('second run without flags reads the TOML and preserves selections', async () => {
    // First run: explicit flags.
    await cmdInit({
      cwd, home, packageRoot: '/pkg', yes: true, detect,
      providers: ['opencode/opencode'], models: ['opencode-deepseek-v4-flash'],
      roles: ['code'], scope: 'skip', write,
    });
    const toml1 = readFileSync(join(cwd, 'sonata.toml'), 'utf8');

    // Second run: no providers/models/roles flags — should read sonata.toml.
    await cmdInit({
      cwd, home, packageRoot: '/pkg', yes: true, detect,
      scope: 'skip', write,
    });
    const toml2 = readFileSync(join(cwd, 'sonata.toml'), 'utf8');

    // The config should be identical — same models, same roles, same per-role.
    expect(toml2).toBe(toml1);

    // Specifically: roles should NOT expand to all 4 defaults.
    expect(toml2).toContain('"code"');
    expect(toml2).not.toContain('"review"');
    expect(toml2).not.toContain('"explore"');
    expect(toml2).not.toContain('"plan"');
  });

  it('re-initializes a global config from its TOML', async () => {
    await cmdInit({
      cwd, home, packageRoot: '/pkg', yes: true, detect, configScope: 'global',
      providers: ['opencode/opencode'], models: ['opencode-deepseek-v4-flash'],
      roles: ['code'], scope: 'skip', write,
    });
    const toml1 = readFileSync(join(home, '.config', 'sonata', 'sonata.toml'), 'utf8');
    await cmdInit({ cwd, home, packageRoot: '/pkg', yes: true, detect, configScope: 'global', scope: 'skip', write });
    expect(readFileSync(join(home, '.config', 'sonata', 'sonata.toml'), 'utf8')).toBe(toml1);
  });
});

describe('deriveInitState', () => {
  const config = (models: Record<string, { gateway: string; id: string }>, generate: Record<string, string[]> = { code: Object.keys(models) }) => parseConfig([
    ...Object.entries(models).flatMap(([key, model]) => [
      `[native.models."${key}"]`, `gateway = "${model.gateway}"`, `id = "${model.id}"`, 'context_window = 128000', '',
    ]),
    ...[...new Set(Object.values(models).map((model) => model.gateway))].flatMap((gateway) => [
      `[native.gateways."${gateway}"]`, `base_url = "https://${gateway}.example/v1"`, '',
    ]),
    '[generate.native]',
    ...Object.entries(generate).map(([role, keys]) => `"${role}" = [${keys.map((key) => `"${key}"`).join(', ')}]`),
  ].join('\n'));

  it('derives a detected gateway provider and harness', () => {
    const state = deriveInitState(config({ m: { gateway: 'anexto', id: 'm' } }), 'project', [
      { harness: 'opencode', provider: 'anexto', count: 1, key: 'opencode/anexto' },
    ]);
    expect(state.providerKeys).toEqual(['opencode/anexto']);
    expect(state.harnesses).toEqual(['opencode']);
  });

  it('uses a synthetic provider for a gateway absent from detection', () => {
    const state = deriveInitState(config({ m: { gateway: 'hand', id: 'm' } }), 'project', []);
    expect(state.providerKeys).toEqual(['config/hand']);
    expect(state.harnesses).toEqual([]);
  });

  it('keeps every harness serving a gateway', () => {
    const state = deriveInitState(config({ m: { gateway: 'shared', id: 'm' } }), 'project', [
      { harness: 'opencode', provider: 'shared', count: 1, key: 'opencode/shared' },
      { harness: 'pi', provider: 'shared', count: 1, key: 'pi/shared' },
    ]);
    expect(state.providerKeys).toEqual(['opencode/shared', 'pi/shared']);
    expect(state.harnesses).toEqual(['opencode', 'pi']);
  });

  it('copies roles and per-role models from generate.native', () => {
    const state = deriveInitState(config({ m: { gateway: 'g', id: 'm' } }, { review: ['m'] }), 'global', []);
    expect(state.roles).toEqual(['review']);
    expect(state.perRoleModels).toEqual({ review: ['m'] });
  });

  it('returns only the scope when native config is absent', () => {
    const plain = parseConfig('[generate.native]\n');
    expect(deriveInitState(plain, 'global', [])).toEqual({ configScope: 'global' });
  });
});

describe('configNativeCandidates and provider filtering', () => {
  it('makes a hand-configured model a candidate with its configured URL', () => {
    const config = parseConfig(`
[native.gateways."hand"]
base_url = "https://hand.example/v1"
[native.models."hand-model"]
gateway = "hand"
id = "model-id"
context_window = 64000
`);
    expect(configNativeCandidates(config)).toEqual([{
      key: 'hand-model', gateway: 'hand', id: 'model-id', contextWindow: 64000, baseUrl: 'https://hand.example/v1',
    }]);
  });

  it('keeps config providers while filtering ordinary providers', () => {
    const providers = [
      { harness: 'config', provider: 'hand', count: 1, key: 'config/hand' },
      { harness: 'opencode', provider: 'live', count: 1, key: 'opencode/live' },
    ];
    expect(providersForHarnesses(providers, ['pi']).map((provider) => provider.key)).toEqual(['config/hand']);
    expect(providersForHarnesses(providers, ['opencode']).map((provider) => provider.key)).toEqual(['config/hand', 'opencode/live']);
  });
});

describe('previousAskedStep', () => {
  it('skips flag-answered steps', () => {
    // Steps 0, 3, 4 are interactive; steps 1 and 2 are flag-answered.
    const asked = [true, false, false, true, true];
    expect(previousAskedStep(asked, 3)).toBe(0);
  });

  it('back from the last step lands on the previous interactive one', () => {
    const asked = [true, true, true, true, true];
    expect(previousAskedStep(asked, 4)).toBe(3);
  });

  it('returns the same step when there is no earlier interactive step', () => {
    const asked = [false, false, true, true, true];
    expect(previousAskedStep(asked, 2)).toBe(2);
  });
});
