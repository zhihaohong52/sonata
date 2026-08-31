import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { checkVersion, cmdDoctor, staleMcpRegistration, routingFailureDetail } from '../../src/commands/doctor.js';
import { planRouteAuto } from '../../src/commands/route.js';
import type { Settings } from '../../src/settings.js';
import { writeSonataKey } from '../../src/native/credentials.js';
import { credentialDir } from '../../src/native/oauth-login.js';
import { cmdRoute } from '../../src/commands/route.js';

vi.mock('../../src/native/litellm.js', () => ({
  findLitellm: () => '/usr/local/bin/litellm',
}));

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
    expect(c?.detail).toContain('1 harness');
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

describe('staleMcpRegistration', () => {
  it('warns when the project MCP file still registers sonata', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'doc-mcp-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-mcp-home-'));
    writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { sonata: { command: 'node' } } }));
    expect(staleMcpRegistration(cwd, home)).toContain('claude mcp remove sonata');
  });

  it('stays quiet when neither MCP scope registers sonata', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'doc-mcp-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-mcp-home-'));
    expect(staleMcpRegistration(cwd, home)).toBeUndefined();
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
    expect(c?.detail).toBe('1 wrapper(s) still grant Bash and can do the work themselves — run `sonata sync`');
    expect(c?.detail).not.toContain('restart Claude Code');
  });

  it('stays quiet on a healthy setup', async () => {
    const { cwd, home } = setup();
    writeFileSync(join(cwd, '.claude', 'agents', 'code-a.md'),
      `---\nname: code-a\ntools: Bash(sonata dispatch:*), Bash(sonata wait:*), Bash(sonata approve:*)\n---\n${MARKER}`);
    const res = await cmdDoctor({ cwd, home, packageRoot: '/pkg' });
    for (const name of ['agents', 'agent tools']) {
      expect(res.checks.find((c) => c.name === name)?.ok).toBe(true);
    }
  });
});

describe('cmdDoctor — stale wrapper agents', () => {
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
    writeFileSync(join(cwd, 'sonata.toml'), MINIMAL);
    mkdirSync(join(cwd, '.claude', 'agents'), { recursive: true });
  });

  const writeAgent = (file: string, tools: string) => {
    writeFileSync(join(cwd, '.claude', 'agents', file), [
      '---',
      `name: ${file.replace(/\.md$/, '')}`,
      `tools: ${tools}`,
      '---',
      '',
      'You are a forwarding wrapper around the sonata runtime.',
      ''
    ].join('\n'));
  };

  it('blocks when a generated agent still names the polling tools', async () => {
    writeAgent('code-old.md', 'mcp__legacy__run, mcp__legacy__tail, mcp__legacy__approve');

    const { checks } = await cmdDoctor({ cwd, home });
    const check = checks.find((c) => c.name === 'agent tools')!;
    expect(check.ok).toBe(false);
    expect(check.detail).toBe('1 wrapper(s) still call removed MCP tools and will fail mid-dispatch — run `sonata sync`');
    expect(check.detail).not.toContain('restart Claude Code');
  });

  it('blocks when a generated agent still names the removed dispatch/wait/approve MCP tools', async () => {
    // The generation immediately before this one — MCP-hosted, but already
    // using dispatch/wait/approve rather than the older run/tail names.
    writeAgent('code-old.md', 'mcp__sonata__dispatch, mcp__sonata__wait, mcp__sonata__approve');

    const { checks } = await cmdDoctor({ cwd, home });
    const check = checks.find((c) => c.name === 'agent tools')!;
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('removed MCP tools');
  });

  it('passes when every agent names the current tools', async () => {
    writeAgent('code-new.md', 'Bash(sonata dispatch:*), Bash(sonata wait:*), Bash(sonata approve:*)');

    const { checks } = await cmdDoctor({ cwd, home });
    expect(checks.find((c) => c.name === 'agent tools')!.ok).toBe(true);
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

describe('cmdDoctor — native path', () => {
  const NATIVE = `
[models."a"]
harness = "codex"
id = "gpt-5.6-sol"

[generate.roles]
code = ["a"]

[native.models."deepseek-v4-flash"]
gateway = "acme"
id = "deepseek-v4-flash-0731"
context_window = 128000

[native.gateways."acme"]
base_url = "https://gateway.example/v1"

[native.gateways."missing"]
base_url = "https://missing.example/v1"

[generate.native]
code = ["deepseek-v4-flash"]
`;

  const setup = () => {
    const cwd = mkdtempSync(join(tmpdir(), 'doc-native-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-native-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), NATIVE);
    mkdirSync(join(cwd, '.claude', 'agents'), { recursive: true });
    return { cwd, home };
  };

  it('checks LiteLLM, a down serve, missing key sources, and native stale agents', async () => {
    const { cwd, home } = setup();
    writeFileSync(join(cwd, '.claude', 'agents', 'native-code-old.md'), '---\nname: native-code-old\n---\nold');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('down'); };
    try {
      const { checks } = await cmdDoctor({ cwd, home });
      expect(checks.find((c) => c.name === 'litellm')).toEqual({
        name: 'litellm', ok: true, detail: '/usr/local/bin/litellm',
      });
      expect(checks.find((c) => c.name === 'serve health')).toEqual({
        name: 'serve health', ok: true, detail: 'not running — start with `sonata serve`',
      });
      expect(checks.find((c) => c.name === 'key source: missing')).toEqual({
        name: 'key source: missing', ok: false, detail: 'no key — `sonata auth add missing`',
      });
      expect(checks.find((c) => c.name === 'agents')?.ok).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('names the recorded source and flags one that has no credential', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'doc-source-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-source-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), `
[native.gateways.codex]
auth = "codex-oauth"
credential_source = "codex"
`);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('down'); };
    try {
      const { checks } = await cmdDoctor({ cwd, home });
      const text = checks.map((check) => check.detail).join('\n');
      expect(text).toContain('codex: credential from codex');
      expect(text).toMatch(/no credential.*codex login/s);
      // Exactly one real check for this gateway — no duplicate/legacy sniff.
      const sourceChecks = checks.filter((c) => c.name === 'key source: codex');
      expect(sourceChecks).toHaveLength(1);
      expect(sourceChecks[0]?.ok).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reports a healthy sonata-sourced credential', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'doc-source-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-source-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), `
[native.gateways.codex]
auth = "codex-oauth"
credential_source = "sonata"
`);
    mkdirSync(credentialDir(home, 'codex'), { recursive: true });
    writeFileSync(join(credentialDir(home, 'codex'), 'auth.json'), '{}');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('down'); };
    try {
      const { checks } = await cmdDoctor({ cwd, home });
      const text = checks.map((check) => check.detail).join('\n');
      expect(text).toContain('codex: credential from sonata');
      expect(text).not.toMatch(/no credential|no ChatGPT login/);
      // Exactly one real check for this gateway — the legacy automatic
      // ChatGPT sniff must not also run and fail behind a healthy sonata source.
      const sourceChecks = checks.filter((c) => c.name === 'key source: codex');
      expect(sourceChecks).toHaveLength(1);
      expect(sourceChecks[0]?.ok).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reports an api-key credential from its recorded source', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'doc-api-source-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-api-source-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), `
[native.gateways.acme]
base_url = "https://gateway.example/v1"
credential_source = "sonata"
`);
    writeSonataKey(home, 'acme', 'source-key');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('down'); };
    try {
      const { checks } = await cmdDoctor({ cwd, home });
      expect(checks.find((c) => c.name === 'key source: acme')).toEqual({
        name: 'key source: acme', ok: true, detail: 'acme: credential from sonata',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('flags a missing sonata-sourced api-key credential with the add command, not login', async () => {
    // Regression: the repair hint used to always say `sonata auth login`,
    // which manages OAuth credentials — wrong for a bearer key, whose fix is
    // `sonata auth add`.
    const cwd = mkdtempSync(join(tmpdir(), 'doc-api-source-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-api-source-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), `
[native.gateways.acme]
base_url = "https://gateway.example/v1"
credential_source = "sonata"
`);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('down'); };
    try {
      const { checks } = await cmdDoctor({ cwd, home });
      expect(checks.find((c) => c.name === 'key source: acme')).toEqual({
        name: 'key source: acme', ok: false,
        detail: 'acme: credential from sonata\n  ! acme: no credential from sonata — ' +
          'run `sonata auth add acme`',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('flags a missing api-key credential from its recorded source', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'doc-api-source-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-api-source-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), `
[native.gateways.acme]
base_url = "https://gateway.example/v1"
credential_source = "opencode"
`);
    writeSonataKey(home, 'acme', 'wrong-source-key');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('down'); };
    try {
      const { checks } = await cmdDoctor({ cwd, home });
      expect(checks.find((c) => c.name === 'key source: acme')).toEqual({
        name: 'key source: acme', ok: false,
        detail: 'acme: credential from opencode\n  ! acme: no credential from opencode — ' +
          'log into opencode itself — sonata does not manage opencode credentials',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('points an opencode-sourced ChatGPT credential at opencode, not `sonata auth login`', async () => {
    // Regression: the OAuth repair hint used to always say `sonata auth
    // login`, which only repairs a sonata-managed credential — wrong for a
    // codex-oauth gateway imported from opencode's own ChatGPT login.
    const cwd = mkdtempSync(join(tmpdir(), 'doc-oauth-source-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-oauth-source-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), `
[native.gateways.codex]
auth = "codex-oauth"
credential_source = "opencode"
`);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('down'); };
    try {
      const { checks } = await cmdDoctor({ cwd, home });
      const text = checks.map((check) => check.detail).join('\n');
      expect(text).toContain('codex: credential from opencode');
      expect(text).toMatch(/no credential from opencode.*log into opencode with a ChatGPT account/s);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('points an opencode-sourced Copilot credential at opencode with the right account', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'doc-copilot-source-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-copilot-source-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), `
[native.gateways."github-copilot"]
auth = "copilot-oauth"
credential_source = "opencode"
`);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('down'); };
    try {
      const { checks } = await cmdDoctor({ cwd, home });
      const text = checks.map((check) => check.detail).join('\n');
      expect(text).toContain('github-copilot: credential from opencode');
      expect(text).toMatch(/no credential from opencode.*log into opencode with a GitHub Copilot account/s);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('flags an opencode Copilot token that exists but cannot exchange for a Copilot key', async () => {
    // A stored GitHub token is not the same as a usable one: opencode's own
    // login requests only `read:user`, so GitHub refuses the Copilot
    // exchange. Presence alone must not be reported as a healthy credential.
    const cwd = mkdtempSync(join(tmpdir(), 'doc-copilot-unusable-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-copilot-unusable-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), `
[native.gateways."github-copilot"]
auth = "copilot-oauth"
credential_source = "opencode"
`);
    mkdirSync(join(home, '.local', 'share', 'opencode'), { recursive: true });
    writeFileSync(
      join(home, '.local', 'share', 'opencode', 'auth.json'),
      JSON.stringify({ 'github-copilot': { type: 'oauth', access: 'gho_x', refresh: 'r' } }),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('{}', { status: 200, headers: { 'x-oauth-scopes': 'read:user' } });
    try {
      const { checks } = await cmdDoctor({ cwd, home });
      const text = checks.map((check) => check.detail).join('\n');
      expect(text).toContain('github-copilot: credential from opencode');
      expect(text).toMatch(/no credential from opencode.*log into opencode with a GitHub Copilot account/s);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('flags a routed-settings env that points claude at a different router port', async () => {
    const { cwd, home } = setup();
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(join(cwd, '.claude', 'settings.local.json'),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://localhost:9999' } }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('down'); };
    try {
      const { checks } = await cmdDoctor({ cwd, home });
      const c = checks.find((x) => x.name === 'routed sessions');
      expect(c).toBeDefined();
      expect(c?.ok).toBe(false);
      expect(c?.detail).toContain('http://localhost:9999');
      expect(c?.detail).toContain('sonata route on');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reports that routed sessions match the configured router', async () => {
    const { cwd, home } = setup();
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(join(cwd, '.claude', 'settings.local.json'),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://localhost:4100' } }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('down'); };
    try {
      const { checks } = await cmdDoctor({ cwd, home });
      const c = checks.find((x) => x.name === 'routed sessions');
      expect(c?.ok).toBe(true);
      expect(c?.detail).toContain('http://localhost:4100');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  const TIERED = `
[models."flash"]
gateway = "acme"
id = "deepseek-v4-flash-0731"

[native.gateways."acme"]
base_url = "https://gateway.example/v1"

[tiers.code]
simple = ["flash"]
complex = ["flash"]
`;

  const tieredSetup = () => {
    const cwd = mkdtempSync(join(tmpdir(), 'doc-cat-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-cat-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), TIERED);
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    return { cwd, home };
  };

  const writeCatalog = (home: string, fetchedAt: string) => {
    const path = join(home, '.config', 'sonata', 'catalog.json');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      fetchedAt,
      models: { 'deepseek-v4-flash': { codingIndex: 45, blendedPriceUsd: 0.3 } },
    }));
  };

  const rankingCheck = async (cwd: string, home: string, now: Date) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('down'); };
    try {
      const { checks } = await cmdDoctor({ cwd, home, now: () => now });
      return checks.find((c) => c.name === 'model rankings');
    } finally {
      globalThis.fetch = originalFetch;
    }
  };

  it('flags a ranking catalog older than the freshness window', async () => {
    // Advisory, not blocking: a stale catalog still ranks, but on superseded
    // scores — a silently-wrong ordering nobody would otherwise notice.
    const { cwd, home } = tieredSetup();
    writeCatalog(home, '2026-06-01T00:00:00.000Z');
    const c = await rankingCheck(cwd, home, new Date('2026-08-28T00:00:00.000Z'));
    expect(c?.ok).toBe(true);
    expect(c?.detail).toMatch(/88d old/);
    expect(c?.detail).toMatch(/sonata catalog update/);
  });

  it('stays quiet about a catalog inside the freshness window', async () => {
    const { cwd, home } = tieredSetup();
    writeCatalog(home, '2026-08-20T00:00:00.000Z');
    const c = await rankingCheck(cwd, home, new Date('2026-08-28T00:00:00.000Z'));
    expect(c?.detail).toMatch(/1 models/);
    expect(c?.detail).not.toMatch(/catalog update/);
  });

  it('says tiers fall back to built-in defaults when no catalog exists', async () => {
    const { cwd, home } = tieredSetup();
    const c = await rankingCheck(cwd, home, new Date('2026-08-28T00:00:00.000Z'));
    expect(c?.detail).toMatch(/built-in defaults/);
  });

  it('does not count a stale routed port as satisfying tier routing', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'doc-tier-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-tier-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), `
[models."flash"]
gateway = "acme"
id = "deepseek-v4-flash-0731"

[native.gateways."acme"]
base_url = "https://gateway.example/v1"

[tiers.code]
simple = ["flash"]
complex = ["flash"]

[native.ports]
router = 4100
`);
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    // A base URL left behind from a since-changed router port — present, but
    // not the configured one.
    writeFileSync(join(cwd, '.claude', 'settings.local.json'),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://localhost:9999' } }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('down'); };
    try {
      const { checks } = await cmdDoctor({ cwd, home });
      const c = checks.find((x) => x.name === 'tier routing');
      expect(c?.ok).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('recognizes a routed port that matches the configured router for tier routing', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'doc-tier-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-tier-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), `
[models."flash"]
gateway = "acme"
id = "deepseek-v4-flash-0731"

[native.gateways."acme"]
base_url = "https://gateway.example/v1"

[tiers.code]
simple = ["flash"]
complex = ["flash"]

[native.ports]
router = 4100
`);
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(join(cwd, '.claude', 'settings.local.json'),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://localhost:4100' } }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('down'); };
    try {
      const { checks } = await cmdDoctor({ cwd, home });
      expect(checks.find((x) => x.name === 'tier routing')).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('global-auto routing does not satisfy tier routing for a project with its own config', async () => {
    // A project with its own sonata.toml is not the machine config, so global
    // routing resolves a different, unrelated configuration — the check must
    // refuse to count it, leaving only project-scoped routing acceptable.
    const cwd = mkdtempSync(join(tmpdir(), 'doc-tier-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-tier-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), `
[models."flash"]
gateway = "acme"
id = "deepseek-v4-flash-0731"

[native.gateways."acme"]
base_url = "https://gateway.example/v1"

[tiers.code]
simple = ["flash"]
complex = ["flash"]

[native.ports]
router = 5100
`);
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(join(home, '.config', 'sonata', 'sonata.toml'), `
[models."flash"]
gateway = "acme"
id = "deepseek-v4-flash-0731"

[native.gateways."acme"]
base_url = "https://gateway.example/v1"

[tiers.code]
simple = ["flash"]
complex = ["flash"]

[native.ports]
router = 4200
`);
    await cmdRoute('auto', { cwd, home, packageRoot: '/pkg', scope: 'global' });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('down'); };
    try {
      const { checks } = await cmdDoctor({ cwd, home, packageRoot: '/pkg' });
      expect(checks.find((x) => x.name === 'tier routing')?.ok).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('global-auto routing satisfies tier routing when the project falls back to the machine config', async () => {
    // No project-scoped sonata.toml: the project's config resolution IS the
    // machine config, so global routing genuinely serves this project and the
    // check may count it. A stray ~/sonata.toml is present — a leftover some
    // upgrades still have — which the old `configPath(home, home)` comparison
    // mistook for the project's resolved config, falsely refusing global
    // routing. The check compares against the machine config's fixed path
    // instead, so the stray file only trips the separate "stray config" check.
    const cwd = mkdtempSync(join(tmpdir(), 'doc-tier-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-tier-home-'));
    writeFileSync(join(home, 'sonata.toml'), `
[models."legacy-flash"]
gateway = "acme"
id = "deepseek-v4-flash-0731"

[native.ports]
router = 9999
`);
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(join(home, '.config', 'sonata', 'sonata.toml'), `
[models."flash"]
gateway = "acme"
id = "deepseek-v4-flash-0731"

[native.gateways."acme"]
base_url = "https://gateway.example/v1"

[tiers.code]
simple = ["flash"]
complex = ["flash"]

[native.ports]
router = 4200
`);
    await cmdRoute('auto', { cwd, home, packageRoot: '/pkg', scope: 'global' });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('down'); };
    try {
      const { checks } = await cmdDoctor({ cwd, home, packageRoot: '/pkg' });
      expect(checks.find((x) => x.name === 'tier routing')).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reports native serve health and key source without exposing key values', async () => {
    const { cwd, home } = setup();
    writeSonataKey(home, 'acme', 'super-secret-key');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ sonata: true }), { status: 200 });
    try {
      const { checks } = await cmdDoctor({ cwd, home });
      expect(checks.find((c) => c.name === 'serve health')).toEqual({
        name: 'serve health', ok: true, detail: 'up',
      });
      const keyChecks = checks.filter((c) => c.name.startsWith('key source:'));
      expect(keyChecks.find((c) => c.name === 'key source: acme')).toEqual({
        name: 'key source: acme', ok: true, detail: 'from sonata',
      });
      expect(keyChecks.every((c) => !c.detail.includes('super-secret-key'))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('routingFailureDetail — naming the cause, not just the fix', () => {
  // All five of these printed the same sentence, so a user who had already run
  // `sonata route auto` was told to run it again with nothing saying why it
  // had not taken. Observed for real: a build run out of a git worktree
  // reported "run `sonata route auto`" while `route auto` was correctly
  // installed and pointing at the main checkout.
  const THIS_ROOT = '/opt/sonata';
  const OTHER_ROOT = '/Users/dev/code/sonata';
  const base = {
    cwd: '/repo',
    packageRoot: THIS_ROOT,
    projectSettings: {} as Settings,
    globalSettings: {} as Settings,
    configuredRouterUrl: 'http://localhost:4100',
    projectResolvesToMachineConfig: true,
  };

  it('keeps the plain instruction when nothing is installed at all', () => {
    expect(routingFailureDetail(base))
      .toBe('tier agents need a routed session — run `sonata route auto`');
  });

  it('names the other install when the hooks belong to a different sonata', () => {
    const detail = routingFailureDetail({
      ...base, projectSettings: planRouteAuto({}, OTHER_ROOT).settings,
    });
    expect(detail).toContain(OTHER_ROOT);
    expect(detail).toContain(THIS_ROOT);
    expect(detail).toContain('repoint');
  });

  it('names the subagent hooks when an older install carries only the session pair', () => {
    const settings = planRouteAuto({}, THIS_ROOT).settings;
    delete settings.hooks!.SubagentStart;
    delete settings.hooks!.SubagentStop;
    const detail = routingFailureDetail({ ...base, projectSettings: settings });
    expect(detail).toContain('SubagentStart and SubagentStop');
    expect(detail).toContain('the hooks that actually route');
  });

  it('explains that global routing cannot serve a project with its own config', () => {
    const detail = routingFailureDetail({
      ...base,
      globalSettings: planRouteAuto({}, THIS_ROOT, 'global').settings,
      projectResolvesToMachineConfig: false,
    });
    expect(detail).toContain('installed globally');
    expect(detail).toContain('its own sonata.toml');
    expect(detail).toContain('without `--global`');
  });

  it('distinguishes a base URL left pointing at a since-changed router port', () => {
    const detail = routingFailureDetail({
      ...base,
      projectSettings: { env: { ANTHROPIC_BASE_URL: 'http://localhost:9999' } },
    });
    expect(detail).toContain('http://localhost:9999');
    expect(detail).toContain('http://localhost:4100');
    expect(detail).toContain('sonata route auto');
  });

  it('does not call a base URL sonata never wrote a stale router port', () => {
    // `route on`/`route off` own only `http://localhost:<port>`; anything else
    // was set deliberately by someone with a reason. Recommending
    // `sonata route auto` here is not merely imprecise — `planRouteAuto` calls
    // `planRouteOff`, which THROWS on a URL sonata does not own, so the
    // suggested repair fails outright for a user behind a corporate proxy.
    const detail = routingFailureDetail({
      ...base,
      projectSettings: { env: { ANTHROPIC_BASE_URL: 'https://proxy.example' } },
    });
    expect(detail).toContain('https://proxy.example');
    expect(detail).toMatch(/sonata did not write|not written by sonata/i);
    expect(detail).not.toContain('sonata route auto');
  });

  it('falls back to the plain instruction when packageRoot is unknown', () => {
    const { packageRoot: _drop, ...noRoot } = base;
    expect(routingFailureDetail(noRoot))
      .toBe('tier agents need a routed session — run `sonata route auto`');
  });
});
