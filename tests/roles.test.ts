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

  it('includes role, repo context and task in that order', () => {
    expect(out.indexOf('ROLE_BODY')).toBeLessThan(out.indexOf('REPO_CONTEXT'));
    expect(out.indexOf('REPO_CONTEXT')).toBeLessThan(out.indexOf('TASK_TEXT'));
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
