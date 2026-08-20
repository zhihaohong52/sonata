import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeAdapter } from '../../src/adapters/claude.js';
import { getAdapter } from '../../src/adapters/index.js';
import { KNOWN_HARNESSES } from '../../src/config.js';

function cwdWithNative(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'sonata-claude-adapter-'));
  writeFileSync(join(cwd, 'sonata.toml'), `
[models."claude-test"]
harness = "claude"
id = "deepseek-v4-flash"

[native.models."deepseek-v4-flash"]
gateway = "anexto"
id = "deepseek-v4-flash-0731"
context_window = 128000

[native.gateways."anexto"]
base_url = "https://bifrost.advai.net/v1"
`);
  const runDir = join(cwd, '.sonata/runs/abc123');
  mkdirSync(runDir, { recursive: true });
  return cwd;
}

const base = (() => {
  const cwd = cwdWithNative();
  return {
    modelId: 'deepseek-v4-flash',
    role: 'code',
    cwd,
    runDir: join(cwd, '.sonata/runs/abc123'),
    instructionsPath: join(cwd, '.sonata/runs/abc123/instructions.md'),
  };
})();

describe('claudeAdapter.plan', () => {
  it('runs claude -p headless with the model id', () => {
    const plan = claudeAdapter.plan({ ...base, mode: 'acceptEdits' });

    expect(plan.script).toContain('claude -p');
    expect(plan.script).toContain('deepseek-v4-flash');
    expect(plan.interactive).toBe(false);
  });

  it('reads the task from the instructions file, keeps report.md for the model', () => {
    const plan = claudeAdapter.plan({ ...base, mode: 'acceptEdits' });

    expect(plan.script).toContain(`cat '${base.instructionsPath}'`);
    // stdout goes to the fallback file, never report.md — the model writes
    // report.md itself, and two writers to one file corrupt it.
    expect(plan.script).toContain(`'${base.runDir}/last-message.txt'`);
    expect(plan.script).not.toContain(`> '${base.runDir}/report.md'`);
    expect(plan.script).not.toContain('tee');
    expect(plan.script).toContain(`echo $? > '${base.runDir}/exit'`);
    expect(claudeAdapter.fallbackReportFile).toBe('last-message.txt');
  });

  it('bakes the router URL from config into the script', () => {
    const plan = claudeAdapter.plan({ ...base, mode: 'acceptEdits' });

    expect(plan.script).toContain("ANTHROPIC_BASE_URL='http://localhost:4100'");
    expect(plan.script).toContain("CLAUDE_CODE_MAX_CONTEXT_TOKENS='128000'");
  });

  it('a read-only role restricts tools and cannot write a report', () => {
    const plan = claudeAdapter.plan({ ...base, role: 'explore', mode: 'acceptEdits' });

    expect(plan.script).toContain('--permission-mode plan');
    expect(plan.script).toContain('--allowedTools Read,Grep,Glob,Bash');
    expect(plan.canWriteReport).toBe(false);
  });

  it('can write a report for a write-capable role', () => {
    expect(claudeAdapter.plan({ ...base, mode: 'acceptEdits' }).canWriteReport).not.toBe(false);
  });
});

describe('claudeAdapter — approvals are not possible in headless mode', () => {
  it('is non-interactive and has no prompt patterns or answer keys', () => {
    expect(claudeAdapter.canPromptForApproval).toBe(false);
    expect(claudeAdapter.promptPatterns).toEqual([]);
    expect(claudeAdapter.describePrompt(['anything'])).toBeNull();
    expect(claudeAdapter.approveKeys).toEqual({ yes: [], no: [] });
  });
});

describe('claude adapter registration', () => {
  it('is registered and known', () => {
    expect(getAdapter('claude').name).toBe('claude');
    expect(KNOWN_HARNESSES).toContain('claude');
  });
});
