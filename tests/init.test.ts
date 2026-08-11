import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseOpenCodeModels, parseAuthedProviders, staleAgents, parseOpenCodeRefs, offerableProviders } from '../src/detect.js';
import { parsePiRefs } from '../src/adapters/pi.js';
import { cmdInit, configKeyFor, duplicateKeys, preTickedRefs, carriedEntries, tomlFor } from '../src/commands/init.js';
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
    harnesses: [{
      name: 'opencode',
      installed: true,
      version: '1.18.15',
      supported: true,
      binPath: '/fake/opencode',
      refs: parseOpenCodeRefs('opencode/deepseek-v4-flash\nopencode/kimi-k3\nopencode/grok-4.5\n'),
      authedProviders: authed,
      problems: authed.length === 0
        ? [{
            severity: 'error' as const,
            message: 'opencode has models configured but no authenticated provider',
            fix: 'opencode auth login',
          }]
        : [],
    }],
  });

  it('writes config, installs the hook and generates agents', async () => {
    const res = await cmdInit({
      cwd, home, packageRoot: '/pkg', yes: true, detect,
      providers: ['opencode/opencode'], models: ['opencode-opencode-deepseek-v4-flash'],
      roles: ['code'], scope: 'project', write,
    });

    expect(res.models).toEqual(['opencode-opencode-deepseek-v4-flash']);
    expect(res.agentsWritten).toHaveLength(1);
    expect(res.hookChanged).toBe(true);

    const toml = readFileSync(join(cwd, 'sonata.toml'), 'utf8');
    expect(toml).toContain('[models."opencode-opencode-deepseek-v4-flash"]');
    expect(toml).toContain('harness = "opencode"');

    const settings = readSettings(join(cwd, '.claude', 'settings.json'));
    expect(settings.hooks!.PreToolUse[0].hooks[0].command)
      .toBe('node "/pkg/hooks/capture-mode.mjs"');

    expect(existsSync(join(cwd, '.claude', 'agents', 'code-opencode-opencode-deepseek-v4-flash.md'))).toBe(true);
  });

  it('is idempotent across repeated runs', async () => {
    const args = {
      cwd, home, packageRoot: '/pkg', yes: true, detect,
      providers: ['opencode/opencode'] as string[],
      models: ['opencode-opencode-deepseek-v4-flash'], roles: ['code'], scope: 'project' as const, write,
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
      providers: ['opencode/opencode'], models: ['opencode-opencode-kimi-k3'],
      roles: ['review'], scope: 'skip', write,
    });
    expect(res.hookChanged).toBe(false);
    expect(existsSync(join(cwd, '.claude', 'settings.json'))).toBe(false);
  });

  it('rejects a model opencode does not offer', async () => {
    await expect(cmdInit({
      cwd, home, packageRoot: '/pkg', yes: true, detect,
      providers: ['opencode/opencode'], models: ['gpt-9'], roles: ['code'], scope: 'skip', write,
    })).rejects.toThrow(/not offer gpt-9/);
  });

  it('rejects an unknown role', async () => {
    await expect(cmdInit({
      cwd, home, packageRoot: '/pkg', yes: true, detect,
      providers: ['opencode/opencode'], models: ['opencode-opencode-kimi-k3'],
      roles: ['dance'], scope: 'skip', write,
    })).rejects.toThrow(/unknown role/);
  });

  // A model id like `grok-4.5` is not a plain TOML key: the dot nests it, so
  // `[models."opencode-opencode-grok-4.5"]` parses as models -> "opencode-opencode-grok-4" -> "5"
  // and the config no longer describes the model it names.
  it('writes a model id containing dots as one quoted key', async () => {
    await cmdInit({
      cwd, home, packageRoot: '/pkg', yes: true, detect,
      providers: ['opencode/opencode'], models: ['opencode-opencode-grok-4.5'],
      roles: ['code'], scope: 'skip', write,
    });

    const config = parseConfig(readFileSync(join(cwd, 'sonata.toml'), 'utf8'));
    expect(Object.keys(config.models)).toEqual(['opencode-opencode-grok-4.5']);
    expect(config.models['opencode-opencode-grok-4.5']).toEqual({ harness: 'opencode', id: 'opencode/grok-4.5' });
  });

  it('reports blocking problems and writes nothing when a provider is unauthed', async () => {
    authed = [];
    const res = await cmdInit({
      cwd, home, packageRoot: '/pkg', yes: true, detect,
      models: ['opencode-opencode-kimi-k3'], roles: ['code'], scope: 'skip', write,
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
      },
      {
        name: 'pi', installed: true, version: '0.84.0', supported: true,
        refs: parsePiRefs('provider  model\nopencode-go  grok-4.5\n'),
        authedProviders: [], problems: [],
      },
    ],
  });

  it('enables the chosen provider\'s copy and writes the ref', async () => {
    const res = await cmdInit({
      cwd, home, packageRoot: '/pkg', yes: true, detect,
      providers: ['opencode/openrouter'], models: ['opencode-openrouter-grok-4.5'],
      roles: ['code'], scope: 'skip', write,
    });

    expect(res.models).toEqual(['opencode-openrouter-grok-4.5']);
    const cfg = parseConfig(readFileSync(join(cwd, 'sonata.toml'), 'utf8'));
    expect(cfg.models['opencode-openrouter-grok-4.5'].id).toBe('openrouter/grok-4.5');
  });

  it('keeps the same model from two harnesses as two entries', async () => {
    await cmdInit({
      cwd, home, packageRoot: '/pkg', yes: true, detect,
      providers: ['opencode/opencode-go', 'pi/opencode-go'],
      models: ['opencode-opencode-go-grok-4.5', 'pi-opencode-go-grok-4.5'],
      roles: ['code'], scope: 'skip', write,
    });

    const cfg = parseConfig(readFileSync(join(cwd, 'sonata.toml'), 'utf8'));
    expect(cfg.models['opencode-opencode-go-grok-4.5'].harness).toBe('opencode');
    expect(cfg.models['pi-opencode-go-grok-4.5'].harness).toBe('pi');
  });

  it('carries a hand-written codex entry through a re-run', async () => {
    writeFileSync(join(cwd, 'sonata.toml'), `
[models."gpt-5-6-sol"]
harness = "codex"
id = "gpt-5.6-sol"

[generate]
roles = ["code"]
models = ["gpt-5-6-sol"]
`);
    await cmdInit({
      cwd, home, packageRoot: '/pkg', yes: true, detect,
      providers: ['opencode/openrouter'], models: ['opencode-openrouter-grok-4.5'],
      roles: ['code'], scope: 'skip', write,
    });

    const cfg = parseConfig(readFileSync(join(cwd, 'sonata.toml'), 'utf8'));
    expect(cfg.models['gpt-5-6-sol'].id).toBe('gpt-5.6-sol');
    expect(cfg.generate.models).toContain('gpt-5-6-sol');
  });

  it('pre-selects an enabled ref on a re-run', async () => {
    const args = {
      cwd, home, packageRoot: '/pkg', yes: true, detect,
      roles: ['code'], scope: 'skip' as const, write,
    };
    await cmdInit({ ...args, providers: ['opencode/openrouter'], models: ['opencode-openrouter-grok-4.5'] });
    const second = await cmdInit(args);

    expect(second.models).toEqual(['opencode-openrouter-grok-4.5']);
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
    // The model id may itself contain slashes; only the provider is delimited.
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
    // `openrouter` is not authed here, but pi must be offered all the same. The
    // free opencode tier is always offered too, needing no auth entry.
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

describe('configKeyFor', () => {
  const ref = (harness: 'opencode' | 'pi', provider: string, id: string) =>
    ({ harness, provider, id, ref: `${provider}/${id}` });

  it('qualifies the key with the harness', () => {
    expect(configKeyFor(ref('opencode', 'openrouter', 'deepseek-v4-flash')))
      .toBe('opencode-openrouter-deepseek-v4-flash');
  });

  it('flattens a nested openrouter id', () => {
    expect(configKeyFor(ref('opencode', 'openrouter', 'deepseek/deepseek-v4-flash')))
      .toBe('opencode-openrouter-deepseek-deepseek-v4-flash');
  });

  it('separates the same ref served by two harnesses', () => {
    const a = configKeyFor(ref('opencode', 'opencode-go', 'deepseek-v4-flash'));
    const b = configKeyFor(ref('pi', 'opencode-go', 'deepseek-v4-flash'));
    expect(a).not.toBe(b);
  });
});

describe('duplicateKeys', () => {
  it('finds two refs that flatten alike', () => {
    // Provider names contain dashes too, so flattening is not injective.
    const a = configKeyFor({ harness: 'opencode', provider: 'opencode', id: 'go-x', ref: 'opencode/go-x' });
    const b = configKeyFor({ harness: 'opencode', provider: 'opencode-go', id: 'x', ref: 'opencode-go/x' });
    expect(a).toBe(b);
    expect(duplicateKeys([a, b])).toEqual([a]);
  });

  it('is empty when every key is distinct', () => {
    expect(duplicateKeys(['a', 'b', 'c'])).toEqual([]);
  });

  it('reports each colliding key once', () => {
    expect(duplicateKeys(['a', 'a', 'a', 'b'])).toEqual(['a']);
  });
});

describe('preTickedRefs', () => {
  const refs = [
    { harness: 'opencode' as const, provider: 'openrouter', id: 'deepseek-v4-flash', ref: 'openrouter/deepseek-v4-flash' },
    { harness: 'pi' as const, provider: 'opencode-go', id: 'deepseek-v4-flash', ref: 'opencode-go/deepseek-v4-flash' },
  ];

  it('recognises a hand-written pi entry from its ref, not its key', () => {
    // The README tells users to name this entry `pi-deepseek`; the wizard
    // would never generate that key, but the ref says exactly what was meant.
    const toml = `
[models."pi-deepseek"]
harness = "pi"
id = "opencode-go/deepseek-v4-flash"

[generate]
roles = ["code"]
models = ["pi-deepseek"]
`;
    expect(preTickedRefs(toml, refs)).toEqual(new Set(['opencode-go/deepseek-v4-flash']));
  });

  it('matches the harness too, so one ref under two harnesses stays distinct', () => {
    const toml = `
[models."opencode-opencode-go-deepseek-v4-flash"]
harness = "opencode"
id = "opencode-go/deepseek-v4-flash"

[generate]
roles = ["code"]
models = ["opencode-opencode-go-deepseek-v4-flash"]
`;
    // The only catalogue ref with that id is pi's, so nothing pre-ticks.
    expect(preTickedRefs(toml, refs)).toEqual(new Set());
  });

  it('pre-ticks nothing for a bare id, which names no provider', () => {
    const toml = `
[models."kimi-k3"]
harness = "opencode"
id = "kimi-k3"

[generate]
roles = ["code"]
models = ["kimi-k3"]
`;
    expect(preTickedRefs(toml, refs)).toEqual(new Set());
  });

  it('is empty for an unparseable or empty config', () => {
    expect(preTickedRefs('', refs)).toEqual(new Set());
    expect(preTickedRefs('not toml at all {{{', refs)).toEqual(new Set());
  });
});

describe('carriedEntries', () => {
  const toml = `
[models."gpt-5-6-sol"]
harness = "codex"
id = "gpt-5.6-sol"

[models."opencode-openrouter-kimi-k3"]
harness = "opencode"
id = "openrouter/kimi-k3"

[generate]
roles = ["code"]
models = ["gpt-5-6-sol", "opencode-openrouter-kimi-k3"]
`;

  it('keeps entries whose harness the wizard does not manage', () => {
    expect(carriedEntries(toml, ['opencode', 'pi'])).toEqual({
      'gpt-5-6-sol': { harness: 'codex', id: 'gpt-5.6-sol' },
    });
  });

  it('drops entries the wizard is about to rewrite', () => {
    expect(carriedEntries(toml, ['opencode', 'pi'])['opencode-openrouter-kimi-k3']).toBeUndefined();
  });

  it('is empty for an unparseable config', () => {
    expect(carriedEntries('not toml {{{', ['opencode'])).toEqual({});
  });
});

describe('tomlFor', () => {
  const refs = [{
    harness: 'opencode' as const, provider: 'openrouter',
    id: 'grok-4.5', ref: 'openrouter/grok-4.5',
  }];

  it('writes quoted keys and the ref verbatim', () => {
    const out = tomlFor(refs, ['code'], {});
    expect(out).toContain('[models."opencode-openrouter-grok-4.5"]');
    expect(out).toContain('harness = "opencode"');
    expect(out).toContain('id = "openrouter/grok-4.5"');
  });

  it('carries a hand-written entry through, in generate.models too', () => {
    const out = tomlFor(refs, ['code'], { 'gpt-5-6-sol': { harness: 'codex', id: 'gpt-5.6-sol' } });
    expect(out).toContain('[models."gpt-5-6-sol"]');
    expect(out).toContain('harness = "codex"');
    expect(out).toContain('"gpt-5-6-sol"');
    // Both the generated and the carried model are generated.
    const parsed = parseConfig(out);
    expect(parsed.generate.models.sort())
      .toEqual(['gpt-5-6-sol', 'opencode-openrouter-grok-4.5']);
  });
});

describe('HarnessStatus.refs', () => {
  it('carries refs rather than bare model ids', async () => {
    // Detection shells out, so this asserts the shape the fakes must satisfy.
    const status = {
      name: 'opencode', installed: true, supported: true,
      refs: parseOpenCodeRefs('openrouter/kimi-k3\n'),
      authedProviders: ['openrouter'], problems: [],
    };
    expect(status.refs[0].ref).toBe('openrouter/kimi-k3');
  });
});

describe('tomlFor — escaping', () => {
  // Found by an independent review run: the table header was escaped via
  // tomlKey, but the generate.models array and the values were interpolated
  // raw. A hand-written key containing a quote produced a config that no
  // longer parsed — destroying the very entry carrying it through was meant
  // to protect.
  it('escapes carried keys everywhere they appear, not just in the header', () => {
    const carried = { 'say"hi': { harness: 'codex', id: 'gpt-5.6-sol' } };
    const out = tomlFor([], ['code'], carried);

    expect(() => parseConfig(out)).not.toThrow();
    expect(parseConfig(out).generate.models).toEqual(['say"hi']);
  });

  it('escapes a backslash in a value', () => {
    const carried = { plain: { harness: 'codex', id: 'a\\b' } };
    const out = tomlFor([], ['code'], carried);
    expect(parseConfig(out).models.plain.id).toBe('a\\b');
  });
});
