import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { chmodSync, mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { checkVersion, cmdDoctor, staleMcpRegistration, routingFailureDetail } from '../../src/commands/doctor.js';
import { planRouteAuto } from '../../src/commands/route.js';
import type { Settings } from '../../src/settings.js';
import { writeSonataKey } from '../../src/native/credentials.js';
import { opencodeDbPath } from '../../src/native/opencode-store.js';
import { sqliteAvailable, writeOpencodeCredDb } from '../opencode-db-fixture.js';
import { credentialDir } from '../../src/native/oauth-login.js';
import { cmdRoute } from '../../src/commands/route.js';
import { nativeAgentMarkdown, plannedAgents } from '../../src/commands/sync.js';
import { parseConfig } from '../../src/config.js';
import { appendRow, type LedgerRow } from '../../src/ledger.js';
import { projectTenant } from '../../src/commands/status.js';

vi.mock('../../src/native/litellm.js', async (importOriginal) => ({
  // The rest is real: doctor merges gateways through serve's own function,
  // which keys credentials by `envVarForGateway`.
  ...await importOriginal<typeof import('../../src/native/litellm.js')>(),
  findLitellm: () => '/usr/local/bin/litellm',
}));

/**
 * Spread into every `cmdDoctor` call so none of them spawns `claude --version`.
 *
 * The default probe costs ~0.7s, and this file calls `cmdDoctor` 36 times —
 * about 3s of the file's runtime spent resolving a value no test here asserts
 * on. The one test that *is* about a known-bad client injects its own version.
 */
const NO_CLIENT = {
  claudeVersion: async () => undefined,
  // Nor the configured harnesses' own binaries: `opencode --version` against
  // the real home ran past the 30s test timeout under a loaded suite, and none
  // of these tests is about the version line or `codex login status`.
  harnessVersion: async () => '0.0.0',
  harnessHealth: async () => [],
};

/**
 * `cmdDoctor` probes the router and LiteLLM health endpoints on the machine
 * ports — 4100 and 4000 when the test home names none, which on a
 * maintainer's machine are a live router and a live LiteLLM. A test about
 * those probes installs its own `fetch`; every other one sees nothing running.
 */
beforeEach(() => {
  vi.stubGlobal('fetch', async () => { throw new Error('no network in doctor tests'); });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

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
    (await cmdDoctor({ ...NO_CLIENT, cwd, home })).checks.find((c) => c.name === name);

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
    (await cmdDoctor({ ...NO_CLIENT, cwd, home })).checks.find((c) => c.name === name);

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
    const res = await cmdDoctor({ ...NO_CLIENT, cwd, home, packageRoot: '/pkg' });
    for (const name of ['agents', 'agent tools']) {
      expect(res.checks.find((c) => c.name === name)?.ok).toBe(true);
    }
  });

  const AUTO = `
[auto_route]
classifier = "jev"

[models."a"]
harness = "codex"
id = "gpt-5.6-sol"

[models."b"]
harness = "codex"
id = "gpt-5.6-pro"

[tiers.code]
simple = ["a"]
normal = ["a", "b"]
complex = ["b"]
`;

  const noModelList = (async () => new Response('{}', { status: 404 })) as any;

  function autoRouteRow(tenant: string | undefined, outcome: 'accepted' | 'low-confidence' | 'invalid' | 'failed', reason?: string): LedgerRow {
    return {
      ts: new Date().toISOString(), ms: 500,
      alias: 'sonata-code-auto', role: 'code', tier: 'normal',
      key: 'a', gateway: 'codex', upstream: 'harness',
      status: 200, complete: true,
      tokens: { input: 10, output: 2, cacheRead: 0, cacheCreation: 0 },
      price: { source: 'none' }, attempts: [], tenant,
      autoRoute: { classifier: 'jev', outcome, ms: 500, reason },
    };
  }

  it('warns when auto-routing is on without a TypeSafe key', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'doc-auto-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-auto-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), AUTO);
    const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home, fetch: noModelList });
    expect(checks.find((c) => c.name === 'auto route' && /sonata auth add typesafe/.test(c.detail))).toBeDefined();
  });

  it('names the key the base_url needs, by host', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'doc-auto-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-auto-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), AUTO.replace('classifier = "jev"\n', 'classifier = "jev"\nbase_url = "https://openrouter.ai/api"\n'));
    const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home, fetch: noModelList });
    expect(checks.find((c) => c.name === 'auto route' && /sonata auth add openrouter/.test(c.detail))).toBeDefined();
  });

  it('reports the chosen decision model, its score and the runner-up', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'doc-auto-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-auto-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), AUTO.replace('classifier = "jev"\n', 'classifier = "jev"\nbase_url = "https://openrouter.ai/api"\n'));
    writeSonataKey(home, 'openrouter', 'or');
    mkdirSync(join(cwd, '.claude', 'agents'), { recursive: true });
    const code = plannedAgents(parseConfig(readFileSync(join(cwd, 'sonata.toml'), 'utf8'))).find((a) => a.name === 'code-auto');
    writeFileSync(join(cwd, '.claude', 'agents', 'code-auto.md'), code?.content ?? '');
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(join(home, '.config', 'sonata', 'decision-catalog.json'), JSON.stringify({
      fetchedAt: new Date().toISOString(), revision: 'v1.5.4',
      systems: [{ key: 'jev-1.13.0', display: 'Jev', capability: 80 }, { key: 'kev-4b', display: 'kev', capability: 55 }],
    }));
    const listing = { data: [
      { id: 'typesafe/jev-1.13', architecture: { output_modalities: ['decisions'] } },
      { id: 'jaredpalmer/kev-4b', architecture: { output_modalities: ['decisions'] } },
    ] };
    const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home, fetch: (async () => new Response(JSON.stringify(listing))) as any });
    const detail = checks.filter((c) => c.name === 'auto route').map((c) => c.detail).join('\n');
    expect(detail).toMatch(/model typesafe\/jev-1\.13 — JevBench capability 80\.0/);
    expect(detail).toMatch(/runner-up jaredpalmer\/kev-4b 55\.0/);
  });

  it('reports the decision catalog\'s revision and age when it is fresh', async () => {
    // Its age is part of the report, not just its absence or its staleness: a
    // ranking is only as trustworthy as the data behind it.
    const cwd = mkdtempSync(join(tmpdir(), 'doc-auto-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-auto-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), AUTO);
    writeSonataKey(home, 'typesafe', 'k');
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(join(home, '.config', 'sonata', 'decision-catalog.json'), JSON.stringify({
      fetchedAt: '2026-10-01T00:00:00.000Z', revision: 'v1.5.4',
      systems: [{ key: 'jev-1.13.0', display: 'Jev', capability: 80 }],
    }));
    const listing = (async () => new Response('{}', { status: 404 })) as any;
    const { checks } = await cmdDoctor({
      ...NO_CLIENT, cwd, home, fetch: listing, now: () => new Date('2026-10-01T06:00:00.000Z'),
    });
    expect(checks.find((c) => c.name === 'auto route'
      && /decision-model catalog: JevBench v1\.5\.4, 0 day\(s\) old/.test(c.detail))).toBeDefined();
  });

  it('with a pinned model it fetches no listing and says nothing about the catalog', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'doc-auto-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-auto-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), AUTO.replace('classifier = "jev"\n', 'classifier = "jev"\nmodel = "typesafe/jev-1.13"\n'));
    writeSonataKey(home, 'typesafe', 'k');
    // The pinned-model line only prints once the agent files are in place.
    mkdirSync(join(cwd, '.claude', 'agents'), { recursive: true });
    const code = plannedAgents(parseConfig(readFileSync(join(cwd, 'sonata.toml'), 'utf8'))).find((a) => a.name === 'code-auto');
    writeFileSync(join(cwd, '.claude', 'agents', 'code-auto.md'), code?.content ?? '');
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(join(home, '.config', 'sonata', 'decision-catalog.json'), JSON.stringify({
      fetchedAt: '2026-10-01T00:00:00.000Z', revision: 'v1.5.4',
      systems: [{ key: 'jev-1.13.0', display: 'Jev', capability: 80 }],
    }));
    const listing = vi.fn(async () => new Response('{}', { status: 404 })) as any;
    const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home, fetch: listing });
    expect(listing).not.toHaveBeenCalled();
    const detail = checks.filter((c) => c.name === 'auto route').map((c) => c.detail).join('\n');
    expect(detail).toContain('pinned model typesafe/jev-1.13');
    expect(detail).not.toContain('decision-model catalog');
  });

  it('does not ask a loopback decision URL for a key', async () => {
    // A local server needs no credential, so a missing one is not a problem to
    // report — flagging it would send the reader after a key nothing reads.
    const cwd = mkdtempSync(join(tmpdir(), 'doc-auto-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-auto-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), AUTO.replace('classifier = "jev"\n', 'classifier = "jev"\nbase_url = "http://localhost:8000"\n'));
    const listing = (async () => new Response('{}', { status: 404 })) as any;
    const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home, fetch: listing });
    const detail = checks.filter((c) => c.name === 'auto route').map((c) => c.detail).join('\n');
    expect(detail).not.toMatch(/no key for/);
    expect(detail).not.toMatch(/sonata auth add/);
  });

  it('names sonata sync when a -auto agent file is missing', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'doc-auto-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-auto-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), AUTO);
    writeSonataKey(home, 'typesafe', 'k');
    const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home, fetch: noModelList });
    expect(checks.find((c) => c.name === 'auto route' && /sonata sync/.test(c.detail) && /code-auto/.test(c.detail))).toBeDefined();
  });

  it('accepts an auto agent written to the user agents directory by a global-scope init', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'doc-auto-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-auto-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), AUTO);
    writeSonataKey(home, 'typesafe', 'k');
    mkdirSync(join(home, '.claude', 'agents'), { recursive: true });
    const code = plannedAgents(parseConfig(AUTO)).find((a) => a.name === 'code-auto');
    writeFileSync(join(home, '.claude', 'agents', 'code-auto.md'), code?.content ?? '');
    const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home, fetch: noModelList });
    expect(checks.some((c) => c.name === 'auto route' && !c.ok)).toBe(false);
    expect(checks.find((c) => c.name === 'auto route' && c.ok && /on \(https?:/.test(c.detail))).toBeDefined();
  });

  it('reports a non-sonata file occupying an auto agent name', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'doc-auto-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-auto-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), AUTO);
    mkdirSync(join(cwd, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(cwd, '.claude', 'agents', 'code-auto.md'), 'My own agent');
    writeSonataKey(home, 'typesafe', 'k');
    const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home, fetch: noModelList });
    const check = checks.find((c) => c.name === 'auto route' && !c.ok);
    expect(check?.detail).toContain('code-auto.md');
    expect(check?.detail).toContain('not sonata-owned');
    expect(check?.detail).toMatch(/rename or remove it/);
  });

  it('flags three or more decisions when none were answered', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'doc-auto-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-auto-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), AUTO);
    const tenant = projectTenant(cwd, home);
    for (let i = 0; i < 5; i++) appendRow(home, autoRouteRow(tenant, 'failed', 'HTTP 422'));
    const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home, fetch: noModelList });
    const check = checks.find((c) => c.name === 'auto route' && c.detail.includes('last 24h'));
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('5 failed');
    expect(check?.detail).toContain('most common failure: HTTP 422 (5)');
    expect(check?.detail).toContain('not working');
  });

  it('reports decisions when some were answered', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'doc-auto-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-auto-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), AUTO);
    const tenant = projectTenant(cwd, home);
    appendRow(home, autoRouteRow(tenant, 'accepted'));
    appendRow(home, autoRouteRow(tenant, 'accepted'));
    appendRow(home, autoRouteRow(tenant, 'failed', 'HTTP 422'));
    const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home, fetch: noModelList });
    const check = checks.find((c) => c.name === 'auto route' && c.detail.includes('last 24h'));
    expect(check?.ok).toBe(true);
    expect(check?.detail).toContain('2 accepted');
    expect(check?.detail).toContain('1 failed');
  });

  it('does not flag two unanswered decisions', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'doc-auto-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-auto-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), AUTO);
    const tenant = projectTenant(cwd, home);
    appendRow(home, autoRouteRow(tenant, 'failed', 'HTTP 422'));
    appendRow(home, autoRouteRow(tenant, 'failed', 'HTTP 422'));
    const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home, fetch: noModelList });
    const check = checks.find((c) => c.name === 'auto route' && c.detail.includes('last 24h'));
    expect(check?.ok).toBe(true);
  });

  it('does not count decisions from another tenant', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'doc-auto-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-auto-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), AUTO);
    appendRow(home, autoRouteRow('another-tenant', 'failed', 'HTTP 422'));
    const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home, fetch: noModelList });
    expect(checks.filter((c) => c.name === 'auto route').some((c) => c.detail.includes('last 24h'))).toBe(false);
  });

  it('does not report a decision summary without rows', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'doc-auto-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-auto-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), AUTO);
    const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home, fetch: noModelList });
    expect(checks.filter((c) => c.name === 'auto route').some((c) => c.detail.includes('last 24h'))).toBe(false);
  });

  it('reports nothing about auto-routing when it is off', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'doc-auto-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-auto-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), AUTO.replace('[auto_route]\nclassifier = "jev"\n\n', ''));
    const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home, fetch: noModelList });
    expect(checks.some((c) => c.name === 'auto route')).toBe(false);
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

    const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home });
    const check = checks.find((c) => c.name === 'agent tools')!;
    expect(check.ok).toBe(false);
    expect(check.detail).toBe('1 wrapper(s) still call removed MCP tools and will fail mid-dispatch — run `sonata sync`');
    expect(check.detail).not.toContain('restart Claude Code');
  });

  it('blocks when a generated agent still names the removed dispatch/wait/approve MCP tools', async () => {
    // The generation immediately before this one — MCP-hosted, but already
    // using dispatch/wait/approve rather than the older run/tail names.
    writeAgent('code-old.md', 'mcp__sonata__dispatch, mcp__sonata__wait, mcp__sonata__approve');

    const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home });
    const check = checks.find((c) => c.name === 'agent tools')!;
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('removed MCP tools');
  });

  it('passes when every agent names the current tools', async () => {
    writeAgent('code-new.md', 'Bash(sonata dispatch:*), Bash(sonata wait:*), Bash(sonata approve:*)');

    const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home });
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

    const c = (await cmdDoctor({ ...NO_CLIENT, cwd, home })).checks.find((x) => x.name === 'opencode agents');
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

    const c = (await cmdDoctor({ ...NO_CLIENT, cwd, home })).checks.find((x) => x.name === 'opencode agents');
    // `general` is not an agent sonata dispatches to; leave the user's choice alone.
    expect(c?.ok).toBe(true);
  });
});

/**
 * A machine that can build the venv. Pinned rather than probed: `no-python` is
 * a real state that depends on PATH, so an unseamed check answers differently
 * on stock macOS (python3 3.9, no uv) than in CI.
 */
const USABLE_PYTHON = { which: (b: string) => (b === 'uv' ? '/bin/uv' : undefined), pythonVersion: () => '3.12.0' };

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

  it('calls a multi-tenant router up and lists what it serves', async () => {
    const { cwd, home } = setup();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      status: 'ok', sonata: true, multiTenant: true, tenants: [{ id: 'aaaaaaaaaaaa', configPath: join(cwd, 'sonata.toml') }],
    }), { status: 200 })) as unknown as typeof fetch;
    try {
      const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home });
      expect(checks.find((c) => c.name === 'serve health')).toEqual({ name: 'serve health', ok: true, detail: `up · 1 project(s): ${join(cwd, 'sonata.toml')}` });
    } finally { globalThis.fetch = originalFetch; }
  });

  it('lists unknown tenant config paths as question marks', async () => {
    const { cwd, home } = setup();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ sonata: true, multiTenant: true, tenants: [{ id: 'bbbbbbbbbbbb', configPath: null }] }), { status: 200 })) as unknown as typeof fetch;
    try {
      const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home });
      expect(checks.find((c) => c.name === 'serve health')).toEqual({ name: 'serve health', ok: true, detail: 'up · 1 project(s): ?' });
    } finally { globalThis.fetch = originalFetch; }
  });

  it('reports malformed multi-tenant health payloads instead of stopped', async () => {
    const { cwd, home } = setup();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ sonata: true, multiTenant: true, tenants: null }), { status: 200 })) as unknown as typeof fetch;
    try {
      const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home });
      expect(checks.find((c) => c.name === 'serve health')).toMatchObject({ ok: false, detail: expect.stringContaining('health payload could not be read') });
      expect(checks.find((c) => c.name === 'serve health')?.detail).toContain('sonata restart');
      expect(checks.find((c) => c.name === 'serve health')?.detail).not.toContain('not running');
    } finally { globalThis.fetch = originalFetch; }
  });

  it('probes the managed LiteLLM at 127.0.0.1, the one address it binds', async () => {
    const { cwd, home } = setup();
    const seen: string[] = [];
    globalThis.fetch = (async (url: string) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ status: 'ok', sonata: true, multiTenant: true, tenants: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home });
    expect(checks.find((c) => c.name === 'litellm health')?.ok).toBe(true);
    expect(seen).toContain('http://127.0.0.1:4000/health/liveliness');
  });

  it('warns on whitespace around a project ports table header', async () => {
    const { cwd, home } = setup();
    writeFileSync(join(cwd, 'sonata.toml'), `${NATIVE}\n  [ native.ports ]\nrouter = 4101\n`);
    const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home });
    expect(checks.find((c) => c.name === 'project ports')?.ok).toBe(true);
  });

  it('fails a router that predates multi-tenant routing', async () => {
    const { cwd, home } = setup();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ status: 'ok', sonata: true, configPath: '/x' }), { status: 200 })) as unknown as typeof fetch;
    try {
      const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home });
      expect(checks.find((c) => c.name === 'serve health')).toMatchObject({ ok: false, detail: expect.stringContaining('sonata restart') });
    } finally { globalThis.fetch = originalFetch; }
  });

  it('warns on a project [native.ports], which the machine router ignores', async () => {
    const { cwd, home } = setup();
    writeFileSync(join(cwd, 'sonata.toml'), `${NATIVE}\n[native.ports]\nrouter = 4101\nlitellm = 4001\n`);
    const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home });
    expect(checks.find((c) => c.name === 'project ports')).toEqual({
      name: 'project ports', ok: true,
      detail: `${join(cwd, 'sonata.toml')} sets [native.ports], which is ignored — one router serves every project on the machine ports; delete the table`,
    });
  });

  it('checks LiteLLM, a down serve, missing key sources, and native stale agents', async () => {
    const { cwd, home } = setup();
    // A real legacy native agent: the name alone no longer claims a file.
    writeFileSync(join(cwd, '.claude', 'agents', 'native-code-old.md'), nativeAgentMarkdown({ role: 'code', model: 'old' }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('down'); };
    try {
      const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home });
      // The state, and the repair for that state — not "not found", which was
      // the same sentence for six different causes.
      expect(checks.find((c) => c.name === 'litellm')).toMatchObject({
        name: 'litellm', ok: false, detail: expect.stringContaining('sonata litellm install'),
      });
      // A PATH litellm is reported as information, explicitly not what runs.
      expect(checks.find((c) => c.name === 'litellm (PATH)')?.detail)
        .toContain('not used; sonata runs its own pinned venv');
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
      const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home });
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

  it('warns about two OAuth gateways of one kind that read different accounts', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'doc-oauth-pair-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-oauth-pair-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), `
[native.gateways.codex]
auth = "codex-oauth"
credential_source = "codex"
[native.gateways.openai]
auth = "codex-oauth"
credential_source = "sonata"
`);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('down'); };
    try {
      const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home });
      const check = checks.find((c) => c.name === 'gateway conflicts');
      expect(check?.ok).toBe(false);
      expect(check?.detail).toContain('gateways with auth = "codex-oauth" read different credentials');
      expect(check?.detail).toContain('"codex" (');
      expect(check?.detail).toContain('"openai" (');
      expect(check?.detail).toContain('! serve drops "codex", "openai" — their models answer 502 until this is resolved');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('says nothing about OAuth accounts when they agree', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'doc-oauth-one-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-oauth-one-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), `
[native.gateways.codex]
auth = "codex-oauth"
[native.gateways.openai]
auth = "codex-oauth"
`);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('down'); };
    try {
      const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home });
      expect(checks.find((c) => c.name === 'gateway conflicts')).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // Serve drops by the union of every tenant's gateways, and the machine
  // config is always one of them — so a conflict can span two files, each
  // fine on its own.
  it('warns about an OAuth conflict between this project and the machine config, naming the machine file', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'doc-oauth-cross-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-oauth-cross-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), `
[native.gateways.codex]
auth = "codex-oauth"
credential_source = "sonata"
`);
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(join(home, '.config', 'sonata', 'sonata.toml'), `
[native.gateways.openai]
auth = "codex-oauth"
`);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('down'); };
    try {
      const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home });
      const check = checks.find((c) => c.name === 'gateway conflicts');
      expect(check?.ok).toBe(false);
      expect(check?.detail).toContain('gateways with auth = "codex-oauth" read different credentials');
      expect(check?.detail).toContain(join('.config', 'sonata', 'sonata.toml'));
      expect(check?.detail).toContain('! serve drops "codex" — their models answer 502 until this is resolved');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('warns about a gateway name the machine config defines with a different credential', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'doc-name-cross-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-name-cross-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), `
[native.gateways.acme]
base_url = "https://b.example/v1"
credential_source = "sonata"
`);
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(join(home, '.config', 'sonata', 'sonata.toml'), `
[native.gateways.acme]
base_url = "https://a.example/v1"
credential_source = "opencode"
`);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('down'); };
    try {
      const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home });
      const check = checks.find((c) => c.name === 'gateway conflicts');
      expect(check?.ok).toBe(false);
      expect(check?.detail).toContain('gateway "acme" is defined by two projects with different credentials');
      expect(check?.detail).toContain(join('.config', 'sonata', 'sonata.toml'));
      expect(check?.detail).toContain('! serve drops "acme" — their models answer 502 until this is resolved');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('says nothing when this project and the machine config agree on an OAuth account', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'doc-oauth-agree-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-oauth-agree-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), `
[native.gateways.codex]
auth = "codex-oauth"
`);
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(join(home, '.config', 'sonata', 'sonata.toml'), `
[native.gateways.openai]
auth = "codex-oauth"
`);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('down'); };
    try {
      const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home });
      expect(checks.find((c) => c.name === 'gateway conflicts')).toBeUndefined();
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
      const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home });
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
      const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home });
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
      const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home });
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
      const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home });
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
      const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home });
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
      const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home });
      const text = checks.map((check) => check.detail).join('\n');
      expect(text).toContain('github-copilot: credential from opencode');
      expect(text).toMatch(/no credential from opencode.*log into opencode with a GitHub Copilot account/s);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it.skipIf(!sqliteAvailable())('reports an api key supplied by opencode.db', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'doc-db-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-db-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), `
[native.gateways.acme]
base_url = "https://gateway.example/v1"
credential_source = "opencode"
`);
    writeOpencodeCredDb(opencodeDbPath(home, {}), [
      {
        id: 'r1', integration: 'acme',
        value: JSON.stringify({ type: 'key', key: 'sk-fake' }), timeCreated: 100,
      },
    ]);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('down'); };
    try {
      const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home });
      expect(checks.find((c) => c.name === 'key source: acme')).toEqual({
        name: 'key source: acme', ok: true, detail: 'acme: credential from opencode.db',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it.skipIf(!sqliteAvailable())('reports a ChatGPT login supplied by opencode.db', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'doc-db-oauth-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-db-oauth-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), `
[native.gateways.codex]
auth = "codex-oauth"
credential_source = "opencode"
`);
    // A real ChatGPT access token is a JWT carrying the shared app's client_id
    // — the same check applies whether the row came from the table or auth.json.
    const body = Buffer.from(JSON.stringify({
      exp: 1787806005, client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
    })).toString('base64url');
    writeOpencodeCredDb(opencodeDbPath(home, {}), [
      {
        id: 'r1', integration: 'openai',
        value: JSON.stringify({ type: 'oauth', access: `header.${body}.sig`, refresh: 'rt-fake' }),
        timeCreated: 100,
      },
    ]);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('down'); };
    try {
      const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home });
      expect(checks.find((c) => c.name === 'key source: codex')).toEqual({
        name: 'key source: codex', ok: true, detail: 'codex: credential from opencode.db',
      });
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
      const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home });
      const text = checks.map((check) => check.detail).join('\n');
      expect(text).toContain('github-copilot: credential from opencode');
      expect(text).toMatch(/no credential from opencode.*log into opencode with a GitHub Copilot account/s);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it.skipIf(!sqliteAvailable())('warns when opencode.db holds credentials and is world-readable', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'doc-db-mode-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-db-mode-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), `
[native.gateways.acme]
base_url = "https://gateway.example/v1"
`);
    writeOpencodeCredDb(opencodeDbPath(home, {}), [
      {
        id: 'r1', integration: 'acme',
        value: JSON.stringify({ type: 'key', key: 'sk-fake' }), timeCreated: 100,
      },
    ]);
    chmodSync(opencodeDbPath(home, {}), 0o644);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('down'); };
    try {
      const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home });
      // The key itself resolves from the table, named as such...
      expect(checks.find((c) => c.name === 'key source: acme')?.detail).toBe('from opencode.db');
      // ...and the file it lives in is called out, without sonata touching it.
      const advisory = checks.find((c) => c.name === 'opencode.db');
      expect(advisory?.ok).toBe(true);
      expect(advisory?.detail).toContain('chmod 600');
      expect(advisory?.detail).toContain('plaintext');
      expect(advisory?.detail).toContain('world-readable');
      // A file only its group can read is named as such, not as everyone's.
      chmodSync(opencodeDbPath(home, {}), 0o640);
      const group = (await cmdDoctor({ ...NO_CLIENT, cwd, home })).checks.find((c) => c.name === 'opencode.db');
      expect(group?.detail).toContain('group-readable');
      expect(group?.detail).not.toContain('world-readable');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('warns, naming the file, when codex\'s auth.json cannot be parsed while opencode serves the login', async () => {
    // serve skips a steadily unreadable store as absent, so a default ChatGPT
    // gateway is quietly served opencode's login — and every other check
    // here reads "fine". Say which file is broken.
    const cwd = mkdtempSync(join(tmpdir(), 'doc-codex-corrupt-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-codex-corrupt-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), `
[native.gateways.codex]
auth = "codex-oauth"
`);
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex', 'auth.json'), '');
    const body = Buffer.from(JSON.stringify({ exp: 1787806005, client_id: 'app_EMoamEEZ73f0CkXaXp7hrann' })).toString('base64url');
    mkdirSync(join(home, '.local', 'share', 'opencode'), { recursive: true });
    writeFileSync(join(home, '.local', 'share', 'opencode', 'auth.json'), JSON.stringify({
      openai: { type: 'oauth', access: `header.${body}.sig`, refresh: 'rt-fake' },
    }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('down'); };
    try {
      const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home });
      const warning = checks.find((c) => c.name === 'credential store');
      expect(warning?.ok).toBe(true);
      expect(warning?.detail).toContain(join(home, '.codex', 'auth.json'));
      expect(warning?.detail).toContain('not valid JSON');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it.skipIf(!sqliteAvailable())('warns, naming the file, when opencode.db cannot be queried', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'doc-db-corrupt-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-db-corrupt-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), `
[native.gateways.acme]
base_url = "https://gateway.example/v1"
`);
    mkdirSync(dirname(opencodeDbPath(home, {})), { recursive: true });
    writeFileSync(opencodeDbPath(home, {}), 'this is not a sqlite database, and never will be');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('down'); };
    try {
      const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home });
      const warning = checks.find((c) => c.name === 'credential store');
      expect(warning?.ok).toBe(true);
      expect(warning?.detail).toContain(opencodeDbPath(home, {}));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('says nothing about credential stores that read cleanly or are not there', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'doc-stores-ok-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-stores-ok-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), `
[native.gateways.acme]
base_url = "https://gateway.example/v1"
`);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('down'); };
    try {
      const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home });
      expect(checks.find((c) => c.name === 'credential store')).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it.skipIf(!sqliteAvailable())('stays quiet about a 0600 opencode.db', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'doc-db-mode-ok-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-db-mode-ok-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), `
[native.gateways.acme]
base_url = "https://gateway.example/v1"
`);
    writeOpencodeCredDb(opencodeDbPath(home, {}), [
      {
        id: 'r1', integration: 'acme',
        value: JSON.stringify({ type: 'key', key: 'sk-fake' }), timeCreated: 100,
      },
    ]);
    chmodSync(opencodeDbPath(home, {}), 0o600);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('down'); };
    try {
      const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home });
      expect(checks.find((c) => c.name === 'opencode.db')).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it.skipIf(!sqliteAvailable())('stays quiet when a world-readable opencode.db holds no credentials', async () => {
    // The rows are the point: an empty table has nothing to leak, whatever the
    // mode says.
    const cwd = mkdtempSync(join(tmpdir(), 'doc-db-mode-empty-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-db-mode-empty-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), `
[native.gateways.acme]
base_url = "https://gateway.example/v1"
`);
    writeOpencodeCredDb(opencodeDbPath(home, {}), []);
    chmodSync(opencodeDbPath(home, {}), 0o666);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('down'); };
    try {
      const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home });
      expect(checks.find((c) => c.name === 'opencode.db')).toBeUndefined();
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
      const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home });
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
      const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home });
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
      models: { 'deepseek-v4-flash': { codingIndex: 45, blendedPriceUsd: 0.3, costPerTask: 0.2 } },
    }));
  };

  // `cmdDoctor` probes the network for harness versions; stub it out so the
  // check list is deterministic.
  const doctorChecks = async (cwd: string, home: string, now: Date) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('down'); };
    try {
      const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home, now: () => now });
      return checks;
    } finally {
      globalThis.fetch = originalFetch;
    }
  };

  /** The whole result, for assertions about the command's own verdict. */
  const doctorResult = async (cwd: string, home: string, now: Date) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('down'); };
    try {
      return await cmdDoctor({ ...NO_CLIENT, cwd, home, now: () => now });
    } finally {
      globalThis.fetch = originalFetch;
    }
  };

  const rankingCheck = async (cwd: string, home: string, now: Date) =>
    (await doctorChecks(cwd, home, now)).find((c) => c.name === 'model rankings');

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

  it('reports a missing normal tier as optional information', async () => {
    const { cwd, home } = tieredSetup();
    const checks = await doctorChecks(cwd, home, new Date('2026-08-28T00:00:00.000Z'));
    const normal = checks.find((check) => check.name === 'normal tier');
    expect(normal?.ok).toBe(true);
    expect(checks.some((check) => !check.ok && /normal/i.test(`${check.name} ${check.detail}`))).toBe(false);
  });

  it('says tiers fall back to built-in defaults when no catalog exists', async () => {
    const { cwd, home } = tieredSetup();
    const c = await rankingCheck(cwd, home, new Date('2026-08-28T00:00:00.000Z'));
    expect(c?.detail).toMatch(/built-in defaults/);
  });

  it('reports that effort levels cannot be checked when there is no catalog', async () => {
    const { cwd, home } = tieredSetup();
    const c = await rankingCheck(cwd, home, new Date('2026-08-28T00:00:00.000Z'));
    expect(c?.detail).toMatch(/no catalog .* effort levels cannot be checked/);
  });

  it('reports a catalog that carries no effort levels, and names the fix', async () => {
    // The dangerous case, and the one "no catalog" cannot cover: a cache
    // written before effort levels existed has no `family` on any row, so the
    // refusal cannot fire. Nothing about the rankings line says so — it reads
    // healthy, and a config with an unpinned candidate loads for months and
    // stops the day someone runs `sonata catalog update`. Said outright rather
    // than left to be inferred.
    const { cwd, home } = tieredSetup();
    writeCatalog(home, '2026-08-20T00:00:00.000Z');
    const checks = await doctorChecks(cwd, home, new Date('2026-08-28T00:00:00.000Z'));
    const c = checks.find((check) => check.name === 'effort levels');
    expect(c?.ok).toBe(true);
    expect(c?.detail).toMatch(/catalog has no effort levels/);
    expect(c?.detail).toMatch(/sonata catalog update/);
  });

  it('says nothing about effort levels when the catalog carries them', async () => {
    const { cwd, home } = tieredSetup();
    const path = join(home, '.config', 'sonata', 'catalog.json');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      fetchedAt: '2026-08-20T00:00:00.000Z',
      models: {
        'deepseek-v4-flash': {
          codingIndex: 45, blendedPriceUsd: 0.3, family: 'deepseek-v4-flash', effort: 'default',
        },
      },
    }));
    const checks = await doctorChecks(cwd, home, new Date('2026-08-28T00:00:00.000Z'));
    expect(checks.find((check) => check.name === 'effort levels')).toBeUndefined();
  });

  it('scores an effort-pinned candidate by its bare key for coverage', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'doc-effort-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-effort-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), `
[models."big"]
gateway = "acme"
id = "big"

[native.gateways."acme"]
base_url = "https://gateway.example/v1"

[tiers.code]
simple = ["big@high"]
complex = ["big@high"]
`);
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    const path = join(home, '.config', 'sonata', 'catalog.json');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      fetchedAt: '2026-08-27T00:00:00.000Z',
      models: { big: { codingIndex: 45, blendedPriceUsd: 0.3, costPerTask: 0.2 } },
    }));
    const c = await rankingCheck(cwd, home, new Date('2026-08-28T00:00:00.000Z'));
    expect(c?.detail).not.toMatch(/unscored/);
  });

  it('names a tiered model the catalog cannot score, however fresh it is', async () => {
    // Age is the wrong instrument for this failure: a catalog fetched
    // yesterday is reported fresh and still knows nothing about a model
    // released today, which then ranks from the capable-not-cheap default with
    // no warning anywhere. Coverage asks the question age stood in for.
    const cwd = mkdtempSync(join(tmpdir(), 'doc-cov-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-cov-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), `
[models."flash"]
gateway = "acme"
id = "deepseek-v4-flash-0731"

[models."brand-new"]
gateway = "acme"
id = "gemini-3.9-flash"

[native.gateways."acme"]
base_url = "https://gateway.example/v1"

[tiers.code]
simple = ["flash", "brand-new"]
complex = ["brand-new"]
`);
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeCatalog(home, '2026-08-27T00:00:00.000Z');
    const c = await rankingCheck(cwd, home, new Date('2026-08-28T00:00:00.000Z'));
    expect(c?.ok).toBe(true);
    expect(c?.detail).toMatch(/1 of 2 tiered models unscored/);
    // Reported by the upstream id, which is what the catalog is keyed by —
    // naming the config key would send the user looking for the wrong string.
    expect(c?.detail).toContain('gemini-3.9-flash');
    expect(c?.detail).toMatch(/sonata catalog update/);
  });

  it('names a pricing_provider id that matches no models.dev provider', async () => {
    // The setting's only visible effect is a price that *appears*, so an id
    // matching nothing is invisible: the gateway reads as configured and
    // every model on it still resolves to `source: none`. Measured on a real
    // config — `"tencent"` is not a models.dev provider id (it files
    // `tencent-tokenhub`), so Hy4 was unpriced despite being asked for.
    const cwd = mkdtempSync(join(tmpdir(), 'doc-pp-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-pp-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), `
[models."flash"]
gateway = "acme"
id = "deepseek-v4-flash"

[native.gateways."acme"]
base_url = "https://gateway.example/v1"
pricing_provider = ["deepseek", "tencent", "nope"]
`);
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(join(home, '.config', 'sonata', 'models-dev.json'), JSON.stringify({
      fetchedAt: '2026-09-14T00:00:00.000Z',
      providers: { deepseek: { 'deepseek-v4-flash': { input: 1, output: 2 } } },
    }));
    const at = new Date('2026-09-14T00:00:00.000Z');
    const { ok, checks } = await doctorResult(cwd, home, at);
    const c = checks.find((check) => check.name === 'pricing providers');
    expect(c?.ok).toBe(true);
    expect(c?.detail).toContain('acme');
    expect(c?.detail).toContain('tencent');
    expect(c?.detail).toContain('nope');
    // The ids that do match are not named — only the ones doing nothing.
    expect(c?.detail).not.toContain('"deepseek"');
    // Advisory end to end: an unmatched id must not change the command's own
    // verdict. Asserted against the same config with only matching ids rather
    // than against `true`, because this temp home has no litellm venv and no
    // gateway key, so `ok` is false here for reasons that have nothing to do
    // with pricing — and asserting `true` would pin a fixture detail instead
    // of the behaviour.
    writeFileSync(join(cwd, 'sonata.toml'),
      readFileSync(join(cwd, 'sonata.toml'), 'utf8')
        .replace('["deepseek", "tencent", "nope"]', '["deepseek"]'));
    const clean = await doctorResult(cwd, home, at);
    expect(clean.checks.some((check) => check.name === 'pricing providers')).toBe(false);
    expect(ok).toBe(clean.ok);
  });

  it('warns when two gateways share a base_url, and only then', async () => {
    // Measured on a real machine: a provider NAMED `opencode` on the Go URL
    // put `opencode` and `opencode-go` on one endpoint, duplicating every
    // model and agent under two names with nothing saying so.
    const cwd = mkdtempSync(join(tmpdir(), 'doc-shared-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-shared-home-'));
    const toml = (second: string) => `
[models."a"]
gateway = "opencode"
id = "kimi-k3"

[models."b"]
gateway = "opencode-go"
id = "kimi-k3"

[native.gateways."opencode"]
base_url = "https://opencode.ai/zen/go/v1"

[native.gateways."opencode-go"]
base_url = "${second}"
`;
    writeFileSync(join(cwd, 'sonata.toml'), toml('https://opencode.ai/zen/go/v1/'));
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    const at = new Date('2026-09-14T00:00:00.000Z');
    const { ok, checks } = await doctorResult(cwd, home, at);
    const c = checks.find((check) => check.name === 'shared base_url');
    expect(c?.ok).toBe(true);
    expect(c?.detail).toContain('opencode, opencode-go');
    expect(c?.detail).toMatch(/one account under two names/);
    expect(c?.detail).toContain(`edit base_url in ${join(cwd, 'sonata.toml')}`);

    writeFileSync(join(cwd, 'sonata.toml'), toml('https://opencode.ai/zen/v1'));
    const clean = await doctorResult(cwd, home, at);
    expect(clean.checks.some((check) => check.name === 'shared base_url')).toBe(false);
    // Advisory: the verdict is whatever it is without the warning.
    expect(ok).toBe(clean.ok);
  });

  it('says nothing about pricing providers that all match, or with no cache', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'doc-pp2-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-pp2-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), `
[models."flash"]
gateway = "acme"
id = "deepseek-v4-flash"

[native.gateways."acme"]
base_url = "https://gateway.example/v1"
pricing_provider = ["deepseek"]
`);
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    // No cache at all: sonata cannot know which ids exist, so it must not guess.
    expect((await doctorChecks(cwd, home, new Date('2026-09-14T00:00:00.000Z')))
      .find((check) => check.name === 'pricing providers')).toBeUndefined();
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(join(home, '.config', 'sonata', 'models-dev.json'), JSON.stringify({
      fetchedAt: '2026-09-14T00:00:00.000Z',
      providers: { deepseek: { 'deepseek-v4-flash': { input: 1, output: 2 } } },
    }));
    expect((await doctorChecks(cwd, home, new Date('2026-09-14T00:00:00.000Z')))
      .find((check) => check.name === 'pricing providers')).toBeUndefined();
  });

  it('scores a vendor alias through its models.dev name, and an id that begins with the gateway name', async () => {
    // A BYOK DeepSeek gateway: its own slug for V4.1 Flash is the versionless
    // `deepseek-flash`, and `deepseek-v4-pro` begins with the gateway's name.
    // Measured, both reported unscored while AA held rows for both.
    const cwd = mkdtempSync(join(tmpdir(), 'doc-alias-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-alias-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), `
[models."deepseek-deepseek-flash"]
gateway = "deepseek"
id = "deepseek-flash"

[models."deepseek-deepseek-v4-pro"]
gateway = "deepseek"
id = "deepseek-v4-pro"

[native.gateways."deepseek"]
base_url = "https://api.deepseek.com/v1"
pricing_provider = ["deepseek"]

[tiers.code]
simple = ["deepseek-deepseek-flash"]
complex = ["deepseek-deepseek-v4-pro"]
`);
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    const catalogPath = join(home, '.config', 'sonata', 'catalog.json');
    mkdirSync(dirname(catalogPath), { recursive: true });
    writeFileSync(catalogPath, JSON.stringify({
      fetchedAt: '2026-08-27T00:00:00.000Z',
      models: {
        'deepseek-v4-1-flash': { codingIndex: 45, blendedPriceUsd: 0.3, costPerTask: 0.2 },
        'deepseek-v4-pro': { codingIndex: 59, blendedPriceUsd: 0.54, costPerTask: 0.3 },
      },
    }));
    writeFileSync(join(home, '.config', 'sonata', 'models-dev.json'), JSON.stringify({
      fetchedAt: '2026-08-27T00:00:00.000Z',
      providers: { deepseek: { 'deepseek-flash': { input: 0.15, output: 0.6 } } },
      names: { deepseek: { 'deepseek-flash': 'DeepSeek V4.1 Flash' } },
    }));
    const c = await rankingCheck(cwd, home, new Date('2026-08-28T00:00:00.000Z'));
    expect(c?.detail).toMatch(/all 2 tiered models scored/);
  });

  it('confirms coverage when every tiered model is scored', async () => {
    // The config key is `flash`; the catalog is keyed by the upstream id. A
    // check that compared keys would call every hand-named model unscored.
    const { cwd, home } = tieredSetup();
    writeCatalog(home, '2026-08-27T00:00:00.000Z');
    const c = await rankingCheck(cwd, home, new Date('2026-08-28T00:00:00.000Z'));
    expect(c?.detail).toMatch(/all 1 tiered models scored/);
    expect(c?.detail).not.toMatch(/unscored/);
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
      const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home });
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
      const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home });
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
      const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home, packageRoot: '/pkg' });
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
      const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home, packageRoot: '/pkg' });
      expect(checks.find((x) => x.name === 'tier routing')).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reports native serve health and key source without exposing key values', async () => {
    const { cwd, home } = setup();
    writeSonataKey(home, 'acme', 'super-secret-key');
    const originalFetch = globalThis.fetch;
    // A real router names the config it runs; one that does not is refused
    // by `route session-start` and is reported as such above.
    globalThis.fetch = async () => new Response(JSON.stringify({ sonata: true, multiTenant: true, tenants: [] }), { status: 200 });
    try {
      const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home });
      expect(checks.find((c) => c.name === 'serve health')).toEqual({
        name: 'serve health', ok: true, detail: 'up · 0 project(s)',
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

  // A fresh worktree has no hooks anywhere, so every diagnosis below reduces
  // to "nothing is installed" and none of them says why `route auto` in the
  // main checkout did not reach here.
  it('names the worktree when the config is borrowed from a main checkout', () => {
    const detail = routingFailureDetail({ ...base, borrowedFrom: '/repo-main' });
    expect(detail).toContain('git worktree of /repo-main');
    expect(detail).toContain('per checkout');
    expect(detail).toContain('here, in the worktree');
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

describe('cmdDoctor — litellm is conditional', () => {
  const ANTHROPIC_ONLY = `
[models."or-flash"]
gateway = "openrouter"
id = "deepseek/deepseek-v4-flash"
context_window = 128000

[tiers.code]
simple = ["or-flash"]
complex = ["or-flash"]

[native.gateways."openrouter"]
base_url = "https://openrouter.ai/api/v1"
provider = "anthropic"
`;

  const setup = (toml: string) => {
    const cwd = mkdtempSync(join(tmpdir(), 'doc-lite-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-lite-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), toml);
    mkdirSync(join(cwd, '.claude', 'agents'), { recursive: true });
    return { cwd, home };
  };

  it('says litellm is not needed rather than not installed', async () => {
    // "not installed" reads as a fault. For a config no gateway routes through
    // litellm, its absence is the correct state.
    const { cwd, home } = setup(ANTHROPIC_ONLY);
    const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home, installerDeps: USABLE_PYTHON });
    const check = checks.find((c) => c.name === 'litellm');
    expect(check?.ok).toBe(true);
    expect(check?.detail).toMatch(/no gateway/i);
  });

  it('does not mention a PATH litellm when none is needed', async () => {
    // Naming an unused binary beside "not needed" only invites the question of
    // whether it is about to be used.
    const { cwd, home } = setup(ANTHROPIC_ONLY);
    const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home, installerDeps: USABLE_PYTHON });
    expect(checks.find((c) => c.name === 'litellm (PATH)')).toBeUndefined();
  });
});

describe('cmdDoctor — litellm on a machine that cannot build it', () => {
  it('says install uv, not install litellm', async () => {
    // The repair differs: uv can fetch a conforming interpreter, so "install
    // uv" is much cheaper advice than "install a different Python" — and the
    // state that distinguishes them exists only because doctor probes.
    const cwd = mkdtempSync(join(tmpdir(), 'doc-nopy-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-nopy-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), `
[models."flash"]
gateway = "acme"
id = "deepseek-v4-flash-0731"
context_window = 128000

[native.gateways."acme"]
base_url = "https://gateway.example/v1"
`);
    mkdirSync(join(cwd, '.claude', 'agents'), { recursive: true });
    const { checks } = await cmdDoctor({
      ...NO_CLIENT, cwd, home, installerDeps: { which: () => undefined, pythonVersion: () => '3.9.6' },
    });
    const check = checks.find((c) => c.name === 'litellm');
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('install uv');
  });
});

// CodeRabbit on #32: `pricing_provider` is the THIRD thing `resolvePrice`
// consults (model rates, then gateway rates, then the provider), so a gateway
// priced by hand needs none — and reporting it as pricing nothing is a false
// statement about the user's own config.
describe('cmdDoctor — gateway pricing', () => {
  let cwd: string;
  let home: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'sonata-doctor-price-'));
    home = mkdtempSync(join(tmpdir(), 'sonata-doctor-price-home-'));
  });

  const pricingCheck = async (toml: string) => {
    writeFileSync(join(cwd, 'sonata.toml'), toml);
    return (await cmdDoctor({ ...NO_CLIENT, cwd, home })).checks.find((c) => c.name === 'gateway pricing');
  };

  const config = (gatewayExtra: string, modelExtra = '') => `
schema_version = 1
[native.gateways."acme"]
base_url = "https://acme.example/v1"
${gatewayExtra}
[models."m"]
gateway = "acme"
id = "model-x"
context_window = 128000
${modelExtra}
`;

  it('names a gateway with no pricing of any kind', async () => {
    const check = await pricingCheck(config(''));
    expect(check).toBeDefined();
    expect(check!.detail).toContain('acme');
  });

  it('stays silent for a gateway priced by a gateway [price] block', async () => {
    expect(await pricingCheck(config('[native.gateways."acme".price]\ninput = 1.0\noutput = 2.0'))).toBeUndefined();
  });

  it('stays silent for a gateway whose every model is priced by hand', async () => {
    expect(await pricingCheck(config('', '[models."m".price]\ninput = 1.0\noutput = 2.0'))).toBeUndefined();
  });

  it('still names a gateway where only SOME models are hand-priced', async () => {
    const toml = `
schema_version = 1
[native.gateways."acme"]
base_url = "https://acme.example/v1"
[models."priced"]
gateway = "acme"
id = "model-x"
context_window = 128000
[models."priced".price]
input = 1.0
output = 2.0
[models."bare"]
gateway = "acme"
id = "model-y"
context_window = 128000
`;
    const check = await pricingCheck(toml);
    expect(check).toBeDefined();
    expect(check!.detail).toContain('acme');
  });

  it('stays silent for a gateway that declares pricing_provider', async () => {
    expect(await pricingCheck(config('pricing_provider = ["openai"]'))).toBeUndefined();
  });

  it('says nothing about a gateway serving no models, which cannot spend', async () => {
    const toml = `
schema_version = 1
[native.gateways."unused"]
base_url = "https://unused.example/v1"
[models."m"]
harness = "codex"
id = "gpt-5.6-sol"
`;
    expect(await pricingCheck(toml)).toBeUndefined();
  });
});

describe('cmdDoctor — tier freshness honours avoid_gateways', () => {
  // The re-proposal compared against the saved `simple` used to be handed the
  // gateway names as `avoided`, and `avoided` is a set of MODEL KEYS — so
  // avoidance never applied and the advisory's demotion was invisible. The
  // observable consequence: a model on the avoided gateway leads the fresh
  // proposal's `simple`, and the preferred model reads as over-ceiling.
  // (Ordering inside the proposal is not directly visible through a check, so
  // this asserts the shape avoidance produces — the avoided model demoted off
  // the lead — through the advisory that reads the proposal.)
  const setup = (extra: string) => {
    const cwd = mkdtempSync(join(tmpdir(), 'doc-fresh-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-fresh-home-'));
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    // `bad-m` is dirt cheap and would anchor `simple`'s cost cap at 12x its
    // price; `good-m` is 20x dearer per task. Saved `simple` holds `good-m`.
    writeFileSync(join(home, '.config', 'sonata', 'catalog.json'), JSON.stringify({
      fetchedAt: '2026-09-25T00:00:00Z',
      models: {
        'bad-model': { intelligenceIndex: 30, blendedPriceUsd: 1, costPerTask: 0.01 },
        'good-model': { intelligenceIndex: 80, blendedPriceUsd: 1, costPerTask: 0.2 },
      },
    }));
    writeFileSync(join(cwd, 'sonata.toml'), `
${extra}
[models."bad-m"]
gateway = "bad-gw"
id = "bad-model"
context_window = 128000

[models."good-m"]
gateway = "good-gw"
id = "good-model"
context_window = 128000

[native.gateways."bad-gw"]
base_url = "https://bad.example/v1"

[native.gateways."good-gw"]
base_url = "https://good.example/v1"

[tiers.code]
simple = ["good-m"]
normal = ["good-m", "bad-m"]
complex = ["good-m"]
`);
    return { cwd, home };
  };

  it('reports a preferred model as over-cap while the avoided gateway sets the anchor', async () => {
    // Control case: with nothing avoided, `bad-m` leads and anchors the cap,
    // so `good-m` is flagged. This is what the bug produced even WITH
    // avoid_gateways — the case below shows the fix.
    const { cwd, home } = setup('');
    const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home });
    const fresh = checks.find((c) => c.name === 'tier freshness');
    expect(fresh?.detail).toContain('good-m');
  });

  it('demotes an avoided gateway\'s model so the preferred one anchors the cap', async () => {
    const { cwd, home } = setup('avoid_gateways = ["bad-gw"]');
    const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home });
    // The avoided model is demoted, `good-m` anchors at its own price, and
    // nothing the cap would exclude is left to report.
    expect(checks.find((c) => c.name === 'tier freshness')).toBeUndefined();
  });
});

describe('doctor survives an unreadable agent file', () => {
  // `outdatedAgents` deliberately propagates anything that is not ENOENT or
  // ENOTDIR, so an unreadable file is not silently treated as "not ours".
  // That is right for the function and wrong for the caller: unguarded, it
  // made `sonata doctor` reject outright — and doctor is the command you run
  // *when* the filesystem is in an odd state, so dying is the one thing it
  // must not do. Reported as a check, which loses nothing and keeps the other
  // twenty checks readable.
  it('reports the unreadable file instead of throwing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sonata-perm-home-'));
    const cwd = mkdtempSync(join(tmpdir(), 'sonata-perm-'));
    mkdirSync(join(cwd, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(cwd, 'sonata.toml'), [
      'schema_version = 1',
      '[models."m1"]', 'gateway = "gw"', 'id = "x-1"',
      '[native.gateways."gw"]', 'base_url = "https://example.test/v1"',
      '[tiers.code]', 'simple = ["m1"]', 'complex = ["m1"]',
    ].join('\n'));
    const agent = join(cwd, '.claude', 'agents', 'code-simple.md');
    writeFileSync(agent, 'x');
    chmodSync(agent, 0o000);
    try {
      const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home });
      // Whichever check notices first, the contract is the same: doctor
      // returns, says it could not read the file, and keeps every other check.
      const row = checks.find((c) => /could not be read/i.test(c.detail));
      expect(row, 'expected a check naming the unreadable file').toBeDefined();
      expect(row?.ok).toBe(false);
      expect(checks.length).toBeGreaterThan(5);
    } finally {
      chmodSync(agent, 0o600);
    }
  });
});

describe('doctor — text tool calls', () => {
  const row = (tenant: string | undefined, key: string, counts: { recovered: number; unparsed: number }): LedgerRow => ({
    ts: new Date().toISOString(), ms: 500, alias: 'sonata-code-normal', role: 'code', tier: 'normal',
    key, gateway: 'acme', upstream: 'litellm', status: 200, complete: true,
    tokens: { input: 10, output: 2, cacheRead: 0, cacheCreation: 0 }, price: { source: 'none' }, attempts: [], tenant,
    textToolCalls: counts,
  });

  it('fails naming the model when calls could not be recovered in the last 24h', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'doc-ttc-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-ttc-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), 'schema_version = 1\n');
    const tenant = projectTenant(cwd, home);
    appendRow(home, row(tenant, 'vendorz-mimo-v2.6-pro', { recovered: 2, unparsed: 1 }));
    const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home });
    const check = checks.find((c) => c.name === 'text tool calls');
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('vendorz-mimo-v2.6-pro');
    expect(check?.detail).toContain('1 unrecovered');
    expect(check?.detail).toContain('2 recovered');
  });

  it('reports recovered-only calls as information, not a failure', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'doc-ttc-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-ttc-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), 'schema_version = 1\n');
    appendRow(home, row(projectTenant(cwd, home), 'm', { recovered: 3, unparsed: 0 }));
    const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home });
    const check = checks.find((c) => c.name === 'text tool calls');
    expect(check?.ok).toBe(true);
    expect(check?.detail).toContain('3 recovered');
  });

  it('says nothing when no row has text tool calls', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'doc-ttc-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-ttc-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), 'schema_version = 1\n');
    const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home });
    expect(checks.some((c) => c.name === 'text tool calls')).toBe(false);
  });
});
