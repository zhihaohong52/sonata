import { describe, it, expect } from 'vitest';
import { loadRole, composeInstructions } from '../src/roles.js';

describe('loadRole', () => {
  it('loads a known role', () => {
    expect(loadRole('code', 'roles')).toContain('smallest change');
  });

  it('throws a helpful error for an unknown role', () => {
    expect(() => loadRole('dance', 'roles')).toThrow(/no role prompt/i);
  });
});

describe('composeInstructions', () => {
  const out = composeInstructions({
    role: 'code',
    roleText: 'ROLE_BODY',
    repoContext: 'REPO_CONTEXT',
    task: 'TASK_TEXT',
    reportPath: '/tmp/run/report.md',
  });

  it('puts the task before repository context and restates it at the end', () => {
    expect(out.indexOf('ROLE_BODY')).toBeLessThan(out.indexOf('REPO_CONTEXT'));
    expect(out.indexOf('TASK_TEXT')).toBeLessThan(out.indexOf('REPO_CONTEXT'));
    expect(out.lastIndexOf('TASK_TEXT')).toBeGreaterThan(out.indexOf('## Reporting'));
  });

  it('instructs the agent to write the report as its final action', () => {
    expect(out).toContain('/tmp/run/report.md');
    expect(out).toMatch(/final action/i);
  });

  it('omits the repository context section when there is none', () => {
    const bare = composeInstructions({
      role: 'code', roleText: 'R', repoContext: '', task: 'T', reportPath: '/p',
    });
    expect(bare).not.toContain('## Repository context');
  });
});

/**
 * A read-only run cannot write report.md. Told to anyway, a codex run once read
 * 92k tokens of a codebase, did the work, and spent its final message
 * apologising — which the harness fallback captured instead of the findings.
 * The run was reported DONE and not degraded, so the loss was invisible.
 */
describe('composeInstructions — a run that cannot write a report', () => {
  const base = {
    role: 'explore',
    roleText: 'You explore.',
    repoContext: '',
    task: 'Find the thing.',
    reportPath: '/repo/.sonata/runs/abc123/report.md',
  };

  it('does not ask for a report file when one is impossible', () => {
    const out = composeInstructions({ ...base, canWriteReport: false });
    expect(out).not.toContain('/repo/.sonata/runs/abc123/report.md');
    expect(out).toContain('Your final message IS the report');
  });

  it('tells the model not to apologise for the sandbox', () => {
    const out = composeInstructions({ ...base, canWriteReport: false });
    expect(out).toMatch(/do not spend your\s*\n?final message explaining that you could not/i);
  });

  it('still asks for the report file when one is possible', () => {
    for (const input of [{ ...base, canWriteReport: true }, base]) {
      const out = composeInstructions(input);
      expect(out).toContain('/repo/.sonata/runs/abc123/report.md');
      expect(out).toContain('write a short report');
    }
  });

  it('keeps the task first in both branches', () => {
    for (const canWriteReport of [true, false]) {
      const out = composeInstructions({ ...base, canWriteReport });
      expect(out.indexOf('## Task')).toBeLessThan(out.indexOf('## Reporting'));
    }
  });
});

/**
 * Reasonix loads the working directory's .mcp.json, so in a repo where sonata
 * is registered a dispatched model receives sonata's own dispatch/wait/approve
 * tools and can start further runs. No harness offers a per-run way to withhold
 * them, so the instructions say it outright. Mitigation, not enforcement.
 */
describe('composeInstructions — inherited sonata tools', () => {
  const base = {
    role: 'code',
    roleText: 'You code.',
    repoContext: '',
    task: 'Do the thing.',
    reportPath: '/repo/.sonata/runs/abc123/report.md',
  };

  it('forbids dispatching when the tools are inherited', () => {
    const out = composeInstructions({ ...base, inheritedSonataTools: true });
    expect(out).toContain('## Do not dispatch');
    expect(out).toContain('You are');
    expect(out).toMatch(/already one of those runs/);
  });

  it('says nothing about it when the tools are not there', () => {
    for (const input of [base, { ...base, inheritedSonataTools: false }]) {
      expect(composeInstructions(input)).not.toContain('## Do not dispatch');
    }
  });

  it('still puts the task before the warning', () => {
    const out = composeInstructions({ ...base, inheritedSonataTools: true });
    expect(out.indexOf('## Task')).toBeLessThan(out.indexOf('## Do not dispatch'));
  });
});
