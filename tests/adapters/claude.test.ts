import { describe, expect, it } from 'vitest';
import { claudeAdapter } from '../../src/adapters/claude.js';
import { getAdapter } from '../../src/adapters/index.js';
import { KNOWN_HARNESSES } from '../../src/config.js';

const base = {
  modelId: 'deepseek-v4-flash',
  role: 'code',
  cwd: '/repo',
  runDir: '/repo/.sonata/runs/abc123',
  instructionsPath: '/repo/.sonata/runs/abc123/instructions.md',
};

describe('claudeAdapter.plan', () => {
  it('runs claude -p headless with the model id', () => {
    const plan = claudeAdapter.plan({ ...base, mode: 'acceptEdits' });

    expect(plan.script).toContain('claude -p');
    expect(plan.script).toContain('deepseek-v4-flash');
    expect(plan.interactive).toBe(false);
  });

  it('reads the task from the instructions file and writes the report and exit sentinel', () => {
    const plan = claudeAdapter.plan({ ...base, mode: 'acceptEdits' });

    expect(plan.script).toContain(`cat '${base.instructionsPath}'`);
    expect(plan.script).toContain(`'${base.runDir}/report.md'`);
    expect(plan.script).toContain(`echo $? > '${base.runDir}/exit'`);
  });

  it('preserves the native proxy environment', () => {
    const plan = claudeAdapter.plan({ ...base, mode: 'acceptEdits' });

    expect(plan.script).toContain('ANTHROPIC_BASE_URL');
    expect(plan.script).toContain('CLAUDE_CODE_MAX_CONTEXT_TOKENS');
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
