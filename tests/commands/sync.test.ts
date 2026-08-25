import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentMarkdown, cmdSync, nativeAgentMarkdown } from '../../src/commands/sync.js';

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
    expect(md).toContain('DELIM="SONATA_TASK_$(');
    expect(md).toContain('<<"$DELIM"');
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

  it('restricts a read-only native role to read tools', () => {
    const md = nativeAgentMarkdown({ role: 'explore', model: 'deepseek-v4-flash' });
    expect(md).toMatch(/^tools: Read, Grep, Glob$/m);
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
    expect(readFileSync(join(agentsDir, 'code-complex.md'), 'utf8')).toContain('model: sonata-code-complex');
    const explore = readFileSync(join(agentsDir, 'explore.md'), 'utf8');
    expect(explore).toContain('model: sonata-explore');
    expect(explore).toMatch(/^tools: Read, Grep, Glob$/m);
    expect(existsSync(join(agentsDir, 'code-simple-model.md'))).toBe(false);
    expect(existsSync(join(agentsDir, 'native-code-simple-model.md'))).toBe(false);
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
