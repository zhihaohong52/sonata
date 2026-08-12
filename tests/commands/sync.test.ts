import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentMarkdown, cmdSync } from '../../src/commands/sync.js';

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

  it('declares a cheap Bash-only wrapper', () => {
    expect(md).toContain('name: code-deepseek-v4-flash');
    expect(md).toContain('model: haiku');
    expect(md).toContain('tools: Bash');
  });

  it('names the exact run command', () => {
    expect(md).toContain('sonata run --role code --model deepseek-v4-flash');
  });

  it('forbids the wrapper doing work of its own', () => {
    expect(md).toMatch(/do not (read|inspect|edit)/i);
  });

  it('documents the PAUSED and STALLED handling', () => {
    expect(md).toContain('PAUSED');
    expect(md).toContain('STALLED');
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
    expect(readFileSync(join(agentsDir, 'code-kimi-k3.md'), 'utf8')).toContain('--model kimi-k3');
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
