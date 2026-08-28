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
import { parseOpenCodeModels, parseAuthedProviders, staleAgents, isSonataAgent, parseOpenCodeRefs, offerableProviders } from '../src/detect.js';
import { tierAgentMarkdown } from '../src/commands/sync.js';
import { parsePiRefs } from '../src/adapters/pi.js';
import {
  cmdInit, credentialAvailabilityFor, duplicateKeys, parseCredentialSourceFlags, previousAskedStep, nativeCandidatesFrom,
  nativeTomlFor, preTickedNative, configPathFor, agentsDirFor,
  deriveInitState, configNativeCandidates, oauthProvidersFor,
  type NativeCandidate,
} from '../src/commands/init.js';
import { reconcilePerRoleModels, reconcileTierList } from '../src/commands/init.js';
import { providersForHarnesses } from '../src/tui-ink/app-state.js';
import { readSettings, writeSettings, installHook, hookCommand } from '../src/settings.js';
import { writeSonataKey } from '../src/native/credentials.js';
import { credentialDir, credentialFileFor } from '../src/native/oauth-login.js';
import { parseConfig, CODEX_OAUTH_BASE_URL, COPILOT_OAUTH_BASE_URL } from '../src/config.js';
import { cmdDoctor } from '../src/commands/doctor.js';

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

  it('recognizes generated tier agents as owned and stale', () => {
    const path = join(dir, 'code-simple.md');
    writeFileSync(path, tierAgentMarkdown({ role: 'code', tier: 'simple' }));
    expect(isSonataAgent(path)).toBe(true);
    expect(staleAgents(dir, [])).toContain('code-simple.md');
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

  it('--yes installs the sonata loop skill and names the routing choice', async () => {
    await cmdInit({
      cwd, home, packageRoot: process.cwd(), yes: true, detect,
      providers: ['opencode/opencode'], models: ['opencode-deepseek-v4-flash'],
      roles: ['code'], scope: 'project', write,
    });

    expect(readFileSync(join(cwd, '.claude', 'skills', 'sonata-loop', 'SKILL.md'), 'utf8'))
      .toBe(readFileSync(join(process.cwd(), 'skills', 'loop', 'SKILL.md'), 'utf8'));
    expect(lines.join('\n')).toContain('routing');
  });

  it('leaving routing disabled warns in doctor for a tiered config', async () => {
    await cmdInit({
      cwd, home, packageRoot: process.cwd(), yes: true, detect,
      providers: ['opencode/opencode'], models: ['opencode-deepseek-v4-flash'],
      roles: ['code'], scope: 'skip', routing: 'skip', write,
    });

    const check = (await cmdDoctor({ cwd, home, packageRoot: process.cwd() })).checks
      .find((candidate) => candidate.name === 'tier routing');
    expect(check?.ok).toBe(false);
    expect(check?.detail).toBe('tier agents need a routed session — run `sonata route auto`');
  });

  it('refuses --routing global when the config is project-scoped', async () => {
    await expect(cmdInit({
      cwd, home, packageRoot: '/pkg', yes: true, detect,
      providers: ['opencode/opencode'], models: ['opencode-deepseek-v4-flash'],
      roles: ['code'], scope: 'skip', configScope: 'project', routing: 'global', write,
    })).rejects.toThrow(/routes every project through the machine config/);
  });

  it('refuses project-scoped routing when a local config would shadow a global init config', async () => {
    writeFileSync(join(cwd, 'sonata.toml'), '[run]\n');
    await expect(cmdInit({
      cwd, home, packageRoot: process.cwd(), yes: true, detect,
      providers: ['opencode/opencode'], models: ['opencode-deepseek-v4-flash'],
      roles: ['code'], scope: 'skip', configScope: 'global', routing: 'project', write,
    })).rejects.toThrow(/shadow the global config/);

    // The guard must reject before config, credentials, settings, or skills
    // can be written. The local config above is the only intentional file.
    expect(existsSync(join(home, '.config', 'sonata', 'sonata.toml'))).toBe(false);
    expect(existsSync(join(home, '.config', 'sonata', 'credentials'))).toBe(false);
    expect(existsSync(join(home, '.claude', 'settings.json'))).toBe(false);
    expect(existsSync(join(home, '.claude', 'skills', 'sonata-loop', 'SKILL.md'))).toBe(false);
  });

  it('allows project-scoped routing for a global config when no local config shadows it', async () => {
    await expect(cmdInit({
      cwd, home, packageRoot: process.cwd(), yes: true, detect,
      providers: ['opencode/opencode'], models: ['opencode-deepseek-v4-flash'],
      roles: ['code'], scope: 'skip', configScope: 'global', routing: 'project', write,
    })).resolves.toMatchObject({ configPath: join(home, '.config', 'sonata', 'sonata.toml') });
  });

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
    expect(toml).toContain('[models."opencode-deepseek-v4-flash"]');
    expect(toml).toContain('[native.gateways."opencode"]');
    expect(toml).not.toContain('[native.models.');
    expect(toml).not.toContain('[generate.roles]');
    expect(toml).not.toContain('[generate.native]');
    expect(toml).toContain('[tiers."code"]');

    const settings = readSettings(join(cwd, '.claude', 'settings.json'));
    expect(settings.hooks!.PreToolUse[0].hooks[0].command)
      .toBe('node "/pkg/hooks/capture-mode.mjs"');
  });

  it('--yes writes catalog-ranked tiers for every selected role, round-tripping through parseConfig', async () => {
    const res = await cmdInit({
      cwd, home, packageRoot: '/pkg', yes: true, detect,
      providers: ['opencode/opencode'],
      models: ['opencode-deepseek-v4-flash', 'opencode-kimi-k3'],
      roles: ['code', 'review'], scope: 'project', write,
    });
    expect(res.models.sort()).toEqual(['opencode-deepseek-v4-flash', 'opencode-kimi-k3']);

    const toml = readFileSync(join(cwd, 'sonata.toml'), 'utf8');
    const cfg = parseConfig(toml);
    for (const role of ['code', 'review']) {
      const lists = cfg.tiers?.[role];
      expect(lists).toBeDefined();
      expect(lists!.simple.length).toBeGreaterThan(0);
      expect(lists!.complex.length).toBeGreaterThan(0);
      for (const key of [...lists!.simple, ...lists!.complex]) {
        expect(['opencode-deepseek-v4-flash', 'opencode-kimi-k3']).toContain(key);
      }
    }
  });

  it('migrates legacy generate selections into tier lists', async () => {
    writeFileSync(join(cwd, 'sonata.toml'), `
[native.gateways."openai"]
base_url = "https://openai.example/v1"

[native.models."gpt-5.6-luna"]
gateway = "openai"
id = "gpt-5.6-luna"
context_window = 128000

[native.models."native-only"]
gateway = "openai"
id = "native-only"
context_window = 128000

[models."opencode-openai-gpt-5.6-luna"]
harness = "opencode"
id = "openai/gpt-5.6-luna"

[generate.roles]
code = ["opencode-openai-gpt-5.6-luna"]

[generate.native]
code = ["native-only"]
`);
    const legacyDetect = makeDetect({
      extraRefs: 'openai/gpt-5.6-luna\nopenai/native-only\n',
      providerBaseUrls: { openai: 'https://openai.example/v1' },
    });
    await cmdInit({ cwd, home, packageRoot: '/pkg', yes: true, detect: legacyDetect, scope: 'skip', write });

    const cfg = parseConfig(readFileSync(join(cwd, 'sonata.toml'), 'utf8'));
    expect(cfg.tiers?.code.simple).toEqual(['native-only', 'gpt-5.6-luna']);
    expect(cfg.tiers?.code.complex).toEqual(['native-only', 'gpt-5.6-luna']);
    expect(cfg.tiers?.code.simple).toEqual(expect.arrayContaining(['native-only', 'gpt-5.6-luna']));
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
    { key: 'acme-grok-4.5', gateway: 'acme', id: 'grok-4.5', contextWindow: 128000, baseUrl: 'https://gateway.acme.example/v1' },
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

  it('writes native gateways, unified models, and tiers', () => {
    const out = nativeTomlFor({ code: [cand('opencode', 'deepseek-v4-flash')] });
    expect(out).toContain('[native.gateways."opencode"]');
    expect(out).toContain('[models."opencode-deepseek-v4-flash"]');
    expect(out).toContain('[tiers."code"]');
    expect(out).not.toContain('[native.models.');
    expect(out).not.toContain('[generate.native]');
    expect(out).not.toContain('[generate.roles]');

    const cfg = parseConfig(out);
    expect(cfg.unifiedModels['opencode-deepseek-v4-flash']).toEqual({
      gateway: 'opencode', id: 'deepseek-v4-flash', contextWindow: 128000,
    });
    expect(cfg.tiers?.code.simple).toEqual(['opencode-deepseek-v4-flash']);
    expect(cfg.tiers?.code.complex).toEqual(['opencode-deepseek-v4-flash']);
  });

  it('defines a model once even when several roles use it', () => {
    const c = cand('opencode', 'kimi-k3');
    const out = nativeTomlFor({ code: [c], plan: [c] });
    expect(out.match(/\[models\./g)).toHaveLength(1);
    expect(parseConfig(out).tiers?.plan.simple).toEqual(['opencode-kimi-k3']);
  });

  it('writes each role with its own tier lists', () => {
    const out = nativeTomlFor({
      code: [cand('opencode', 'kimi-k3')],
      review: [cand('opencode', 'kimi-k3'), cand('opencode', 'grok-4.5')],
    });
    const cfg = parseConfig(out);
    expect(cfg.tiers?.code.simple).toEqual(['opencode-kimi-k3']);
    expect([...(cfg.tiers?.review.complex ?? [])].sort()).toEqual(['opencode-grok-4.5', 'opencode-kimi-k3']);
  });

  it('emits hardcoded [run] defaults when no existing run settings are given', () => {
    const out = nativeTomlFor({ code: [cand('opencode', 'kimi-k3')] });
    expect(out).toContain('tail_window_seconds = 20');
    expect(out).toContain('stall_timeout_seconds = 120');
    expect(out).toContain('run_timeout_seconds = 1800');
    expect(out).toContain('dispatch_window_seconds = 1500');
  });

  it('preserves existing [run] settings when given', () => {
    const out = nativeTomlFor(
      { code: [cand('opencode', 'kimi-k3')] },
      {},
      undefined,
      {},
      [],
      {
        tailWindowSeconds: 33,
        stallTimeoutSeconds: 222,
        runTimeoutSeconds: 4444,
        dispatchWindowSeconds: 3000,
      },
    );
    expect(out).toContain('tail_window_seconds = 33');
    expect(out).toContain('stall_timeout_seconds = 222');
    expect(out).toContain('run_timeout_seconds = 4444');
    expect(out).toContain('dispatch_window_seconds = 3000');
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

  it('syncs global agents from the just-written global config, not the invoking repo', async () => {
    // The repo has its OWN sonata.toml naming a different model. A global-scope
    // init must still generate its agents from the machine config it just
    // wrote, not from whatever the invoking directory happens to contain —
    // otherwise the global config and its generated agents silently disagree.
    writeFileSync(join(cwd, 'sonata.toml'), `[models."other-model"]
harness = "opencode"
id = "openrouter/other"
`);

    const res = await cmdInit({ ...args, cwd, home, configScope: 'global', routing: 'global', write });

    const globalAgents = join(home, '.claude', 'agents');
    // The global config has one model, so its [tiers.code] collapses to the
    // single unsuffixed tier agent.
    expect(existsSync(join(globalAgents, 'code.md'))).toBe(true);
    // The repo's model must not leak into the global agent set.
    expect(existsSync(join(globalAgents, 'code-other-model.md'))).toBe(false);
    expect(res.agentsWritten.every((p) => p.startsWith(globalAgents + join('/')))).toBe(true);
    // Nothing is ever generated into the invoking repo.
    expect(existsSync(join(cwd, '.claude', 'agents'))).toBe(false);
  });

  it('installs the loop skill under home at global scope, not in the invoking repo', async () => {
    await cmdInit({ ...args, cwd, home, configScope: 'global', write });

    const skillTarget = join(home, '.claude', 'skills', 'sonata-loop', 'SKILL.md');
    expect(readFileSync(skillTarget, 'utf8'))
      .toBe(readFileSync(join(process.cwd(), 'skills', 'loop', 'SKILL.md'), 'utf8'));
    expect(existsSync(join(cwd, '.claude', 'skills', 'sonata-loop', 'SKILL.md'))).toBe(false);
  });

  it('defaults to the project scope', async () => {
    const res = await cmdInit({ ...args, cwd, home, write });
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

describe('cmdInit — allow-list upgrade', () => {
  it('refreshes a stale Bash allow-list even when the hook is already installed', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'init-upgrade-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'init-upgrade-home-'));
    const detect = async () => ({
      tmux: { installed: true, version: '3.7b', problems: [] },
      harnesses: [{
        name: 'opencode', installed: true, version: '1.18.16', supported: true,
        refs: parseOpenCodeRefs('openrouter/kimi-k3\n'),
        authedProviders: ['openrouter'], problems: [],
        providerBaseUrls: { openrouter: 'https://openrouter.ai/api/v1' },
      }],
    });

    // Simulate a settings file from before the MCP -> dispatch-CLI switch:
    // the hook is installed (so init would normally treat it as "nothing to
    // do here"), but permissions.allow still names the removed MCP tools.
    const settingsPath = join(cwd, '.claude', 'settings.json');
    const { settings } = installHook({}, hookCommand('/pkg'));
    writeSettings(settingsPath, {
      ...settings,
      permissions: { allow: ['mcp__sonata__dispatch', 'mcp__sonata__wait', 'mcp__sonata__approve'] },
    });

    await cmdInit({
      cwd, home, packageRoot: '/pkg', yes: true, detect,
      providers: ['opencode/openrouter'], models: ['openrouter-kimi-k3'],
      roles: ['code'], write: () => {},
    });

    const after = readSettings(settingsPath);
    expect(after.permissions?.allow).toEqual(expect.arrayContaining([
      'Bash(sonata dispatch:*)', 'Bash(sonata wait:*)', 'Bash(sonata approve:*)',
    ]));
    // The stale entries are harmless to keep, but the point is the new ones exist.
    expect(after.permissions?.allow).toContain('mcp__sonata__dispatch');
  });
});

describe('cmdInit — pruning', () => {
  let cwd: string;
  let home: string;
  const write = (_line: string) => {};

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'init-prune-cwd-'));
    home = mkdtempSync(join(tmpdir(), 'init-prune-home-'));
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

  it('does not delete stale agents unless asked', async () => {
    await cmdInit({ ...args, cwd, home, write });
    const dir = join(cwd, '.claude', 'agents');
    writeFileSync(join(dir, 'code-gone.md'), 'forwarding wrapper around the sonata runtime');

    const res = await cmdInit({ ...args, cwd, home, write });
    expect(res.pruned).toEqual([]);
    expect(existsSync(join(dir, 'code-gone.md'))).toBe(true);
  });

  it('deletes stale agents when --prune is given', async () => {
    await cmdInit({ ...args, cwd, home, write });
    const dir = join(cwd, '.claude', 'agents');
    writeFileSync(join(dir, 'code-gone.md'), 'forwarding wrapper around the sonata runtime');

    const res = await cmdInit({ ...args, cwd, home, prune: true, write });
    expect(res.pruned).toEqual(['code-gone.md']);
    expect(existsSync(join(dir, 'code-gone.md'))).toBe(false);
  });
});

describe('nativeCandidatesFrom', () => {
  const refs = [
    { harness: 'opencode' as const, provider: 'acme', id: 'deepseek-v4-flash-0731', ref: 'acme/deepseek-v4-flash-0731' },
    { harness: 'opencode' as const, provider: 'opencode', id: 'kimi-k3', ref: 'opencode/kimi-k3' },
    { harness: 'pi' as const, provider: 'acme', id: 'deepseek-v4-flash-0731', ref: 'acme/deepseek-v4-flash-0731' },
  ];

  it('keeps refs whose provider has a known base URL, deduplicating across harnesses', () => {
    const got = nativeCandidatesFrom(refs, { acme: 'https://gateway.acme.example/v1' });
    expect(got).toEqual([{
      key: 'acme-deepseek-v4-flash-0731',
      gateway: 'acme',
      id: 'deepseek-v4-flash-0731',
      contextWindow: 128000,
      baseUrl: 'https://gateway.acme.example/v1',
      auth: 'api-key',
      harness: 'opencode',
      harnessId: 'acme/deepseek-v4-flash-0731',
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
      harness: 'codex',
      harnessId: 'gpt-5.6-luna',
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

  // These declare the gateway's auth directly in sonata.toml (auth =
  // "codex-oauth") rather than relying on harness-detected OAuth, so the
  // credential's presence/absence at report time is fully controlled by
  // tuiMocks.codexCredential rather than also gating whether gpt-5 is even
  // offered as a candidate.
  const codexOauthConfig = `
[native.gateways.codex]
auth = "codex-oauth"
[native.models.gpt-5]
gateway = "codex"
id = "gpt-5"
context_window = 128000
[generate.native]
code = ["gpt-5"]
`;

  it('reports a healthy oauth credential from its recorded source in the key check', async () => {
    // Regression: the key-check summary used to fall through to keyReport
    // (a bearer-key store lookup) for any non-api-key gateway, so a healthy
    // codex-sourced codex-oauth credential printed "no key — sonata auth add".
    writeFileSync(join(cwd, 'sonata.toml'), codexOauthConfig);
    tuiMocks.codexCredential = true;
    const lines: string[] = [];
    await cmdInit({
      cwd, home, packageRoot: '/pkg', yes: true, detect,
      scope: 'skip',
      write: (l: string) => { lines.push(l); },
      credentialSource: ['codex=codex'],
    });
    expect(lines.some((l) => l.includes('codex: credential from codex'))).toBe(true);
  });

  it('gives a `codex login` repair hint for a missing codex-sourced oauth credential', async () => {
    writeFileSync(join(cwd, 'sonata.toml'), codexOauthConfig);
    tuiMocks.codexCredential = false;
    const lines: string[] = [];
    await cmdInit({
      cwd, home, packageRoot: '/pkg', yes: true, detect,
      scope: 'skip',
      write: (l: string) => { lines.push(l); },
      credentialSource: ['codex=codex'],
    });
    expect(lines.some((l) => l.includes('no credential from codex') && l.includes('codex login'))).toBe(true);
  });

  it('refuses by name when the named source has no credential', async () => {
    tuiMocks.codexCredential = true;
    await expect(init(['codex=sonata'])).rejects.toThrow(
      /gateway "codex" needs a credential.*sonata auth login codex/s,
    );
  });

  const copilotOauthConfig = `
[native.gateways."github-copilot"]
auth = "copilot-oauth"
[native.models.gpt-4o]
gateway = "github-copilot"
id = "gpt-4o"
context_window = 128000
[generate.native]
code = ["gpt-4o"]
`;

  it('flags an opencode Copilot token that exists but cannot exchange for a Copilot key', async () => {
    // Regression: presence of a stored GitHub token was treated as a healthy
    // credential, but opencode's login only grants `read:user` — GitHub
    // refuses the Copilot exchange, so the token cannot actually be used.
    writeFileSync(join(cwd, 'sonata.toml'), copilotOauthConfig);
    mkdirSync(join(home, '.local', 'share', 'opencode'), { recursive: true });
    writeFileSync(
      join(home, '.local', 'share', 'opencode', 'auth.json'),
      JSON.stringify({ 'github-copilot': { type: 'oauth', access: 'gho_x', refresh: 'r' } }),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('{}', { status: 200, headers: { 'x-oauth-scopes': 'read:user' } });
    const lines: string[] = [];
    try {
      await cmdInit({
        cwd, home, packageRoot: '/pkg', yes: true, detect,
        scope: 'skip',
        write: (l: string) => { lines.push(l); },
        credentialSource: ['github-copilot=opencode'],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(lines.some((l) => l.includes('no credential from opencode') && l.includes('GitHub Copilot'))).toBe(true);
  });

  it('refuses a malformed pair', async () => {
    await expect(init(['codex'])).rejects.toThrow(/--credential-source expects <gateway>=<source>/);
  });

  it('refuses an unknown source, listing the valid ones', async () => {
    await expect(init(['codex=keychain'])).rejects.toThrow(/sonata, codex, opencode/);
  });

  it('refuses a pair with an extra equals sign', () => {
    expect(() => parseCredentialSourceFlags(['codex=sonata=typo']))
      .toThrow(/--credential-source expects <gateway>=<source>/);
  });

  it('refuses a source for a gateway outside the selected models', async () => {
    writeFileSync(join(cwd, 'sonata.toml'), `
[native.gateways.codex]
base_url = "https://gateway.example/v1"
[native.models.gpt-5]
gateway = "codex"
id = "gpt-5"
context_window = 128000
[generate.native]
code = ["gpt-5"]
`);
    await expect(cmdInit({
      cwd, home, packageRoot: '/pkg', yes: true, detect,
      providers: ['codex/codex'], models: ['gpt-5'], roles: ['code'], scope: 'skip', write,
      credentialSource: ['codxe=sonata'],
    })).rejects.toThrow(/--credential-source names gateway "codxe".*Known gateways: codex/);
  });

  it('refuses codex as the source for an api-key gateway', async () => {
    const apiKeyInit = () => cmdInit({
      cwd, home, packageRoot: '/pkg', yes: true, detect,
      providers: ['codex/codex'], models: ['gpt-5'], roles: ['code'], scope: 'skip', write,
      credentialSource: ['codex=codex'],
    });
    // The fixture's Codex provider resolves as codex-oauth, so use an existing
    // config-only api-key gateway to exercise the unified validation loop.
    writeFileSync(join(cwd, 'sonata.toml'), `
[native.gateways.codex]
base_url = "https://gateway.example/v1"
[native.models.gpt-5]
gateway = "codex"
id = "gpt-5"
context_window = 128000
[generate.native]
code = ["gpt-5"]
`);
    await expect(apiKeyInit()).rejects.toThrow(/auth = "api-key".*cannot take its credential from codex/);
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
      refs: parseOpenCodeRefs('acme/deepseek-v4-flash-0731\n'),
      authedProviders: ['acme'],
      providerBaseUrls: { acme: 'https://gateway.acme.example/v1' },
      problems: [],
    }],
  });

  it('prints a key-source line for a chosen gateway with no discovered key', async () => {
    await cmdInit({
      cwd, home, packageRoot: '/pkg', yes: true, detect,
      providers: ['opencode/acme'], models: ['acme-deepseek-v4-flash-0731'],
      roles: ['code'], scope: 'skip', write,
    });
    expect(lines.some((l) => l.includes('acme') && l.includes('sonata auth add acme'))).toBe(true);
  });

  it('prints a key-source line naming the source when a key is discovered', async () => {
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(join(home, '.config', 'sonata', 'keys.json'), JSON.stringify({ acme: 'sk-test' }));

    await cmdInit({
      cwd, home, packageRoot: '/pkg', yes: true, detect,
      providers: ['opencode/acme'], models: ['acme-deepseek-v4-flash-0731'],
      roles: ['code'], scope: 'skip', write,
    });
    expect(lines.some((l) => l.includes('acme') && l.includes('key from sonata'))).toBe(true);
  });

  it('honors a recorded credential source over automatic precedence', async () => {
    // Regression: the key-check summary used to call keyReport with no
    // knowledge of credentialSources, so it reported whichever store
    // resolveKeys found first rather than the source init was told to pin.
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(join(home, '.config', 'sonata', 'keys.json'), JSON.stringify({ acme: 'sk-test' }));

    await cmdInit({
      cwd, home, packageRoot: '/pkg', yes: true, detect,
      providers: ['opencode/acme'], models: ['acme-deepseek-v4-flash-0731'],
      roles: ['code'], scope: 'skip', write,
      credentialSource: ['acme=opencode'],
    });
    expect(lines.some((l) => l.includes('acme') && l.includes('no key from opencode'))).toBe(true);
    expect(lines.some((l) => l.includes('key from sonata'))).toBe(false);
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

  it('rescripts an untiered native-only unified config with --yes and no flags', async () => {
    // A valid config with a hand-configured gateway, a native-only unified
    // [models] entry, and no [tiers] or legacy generate table at all. Two
    // bugs used to compound here: `deriveInitState`'s own providerKeys named
    // `config/solo-gateway`, but the separate `configuredGateways` scan (only
    // read `native.models`, never `unifiedModels`) never added that provider
    // to `offered` — so scripted init rejected it as unknown before role
    // selection was ever reached, masking the `roles: []` bug this config
    // shape was also written to catch.
    writeFileSync(join(cwd, 'sonata.toml'), `
[native.gateways."solo-gateway"]
base_url = "https://solo.example/v1"

[models."solo-native"]
gateway = "solo-gateway"
id = "solo-model"
context_window = 128000
`);
    await cmdInit({ cwd, home, packageRoot: '/pkg', yes: true, detect, scope: 'skip', write });
    const cfg = parseConfig(readFileSync(join(cwd, 'sonata.toml'), 'utf8'));
    expect(Object.keys(cfg.tiers ?? {}).sort()).toEqual(['code', 'explore', 'plan', 'review']);
    expect(cfg.unifiedModels['solo-native']).toBeDefined();
  });

  it('preserves a harness-only model with no native route across a re-init', async () => {
    writeFileSync(join(cwd, 'sonata.toml'), `
[models."opencode-deepseek-v4-flash"]
gateway = "opencode"
id = "deepseek-v4-flash"
context_window = 128000

[models."harness-only-thing"]
harness = "opencode"
id = "vendorx/some-model"

[native.gateways."opencode"]
base_url = "https://opencode.ai/api/v1"

[tiers.code]
simple = ["opencode-deepseek-v4-flash", "harness-only-thing"]
complex = ["opencode-deepseek-v4-flash", "harness-only-thing"]
`);
    await cmdInit({
      cwd, home, packageRoot: '/pkg', yes: true, detect,
      models: ['opencode-deepseek-v4-flash'], roles: ['code'], scope: 'skip', write,
    });
    const toml2 = readFileSync(join(cwd, 'sonata.toml'), 'utf8');
    expect(toml2).toContain('[models."harness-only-thing"]');
    expect(parseConfig(toml2).tiers?.code.complex).toContain('harness-only-thing');
  });

  it('drops a deselected model from [tiers] rather than writing a dangling reference', async () => {
    await cmdInit({
      cwd, home, packageRoot: '/pkg', yes: true, detect,
      providers: ['opencode/opencode'],
      models: ['opencode-deepseek-v4-flash', 'opencode-kimi-k3'],
      roles: ['code'], scope: 'skip', write,
    });
    const cfg1 = parseConfig(readFileSync(join(cwd, 'sonata.toml'), 'utf8'));
    expect([...cfg1.tiers!.code.simple, ...cfg1.tiers!.code.complex]).toContain('opencode-kimi-k3');

    // Re-init with only one of the two previously-selected models.
    await cmdInit({
      cwd, home, packageRoot: '/pkg', yes: true, detect,
      providers: ['opencode/opencode'], models: ['opencode-deepseek-v4-flash'],
      roles: ['code'], scope: 'skip', write,
    });
    const toml2 = readFileSync(join(cwd, 'sonata.toml'), 'utf8');
    const cfg2 = parseConfig(toml2); // throws if [tiers] references an undefined model
    expect([...cfg2.tiers!.code.simple, ...cfg2.tiers!.code.complex]).not.toContain('opencode-kimi-k3');
    expect(toml2).not.toContain('opencode-kimi-k3');
  });

  it('writes a newly added model when the wizard keeps the existing [tiers]', async () => {
    // Pre-existing config: one native model `a` listed in [tiers].
    writeFileSync(join(cwd, 'sonata.toml'), `
[native.gateways."opencode"]
base_url = "https://opencode.ai/api/v1"

[models."opencode-deepseek-v4-flash"]
gateway = "opencode"
id = "deepseek-v4-flash"
context_window = 128000

[tiers.code]
simple = ["opencode-deepseek-v4-flash"]
complex = ["opencode-deepseek-v4-flash"]
`);
    // The wizard keeps `a` and adds a second model `b`.
    tuiMocks.interactive = true;
    tuiMocks.result = {
      cancelled: false,
      state: {
        configScope: 'project',
        providerKeys: ['opencode/opencode'],
        nativeKeys: ['opencode-deepseek-v4-flash', 'opencode-kimi-k3'],
        perRoleModels: { code: ['opencode-deepseek-v4-flash', 'opencode-kimi-k3'] },
        roles: ['code'],
        byokKeys: {},
      },
    };
    await cmdInit({ cwd, home, packageRoot: '/pkg', detect, scope: 'skip', routing: 'skip', write });
    const toml = readFileSync(join(cwd, 'sonata.toml'), 'utf8');
    expect(toml).toContain('[models."opencode-deepseek-v4-flash"]');
    expect(toml).toContain('[models."opencode-kimi-k3"]');
  });

  it('appends a newly-added model to an existing [tiers] list on a scripted re-init', async () => {
    await cmdInit({
      cwd, home, packageRoot: '/pkg', yes: true, detect,
      providers: ['opencode/opencode'], models: ['opencode-deepseek-v4-flash'],
      roles: ['code'], scope: 'skip', write,
    });
    // The first run has only deepseek-v4-flash in [tiers]. Adding kimi-k3 on
    // the second run must append it to the existing non-empty list, not drop
    // it — `reconcileTierList` used to keep the saved list verbatim.
    await cmdInit({
      cwd, home, packageRoot: '/pkg', yes: true, detect,
      providers: ['opencode/opencode'],
      models: ['opencode-deepseek-v4-flash', 'opencode-kimi-k3'],
      roles: ['code'], scope: 'skip', write,
    });
    const cfg = parseConfig(readFileSync(join(cwd, 'sonata.toml'), 'utf8'));
    expect(cfg.tiers!.code.simple).toContain('opencode-kimi-k3');
    expect(cfg.tiers!.code.complex).toContain('opencode-kimi-k3');
    expect(cfg.tiers!.code.simple).toContain('opencode-deepseek-v4-flash');
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
    const state = deriveInitState(config({ m: { gateway: 'acme', id: 'm' } }), 'project', [
      { harness: 'opencode', provider: 'acme', count: 1, key: 'opencode/acme' },
    ]);
    expect(state.providerKeys).toEqual(['opencode/acme']);
    expect(state.harnesses).toEqual(['opencode']);
  });

  it('uses a synthetic provider for a gateway absent from detection', () => {
    const state = deriveInitState(config({ m: { gateway: 'hand', id: 'm' } }), 'project', []);
    expect(state.providerKeys).toEqual(['config/hand']);
    expect(state.harnesses).toEqual([]);
  });

  it('falls back to a synthetic provider when the same name is offered by more than one harness', () => {
    // A bare gateway name in sonata.toml carries no record of which harness's
    // discovery produced it. Two harnesses can coincidentally catalog an
    // identically named provider (verified live: both opencode and pi list
    // one called "opencode-go") — crediting both would pre-select a harness
    // the user never actually chose, with no way to make it stick unticked.
    const state = deriveInitState(config({ m: { gateway: 'shared', id: 'm' } }), 'project', [
      { harness: 'opencode', provider: 'shared', count: 1, key: 'opencode/shared' },
      { harness: 'pi', provider: 'shared', count: 1, key: 'pi/shared' },
    ]);
    expect(state.providerKeys).toEqual(['config/shared']);
    expect(state.harnesses).toEqual([]);
  });

  it('copies roles and per-role models from generate.native', () => {
    const state = deriveInitState(config({ m: { gateway: 'g', id: 'm' } }, { review: ['m'] }), 'global', []);
    expect(state.roles).toEqual(['review']);
    expect(state.perRoleModels).toEqual({ review: ['m'] });
  });

  it('keeps an untiered unified native-only model selected', () => {
    const config = parseConfig(`
[native.gateways."solo-gateway"]
base_url = "https://solo.example/v1"

[models."solo-native"]
gateway = "solo-gateway"
id = "solo-model"
context_window = 128000
`);
    const state = deriveInitState(config, 'project', []);
    expect(state.nativeKeys).toEqual(['solo-native']);
  });

  it('leaves roles undefined for a native-only unified config with no [tiers] or generate table', () => {
    // Downstream, `d.roles ?? [...KNOWN_ROLES]` only falls through to the
    // default role set on nullish — an explicit `[]` here used to be read as
    // "zero roles selected" and made scripted `sonata init --yes` throw
    // "no roles selected" for exactly this untiered, generatorless shape.
    const config = parseConfig(`
[native.gateways."solo-gateway"]
base_url = "https://solo.example/v1"

[models."solo-native"]
gateway = "solo-gateway"
id = "solo-model"
context_window = 128000
`);
    const state = deriveInitState(config, 'project', []);
    expect(state.roles).toBeUndefined();
  });

  it('keeps roles as [] for a syntactically present but empty [tiers] block', () => {
    // parseConfig accepts `[tiers]` with zero role sub-tables under it
    // without error — that's explicit configuration (of zero roles), not the
    // "no role configuration at all" case `roles: undefined` exists for.
    // A plain non-empty check on `config.tiers` would conflate the two;
    // `!== undefined` alone tells them apart.
    const config = parseConfig(`
[tiers]

[native.gateways."solo-gateway"]
base_url = "https://solo.example/v1"

[models."solo-native"]
gateway = "solo-gateway"
id = "solo-model"
context_window = 128000
`);
    const state = deriveInitState(config, 'project', []);
    expect(state.roles).toEqual([]);
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

  it('carries wire_format through when reconstructing a candidate from an existing config', () => {
    const config = parseConfig(`
[native.gateways."custom"]
auth = "api-key"
base_url = "https://custom.example/v1"
wire_format = "anthropic"
[native.models."custom-model"]
gateway = "custom"
id = "model-id"
context_window = 64000
`);
    expect(configNativeCandidates(config)).toEqual([{
      key: 'custom-model', gateway: 'custom', id: 'model-id', contextWindow: 64000,
      baseUrl: 'https://custom.example/v1', auth: 'api-key', wireFormat: 'anthropic',
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

  it('merges a legacy [native.models] entry alongside a unified [models] entry under a different key', () => {
    // A transitional config can have both tables at once. `unified.length > 0`
    // used to be treated as proof `[native.models]` was empty, silently
    // dropping the legacy-only key from the candidate list even though
    // `deriveInitState` still names it — scripted init then rejected it as
    // unavailable, and the interactive path couldn't resolve it either.
    const config = parseConfig(`
[native.gateways."acme"]
base_url = "https://acme.example/v1"

[models."unified-model"]
gateway = "acme"
id = "unified-upstream"
context_window = 128000

[native.models."legacy-model"]
gateway = "acme"
id = "legacy-upstream"
context_window = 64000
`);
    const keys = configNativeCandidates(config).map((candidate) => candidate.key);
    expect(keys).toContain('unified-model');
    expect(keys).toContain('legacy-model');
  });

  it('lets a legacy entry win over a unified entry sharing the same key, matching litellmConfig', () => {
    // native/litellm.ts builds its model list from `native.models` first,
    // unconditionally, and skips a unified entry sharing that key — this
    // must agree, or `sonata init` could rewrite a key to point at a
    // different upstream than the one actually being served.
    const config = parseConfig(`
[native.gateways."acme"]
base_url = "https://acme.example/v1"

[models."shared-key"]
gateway = "acme"
id = "unified-upstream"
context_window = 128000

[native.models."shared-key"]
gateway = "acme"
id = "legacy-upstream"
context_window = 64000
`);
    const candidates = configNativeCandidates(config);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].id).toBe('legacy-upstream');
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

describe('nativeTomlFor — wire_format', () => {
  it('emits wire_format for an anthropic-wire-format candidate', () => {
    const toml = nativeTomlFor({
      code: [{
        key: 'custom-claude-clone', gateway: 'custom', id: 'claude-clone',
        contextWindow: 128000, baseUrl: 'https://example.com/v1', auth: 'api-key',
        wireFormat: 'anthropic',
      }],
    });
    expect(toml).toMatch(/\[native\.gateways\."custom"\][\s\S]*wire_format = "anthropic"/);
  });

  it('omits wire_format for an openai (default) candidate', () => {
    const toml = nativeTomlFor({
      code: [{
        key: 'custom-gpt', gateway: 'custom', id: 'gpt',
        contextWindow: 128000, baseUrl: 'https://example.com/v1', auth: 'api-key',
      }],
    });
    expect(toml).not.toContain('wire_format');
  });
});

describe('nativeTomlFor — codex-oauth gateways', () => {
  const codexCandidate: NativeCandidate = {
    key: 'luna', gateway: 'codex', id: 'gpt-5.6-luna',
    contextWindow: 128000, baseUrl: CODEX_OAUTH_BASE_URL, auth: 'codex-oauth',
  };
  const keyCandidate: NativeCandidate = {
    key: 'ds', gateway: 'acme', id: 'deepseek-v4-flash-0731',
    contextWindow: 128000, baseUrl: 'https://gateway.acme.example/v1', auth: 'api-key',
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
    expect(toml).toContain('base_url = "https://gateway.acme.example/v1"');
  });

  it('round-trips through parseConfig', () => {
    const config = parseConfig(nativeTomlFor({ code: [codexCandidate, keyCandidate] }));
    expect(config.native!.gateways.codex).toEqual({
      baseUrl: CODEX_OAUTH_BASE_URL, auth: 'codex-oauth',
    });
    expect(config.native!.gateways.acme.auth).toBe('api-key');
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
      cwd, home, packageRoot: '/pkg', detect, scope: 'skip', routing: 'skip', write: () => {},
    });

    expect(parseConfig(readFileSync(join(cwd, 'sonata.toml'), 'utf8')).native!.gateways.codex).toEqual({
      baseUrl: 'https://api.openai.com/v1', auth: 'api-key',
    });
  });

  it('refuses codex as the source for an api-key gateway chosen through the wizard', async () => {
    // Regression: the codex-combo check used to live only in the scripted
    // (--credential-source) branch, so a stale wizard result could still
    // write this incompatible combination.
    writeFileSync(join(cwd, 'sonata.toml'), `
[native.gateways.codex]
base_url = "https://gateway.example/v1"
[native.models.gpt-5]
gateway = "codex"
id = "gpt-5"
context_window = 128000
[generate.native]
"code" = ["gpt-5"]
`);
    tuiMocks.interactive = true;
    tuiMocks.result = {
      cancelled: false,
      state: {
        configScope: 'project', providerKeys: ['config/codex'], nativeKeys: ['gpt-5'],
        roles: ['code'], perRoleModels: { code: ['gpt-5'] }, byokKeys: {},
        credentialSources: { codex: 'codex' },
      },
    };
    const detect = async () => ({
      tmux: { installed: true, version: '3.7b', problems: [] },
      harnesses: [],
    });

    await expect(cmdInit({
      cwd, home, packageRoot: '/pkg', detect, scope: 'skip', write: () => {},
    })).rejects.toThrow(/auth = "api-key".*cannot take its credential from codex/);
  });
});

describe('cmdInit — custom provider wire format', () => {
  it('writes wire_format for a custom provider added through the wizard', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'init-custom-provider-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'init-custom-provider-home-'));
    const detect = makeDetect();
    tuiMocks.interactive = true;
    tuiMocks.result = {
      cancelled: false,
      state: {
        configScope: 'project',
        harnesses: [],
        providerKeys: ['byok/my-proxy'],
        nativeKeys: ['my-proxy-proxy-model'],
        roles: ['code'],
        perRoleModels: { code: ['my-proxy-proxy-model'] },
        byokKeys: { 'my-proxy': 'sk-test' },
        byokModels: { 'my-proxy': ['proxy-model'] },
        customProviders: [{ name: 'my-proxy', url: 'https://my-proxy.example.com/v1' }],
        customWireFormats: { 'my-proxy': 'anthropic' },
      },
    };
    await cmdInit({ cwd, home, packageRoot: '/pkg', yes: false, detect, scope: 'skip', routing: 'skip', write: () => {} });
    const written = readFileSync(join(cwd, 'sonata.toml'), 'utf8');
    expect(written).toMatch(/\[native\.gateways\."my-proxy"\][\s\S]*base_url = "https:\/\/my-proxy\.example\.com\/v1"[\s\S]*wire_format = "anthropic"/);
    expect(written).toContain('id = "proxy-model"');
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

  it('falls back to the config-persisted base URL for a gateway no harness discovers anymore', async () => {
    // A gateway can be removed from a harness (e.g. unlinked from opencode)
    // while staying configured in sonata.toml. Re-authenticating it through
    // the wizard needs a base URL to fetch a fresh model list from — with no
    // live harness detection, sonata.toml's own base_url is the only source.
    const cwd = mkdtempSync(join(tmpdir(), 'init-gateway-base-url-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'init-gateway-base-url-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), `
[native.gateways."removed-gw"]
base_url = "https://gateway.example/v1"
[native.models."removed-model"]
gateway = "removed-gw"
id = "some-model"
context_window = 128000
[generate.native]
"code" = ["removed-model"]
`);
    tuiMocks.interactive = true;
    tuiMocks.result = { cancelled: true, state: { configScope: 'project' } };
    const detect = async () => ({
      tmux: { installed: true, version: '3.7b', problems: [] },
      harnesses: [],
    });

    await cmdInit({ cwd, home, packageRoot: '/pkg', detect, write: () => {} });

    expect(tuiMocks.data!.gatewayBaseUrls?.['removed-gw']).toBe('https://gateway.example/v1');
  });

  it('prefers a harness-live base URL over a config-persisted one for the same gateway', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'init-gateway-base-url-live-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'init-gateway-base-url-live-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), `
[native.gateways."acme"]
base_url = "https://stale.example/v1"
[native.models."acme-model"]
gateway = "acme"
id = "some-model"
context_window = 128000
[generate.native]
"code" = ["acme-model"]
`);
    tuiMocks.interactive = true;
    tuiMocks.result = { cancelled: true, state: { configScope: 'project' } };
    const detect = async () => ({
      tmux: { installed: true, version: '3.7b', problems: [] },
      harnesses: [{
        name: 'opencode', installed: true, version: '1.18.16', supported: true,
        refs: parseOpenCodeRefs('acme/deepseek-v4-flash-0731\n'),
        authedProviders: ['acme'],
        providerBaseUrls: { acme: 'https://live.example/v1' },
        problems: [],
      }],
    });

    await cmdInit({ cwd, home, packageRoot: '/pkg', detect, write: () => {} });

    expect(tuiMocks.data!.gatewayBaseUrls?.acme).toBe('https://live.example/v1');
  });
});

describe('oauthProvidersFor', () => {
  const refs = [
    { harness: 'codex' as const, provider: 'codex', id: 'gpt-5.6-luna', ref: 'codex/gpt-5.6-luna' },
    { harness: 'opencode' as const, provider: 'openai', id: 'gpt-4o', ref: 'openai/gpt-4o' },
    { harness: 'opencode' as const, provider: 'github-copilot', id: 'gpt-4o', ref: 'github-copilot/gpt-4o' },
    { harness: 'opencode' as const, provider: 'acme', id: 'deepseek', ref: 'acme/deepseek' },
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
    expect(got.has('acme')).toBe(false);
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
      harness: 'opencode',
      harnessId: 'github-copilot/gpt-4o',
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
      { harness: 'opencode' as const, provider: 'acme', id: 'deepseek-v4', ref: 'acme/deepseek-v4' },
    ];
    const got = nativeCandidatesFrom(refs, { anthropic: 'https://a/v1', acme: 'https://b/v1' });
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
    const res = await cmdInit({ ...args, cwd, home, write });

    const toml = readFileSync(res.configPath, 'utf8');
    expect(toml).toMatch(/\[native\.gateways\."deepseek"\]/);
    expect(toml).toMatch(/base_url = "https:\/\/api\.deepseek\.com\/v1"/);
    expect(toml).toMatch(/\[models\."deepseek-deepseek-v4-flash"\]/);
    expect(toml).toMatch(/id = "deepseek-v4-flash"/);
  });

  it('does not make a missing harness fatal', async () => {
    // Before BYOK this returned early with severity 'error' and wrote nothing.
    writeSonataKey(home, 'deepseek', 'sk-test');
    const res = await cmdInit({ ...args, cwd, home, write });
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
    });
    expect(readFileSync(res.configPath, 'utf8')).toMatch(/\[models\."openrouter-kimi-k3"\]/);
  });

  // The double-init bug, now for a gateway no harness can rediscover.
  it('re-derives a BYOK config on a second init', async () => {
    writeSonataKey(home, 'deepseek', 'sk-test');
    const res = await cmdInit({ ...args, cwd, home, write });

    const config = parseConfig(readFileSync(res.configPath, 'utf8'));
    const state = deriveInitState(config, 'project', []);

    expect(state.nativeKeys).toEqual(['deepseek-deepseek-v4-flash']);
    expect(state.providerKeys).toEqual(['config/deepseek']);
    expect(state.perRoleModels).toEqual({ code: ['deepseek-deepseek-v4-flash'] });
  });

  it('carries a BYOK config through a second init unchanged', async () => {
    writeSonataKey(home, 'deepseek', 'sk-test');
    const first = await cmdInit({ ...args, cwd, home, write });
    const before = readFileSync(first.configPath, 'utf8');

    // No flags this time: everything must come back from the config on disk.
    const second = await cmdInit({
      packageRoot: '/pkg', yes: true, detect: noHarness, cwd, home, write,
      scope: 'skip' as const,
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
    expect(reconcilePerRoleModels({ code: ['acme-kimi-k3'] }, ['acme-kimi-k3'], ['gpt-5.6-luna'], ['code']))
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

describe('reconcileTierList', () => {
  it('appends a newly-added model to an existing non-empty tier list', () => {
    // The bug this exists for: re-seeding only from the saved list dropped a
    // model the user had just added — `[tiers]` silently kept the old list.
    expect(reconcileTierList(['a'], new Set(['a', 'b']), ['a'], ['b']))
      .toEqual(['a', 'b']);
  });

  it('falls back to the proposal when nothing survives', () => {
    expect(reconcileTierList(undefined, new Set(['a']), ['a'])).toEqual(['a']);
    expect(reconcileTierList(['gone'], new Set(['a']), ['a'], ['b'])).toEqual(['a']);
  });

  it('does not duplicate an added model already in the saved list', () => {
    expect(reconcileTierList(['a', 'b'], new Set(['a', 'b']), ['a'], ['a', 'b']))
      .toEqual(['a', 'b']);
  });
});
