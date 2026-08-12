import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkVersion, cmdDoctor } from '../../src/commands/doctor.js';

describe('checkVersion', () => {
  it('accepts a version inside the supported range', () => {
    expect(checkVersion('1.18.15', '>=1.18.0 <2.0.0')).toBe(true);
  });

  it('rejects a version below the floor', () => {
    expect(checkVersion('1.17.9', '>=1.18.0 <2.0.0')).toBe(false);
  });

  it('rejects a version at or above the ceiling', () => {
    expect(checkVersion('2.0.0', '>=1.18.0 <2.0.0')).toBe(false);
  });

  it('tolerates a v prefix and trailing text', () => {
    expect(checkVersion('v1.18.15 (build 3)', '>=1.18.0 <2.0.0')).toBe(true);
  });
});

describe('cmdDoctor — which config', () => {
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
    cwd = mkdtempSync(join(tmpdir(), 'doc-cwd-'));
    home = mkdtempSync(join(tmpdir(), 'doc-home-'));
  });

  const check = async (name: string) =>
    (await cmdDoctor({ cwd, home })).checks.find((c) => c.name === name);

  it('reports the machine config path when that is what it used', async () => {
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(join(home, '.config', 'sonata', 'sonata.toml'), MINIMAL);

    const c = await check('sonata.toml');
    expect(c?.ok).toBe(true);
    // With two possible sources, a model count alone cannot be debugged from.
    expect(c?.detail).toContain(join(home, '.config', 'sonata', 'sonata.toml'));
    expect(c?.detail).toContain('1 model');
  });

  it('reports the project config path when the repo has one', async () => {
    writeFileSync(join(cwd, 'sonata.toml'), MINIMAL);
    expect((await check('sonata.toml'))?.detail).toContain(join(cwd, 'sonata.toml'));
  });

  it('warns about a stray ~/sonata.toml, which nothing reads', async () => {
    writeFileSync(join(cwd, 'sonata.toml'), MINIMAL);
    writeFileSync(join(home, 'sonata.toml'), MINIMAL);

    const c = await check('stray config');
    expect(c?.ok).toBe(false);
    expect(c?.detail).toContain(join(home, 'sonata.toml'));
    expect(c?.detail).toContain('mv');
  });

  it('says nothing about a stray file when there is none', async () => {
    writeFileSync(join(cwd, 'sonata.toml'), MINIMAL);
    expect(await check('stray config')).toBeUndefined();
  });
});

describe('cmdDoctor — completeness', () => {
  const MIN = `
[models."a"]
harness = "codex"
id = "gpt-5.6-sol"

[generate.roles]
code = ["a"]
`;
  const MARKER = 'forwarding wrapper around the sonata runtime';

  const setup = () => {
    const cwd = mkdtempSync(join(tmpdir(), 'doc-c-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-h-'));
    writeFileSync(join(cwd, 'sonata.toml'), MIN);
    mkdirSync(join(cwd, '.claude', 'agents'), { recursive: true });
    return { cwd, home };
  };
  const check = async (cwd: string, home: string, name: string) =>
    (await cmdDoctor({ cwd, home })).checks.find((c) => c.name === name);

  it('flags an agent naming a model the config does not define', async () => {
    const { cwd, home } = setup();
    writeFileSync(join(cwd, '.claude', 'agents', 'code-gone.md'), MARKER);
    expect((await check(cwd, home, 'agents'))?.ok).toBe(false);
  });

  it('flags an agent that still grants Bash', async () => {
    const { cwd, home } = setup();
    writeFileSync(join(cwd, '.claude', 'agents', 'code-a.md'),
      `---\nname: code-a\ntools: Bash\n---\n${MARKER}`);
    const c = await check(cwd, home, 'agent tools');
    expect(c?.ok).toBe(false);
    expect(c?.detail).toContain('sonata sync');
  });

  it('flags an unregistered MCP server', async () => {
    const { cwd, home } = setup();
    // The wrapper cannot report its own absence of tools, so doctor must.
    expect((await check(cwd, home, 'mcp server'))?.ok).toBe(false);
  });

  it('stays quiet on a healthy setup', async () => {
    const { cwd, home } = setup();
    writeFileSync(join(cwd, '.claude', 'agents', 'code-a.md'),
      `---\nname: code-a\ntools: mcp__sonata__run\n---\n${MARKER}`);
    writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({
      mcpServers: { sonata: { command: 'node', args: [join('/pkg', 'dist', 'cli.js'), 'mcp'] } },
    }));
    const res = await cmdDoctor({ cwd, home, packageRoot: '/pkg' });
    for (const name of ['agents', 'agent tools', 'mcp server']) {
      expect(res.checks.find((c) => c.name === name)?.ok).toBe(true);
    }
  });
});

describe('cmdDoctor — opencode agents sonata needs', () => {
  const MIN = `
[models."a"]
harness = "opencode"
id = "openrouter/kimi-k3"

[generate.roles]
explore = ["a"]
`;
  it('re-enables an agent sonata needs and says so', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'doc-oc-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-och-'));
    writeFileSync(join(cwd, 'sonata.toml'), MIN);
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
    const cfg = join(home, '.config', 'opencode', 'opencode.json');
    writeFileSync(cfg, JSON.stringify({ agent: { explore: { disable: true } } }));

    const c = (await cmdDoctor({ cwd, home })).checks.find((x) => x.name === 'opencode agents');
    // A disabled read-only agent silently becomes the write-capable `build`,
    // so this is corrected rather than merely reported.
    expect(c?.detail).toContain('explore');
    expect(JSON.parse(readFileSync(cfg, 'utf8')).agent.explore.disable).toBe(false);
  });

  it('stays quiet when nothing sonata needs is disabled', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'doc-oc2-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-och2-'));
    writeFileSync(join(cwd, 'sonata.toml'), MIN);
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
    writeFileSync(join(home, '.config', 'opencode', 'opencode.json'),
      JSON.stringify({ agent: { general: { disable: true } } }));

    const c = (await cmdDoctor({ cwd, home })).checks.find((x) => x.name === 'opencode agents');
    // `general` is not an agent sonata dispatches to; leave the user's choice alone.
    expect(c?.ok).toBe(true);
  });
});
