import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

  it('maps the explore role to the explore agent', () => {
    const p = openCodeAdapter.plan({ ...base, role: 'explore', mode: 'acceptEdits' });
    expect(p.script).toContain('--agent explore');
  });

  it('uses the read-only plan agent for the plan role', () => {
    const p = openCodeAdapter.plan({ ...base, role: 'plan', mode: 'acceptEdits' });
    expect(p.script).toContain('--agent plan');
  });

  it('never passes --auto for a read-only role even in bypassPermissions', () => {
    for (const role of ['review', 'explore', 'plan']) {
      const p = openCodeAdapter.plan({ ...base, role, mode: 'bypassPermissions' });
      expect(p.script).not.toContain('--auto');
    }
  });

  it('streams via --interactive without claiming approvals can surface', () => {
    // `--interactive` picks opencode's split-footer renderer so the pane shows
    // the run as it happens. It does not make the run answerable — opencode
    // auto-rejects permission requests in `run` mode regardless.
    const p = openCodeAdapter.plan({ ...base, mode: 'acceptEdits' });
    expect(p.script).toContain('--interactive');
    expect(p.interactive).toBe(false);
  });

  it('refuses default mode rather than running a write-capable role ungated', () => {
    // opencode cannot ask, so honouring "ask me first" is impossible. Running
    // anyway would exceed the permissions of the session that dispatched it.
    expect(() => openCodeAdapter.plan({ ...base, mode: 'default' }))
      .toThrow(/cannot ask for approval/i);
  });

  it('still allows default mode for read-only roles, which never need to ask', () => {
    for (const role of ['review', 'explore', 'plan']) {
      const p = openCodeAdapter.plan({ ...base, role, mode: 'default' });
      expect(p.script).not.toContain('--auto');
    }
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

/**
 * `opencode run` has no approval UI. Probed against opencode 1.18 with
 * `--interactive` and `permission = { bash = "ask" }`, a call needing approval
 * is auto-rejected rather than offered. These tests pin that limitation so it
 * is not quietly "fixed" back into a prompt pattern that never fires.
 */
describe('openCodeAdapter — approvals are not possible in run mode', () => {
  it('never reports a pending prompt, even on a real auto-reject', () => {
    const captured = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../fixtures/panes/opencode-auto-reject.txt'),
      'utf8',
    ).split('\n');
    expect(openCodeAdapter.describePrompt(captured)).toBeNull();
  });

  it('returns null when nothing is pending', () => {
    expect(openCodeAdapter.describePrompt(['reading src/a.ts'])).toBeNull();
  });

  it('offers no keys to answer with', () => {
    expect(openCodeAdapter.approveKeys.yes).toEqual([]);
    expect(openCodeAdapter.approveKeys.no).toEqual([]);
  });

  it('never claims a plan is interactive, in any mode it will run', () => {
    for (const mode of ['plan', 'acceptEdits', 'bypassPermissions'] as const) {
      expect(openCodeAdapter.plan({ ...base, mode }).interactive).toBe(false);
    }
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
