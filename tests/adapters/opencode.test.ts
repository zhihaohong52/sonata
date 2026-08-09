import { describe, it, expect } from 'vitest';
import { openCodeAdapter } from '../../src/adapters/opencode.js';
import { getAdapter } from '../../src/adapters/index.js';

const base = {
  modelId: 'deepseek-v4-flash',
  role: 'code',
  cwd: '/repo',
  runDir: '/repo/.sonata/runs/abc123',
  instructionsPath: '/repo/.sonata/runs/abc123/instructions.md',
};

describe('openCodeAdapter.plan', () => {
  it('uses non-interactive run with --auto for acceptEdits', () => {
    const p = openCodeAdapter.plan({ ...base, mode: 'acceptEdits' });
    expect(p.interactive).toBe(false);
    expect(p.script).toContain('opencode run');
    expect(p.script).toContain('--auto');
    expect(p.script).toContain('--agent build');
    expect(p.script).toContain('-m opencode/deepseek-v4-flash');
  });

  it('never passes --format json, which is broken upstream', () => {
    const p = openCodeAdapter.plan({ ...base, mode: 'bypassPermissions' });
    expect(p.script).not.toContain('--format json');
  });

  it('uses the read-only plan agent and no --auto in plan mode', () => {
    const p = openCodeAdapter.plan({ ...base, mode: 'plan' });
    expect(p.script).toContain('--agent plan');
    expect(p.script).not.toContain('--auto');
  });

  it('uses the read-only plan agent for the review role', () => {
    const p = openCodeAdapter.plan({ ...base, role: 'review', mode: 'acceptEdits' });
    expect(p.script).toContain('--agent plan');
  });

  it('runs interactively in default mode so approvals can surface', () => {
    const p = openCodeAdapter.plan({ ...base, mode: 'default' });
    expect(p.interactive).toBe(true);
    expect(p.script).toContain('--interactive');
    expect(p.script).not.toContain('--auto');
  });

  it('prepends the opencode bin dir, which is not on PATH', () => {
    const p = openCodeAdapter.plan({ ...base, mode: 'acceptEdits' });
    expect(p.script).toContain('$HOME/.opencode/bin');
  });

  it('writes the exit sentinel and enables pipefail', () => {
    const p = openCodeAdapter.plan({ ...base, mode: 'acceptEdits' });
    expect(p.script).toContain('set -o pipefail');
    expect(p.script).toContain(`echo $? > '${base.runDir}/exit'`);
  });

  it('attaches instructions as a file rather than interpolating them', () => {
    const p = openCodeAdapter.plan({ ...base, mode: 'acceptEdits' });
    expect(p.script).toContain(`-f '${base.instructionsPath}'`);
  });

  it('puts the message before -f, which greedily consumes positionals', () => {
    const p = openCodeAdapter.plan({ ...base, mode: 'acceptEdits' });
    expect(p.script.indexOf("'Follow the attached instructions.'"))
      .toBeLessThan(p.script.indexOf('-f '));
  });
});

describe('openCodeAdapter.describePrompt', () => {
  it('detects an approval request', () => {
    const lines = ['> build · deepseek-v4-flash', 'Allow bash to run rm -rf build? (y/n)'];
    expect(openCodeAdapter.describePrompt(lines)).toContain('rm -rf build');
  });

  it('returns null when nothing is pending', () => {
    expect(openCodeAdapter.describePrompt(['reading src/a.ts'])).toBeNull();
  });
});

describe('getAdapter', () => {
  it('resolves opencode', () => {
    expect(getAdapter('opencode').name).toBe('opencode');
  });

  it('throws for an unknown harness', () => {
    expect(() => getAdapter('nope')).toThrow(/unknown harness/i);
  });
});
