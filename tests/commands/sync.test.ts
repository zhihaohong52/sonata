import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentMarkdown, cmdSync, nativeAgentMarkdown, tierAgentMarkdown, TIER_AGENT_MARKER } from '../../src/commands/sync.js';

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'sonata-sync-'));
  writeFileSync(join(cwd, 'sonata.toml'), `
[models.deepseek-v4-flash]
harness = "opencode"
id = "opencode-go/deepseek-v4-flash"

[models.kimi-k3]
harness = "opencode"
id = "opencode-go/kimi-k3"

[generate.roles]
review = ["deepseek-v4-flash", "kimi-k3"]
code = ["deepseek-v4-flash", "kimi-k3"]
`);
});

describe('agentMarkdown', () => {
  const md = agentMarkdown({ role: 'code', model: 'deepseek-v4-flash', harness: 'opencode' });

  it('declares a cheap tool-only wrapper', () => {
    expect(md).toContain('name: code-deepseek-v4-flash');
    expect(md).toContain('model: haiku');
    expect(md).toContain('tools: Bash(sonata dispatch:*), Bash(sonata wait:*), Bash(sonata approve:*)');
  });

  it('grants only the three sonata Bash commands', () => {
    expect(md).toContain('tools: Bash(sonata dispatch:*), Bash(sonata wait:*), Bash(sonata approve:*)');
    expect(md).not.toContain('sonata run --role');
  });

  it('forbids the wrapper doing work of its own', () => {
    expect(md).toMatch(/do not (read|inspect|edit)/i);
  });

  it('requires verbatim task forwarding via --task-file or --task-stdin, never inline shell text', () => {
    expect(md).toMatch(/verbatim, byte for byte/i);
    expect(md).toContain('sonata dispatch --model deepseek-v4-flash --role code --task-file <path>');
    expect(md).toContain("--task-stdin <<< '");
    expect(md).not.toContain("printf '%s'");
    expect(md).not.toContain(' | sonata dispatch');
    expect(md).not.toContain("<<'SONATA_TASK");
    expect(md).not.toContain('<<"$DELIM"');
    expect(md).not.toContain('DELIM="SONATA_TASK_$(');
  });

  it('documents the single-quote escaping transformation with the worked example', () => {
    // The worked example must appear with the shell single-quote sequence
    // (backslash-escaped) intact, not mangled by JS template-literal quoting
    // in a future edit.
    expect(md).toContain("it'\\''s done");
    expect(md).toContain("`'\\''`");
  });

  it('documents the PAUSED and STALLED handling', () => {
    expect(md).toContain('PAUSED');
    expect(md).toContain('STALLED');
  });
});

describe('agentMarkdown — tool grant', () => {
  const md = () => agentMarkdown({ role: 'code', model: 'm', harness: 'opencode' });

  it('grants only the three sonata commands', () => {
    expect(md()).toContain(
      'tools: Bash(sonata dispatch:*), Bash(sonata wait:*), Bash(sonata approve:*)');
  });

  it('does not grant unrelated Bash commands', () => {
    expect(md()).not.toContain('Bash(ls:*)');
    expect(md()).not.toContain('Bash(sonata run:*)');
  });

  it('tells the wrapper to run only the sonata commands', () => {
    expect(md()).not.toContain('sonata run --role');
  });
});

describe('agentMarkdown — one-call dispatch', () => {
  const md = agentMarkdown({ role: 'code', model: 'm', harness: 'opencode' });

  it('grants the three commands the wrapper runs', () => {
    expect(md).toContain('tools: Bash(sonata dispatch:*), Bash(sonata wait:*), Bash(sonata approve:*)');
  });

  it('never tells the wrapper to poll', () => {
    expect(md).not.toMatch(/\bpoll\b/i);
    expect(md).not.toContain('`tail`');
  });

  it('tells it to resume with sonata wait after a RUNNING result', () => {
    expect(md).toContain('RUNNING');
    expect(md).toContain('sonata wait <id>');
  });

  it('still forbids doing the work itself', () => {
    expect(md).toContain('You do no work of your own.');
  });
});

describe('nativeAgentMarkdown', () => {
  it('generates a native agent with the model id in frontmatter and no dispatch tools', () => {
    const md = nativeAgentMarkdown({ role: 'code', model: 'deepseek-v4-flash' });
    expect(md).toMatch(/^name: native-code-deepseek-v4-flash$/m);
    expect(md).toMatch(/^model: deepseek-v4-flash$/m);
    expect(md).not.toMatch(/mcp__legacy__/);
    expect(md).not.toMatch(/forwarding wrapper/);
    expect(md).toContain('sonata code');
  });

  it('gives a read-only native role read and fan-out tools with the delegation guard', () => {
    const md = nativeAgentMarkdown({ role: 'explore', model: 'deepseek-v4-flash' });
    expect(md).toMatch(/^tools: Read, Grep, Glob, Agent, Task, Workflow$/m);
    expect(md).toContain('## Delegating');
  });

  it('leaves a write-capable native role unrestricted without the delegation guard', () => {
    // A write-capable role has no `tools:` line at all, so it already inherits
    // fan-out. The guard is addressed to roles that must not delegate writes,
    // and adding it here would be advice about a constraint that is not theirs.
    const md = nativeAgentMarkdown({ role: 'code', model: 'deepseek-v4-flash' });
    expect(md).not.toMatch(/^tools:/m);
    expect(md).not.toContain('## Delegating');
  });
});

describe('tierAgentMarkdown', () => {
  it('generates a normal agent when the role has one', () => {
    const md = tierAgentMarkdown({ role: 'code', tier: 'normal' });
    expect(md).toMatch(/^name: code-normal$/m);
    expect(md).toMatch(/^model: sonata-code-normal$/m);
  });

  it('names normal the default and never tells the reader to default upward', () => {
    const md = tierAgentMarkdown({ role: 'code', tier: 'normal' });
    const description = /^description: (.+)$/m.exec(md)?.[1] ?? '';
    expect(description).toContain('default');
    for (const tier of ['simple', 'normal', 'complex'] as const) {
      const d = /^description: (.+)$/m.exec(tierAgentMarkdown({ role: 'code', tier }))?.[1] ?? '';
      expect(d).not.toContain('When unsure, use -complex');
      expect(d).not.toContain(': ');
    }
  });

  it('says size is not difficulty, and names the default in the body', () => {
    // Asserted on wording unique to the body's own block. The phrase alone
    // appears in the description too, so a test matching only that stayed
    // green when the body copy was mutated — reported by the agent that
    // wrote it rather than left to be discovered.
    const body = tierAgentMarkdown({ role: 'code', tier: 'normal' }).split('---')[2] ?? '';
    expect(body).toContain('A large mechanical change is `simple`; a three-line');
    expect(body).toContain('`-normal` — the default. You know what to change, not exactly how.');
    expect(body).toContain('A task\nthat fails review is re-run one tier up');
  });

  it('gives a read-only tier agent read and fan-out tools', () => {
    // `tools:` is an allow-list: omitting the agent tools from a read-only
    // role's line is what removes the capability, so granting fan-out has to
    // be explicit here even though a write-capable role gets it for free.
    const md = tierAgentMarkdown({ role: 'explore' });
    expect(md).toMatch(/^tools: Read, Grep, Glob, Agent, Task, Workflow$/m);
  });

  it('warns against a model argument in both the description and the body', () => {
    // The description is what the *dispatching* model reads while choosing an
    // agent; by the time the body is in context the override has happened. So
    // both placements are asserted, on both generators that pin a model — a
    // native agent's frontmatter is overridden just as silently as a tier
    // agent's, and nothing else here would fail if its warning were dropped.
    for (const md of [
      tierAgentMarkdown({ role: 'code', tier: 'complex' }),
      nativeAgentMarkdown({ role: 'code', model: 'flash' }),
    ]) {
      const description = /^description: (.+)$/m.exec(md)?.[1] ?? '';
      expect(description).toContain('no `model` argument');
      expect(md.split('---')[2]).toContain('no `model` argument');
    }
  });

  it('keeps the description a plain YAML scalar', () => {
    // Claude Code parses the frontmatter as YAML, where ": " inside an
    // unquoted scalar is a mapping, not text — so the warning cannot be
    // punctuated with a colon however naturally it reads.
    for (const md of [
      tierAgentMarkdown({ role: 'code', tier: 'simple' }),
      tierAgentMarkdown({ role: 'explore' }),
      nativeAgentMarkdown({ role: 'code', model: 'flash' }),
    ]) {
      const description = /^description: (.+)$/m.exec(md)?.[1] ?? '';
      expect(description).not.toBe('');
      expect(description).not.toContain(': ');
      expect(description.startsWith('`')).toBe(false);
    }
  });

  it('tells a write-capable tier agent to fan out inside the lane', () => {
    // The gap this closes: the delegation guard sat only on read-only roles,
    // so `code-complex` — the agent most able to fan out — was told nothing,
    // and one called Claude's own `Plan` (2026-09-16), ending the lane.
    const md = tierAgentMarkdown({ role: 'code', tier: 'complex' });
    expect(md).toContain('## Fanning out');
    expect(md).toContain('plan-normal');
    expect(md).not.toContain('## Delegating');
  });

  it('lets complex delegate to the two tiers below it, and not to its own', () => {
    const md = tierAgentMarkdown({ role: 'review', tier: 'complex' });
    expect(md).toContain('`*-simple`');
    expect(md).toContain('`*-normal`');
    // The measured failure: one review-complex spawned 8 more review-complex
    // agents, whose leaves exhausted a $200 gateway cap.
    expect(md).toContain('Never your own tier (`*-complex`)');
    expect(md).toContain('plan-simple');
    expect(md).toContain('plan-normal');
    expect(md).not.toContain('`plan-complex`');
  });

  it('lets normal delegate only to simple', () => {
    const md = tierAgentMarkdown({ role: 'review', tier: 'normal' });
    expect(md).toContain('`*-simple`');
    expect(md).not.toContain('`*-normal` agents');
    expect(md).toContain('Never your own tier (`*-normal`)');
    expect(md).toContain('`plan-simple`');
    expect(md).not.toContain('`plan-normal`');
  });

  it('makes the cheapest tier a leaf', () => {
    const md = tierAgentMarkdown({ role: 'review', tier: 'simple' });
    expect(md).toContain('Do not spawn another sonata tier agent');
    expect(md).toContain('nothing below you to delegate to');
    expect(md).not.toContain('Delegate downward only');
  });

  it('makes a collapsed agent a leaf, since every tier resolves the same', () => {
    // A collapsed agent is generated only when the role's tier lists are
    // element-wise identical, so delegating buys the same models for the
    // price of a subagent. Being a leaf is also what makes it safe to call.
    const md = tierAgentMarkdown({ role: 'review' });
    expect(md).toContain('Do not spawn another sonata tier agent');
    expect(md).toContain('resolves to the same ranked models');
  });

  it('never names a tier the role does not define', () => {
    // `normal` is optional so existing configs need no migration, and this
    // repository's own sonata.toml is exactly this shape. Naming `*-normal`
    // here points the delegation at an alias `resolveTierAlias` refuses and
    // `cmdSync` never wrote — silent at generation, dead at dispatch.
    const md = tierAgentMarkdown({
      role: 'code',
      tier: 'complex',
      availableTiers: ['simple', 'complex'],
      planTiers: ['simple', 'complex'],
    });
    expect(md).toContain('`*-simple`');
    expect(md).not.toContain('`*-normal`');
    expect(md).not.toContain('`plan-normal`');
    expect(md).toContain('`plan-simple`');
  });

  it('becomes a leaf when no defined tier sits below it', () => {
    const md = tierAgentMarkdown({ role: 'code', tier: 'complex', availableTiers: ['complex'] });
    expect(md).toContain('Do not spawn another sonata tier agent');
    expect(md).not.toContain('Delegate downward only');
  });

  it('caps fan-out width as well as depth', () => {
    // The descent alone still allowed 12 siblings from one node, which is
    // what the measured review-complex actually did (8 same-tier + 4 claude).
    for (const tier of ['simple', 'normal', 'complex'] as const) {
      const md = tierAgentMarkdown({ role: 'code', tier });
      expect(md).toContain('**Spawn at most 3 subagents in your entire run**');
      expect(md).toContain('if it does not fit in 3 agents, it does not fit');
    }
  });

  it('tells a reviewer to narrow scope and name its gaps', () => {
    const md = tierAgentMarkdown({ role: 'review', tier: 'complex' });
    expect(md).toContain('## Scoping the review');
    expect(md).toContain('do not grow to fill the request');
    expect(md).toContain('state plainly which you did not cover');
    expect(md).toContain('Anything a `grep` answers is not a review question');
  });

  it('scopes only the review role', () => {
    for (const role of ['code', 'explore', 'plan']) {
      expect(tierAgentMarkdown({ role, tier: 'complex' })).not.toContain('## Scoping the review');
    }
  });

  it('names no plan agent when none sits below the tier', () => {
    const md = tierAgentMarkdown({ role: 'code', tier: 'normal', planTiers: ['complex'] });
    expect(md).toContain('No plan agent sits below your tier');
  });

  it('keeps a collapsed plan role reachable from any tier', () => {
    // A collapsed `plan` is a leaf, so calling it cannot extend the chain.
    const md = tierAgentMarkdown({ role: 'code', tier: 'normal', planTiers: [] });
    expect(md).toContain('`plan`');
    expect(md).not.toContain('No plan agent sits below your tier');
  });

  it('keeps the read-only delegation guard alongside the fan-out rule', () => {
    const md = tierAgentMarkdown({ role: 'explore' });
    expect(md).toContain('## Fanning out');
    expect(md).toContain('## Delegating');
  });

  it('leaves a write-capable tier agent unrestricted', () => {
    const md = tierAgentMarkdown({ role: 'code', tier: 'simple' });
    expect(md).not.toMatch(/^tools:/m);
  });

  it('adds the delegation guard to a read-only tier agent', () => {
    const md = tierAgentMarkdown({ role: 'explore' });
    expect(md).toContain('## Delegating');
  });

  it('does not add the delegation guard to a write-capable tier agent', () => {
    const md = tierAgentMarkdown({ role: 'code', tier: 'simple' });
    expect(md).not.toContain('## Delegating');
  });
});

describe('cmdSync', () => {
  it('writes one agent file per role x model pair', () => {
    const agentsDir = join(cwd, '.claude', 'agents');
    const written = cmdSync({ cwd, agentsDir }).written;
    expect(written).toHaveLength(4);
    expect(written.map((p) => p.split('/').pop()).sort()).toEqual([
      'code-deepseek-v4-flash.md',
      'code-kimi-k3.md',
      'review-deepseek-v4-flash.md',
      'review-kimi-k3.md',
    ]);
    // The wrapper must name its own role and model; the exact sentence around
    // them is prose and changes, so assert the facts rather than the wording.
    const body = readFileSync(join(agentsDir, 'code-kimi-k3.md'), 'utf8');
    expect(body).toContain('--model kimi-k3');
    expect(body).toContain('--role code');
  });

  it('writes explore and plan agent files', () => {
    writeFileSync(join(cwd, 'sonata.toml'), `
[models.deepseek-v4-flash]
harness = "opencode"
id = "opencode-go/deepseek-v4-flash"

[generate.roles]
explore = ["deepseek-v4-flash"]
plan = ["deepseek-v4-flash"]
`);
    const agentsDir = join(cwd, '.claude', 'agents');
    const written = cmdSync({ cwd, agentsDir }).written;
    expect(written.map((p) => p.split('/').pop()).sort()).toEqual([
      'explore-deepseek-v4-flash.md',
      'plan-deepseek-v4-flash.md',
    ]);
  });

  it('writes native-<role>-<model>.md alongside wrapper agents', () => {
    writeFileSync(join(cwd, 'sonata.toml'), `
[models."deepseek-v4-flash"]
harness = "opencode"
id = "opencode-go/deepseek-v4-flash"

[generate.roles]
code = ["deepseek-v4-flash"]

[native.models."native-deepseek"]
gateway = "gateway"
id = "deepseek-v4-flash"
context_window = 128000

[native.gateways."gateway"]
base_url = "https://gateway.example/v1"

[generate.native]
code = ["native-deepseek"]
`);
    const agentsDir = join(cwd, '.claude', 'agents');
    const res = cmdSync({ cwd, agentsDir });
    expect(res.written.some((p) => p.endsWith('native-code-native-deepseek.md'))).toBe(true);
    expect(existsSync(join(agentsDir, 'code-deepseek-v4-flash.md'))).toBe(true);
  });
});

describe('cmdSync — machine config', () => {
  it('generates from the machine config when the repo has none', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'sync-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'sync-home-'));
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(join(home, '.config', 'sonata', 'sonata.toml'), `
[models."m"]
harness = "codex"
id = "gpt-5.6-sol"

[generate.roles]
code = ["m"]
`);

    const agentsDir = join(home, '.claude', 'agents');
    const written = cmdSync({ cwd, home, agentsDir }).written;

    expect(written).toHaveLength(1);
    expect(existsSync(join(agentsDir, 'code-m.md'))).toBe(true);
  });
});

describe('cmdSync — per-role models and staleness', () => {
  it('writes only the agents the roles ask for', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'sync-roles-'));
    writeFileSync(join(cwd, 'sonata.toml'), `
[models."a"]
harness = "codex"
id = "gpt-5.6-sol"

[models."b"]
harness = "codex"
id = "gpt-5.6-terra"

[generate.roles]
code = ["a"]
review = ["a", "b"]
`);
    const agentsDir = join(cwd, '.claude', 'agents');
    const res = cmdSync({ cwd, agentsDir });

    expect(res.written).toHaveLength(3);
    expect(existsSync(join(agentsDir, 'code-a.md'))).toBe(true);
    expect(existsSync(join(agentsDir, 'review-b.md'))).toBe(true);
    // code did not ask for b
    expect(existsSync(join(agentsDir, 'code-b.md'))).toBe(false);
  });

  it('reports stale agents without deleting them', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'sync-stale-'));
    writeFileSync(join(cwd, 'sonata.toml'), `
[models."a"]
harness = "codex"
id = "gpt-5.6-sol"

[generate.roles]
code = ["a"]
`);
    const agentsDir = join(cwd, '.claude', 'agents');
    cmdSync({ cwd, agentsDir });
    // An agent sonata wrote earlier, for a model no longer configured.
    writeFileSync(join(agentsDir, 'code-gone.md'),
      'forwarding wrapper around the sonata runtime');

    const res = cmdSync({ cwd, agentsDir });
    expect(res.stale).toEqual(['code-gone.md']);
    // Reported, not removed — the caller decides.
    expect(existsSync(join(agentsDir, 'code-gone.md'))).toBe(true);
  });

  it('never reports an agent sonata did not write', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'sync-foreign-'));
    writeFileSync(join(cwd, 'sonata.toml'), `
[models."a"]
harness = "codex"
id = "gpt-5.6-sol"

[generate.roles]
code = ["a"]
`);
    const agentsDir = join(cwd, '.claude', 'agents');
    cmdSync({ cwd, agentsDir });
    writeFileSync(join(agentsDir, 'my-own-agent.md'), 'hand written, not sonata');

    expect(cmdSync({ cwd, agentsDir }).stale).toEqual([]);
  });
});

describe('cmdSync — tier agents', () => {
  it('skips normal when a role has no normal tier', () => {
    writeFileSync(join(cwd, 'sonata.toml'), `
[models."simple-model"]
gateway = "gateway"
id = "simple"

[models."complex-model"]
gateway = "gateway"
id = "complex"

[native.gateways."gateway"]
base_url = "https://gateway.example/v1"

[tiers.code]
simple = ["simple-model"]
complex = ["complex-model"]
`);
    const agentsDir = join(cwd, '.claude', 'agents');
    const res = cmdSync({ cwd, agentsDir });
    expect(res.written.map((p) => p.split('/').pop()).sort()).toEqual([
      'code-complex.md',
      'code-simple.md',
    ]);
    expect(existsSync(join(agentsDir, 'code-normal.md'))).toBe(false);
  });

  it('writes normal when a role has a distinct normal tier', () => {
    writeFileSync(join(cwd, 'sonata.toml'), `
[models."simple-model"]
gateway = "gateway"
id = "simple"

[models."normal-model"]
gateway = "gateway"
id = "normal"

[models."complex-model"]
gateway = "gateway"
id = "complex"

[native.gateways."gateway"]
base_url = "https://gateway.example/v1"

[tiers.code]
simple = ["simple-model"]
normal = ["normal-model"]
complex = ["complex-model"]
`);
    const agentsDir = join(cwd, '.claude', 'agents');
    const res = cmdSync({ cwd, agentsDir });
    expect(res.written.map((p) => p.split('/').pop()).sort()).toEqual([
      'code-complex.md',
      'code-normal.md',
      'code-simple.md',
    ]);
    expect(readFileSync(join(agentsDir, 'code-normal.md'), 'utf8')).toContain('model: sonata-code-normal');
  });

  it('writes one agent per distinct tier and collapses identical tier lists', () => {
    writeFileSync(join(cwd, 'sonata.toml'), `
[models."simple-model"]
gateway = "gateway"
id = "simple"

[models."complex-model"]
gateway = "gateway"
id = "complex"

[native.gateways."gateway"]
base_url = "https://gateway.example/v1"

[tiers.code]
simple = ["simple-model"]
complex = ["complex-model"]

[tiers.explore]
simple = ["simple-model"]
complex = ["simple-model"]
`);
    const agentsDir = join(cwd, '.claude', 'agents');
    const res = cmdSync({ cwd, agentsDir });
    expect(res.written.map((p) => p.split('/').pop()).sort()).toEqual([
      'code-complex.md',
      'code-simple.md',
      'explore.md',
    ]);
    expect(readFileSync(join(agentsDir, 'code-simple.md'), 'utf8')).toContain('model: sonata-code-simple');
    expect(readFileSync(join(agentsDir, 'code-simple.md'), 'utf8')).toContain(TIER_AGENT_MARKER);
    expect(readFileSync(join(agentsDir, 'code-complex.md'), 'utf8')).toContain('model: sonata-code-complex');
    const explore = readFileSync(join(agentsDir, 'explore.md'), 'utf8');
    expect(explore).toContain('model: sonata-explore');
    expect(explore).toMatch(/^tools: Read, Grep, Glob, Agent, Task, Workflow$/m);
    expect(existsSync(join(agentsDir, 'code-simple-model.md'))).toBe(false);
    expect(existsSync(join(agentsDir, 'native-code-simple-model.md'))).toBe(false);
  });

  it('does not overwrite a custom tier agent, but overwrites a sonata tier agent', () => {
    const agentsDir = join(cwd, '.claude', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(cwd, 'sonata.toml'), `
[models."simple-model"]
gateway = "gateway"
id = "simple"

[native.gateways."gateway"]
base_url = "https://gateway.example/v1"

[tiers.code]
simple = ["simple-model"]
complex = ["simple-model"]
`);
    const path = join(agentsDir, 'code.md');
    const custom = '---\\nname: code\\ndescription: custom\\n---\\ncustom body\\n';
    writeFileSync(path, custom);

    const skipped = cmdSync({ cwd, agentsDir });
    expect(readFileSync(path, 'utf8')).toBe(custom);
    expect(skipped.skipped).toEqual([path]);
    expect(skipped.written).not.toContain(path);

    writeFileSync(path, tierAgentMarkdown({ role: 'code' }));
    const overwritten = cmdSync({ cwd, agentsDir });
    expect(overwritten.written).toContain(path);
    expect(overwritten.skipped).not.toContain(path);
    expect(readFileSync(path, 'utf8')).toContain('model: sonata-code');
  });

  it('reports superseded legacy agents as stale', () => {
    const agentsDir = join(cwd, '.claude', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'code-old.md'), 'forwarding wrapper around the sonata runtime');
    writeFileSync(join(cwd, 'sonata.toml'), `
[models."simple-model"]
gateway = "gateway"
id = "simple"

[native.gateways."gateway"]
base_url = "https://gateway.example/v1"

[tiers.code]
simple = ["simple-model"]
complex = ["simple-model"]
`);
    const res = cmdSync({ cwd, agentsDir });
    expect(res.written.map((p) => p.split('/').pop())).toEqual(['code.md']);
    expect(res.stale).toEqual(['code-old.md']);
  });

  it('keeps generating legacy agents when tiers are absent', () => {
    const agentsDir = join(cwd, '.claude', 'agents');
    const res = cmdSync({ cwd, agentsDir });
    expect(res.written.map((p) => p.split('/').pop()).sort()).toEqual([
      'code-deepseek-v4-flash.md',
      'code-kimi-k3.md',
      'review-deepseek-v4-flash.md',
      'review-kimi-k3.md',
    ]);
  });
});
