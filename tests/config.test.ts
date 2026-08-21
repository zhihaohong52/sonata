import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig, isReadOnlyRole, configPath, loadConfig, generatedAgents, expectedAgentNames, CODEX_OAUTH_BASE_URL, COPILOT_OAUTH_BASE_URL } from '../src/config.js';

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
gateway = "anexto"
id = "deepseek-v4-flash-0731"
context_window = 128000
[native.gateways."anexto"]
base_url = "https://bifrost.advai.net/v1"
[generate.native]
code = ["deepseek-v4-flash"]
`);
    expect(cfg.native?.models['deepseek-v4-flash']).toEqual({
      gateway: 'anexto', id: 'deepseek-v4-flash-0731', contextWindow: 128000,
    });
    expect(cfg.native?.gateways.anexto.baseUrl).toBe('https://bifrost.advai.net/v1');
    expect(cfg.native?.ports).toEqual({ router: 4100, litellm: 4000 });
    expect(cfg.native?.generate.code).toEqual(['deepseek-v4-flash']);
  });

  it('leaves native undefined when no [native] table is present', () => {
    expect(parseConfig(`[models."x"]\nharness="codex"\nid="gpt"`).native).toBeUndefined();
  });

  it('refuses a native model id beginning claude-', () => {
    expect(() => parseConfig(`
[native.models."sneaky"]
gateway = "g"
id = "claude-opus-5"
context_window = 1000
[native.gateways."g"]
base_url = "http://x"
`)).toThrow(/claude-/);
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
  it('still refuses a claude- id on a copilot gateway, which Copilot does serve', () => {
    // Copilot offers claude-sonnet-4 and friends, but the router sends any
    // `claude-` model to Anthropic, so such an id cannot be reached through the
    // native path. Documented so the collision is not rediscovered as a bug.
    expect(() => parseConfig(`
[native.gateways."copilot"]
auth="copilot-oauth"
[native.models."sonnet"]
gateway="copilot"
id="claude-sonnet-4"
context_window=1000
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
