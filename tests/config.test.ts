import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig, isReadOnlyRole, configPath, loadConfig, generatedAgents } from '../src/config.js';

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
