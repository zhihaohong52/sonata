import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openCodeAdapter } from '../../src/adapters/opencode.js';
import { getAdapter } from '../../src/adapters/index.js';

const base = {
  modelId: 'openrouter/deepseek-v4-flash',
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
    expect(p.script).toContain('-m openrouter/deepseek-v4-flash');
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

  it('maps the explore role to plan, the only read-only primary agent', () => {
    const p = openCodeAdapter.plan({ ...base, role: 'explore', mode: 'acceptEdits' });
    expect(p.script).toContain('--agent plan');
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

describe('openCodeAdapter.plan — provider routing', () => {
  it('passes the ref to -m verbatim, with no hardcoded provider', () => {
    // The adapter used to prefix `opencode/`, which sent every run to the free
    // tier regardless of the provider the user chose — and that tier serves
    // none of these models, so the run died before the model saw the task.
    const p = openCodeAdapter.plan({ ...base, mode: 'acceptEdits' });
    expect(p.script).toContain('-m openrouter/deepseek-v4-flash');
    expect(p.script).not.toContain('-m opencode/openrouter/deepseek-v4-flash');
  });

  it('routes a nested openrouter ref unchanged', () => {
    const p = openCodeAdapter.plan({
      ...base, modelId: 'openrouter/deepseek/deepseek-v4-flash', mode: 'acceptEdits',
    });
    expect(p.script).toContain('-m openrouter/deepseek/deepseek-v4-flash');
  });
});

describe('openCodeAdapter.plan — report writability', () => {
  // A read-only role runs under opencode's `plan` agent, which prohibits file
  // edits — so the model cannot write report.md either. Observed live: a
  // review run ended "Unable to write the required report because plan mode
  // prohibits file edits." Sonata must not then call the run degraded.
  it('reports that a read-only role cannot write its report', () => {
    expect(openCodeAdapter.plan({ ...base, role: 'review', mode: 'acceptEdits' }).canWriteReport)
      .toBe(false);
    expect(openCodeAdapter.plan({ ...base, role: 'plan', mode: 'acceptEdits' }).canWriteReport)
      .toBe(false);
  });

  it('still expects a report from a write-capable role', () => {
    expect(openCodeAdapter.plan({ ...base, role: 'code', mode: 'acceptEdits' }).canWriteReport)
      .not.toBe(false);
  });

  it('explore cannot write either, now that it runs under plan', () => {
    // It used to resolve to the write-capable `build` by accident. Being
    // unable to write its own report is the cost of the role actually being
    // read-only, and sonata must not call such a run degraded.
    expect(openCodeAdapter.plan({ ...base, role: 'explore', mode: 'acceptEdits' }).canWriteReport)
      .toBe(false);
  });
});

describe('openCodeAdapter.plan — only primary agents are dispatchable', () => {
  it('runs the explore role under plan, not explore', () => {
    // `opencode run --agent` accepts primary agents only. `explore` is a
    // SUBAGENT, so opencode silently substituted the write-capable `build` —
    // a read-only role that was not read-only. Enabling it in opencode.json
    // does not help; it is still not primary.
    const p = openCodeAdapter.plan({ ...base, role: 'explore', mode: 'acceptEdits' });
    expect(p.script).toContain('--agent plan');
    expect(p.script).not.toContain('--agent explore');
  });

  it('never dispatches to a non-primary agent for any role', () => {
    const PRIMARY = ['build', 'plan'];
    for (const role of ['code', 'review', 'explore', 'plan']) {
      const script = openCodeAdapter.plan({ ...base, role, mode: 'acceptEdits' }).script;
      const agent = /--agent (\S+)/.exec(script)![1];
      expect(PRIMARY).toContain(agent);
    }
  });

  it('still reports that a read-only run cannot write its report', () => {
    expect(openCodeAdapter.plan({ ...base, role: 'explore', mode: 'acceptEdits' }).canWriteReport)
      .toBe(false);
  });
});
