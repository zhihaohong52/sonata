import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig, isReadOnlyRole, configPath, loadConfig, generatedAgents, expectedAgentNames, CODEX_OAUTH_BASE_URL, COPILOT_OAUTH_BASE_URL, resolveTierAlias, harnessModelFor } from '../src/config.js';

const VALID = `
[models.deepseek-v4-flash]
harness = "opencode"
id = "opencode-go/deepseek-v4-flash"

[generate.roles]
code = ["deepseek-v4-flash"]
`;

describe('parseConfig', () => {
  it('parses models and applies run defaults', () => {
    const cfg = parseConfig(VALID);
    expect(cfg.models['deepseek-v4-flash']).toEqual({
      harness: 'opencode', id: 'opencode-go/deepseek-v4-flash',
    });
    expect(cfg.run.tailWindowSeconds).toBe(20);
    expect(cfg.run.stallTimeoutSeconds).toBe(120);
    expect(cfg.run.runTimeoutSeconds).toBe(1800);
  });

  it('overrides run defaults from snake_case keys', () => {
    const cfg = parseConfig(`${VALID}\n[run]\ntail_window_seconds = 5\n`);
    expect(cfg.run.tailWindowSeconds).toBe(5);
  });

  it('rejects a generate.roles entry with no model definition', () => {
    const bad = `
[models.a]
harness = "opencode"
id = "openrouter/a"

[generate.roles]
code = ["ghost"]
`;
    expect(() => parseConfig(bad)).toThrow(/unknown model "ghost"/);
  });

  it('rejects an unknown harness', () => {
    const bad = `
[models.a]
harness = "nope"
id = "a"

[generate.roles]
code = ["a"]
`;
    expect(() => parseConfig(bad)).toThrow(/unknown harness "nope"/);
  });

  it('rejects an unknown role', () => {
    const bad = `
[models.a]
harness = "opencode"
id = "openrouter/a"

[generate.roles]
dance = ["a"]
`;
    expect(() => parseConfig(bad)).toThrow(/unknown role "dance"/);
  });

  it('accepts explore and plan roles', () => {
    const cfg = parseConfig(`
[models.a]
harness = "opencode"
id = "openrouter/a"

[generate.roles]
explore = ["a"]
plan = ["a"]
`);
    expect(cfg.generate.roles).toEqual({ explore: ['a'], plan: ['a'] });
  });
});

describe('native gateway wire_format', () => {
  it('parses wire_format = "anthropic" on an api-key gateway', () => {
    const config = parseConfig(`
[native.gateways.custom]
auth = "api-key"
base_url = "https://example.com/v1"
wire_format = "anthropic"
`);
    expect(config.native!.gateways.custom.wireFormat).toBe('anthropic');
  });

  it('defaults to no wireFormat when absent, unchanged from today', () => {
    const config = parseConfig(`
[native.gateways.custom]
auth = "api-key"
base_url = "https://example.com/v1"
`);
    expect(config.native!.gateways.custom.wireFormat).toBeUndefined();
  });

  it('refuses wire_format on an unknown value', () => {
    expect(() => parseConfig(`
[native.gateways.custom]
auth = "api-key"
base_url = "https://example.com/v1"
wire_format = "grpc"
`)).toThrow(/unknown wire_format "grpc".*openai, anthropic/s);
  });

  it('refuses wire_format on a codex-oauth gateway', () => {
    expect(() => parseConfig(`
[native.gateways.codex]
auth = "codex-oauth"
wire_format = "anthropic"
`)).toThrow(/codex-oauth, so it cannot set wire_format/);
  });

  it('refuses wire_format on a copilot-oauth gateway', () => {
    expect(() => parseConfig(`
[native.gateways."github-copilot"]
auth = "copilot-oauth"
wire_format = "anthropic"
`)).toThrow(/copilot-oauth, so it cannot set wire_format/);
  });
});

describe('dispatch window', () => {
  it('defaults to 1500 seconds, inside the 30-minute MCP idle window', () => {
    const c = parseConfig(`
[models.m]
harness = "opencode"
id = "p/m"

[generate.roles]
code = ["m"]
`);
    expect(c.run.dispatchWindowSeconds).toBe(1500);
  });

  it('reads an override from the run table', () => {
    const c = parseConfig(`
[models.m]
harness = "opencode"
id = "p/m"

[generate.roles]
code = ["m"]

[run]
dispatch_window_seconds = 600
`);
    expect(c.run.dispatchWindowSeconds).toBe(600);
  });
});

describe('parseConfig — provider-qualified ids', () => {
  const cfg = (harness: string, id: string) => `
[models."m"]
harness = "${harness}"
id = "${id}"

[generate.roles]
code = ["m"]
`;

  it('rejects a bare id on opencode, which needs provider/model', () => {
    expect(() => parseConfig(cfg('opencode', 'kimi-k3')))
      .toThrow(/needs a provider.*sonata init/s);
  });

  it('rejects a bare id on pi for the same reason', () => {
    expect(() => parseConfig(cfg('pi', 'kimi-k3'))).toThrow(/needs a provider/);
  });

  it('accepts a ref', () => {
    expect(parseConfig(cfg('opencode', 'openrouter/kimi-k3')).models.m.id).toBe('openrouter/kimi-k3');
  });

  it('accepts a bare codex id, which has no provider dimension', () => {
    expect(parseConfig(cfg('codex', 'gpt-5.6-sol')).models.m.id).toBe('gpt-5.6-sol');
  });
});

describe('isReadOnlyRole', () => {
  it('returns true for read-only roles', () => {
    expect(isReadOnlyRole('review')).toBe(true);
    expect(isReadOnlyRole('explore')).toBe(true);
    expect(isReadOnlyRole('plan')).toBe(true);
  });

  it('returns false for code', () => {
    expect(isReadOnlyRole('code')).toBe(false);
  });
});

describe('configPath', () => {
  const MINIMAL = `
[models."m"]
harness = "codex"
id = "gpt-5.6-sol"

[generate.roles]
code = ["m"]
`;

  let cwd: string;
  let home: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'cfg-cwd-'));
    home = mkdtempSync(join(tmpdir(), 'cfg-home-'));
  });

  const writeLocal = () => writeFileSync(join(cwd, 'sonata.toml'), MINIMAL);
  const writeGlobal = (body = MINIMAL) => {
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(join(home, '.config', 'sonata', 'sonata.toml'), body);
  };

  it('uses the project config when there is one', () => {
    writeLocal();
    expect(configPath(cwd, home)).toBe(join(cwd, 'sonata.toml'));
  });

  it('falls back to the machine config', () => {
    writeGlobal();
    expect(configPath(cwd, home)).toBe(join(home, '.config', 'sonata', 'sonata.toml'));
  });

  it('prefers the project config when both exist', () => {
    writeLocal();
    writeGlobal();
    expect(configPath(cwd, home)).toBe(join(cwd, 'sonata.toml'));
  });

  it('returns null when neither exists', () => {
    expect(configPath(cwd, home)).toBeNull();
  });
});

describe('loadConfig — resolution', () => {
  let cwd: string;
  let home: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'cfg-cwd-'));
    home = mkdtempSync(join(tmpdir(), 'cfg-home-'));
  });

  it('loads the machine config when the project has none', () => {
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(join(home, '.config', 'sonata', 'sonata.toml'), `
[models."m"]
harness = "codex"
id = "gpt-5.6-sol"

[generate.roles]
code = ["m"]
`);
    expect(Object.keys(loadConfig(cwd, home).models)).toEqual(['m']);
  });

  it('names both places it looked when neither exists', () => {
    expect(() => loadConfig(cwd, home)).toThrow(/sonata\.toml/);
    expect(() => loadConfig(cwd, home)).toThrow(new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    expect(() => loadConfig(cwd, home)).toThrow(/\.config[/\\]sonata/);
  });
});

describe('generate.roles table', () => {
  const cfg = (body: string) => `
[models."a"]
harness = "codex"
id = "gpt-5.6-sol"

[models."b"]
harness = "codex"
id = "gpt-5.6-terra"

${body}
`;

  it('gives each role its own models', () => {
    const c = parseConfig(cfg(`
[generate.roles]
code = ["a"]
review = ["a", "b"]
`));
    expect(c.generate.roles).toEqual({ code: ['a'], review: ['a', 'b'] });
    expect(generatedAgents(c)).toEqual([
      { role: 'code', model: 'a' },
      { role: 'review', model: 'a' },
      { role: 'review', model: 'b' },
    ]);
  });

  it('treats an empty list and an omitted role alike', () => {
    const c = parseConfig(cfg(`
[generate.roles]
code = []
`));
    expect(generatedAgents(c)).toEqual([]);
  });

  // TOML cannot hold both `roles = [...]` and `[generate.roles]`, so the old
  // form is detected by type rather than guessed. A config that parses into
  // something nobody intended is how the [models.gpt-5.6-luna] bug happened.
  it('rejects the old flat form, naming the fix', () => {
    expect(() => parseConfig(cfg(`
[generate]
roles = ["code"]
models = ["a"]
`))).toThrow(/\[generate\.roles\]/);
  });

  it('rejects a leftover generate.models key', () => {
    expect(() => parseConfig(cfg(`
[generate]
models = ["a"]
`))).toThrow(/\[generate\.roles\]/);
  });

  it('rejects an unknown role key', () => {
    expect(() => parseConfig(cfg(`
[generate.roles]
dance = ["a"]
`))).toThrow(/unknown role/i);
  });

  it('names the role when a model is undefined', () => {
    expect(() => parseConfig(cfg(`
[generate.roles]
code = ["nope"]
`))).toThrow(/code.*nope/s);
  });
});

describe('native config', () => {
  it('parses a [native] table with models, gateways, ports and generate', () => {
    const cfg = parseConfig(`
[native.models."deepseek-v4-flash"]
gateway = "acme"
id = "deepseek-v4-flash-0731"
context_window = 128000
[native.gateways."acme"]
base_url = "https://gateway.acme.example/v1"
[generate.native]
code = ["deepseek-v4-flash"]
`);
    expect(cfg.native?.models['deepseek-v4-flash']).toEqual({
      gateway: 'acme', id: 'deepseek-v4-flash-0731', contextWindow: 128000,
    });
    expect(cfg.native?.gateways.acme.baseUrl).toBe('https://gateway.acme.example/v1');
    expect(cfg.native?.ports).toEqual({ router: 4100, litellm: 4000 });
    expect(cfg.native?.generate.code).toEqual(['deepseek-v4-flash']);
  });

  it('leaves native undefined when no [native] table is present', () => {
    expect(parseConfig(`[models."x"]\nharness="codex"\nid="gpt"`).native).toBeUndefined();
  });

  it('accepts a native model id beginning claude- when its key is unreserved', () => {
    expect(() => parseConfig(`
[native.models."copilot-sonnet"]
gateway = "g"
id = "claude-sonnet-4-5"
context_window = 1000
[native.gateways."g"]
base_url = "http://x"
`)).not.toThrow();
  });

  it('refuses a native model key beginning claude-', () => {
    expect(() => parseConfig(`
[native.models."claude-ish"]
gateway = "g"
id = "foo"
context_window = 1000
[native.gateways."g"]
base_url = "http://x"
`)).toThrow(/claude-/);
  });

  it('refuses generate.native referencing an undefined native model', () => {
    expect(() => parseConfig(`
[native.models."a"]
gateway="g"
id="a1"
context_window=1000
[native.gateways."g"]
base_url="http://x"
[generate.native]
code = ["missing"]
`)).toThrow(/unknown native model "missing"/);
  });

  it('refuses a native model naming an undefined gateway', () => {
    expect(() => parseConfig(`
[native.models."a"]
gateway="nope"
id="a1"
context_window=1000
`)).toThrow(/unknown gateway "nope"/);
  });
});

describe('parseConfig — native gateway auth', () => {
  const withGateway = (body: string) => `
[native.gateways."g"]
${body}

[native.models."m"]
gateway="g"
id="m1"
context_window=1000
`;

  it('defaults an unmarked gateway to api-key, preserving existing configs', () => {
    const cfg = parseConfig(withGateway('base_url="https://x.example/v1"'));
    expect(cfg.native!.gateways.g).toEqual({
      baseUrl: 'https://x.example/v1', auth: 'api-key',
    });
  });

  it('accepts codex-oauth and supplies the Codex backend URL itself', () => {
    const cfg = parseConfig(withGateway('auth="codex-oauth"'));
    expect(cfg.native!.gateways.g).toEqual({
      baseUrl: CODEX_OAUTH_BASE_URL, auth: 'codex-oauth',
    });
    expect(CODEX_OAUTH_BASE_URL).toBe('https://chatgpt.com/backend-api/codex');
  });

  it('still requires base_url for an api-key gateway', () => {
    expect(() => parseConfig(withGateway('auth="api-key"'))).toThrow(/needs string "base_url"/);
  });

  it('refuses a codex-oauth gateway that claims a different base_url', () => {
    // A ChatGPT OAuth credential is refused by the metered api.openai.com with
    // insufficient_quota, so a config naming it would never authenticate.
    expect(() => parseConfig(withGateway(
      'auth="codex-oauth"\nbase_url="https://api.openai.com/v1"',
    ))).toThrow(/only reaches https:\/\/chatgpt\.com\/backend-api\/codex/);
  });

  it('allows codex-oauth to restate the correct base_url', () => {
    const cfg = parseConfig(withGateway(
      `auth="codex-oauth"\nbase_url="${CODEX_OAUTH_BASE_URL}"`,
    ));
    expect(cfg.native!.gateways.g.auth).toBe('codex-oauth');
  });

  it('names the known auth kinds when given an unknown one', () => {
    expect(() => parseConfig(withGateway('auth="oauth2"\nbase_url="https://x/v1"')))
      .toThrow(/unknown auth "oauth2".*api-key, codex-oauth/s);
  });
});

describe('expectedAgentNames', () => {
  const config = (toml: string) => parseConfig(toml);

  it('includes the wrapper sync writes for a native model', () => {
    // sync writes native-<role>-<model> AND <role>-<model>; doctor computed the
    // set separately and omitted the second, so every sync left a "stale" file.
    const names = expectedAgentNames(config(`
[native.gateways."g"]
base_url="https://x/v1"
[native.models."m"]
gateway="g"
id="m1"
context_window=1000
[generate.native]
code=["m"]
`));
    expect(names).toContain('native-code-m');
    expect(names).toContain('code-m');
  });

  it('does not duplicate a name a harness model already claims', () => {
    const names = expectedAgentNames(config(`
[models."m"]
harness="codex"
id="m1"
[generate.roles]
code=["m"]

[native.gateways."g"]
base_url="https://x/v1"
[native.models."m"]
gateway="g"
id="m1"
context_window=1000
[generate.native]
code=["m"]
`));
    expect(names.filter((n) => n === 'code-m')).toHaveLength(1);
    expect(names).toContain('native-code-m');
  });

  it('is empty for a config that generates nothing', () => {
    expect(expectedAgentNames(config('[run]\n'))).toEqual([]);
  });
});

describe('parseConfig — copilot-oauth gateways', () => {
  const withGateway = (body: string) => `
[native.gateways."g"]
${body}

[native.models."m"]
gateway="g"
id="m1"
context_window=1000
`;

  it('accepts copilot-oauth and supplies the Copilot URL itself', () => {
    const cfg = parseConfig(withGateway('auth="copilot-oauth"'));
    expect(cfg.native!.gateways.g).toEqual({
      baseUrl: COPILOT_OAUTH_BASE_URL, auth: 'copilot-oauth',
    });
  });

  it('refuses a copilot-oauth gateway that claims a different base_url', () => {
    expect(() => parseConfig(withGateway(
      'auth="copilot-oauth"\nbase_url="https://api.openai.com/v1"',
    ))).toThrow(/only reaches https:\/\/api\.githubcopilot\.com/);
  });
});

describe('parseConfig — the claude- prefix and Copilot', () => {
  it('accepts a claude- upstream id under an unreserved unified key', () => {
    expect(() => parseConfig(`
[models."copilot-sonnet"]
gateway = "copilot"
id = "claude-sonnet-4-5"
context_window = 1000
[native.gateways."copilot"]
auth = "copilot-oauth"
`)).not.toThrow();
  });

  it('still refuses a unified model key beginning claude-', () => {
    expect(() => parseConfig(`
[models."claude-sonnet"]
gateway = "copilot"
id = "claude-sonnet-4-5"
context_window = 1000
`)).toThrow(/cannot use the "claude-" prefix/);
  });
});

describe('native gateway credential_source', () => {
  it('round-trips each valid source', () => {
    for (const source of ['sonata', 'codex', 'opencode']) {
      const config = parseConfig(`
[native]
[native.ports]
router = 4100
litellm = 4101
[native.gateways.codex]
auth = "codex-oauth"
credential_source = "${source}"
`, '/tmp/x');
      expect(config.native!.gateways.codex.credentialSource).toBe(source);
    }
  });

  it('leaves the field undefined when absent, preserving today\'s resolution', () => {
    const config = parseConfig(`
[native]
[native.ports]
router = 4100
litellm = 4101
[native.gateways.codex]
auth = "codex-oauth"
`, '/tmp/x');
    expect(config.native!.gateways.codex.credentialSource).toBeUndefined();
  });

  it('refuses an unknown source by name, listing the valid ones', () => {
    expect(() => parseConfig(`
[native]
[native.ports]
router = 4100
litellm = 4101
[native.gateways.codex]
auth = "codex-oauth"
credential_source = "keychain"
`, '/tmp/x')).toThrow(/unknown credential_source "keychain".*sonata, codex, opencode/s);
  });

  it('refuses codex as the source for an api-key gateway', () => {
    // codex holds a subscription, not a bearer key; a metered endpoint
    // authenticates it and then 429s, which reads as a missing key.
    expect(() => parseConfig(`
[native]
[native.ports]
router = 4100
litellm = 4101
[native.gateways.openrouter]
base_url = "https://openrouter.ai/api/v1"
credential_source = "codex"
`, '/tmp/x')).toThrow(/cannot take its credential from codex/);
  });

  it('allows opencode as the source for an api-key gateway', () => {
    // opencode holds API keys as well as OAuth entries.
    const config = parseConfig(`
[native]
[native.ports]
router = 4100
litellm = 4101
[native.gateways.openrouter]
base_url = "https://openrouter.ai/api/v1"
credential_source = "opencode"
`, '/tmp/x');
    expect(config.native!.gateways.openrouter.credentialSource).toBe('opencode');
  });
});


describe('unified [models] and [tiers]', () => {
  const TIERED = `
[models."deepseek-v4-flash"]
gateway = "vendorx"
id = "deepseek-v4-flash-0731"
harness = "opencode"

[models."gpt-5.6-terra"]
gateway = "openai"
id = "gpt-5.6-terra"

[models."kimi-harness-only"]
harness = "opencode"
id = "vendorx/kimi-k3"

[tiers.code]
simple = ["deepseek-v4-flash"]
complex = ["gpt-5.6-terra", "deepseek-v4-flash"]

[tiers.explore]
simple = ["deepseek-v4-flash"]
complex = ["deepseek-v4-flash"]

[native.gateways."vendorx"]
base_url = "http://gateway.example/v1"
[native.gateways."openai"]
base_url = "http://openai.example/v1"
`;

  it('parses unified models with native and harness routes', () => {
    const config = parseConfig(TIERED);
    expect(config.models['deepseek-v4-flash']).toEqual({
      harness: 'opencode', id: 'vendorx/deepseek-v4-flash-0731',
    });
    expect(config.unifiedModels['deepseek-v4-flash']).toEqual({
      gateway: 'vendorx', id: 'deepseek-v4-flash-0731', contextWindow: 128000,
      harness: 'opencode', harnessId: 'vendorx/deepseek-v4-flash-0731',
    });
    expect(config.unifiedModels['kimi-harness-only']).toMatchObject({
      harness: 'opencode', harnessId: 'vendorx/kimi-k3',
    });
    expect(config.tiers?.code.complex).toEqual(['gpt-5.6-terra', 'deepseek-v4-flash']);
  });

  it('defaults a unified codex harness id to the bare id, never a synthesized provider/model ref', () => {
    // Codex takes a bare model id — unlike opencode/pi/reasonix, it has no
    // provider dimension. Defaulting harnessId to `${gateway}/${id}` (the
    // opencode/pi/reasonix shape) for codex would produce an id like
    // `openai/gpt-5.6-sol` that parses fine here but is invalid the moment
    // `sonata dispatch` actually launches codex with it.
    const config = parseConfig(`
[models."gpt-5.6-sol"]
gateway = "openai"
id = "gpt-5.6-sol"
harness = "codex"

[native.gateways."openai"]
base_url = "https://openai.example/v1"
`);
    expect(config.unifiedModels['gpt-5.6-sol']).toMatchObject({
      harness: 'codex', harnessId: 'gpt-5.6-sol',
    });
    expect(config.models['gpt-5.6-sol']).toEqual({ harness: 'codex', id: 'gpt-5.6-sol' });
  });

  it('defaults a unified claude harness id to the config key when no harness_id is set', () => {
    // The claude harness dispatches `claude -p` for the config's own key; the
    // unified entry's `id` names the native upstream model, which is not the
    // model the harness launches. Defaulting to that id (or to a synthesized
    // `<gateway>/<id>`) would send `sonata dispatch` an id that names no
    // reachable Claude Code model — the key is what `harnessModelFor` must
    // report.
    const config = parseConfig(`
[models."my-model"]
gateway = "acme"
id = "deepseek-v4-flash-0731"
harness = "claude"

[native.gateways."acme"]
base_url = "https://acme.example/v1"
`);
    expect(config.unifiedModels['my-model']).toMatchObject({
      harness: 'claude', harnessId: 'my-model',
    });
    expect(config.models['my-model']).toEqual({ harness: 'claude', id: 'my-model' });
    expect(harnessModelFor(config, 'my-model'))
      .toEqual({ harness: 'claude', id: 'my-model' });
  });

  it('resolveTierAlias returns ranked routes for sonata-<role>-<tier>', () => {
    const config = parseConfig(TIERED);
    const resolved = resolveTierAlias(config, 'sonata-code-complex');
    expect(resolved?.routes.map((r) => r.key)).toEqual(['gpt-5.6-terra', 'deepseek-v4-flash']);
    expect(resolved?.routes[1].native).toEqual({ gateway: 'vendorx', id: 'deepseek-v4-flash-0731' });
    expect(resolved?.routes[1].harness).toEqual({ harness: 'opencode', id: 'vendorx/deepseek-v4-flash-0731' });
  });

  it('resolveTierAlias accepts a collapsed sonata-<role> alias when the lists are identical', () => {
    const config = parseConfig(TIERED);
    expect(resolveTierAlias(config, 'sonata-explore')?.routes.map((r) => r.key))
      .toEqual(['deepseek-v4-flash']);
    expect(resolveTierAlias(config, 'sonata-nonsense')).toBeUndefined();
  });

  it('does not collapse a role whose tier rankings differ', () => {
    const config = parseConfig(TIERED);
    expect(resolveTierAlias(config, 'sonata-code')).toBeUndefined();
  });

  it('passes a claude- model id through harness tier resolution', () => {
    const config = parseConfig(`
[models."fallback"]
harness = "codex"
id = "claude-opus-5"
[tiers.code]
simple = ["fallback"]
complex = ["fallback"]
`);
    expect(resolveTierAlias(config, 'sonata-code')?.routes[0]).toMatchObject({
      key: 'fallback',
      harness: { harness: 'codex', id: 'claude-opus-5' },
    });
    expect(harnessModelFor(config, 'fallback'))
      .toEqual({ harness: 'codex', id: 'claude-opus-5' });
  });

  it('refuses a tier entry that names no [models] key', () => {
    expect(() => parseConfig(`
[models."known"]
harness = "opencode"
id = "vendorx/known"

[tiers.code]
simple = ["missing-model"]
complex = ["known"]
`)).toThrow(/missing-model/);
  });

  it('refuses an empty tier list — a tier with no candidates can never route', () => {
    expect(() => parseConfig(`
[models."known"]
harness = "opencode"
id = "vendorx/known"

[tiers.code]
simple = []
complex = ["known"]
`)).toThrow(/non-empty/);
    expect(() => parseConfig(`
[models."known"]
harness = "opencode"
id = "vendorx/known"

[tiers.code]
simple = ["known"]
complex = []
`)).toThrow(/non-empty/);
  });

  it('allows a claude- upstream id in unified models when the key is unreserved', () => {
    expect(() => parseConfig(TIERED.replace('id = "gpt-5.6-terra"', 'id = "claude-opus-5"')))
      .not.toThrow();
  });

  it('refuses claude- keys in unified models and tier keys', () => {
    expect(() => parseConfig(TIERED.replace('[models."gpt-5.6-terra"]', '[models."claude-terra"]')))
      .toThrow(/claude-/);
  });

  it('refuses mixing [tiers] with [generate]', () => {
    expect(() => parseConfig(`${TIERED}\n[generate.roles]\ncode = []\n`))
      .toThrow(/sonata init/);
  });

  it('refuses a unified model whose gateway is not defined', () => {
    expect(() => parseConfig(`
[models."flash"]
gateway = "missing-gateway"
id = "deepseek-v4-flash-0731"
`)).toThrow(/unknown gateway "missing-gateway"/);
  });

  it('harnessModelFor exposes the harness route for the dispatch CLI', () => {
    const config = parseConfig(TIERED);
    expect(harnessModelFor(config, 'deepseek-v4-flash'))
      .toEqual({ harness: 'opencode', id: 'vendorx/deepseek-v4-flash-0731' });
    expect(harnessModelFor(config, 'gpt-5.6-terra')).toBeUndefined();
  });
});


describe('price config', () => {
  it('parses per-model rates and windows', () => {
    const config = parseConfig(`
[models."flash"]
gateway = "acme"
id = "deepseek-v4-flash"

[models."flash".price]
input = 0.44
cached_input = 0.014
output = 1.32

[native.gateways."acme"]
base_url = "https://example.invalid/v1"

[[models."flash".price.windows]]
from = "16:30"
to = "00:30"
input = 0.11
output = 0.33
`);
    const price = config.unifiedModels.flash.price!;
    expect(price).toMatchObject({ input: 0.44, cachedInput: 0.014, output: 1.32 });
    expect(price.windows).toEqual([{ from: '16:30', to: '00:30', input: 0.11, output: 0.33 }]);
  });

  it('parses gateway rates and pricing_provider', () => {
    const config = parseConfig(`
[native.gateways."google"]
base_url = "https://example.invalid/v1"
pricing_provider = "google"

[native.gateways."google".price]
input = 0.1
`);
    const gw = config.native!.gateways.google;
    expect(gw.pricingProvider).toBe('google');
    expect(gw.price).toMatchObject({ input: 0.1 });
  });

  it('parses a price on a harness-only model', () => {
    const config = parseConfig(`
[models."fallback"]
harness = "codex"
id = "gpt-5.6-terra"

[models."fallback".price]
output = 2
`);
    expect(config.unifiedModels.fallback.price).toEqual({ output: 2 });
  });

  it('refuses a non-string pricing_provider', () => {
    expect(() => parseConfig(`
[native.gateways."google"]
base_url = "https://example.invalid/v1"
pricing_provider = 42
`)).toThrow(/pricing_provider/);
  });

  it('leaves price undefined when no table is present', () => {
    const config = parseConfig(`
[models."flash"]
gateway = "acme"
id = "x"

[native.gateways."acme"]
base_url = "https://example.invalid/v1"
`);
    expect(config.unifiedModels.flash.price).toBeUndefined();
    expect(config.native!.gateways.acme.price).toBeUndefined();
    expect(config.native!.gateways.acme.pricingProvider).toBeUndefined();
  });

  it('refuses a negative rate', () => {
    expect(() => parseConfig(`
[models."flash"]
gateway = "acme"
id = "x"

[models."flash".price]
input = -1

[native.gateways."acme"]
base_url = "https://example.invalid/v1"
`)).toThrow(/price.*must be a non-negative number/i);
  });

  it('refuses a malformed window time', () => {
    expect(() => parseConfig(`
[models."flash"]
gateway = "acme"
id = "x"

[[models."flash".price.windows]]
from = "16:70"
to = "00:30"

[native.gateways."acme"]
base_url = "https://example.invalid/v1"
`)).toThrow(/HH:MM/);
  });

  it('refuses a window missing from or to', () => {
    expect(() => parseConfig(`
[models."flash"]
gateway = "acme"
id = "x"

[[models."flash".price.windows]]
from = "16:30"

[native.gateways."acme"]
base_url = "https://example.invalid/v1"
`)).toThrow(/from.*to/i);
  });
});

describe('avoid_gateways', () => {
  const base = `
avoid_gateways = ["acme"]

[models."m"]
gateway = "acme"
id = "m"
context_window = 128000

[native.gateways."acme"]
base_url = "https://acme.example/v1"

[tiers.code]
simple = ["m"]
complex = ["m"]
`;

  it('parses a list of gateway names', () => {
    expect(parseConfig(base).avoidGateways).toEqual(['acme']);
  });

  it('is absent when unset, so existing configs are unaffected', () => {
    expect(parseConfig(base.replace('avoid_gateways = ["acme"]\n', '')).avoidGateways).toBeUndefined();
  });

  it('refuses a gateway that does not exist', () => {
    // A typo would otherwise read as "not avoided", and the setting's whole
    // failure mode is that its absence is invisible.
    expect(() => parseConfig(base.replace('"acme"]', '"acmee"]')))
      .toThrow(/unknown gateway "acmee"/);
  });

  it('refuses a non-list value', () => {
    expect(() => parseConfig(base.replace('avoid_gateways = ["acme"]', 'avoid_gateways = "acme"')))
      .toThrow(/must be a list/);
  });
});

describe('native gateway provider', () => {
  const gw = (extra: string) => `
[models."m"]
gateway = "gw"
id = "x"

[native.gateways."gw"]
base_url = "https://gw.example/v1"
${extra}
`;

  it('parses provider on a gateway', () => {
    expect(parseConfig(gw('provider = "gemini"')).native!.gateways.gw.provider).toBe('gemini');
  });

  it('refuses a provider LiteLLM does not have', () => {
    expect(() => parseConfig(gw('provider = "not-a-provider"'))).toThrow(/provider/);
  });

  it('accepts wire_format as the older spelling of provider', () => {
    // `wire_format` was a two-valued subset of the same idea and ships in
    // configs today, so it maps rather than being refused. Migrating here in
    // parseConfig covers every load path, not just the legacy-config one.
    expect(parseConfig(gw('wire_format = "anthropic"')).native!.gateways.gw.provider).toBe('anthropic');
  });

  it('lets an explicit provider win over the older wire_format', () => {
    expect(parseConfig(gw('wire_format = "openai"\nprovider = "gemini"')).native!.gateways.gw.provider)
      .toBe('gemini');
  });

  it('refuses provider on an oauth gateway, as it already refuses wire_format', () => {
    // Their dialect is fixed by their auth: chatgpt needs mode: responses,
    // copilot needs a token exchange first.
    expect(() => parseConfig(`
[models."m"]
gateway = "gw"
id = "x"

[native.gateways."gw"]
auth = "codex-oauth"
provider = "openai"
`)).toThrow(/provider/);
  });
});
