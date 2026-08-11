import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
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

[generate]
roles = ["review", "code"]
models = ["deepseek-v4-flash", "kimi-k3"]
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
    const written = cmdSync({ cwd, agentsDir });
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

[generate]
roles = ["explore", "plan"]
models = ["deepseek-v4-flash"]
`);
    const agentsDir = join(cwd, '.claude', 'agents');
    const written = cmdSync({ cwd, agentsDir });
    expect(written.map((p) => p.split('/').pop()).sort()).toEqual([
      'explore-deepseek-v4-flash.md',
      'plan-deepseek-v4-flash.md',
    ]);
  });
});
