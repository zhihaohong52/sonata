import { describe, it, expect, beforeEach, vi } from 'vitest';

const tuiMocks = vi.hoisted(() => ({
  interactive: false,
  codexCredential: false,
  opencodeCredential: false,
  data: undefined as import('../src/tui-ink/app.js').WizardData | undefined,
  result: undefined as { cancelled: boolean; state: import('../src/tui-ink/types.js').InitState } | undefined,
}));

vi.mock('../src/tui.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/tui.js')>();
  return {
    ...actual,
    isInteractive: () => tuiMocks.interactive,
    confirm: async () => true,
  };
});

vi.mock('../src/tui-ink/run.js', () => ({
  runInitTui: async (data: import('../src/tui-ink/app.js').WizardData) => {
    tuiMocks.data = data;
    if (tuiMocks.result === undefined) throw new Error('missing wizard result');
    return tuiMocks.result;
  },
}));

vi.mock('../src/native/codex-auth.js', () => ({
  readChatGptOAuth: () => tuiMocks.codexCredential ? { expires_at: Date.now() / 1000 + 86400 } : null,
  readOpencodeChatGptOAuth: () => tuiMocks.opencodeCredential ? { expires_at: Date.now() / 1000 + 86400 } : null,
}));
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseOpenCodeModels, parseAuthedProviders, staleAgents, parseOpenCodeRefs, offerableProviders } from '../src/detect.js';
import { parsePiRefs } from '../src/adapters/pi.js';
import {
  cmdInit, credentialAvailabilityFor, duplicateKeys, previousAskedStep, nativeCandidatesFrom,
  nativeTomlFor, preTickedNative, configPathFor, agentsDirFor,
  deriveInitState, configNativeCandidates, oauthProvidersFor,
  type NativeCandidate,
} from '../src/commands/init.js';
import { reconcilePerRoleModels } from '../src/commands/init.js';
import { providersForHarnesses } from '../src/tui-ink/app-state.js';
import { readSettings } from '../src/settings.js';
import { writeSonataKey } from '../src/native/credentials.js';
import { credentialDir, credentialFileFor } from '../src/native/oauth-login.js';
import { parseConfig, CODEX_OAUTH_BASE_URL, COPILOT_OAUTH_BASE_URL } from '../src/config.js';

beforeEach(() => {
  tuiMocks.interactive = false;
  tuiMocks.codexCredential = false;
  tuiMocks.opencodeCredential = false;
  tuiMocks.data = undefined;
  tuiMocks.result = undefined;
});

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
      auth: 'api-key',
    }]);
  });

  it('marks an oauth provider codex-oauth and gives it the Codex backend URL', () => {
    const codexRefs = [
      { harness: 'codex' as const, provider: 'codex', id: 'gpt-5.6-luna', ref: 'codex/gpt-5.6-luna' },
    ];
    // No discovered base URL for codex: a subscription credential reaches only
    // the Codex backend, which LiteLLM's own provider addresses.
    expect(nativeCandidatesFrom(codexRefs, {}, new Map([['codex', 'codex-oauth' as const]]))).toEqual([{
      key: 'codex-gpt-5.6-luna',
      gateway: 'codex',
      id: 'gpt-5.6-luna',
      contextWindow: 128000,
      baseUrl: CODEX_OAUTH_BASE_URL,
      auth: 'codex-oauth',
    }]);
  });

  it('drops a non-oauth provider with no known base URL', () => {
    const unknown = [
      { harness: 'codex' as const, provider: 'codex', id: 'gpt-5.6-luna', ref: 'codex/gpt-5.6-luna' },
    ];
    expect(nativeCandidatesFrom(unknown, {})).toEqual([]);
  });

  it('is empty when no provider has a known base URL', () => {
    expect(nativeCandidatesFrom(refs, {})).toEqual([]);
  });
});

describe('cmdInit --credential-source', () => {
  let cwd: string;
  let home: string;
  const write = () => {};
  const detect = async () => ({
    tmux: { installed: true, version: '3.7b', problems: [] },
    harnesses: [{
      name: 'codex', installed: true, version: '1.0.0', supported: true,
      refs: [{ harness: 'codex' as const, provider: 'codex', id: 'gpt-5', ref: 'gpt-5' }],
      authedProviders: ['codex'], providerBaseUrls: {}, problems: [],
    }],
  });

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'init-source-cwd-'));
    home = mkdtempSync(join(tmpdir(), 'init-source-home-'));
    tuiMocks.codexCredential = false;
  });

  const init = (credentialSource?: string[]) => cmdInit({
    cwd, home, packageRoot: '/pkg', yes: true, detect,
    providers: ['codex/codex'], models: ['gpt-5'], roles: ['code'], scope: 'skip', write,
    credentialSource,
  });

  it('records a credential source given on the command line', async () => {
    tuiMocks.codexCredential = true;
    mkdirSync(credentialDir(home, 'codex'), { recursive: true });
    writeFileSync(join(credentialDir(home, 'codex'), credentialFileFor('codex-oauth')), '{}');
    await init(['codex=sonata']);
    expect(readFileSync(join(cwd, 'sonata.toml'), 'utf8')).toMatch(/credential_source = "sonata"/);
  });

  it('refuses by name when the named source has no credential', async () => {
    tuiMocks.codexCredential = true;
    await expect(init(['codex=sonata'])).rejects.toThrow(
      /gateway "codex" needs a credential.*sonata auth login codex/s,
    );
  });

  it('refuses a malformed pair', async () => {
    await expect(init(['codex'])).rejects.toThrow(/--credential-source expects <gateway>=<source>/);
  });

  it('refuses an unknown source, listing the valid ones', async () => {
    await expect(init(['codex=keychain'])).rejects.toThrow(/sonata, codex, opencode/);
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
      key: 'hand-model', gateway: 'hand', id: 'model-id', contextWindow: 64000,
      baseUrl: 'https://hand.example/v1', auth: 'api-key',
    }]);
  });

  it('carries a codex-oauth gateway through as a candidate', () => {
    const config = parseConfig(`
[native.gateways."codex"]
auth = "codex-oauth"
[native.models."luna"]
gateway = "codex"
id = "gpt-5.6-luna"
context_window = 128000
`);
    expect(configNativeCandidates(config)).toEqual([{
      key: 'luna', gateway: 'codex', id: 'gpt-5.6-luna', contextWindow: 128000,
      baseUrl: CODEX_OAUTH_BASE_URL, auth: 'codex-oauth',
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

describe('nativeTomlFor — codex-oauth gateways', () => {
  const codexCandidate: NativeCandidate = {
    key: 'luna', gateway: 'codex', id: 'gpt-5.6-luna',
    contextWindow: 128000, baseUrl: CODEX_OAUTH_BASE_URL, auth: 'codex-oauth',
  };
  const keyCandidate: NativeCandidate = {
    key: 'ds', gateway: 'anexto', id: 'deepseek-v4-flash-0731',
    contextWindow: 128000, baseUrl: 'https://bifrost.advai.net/v1', auth: 'api-key',
  };

  it('writes auth instead of base_url for a subscription gateway', () => {
    const toml = nativeTomlFor({ code: [codexCandidate] });
    expect(toml).toContain('[native.gateways."codex"]');
    expect(toml).toContain('auth = "codex-oauth"');
    // A metered URL here is the exact config that authenticates then 429s.
    expect(toml).not.toContain('api.openai.com');
    expect(toml).not.toContain('base_url');
  });

  it('still writes base_url for an api-key gateway alongside it', () => {
    const toml = nativeTomlFor({ code: [codexCandidate, keyCandidate] });
    expect(toml).toContain('auth = "codex-oauth"');
    expect(toml).toContain('base_url = "https://bifrost.advai.net/v1"');
  });

  it('round-trips through parseConfig', () => {
    const config = parseConfig(nativeTomlFor({ code: [codexCandidate, keyCandidate] }));
    expect(config.native!.gateways.codex).toEqual({
      baseUrl: CODEX_OAUTH_BASE_URL, auth: 'codex-oauth',
    });
    expect(config.native!.gateways.anexto.auth).toBe('api-key');
  });
});

describe('cmdInit — wizard API key credential source', () => {
  let cwd: string;
  let home: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'init-wizard-cwd-'));
    home = mkdtempSync(join(tmpdir(), 'init-wizard-home-'));
  });

  it('switches a codex-oauth gateway to metered API-key auth when a key is entered', async () => {
    writeFileSync(join(cwd, 'sonata.toml'), `
[native.gateways."codex"]
auth = "codex-oauth"
[native.models."luna"]
gateway = "codex"
id = "gpt-5.6-luna"
context_window = 128000
[generate.native]
"code" = ["luna"]
`);
    tuiMocks.interactive = true;
    tuiMocks.result = {
      cancelled: false,
      state: {
        configScope: 'project', providerKeys: ['config/codex'], nativeKeys: ['luna'],
        roles: ['code'], perRoleModels: { code: ['luna'] }, byokKeys: { codex: 'sk-test' },
      },
    };
    const detect = async () => ({
      tmux: { installed: true, version: '3.7b', problems: [] },
      harnesses: [{
        name: 'codex', installed: false, version: undefined, supported: false,
        refs: [], authedProviders: [], problems: [],
      }],
    });

    await cmdInit({
      cwd, home, packageRoot: '/pkg', detect, scope: 'skip',
      mcpRunner: () => ({ ok: true, output: 'Added' }), write: () => {},
    });

    expect(parseConfig(readFileSync(join(cwd, 'sonata.toml'), 'utf8')).native!.gateways.codex).toEqual({
      baseUrl: 'https://api.openai.com/v1', auth: 'api-key',
    });
  });
});

describe('credentialAvailabilityFor', () => {
  it('only offers imports compatible with each gateway auth type', () => {
    const availability = credentialAvailabilityFor(
      [{ provider: 'openrouter' }, { provider: 'codex' }, { provider: 'github-copilot' }],
      new Map([
        ['codex', 'codex-oauth' as const],
        ['github-copilot', 'copilot-oauth' as const],
      ]),
      {
        codex: { expiresInDays: 2 },
        opencode: { expiresInDays: 3 },
        copilot: { expiresInDays: null },
      },
      () => false,
    );

    expect(availability.openrouter).toMatchObject({ codex: null, opencode: null, keyEntryAvailable: true });
    expect(availability.codex).toMatchObject({
      codex: { expiresInDays: 2 }, opencode: { expiresInDays: 3 }, keyEntryAvailable: true,
    });
    expect(availability['github-copilot']).toMatchObject({
      codex: null, opencode: { expiresInDays: null }, keyEntryAvailable: false,
    });
  });

  it('allows key entry for an explicit api-key gateway even with an unrecognized name', () => {
    const availability = credentialAvailabilityFor(
      [{ provider: 'work-openai' }],
      new Map([['work-openai', 'api-key' as const]]),
      { codex: null, opencode: null, copilot: null },
      () => false,
    );

    expect(availability['work-openai']).toMatchObject({ keyEntryAvailable: true });
  });

  it('retains imports for a config-only OAuth gateway', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'init-config-oauth-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'init-config-oauth-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), `
[native.gateways."codex"]
auth = "codex-oauth"
[native.models."luna"]
gateway = "codex"
id = "gpt-5.6-luna"
context_window = 128000
[generate.native]
"code" = ["luna"]
`);
    tuiMocks.interactive = true;
    tuiMocks.codexCredential = true;
    tuiMocks.opencodeCredential = true;
    tuiMocks.result = { cancelled: true, state: { configScope: 'project' } };
    const detect = async () => ({
      tmux: { installed: true, version: '3.7b', problems: [] },
      harnesses: [{
        name: 'codex', installed: false, version: undefined, supported: false,
        refs: [], authedProviders: [], problems: [],
      }],
    });

    await cmdInit({ cwd, home, packageRoot: '/pkg', detect, write: () => {} });

    expect(tuiMocks.data!.credentialAvailability.codex.codex).not.toBeNull();
    expect(tuiMocks.data!.credentialAvailability.codex.opencode).not.toBeNull();
  });
});

describe('oauthProvidersFor', () => {
  const refs = [
    { harness: 'codex' as const, provider: 'codex', id: 'gpt-5.6-luna', ref: 'codex/gpt-5.6-luna' },
    { harness: 'opencode' as const, provider: 'openai', id: 'gpt-4o', ref: 'openai/gpt-4o' },
    { harness: 'opencode' as const, provider: 'github-copilot', id: 'gpt-4o', ref: 'github-copilot/gpt-4o' },
    { harness: 'opencode' as const, provider: 'anexto', id: 'deepseek', ref: 'anexto/deepseek' },
  ];
  const none = () => null;
  const some = () => ({});

  it('marks nothing when no harness holds an OAuth login', () => {
    expect(oauthProvidersFor(refs, '/h', {
      chatGpt: none, opencodeChatGpt: none, copilot: none,
    })).toEqual(new Map());
  });

  it('marks codex when codex logged in with a ChatGPT account', () => {
    const got = oauthProvidersFor(refs, '/h', {
      chatGpt: some, opencodeChatGpt: none, copilot: none,
    });
    expect(got.get('codex')).toBe('codex-oauth');
    expect(got.has('openai')).toBe(false);
  });

  it('marks opencode openai, which serves the same subscription', () => {
    // Left unmarked, init would write base_url = api.openai.com for a
    // subscription credential — a gateway that authenticates and then 429s.
    const got = oauthProvidersFor(refs, '/h', {
      chatGpt: none, opencodeChatGpt: some, copilot: none,
    });
    expect(got.get('openai')).toBe('codex-oauth');
  });

  it('marks github-copilot as copilot-oauth', () => {
    const got = oauthProvidersFor(refs, '/h', {
      chatGpt: none, opencodeChatGpt: none, copilot: some,
    });
    expect(got.get('github-copilot')).toBe('copilot-oauth');
  });

  it('never marks a provider the harnesses do not actually offer', () => {
    const got = oauthProvidersFor([], '/h', {
      chatGpt: some, opencodeChatGpt: some, copilot: some,
    });
    expect(got).toEqual(new Map());
  });

  it('leaves api-key providers alone', () => {
    const got = oauthProvidersFor(refs, '/h', {
      chatGpt: some, opencodeChatGpt: some, copilot: some,
    });
    expect(got.has('anexto')).toBe(false);
  });
});

describe('nativeCandidatesFrom — copilot', () => {
  it('gives a copilot provider the Copilot URL and copilot-oauth', () => {
    const refs = [
      { harness: 'opencode' as const, provider: 'github-copilot', id: 'gpt-4o', ref: 'github-copilot/gpt-4o' },
    ];
    expect(nativeCandidatesFrom(refs, {}, new Map([['github-copilot', 'copilot-oauth' as const]]))).toEqual([{
      key: 'github-copilot-gpt-4o',
      gateway: 'github-copilot',
      id: 'gpt-4o',
      contextWindow: 128000,
      baseUrl: COPILOT_OAUTH_BASE_URL,
      auth: 'copilot-oauth',
    }]);
  });
});

describe('nativeTomlFor — copilot-oauth', () => {
  it('writes auth and no base_url, and round-trips', () => {
    const candidate: NativeCandidate = {
      key: 'copilot-gpt4o', gateway: 'github-copilot', id: 'gpt-4o',
      contextWindow: 128000, baseUrl: COPILOT_OAUTH_BASE_URL, auth: 'copilot-oauth',
    };
    const toml = nativeTomlFor({ code: [candidate] });
    expect(toml).toContain('auth = "copilot-oauth"');
    expect(toml).not.toContain('base_url');

    const config = parseConfig(toml);
    expect(config.native!.gateways['github-copilot']).toEqual({
      baseUrl: COPILOT_OAUTH_BASE_URL, auth: 'copilot-oauth',
    });
  });
});

describe('nativeCandidatesFrom — models the router cannot reach', () => {
  it('drops a claude- model, which parseConfig would refuse', () => {
    // Copilot really does serve these; offering one would let init write a
    // config that then fails to load.
    const refs = [
      { harness: 'opencode' as const, provider: 'github-copilot', id: 'claude-opus-4.6', ref: 'github-copilot/claude-opus-4.6' },
      { harness: 'opencode' as const, provider: 'github-copilot', id: 'gpt-5.4', ref: 'github-copilot/gpt-5.4' },
    ];
    const got = nativeCandidatesFrom(refs, {}, new Map([['github-copilot', 'copilot-oauth' as const]]));
    expect(got.map((c) => c.id)).toEqual(['gpt-5.4']);
  });

  it('drops one whose flattened key starts with the prefix', () => {
    const refs = [
      { harness: 'opencode' as const, provider: 'claude', id: 'x', ref: 'claude-x' },
    ];
    expect(nativeCandidatesFrom(refs, { claude: 'https://x/v1' })).toEqual([]);
  });

  it('every candidate it returns survives parseConfig', () => {
    const refs = [
      { harness: 'opencode' as const, provider: 'anthropic', id: 'claude-opus-4.6', ref: 'anthropic/claude-opus-4.6' },
      { harness: 'opencode' as const, provider: 'anexto', id: 'deepseek-v4', ref: 'anexto/deepseek-v4' },
    ];
    const got = nativeCandidatesFrom(refs, { anthropic: 'https://a/v1', anexto: 'https://b/v1' });
    expect(() => parseConfig(nativeTomlFor({ code: got }))).not.toThrow();
  });
});

describe('cmdInit — BYOK', () => {
  let cwd: string;
  let home: string;
  let lines: string[];

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'init-byok-cwd-'));
    home = mkdtempSync(join(tmpdir(), 'init-byok-home-'));
    lines = [];
  });

  const write = (l: string) => { lines.push(l); };

  /** A machine with nothing installed — the case BYOK exists for. */
  const noHarness = async () => ({
    tmux: { installed: true, version: '3.7b', problems: [] },
    harnesses: [{
      name: 'opencode', installed: false, version: undefined, supported: false,
      refs: [], authedProviders: [], problems: [],
    }],
  });

  const args = {
    packageRoot: '/pkg', yes: true, detect: noHarness,
    providers: ['byok/deepseek'], models: ['deepseek-deepseek-v4-flash'],
    roles: ['code'], scope: 'skip' as const,
  };

  it('writes BYOK models to the native config with no harness installed', async () => {
    writeSonataKey(home, 'deepseek', 'sk-test');
    const res = await cmdInit({ ...args, cwd, home, write, mcpRunner: () => ({ ok: true, output: 'Added' }) });

    const toml = readFileSync(res.configPath, 'utf8');
    expect(toml).toMatch(/\[native\.gateways\."deepseek"\]/);
    expect(toml).toMatch(/base_url = "https:\/\/api\.deepseek\.com\/v1"/);
    expect(toml).toMatch(/\[native\.models\."deepseek-deepseek-v4-flash"\]/);
    expect(toml).toMatch(/id = "deepseek-v4-flash"/);
  });

  it('does not make a missing harness fatal', async () => {
    // Before BYOK this returned early with severity 'error' and wrote nothing.
    writeSonataKey(home, 'deepseek', 'sk-test');
    const res = await cmdInit({ ...args, cwd, home, write, mcpRunner: () => ({ ok: true, output: 'Added' }) });
    expect(res.problems.some((p) => p.severity === 'error')).toBe(false);
    expect(res.problems.some((p) => p.severity === 'warn')).toBe(true);
    expect(existsSync(res.configPath)).toBe(true);
  });

  it('leaves BYOK out of the default provider set', async () => {
    // `--yes` with no --providers defaults to everything on offer, and BYOK
    // rows are on offer — so without an opt-in rule this asks for a key for all
    // thirty well-known providers and refuses a command that used to work.
    const withOpenrouter = async () => ({
      tmux: { installed: true, version: '3.7b', problems: [] },
      harnesses: [{
        name: 'opencode', installed: true, version: '1.18.16', supported: true,
        refs: parseOpenCodeRefs('openrouter/kimi-k3\n'),
        authedProviders: ['openrouter'], problems: [],
        providerBaseUrls: { openrouter: 'https://openrouter.ai/api/v1' },
      }],
    });
    const res = await cmdInit({
      packageRoot: '/pkg', yes: true, detect: withOpenrouter, cwd, home, write,
      models: ['openrouter-kimi-k3'], roles: ['code'], scope: 'skip' as const,
      mcpRunner: () => ({ ok: true, output: 'Added' }),
    });
    expect(res.models).toEqual(['openrouter-kimi-k3']);
  });

  it('refuses a BYOK provider with no stored key', async () => {
    await expect(cmdInit({ ...args, cwd, home, write }))
      .rejects.toThrow(/sonata auth add deepseek/);
  });

  it('does not offer a BYOK row for a provider a harness already covers', async () => {
    const withOpenrouter = async () => ({
      tmux: { installed: true, version: '3.7b', problems: [] },
      harnesses: [{
        name: 'opencode', installed: true, version: '1.18.16', supported: true,
        refs: parseOpenCodeRefs('openrouter/kimi-k3\n'),
        authedProviders: ['openrouter'], problems: [],
        providerBaseUrls: { openrouter: 'https://openrouter.ai/api/v1' },
      }],
    });
    // There must be no byok/openrouter row at all: offering the same provider
    // twice, once with a catalogue and once without, is the confusing outcome.
    // The unknown-provider error lists what is on offer, so it is the evidence.
    await expect(cmdInit({
      ...args, detect: withOpenrouter, cwd, home, write,
      providers: ['byok/openrouter'], models: ['openrouter-kimi-k3'],
    })).rejects.toThrow(/no harness offers byok\/openrouter/);

    // …while the harness row for the same provider still works.
    const res = await cmdInit({
      ...args, detect: withOpenrouter, cwd, home, write,
      providers: ['opencode/openrouter'], models: ['openrouter-kimi-k3'],
      mcpRunner: () => ({ ok: true, output: 'Added' }),
    });
    expect(readFileSync(res.configPath, 'utf8')).toMatch(/\[native\.models\."openrouter-kimi-k3"\]/);
  });

  // The double-init bug, now for a gateway no harness can rediscover.
  it('re-derives a BYOK config on a second init', async () => {
    writeSonataKey(home, 'deepseek', 'sk-test');
    const res = await cmdInit({ ...args, cwd, home, write, mcpRunner: () => ({ ok: true, output: 'Added' }) });

    const config = parseConfig(readFileSync(res.configPath, 'utf8'));
    const state = deriveInitState(config, 'project', []);

    expect(state.nativeKeys).toEqual(['deepseek-deepseek-v4-flash']);
    expect(state.providerKeys).toEqual(['config/deepseek']);
    expect(state.perRoleModels).toEqual({ code: ['deepseek-deepseek-v4-flash'] });
  });

  it('carries a BYOK config through a second init unchanged', async () => {
    writeSonataKey(home, 'deepseek', 'sk-test');
    const first = await cmdInit({ ...args, cwd, home, write, mcpRunner: () => ({ ok: true, output: 'Added' }) });
    const before = readFileSync(first.configPath, 'utf8');

    // No flags this time: everything must come back from the config on disk.
    const second = await cmdInit({
      packageRoot: '/pkg', yes: true, detect: noHarness, cwd, home, write,
      scope: 'skip' as const, mcpRunner: () => ({ ok: true, output: 'Added' }),
    });
    expect(second.models).toEqual(['deepseek-deepseek-v4-flash']);
    expect(readFileSync(second.configPath, 'utf8')).toBe(before);
  });
});

describe('reconcilePerRoleModels', () => {
  it('keeps a saved assignment when the selection is unchanged', () => {
    expect(reconcilePerRoleModels({ code: ['a'], review: ['b'] }, ['a', 'b'], ['a', 'b'], ['code', 'review']))
      .toEqual({ code: ['a'], review: ['b'] });
  });

  it('replaces the saved assignment when a different model is selected', () => {
    // The bug this exists for: `--models <new>` printed the new model in the
    // summary and wrote the old one, because a role already in the config kept
    // its saved list and the selection was discarded whole.
    expect(reconcilePerRoleModels({ code: ['anexto-kimi-k3'] }, ['anexto-kimi-k3'], ['gpt-5.6-luna'], ['code']))
      .toEqual({ code: ['gpt-5.6-luna'] });
  });

  it('adds a newly selected model to every role', () => {
    expect(reconcilePerRoleModels(
      { code: ['old'], review: ['old'] }, ['old'], ['old', 'new'], ['code', 'review'],
    )).toEqual({ code: ['old', 'new'], review: ['old', 'new'] });
  });

  it('drops a model that is no longer selected', () => {
    expect(reconcilePerRoleModels({ code: ['a', 'b'] }, ['a', 'b'], ['a'], ['code']))
      .toEqual({ code: ['a'] });
  });

  it('gives a role with nothing left the whole selection', () => {
    // An empty list would generate no agent for that role at all.
    expect(reconcilePerRoleModels({ code: ['gone'] }, ['gone', 'a'], ['a'], ['code']))
      .toEqual({ code: ['a'] });
  });

  it('covers a role that has no saved assignment', () => {
    expect(reconcilePerRoleModels({ code: ['a'] }, ['a'], ['a'], ['code', 'plan']))
      .toEqual({ code: ['a'], plan: ['a'] });
  });

  it('omits a role that is no longer selected', () => {
    expect(reconcilePerRoleModels({ code: ['a'], plan: ['a'] }, ['a'], ['a'], ['code']))
      .toEqual({ code: ['a'] });
  });

  it('handles no saved state at all', () => {
    expect(reconcilePerRoleModels(undefined, [], ['a'], ['code'])).toEqual({ code: ['a'] });
  });
});
