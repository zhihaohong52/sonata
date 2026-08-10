import { describe, it, expect } from 'vitest';
import { codexAdapter, configuredBaseUrl } from '../../src/adapters/codex.js';
import { getAdapter } from '../../src/adapters/index.js';

const base = {
  modelId: 'gpt-5.6-sol',
  role: 'code',
  cwd: '/repo',
  runDir: '/repo/.sonata/runs/abc123',
  instructionsPath: '/repo/.sonata/runs/abc123/instructions.md',
};

describe('codexAdapter.plan — sandbox mapping', () => {
  it('uses read-only for plan mode', () => {
    const p = codexAdapter.plan({ ...base, mode: 'plan' });
    expect(p.script).toContain('codex exec');
    expect(p.script).toContain('-s read-only');
    expect(p.interactive).toBe(false);
  });

  it('uses workspace-write for acceptEdits', () => {
    const p = codexAdapter.plan({ ...base, mode: 'acceptEdits' });
    expect(p.script).toContain('-s workspace-write');
    expect(p.script).not.toContain('danger-full-access');
  });

  it('uses danger-full-access only for bypassPermissions', () => {
    const p = codexAdapter.plan({ ...base, mode: 'bypassPermissions' });
    expect(p.script).toContain('-s danger-full-access');
  });

  it('never uses the bypass-approvals-and-sandbox flag', () => {
    for (const mode of ['plan', 'acceptEdits', 'bypassPermissions'] as const) {
      const p = codexAdapter.plan({ ...base, mode });
      expect(p.script).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    }
  });
});

describe('codexAdapter.plan — default mode', () => {
  const p = codexAdapter.plan({ ...base, mode: 'default' });

  it('runs the interactive TUI, since `codex exec` cannot ask for approval', () => {
    expect(p.interactive).toBe(true);
    expect(p.script).not.toContain('codex exec');
  });

  it('forces approvals on, overriding a config that disables them', () => {
    expect(p.script).toContain('-c approval_policy="on-request"');
  });

  it('is never more permissive than workspace-write', () => {
    expect(p.script).toContain('-s workspace-write');
    expect(p.script).not.toContain('danger-full-access');
  });
});

describe('codexAdapter.plan — invocation details', () => {
  const p = codexAdapter.plan({ ...base, mode: 'acceptEdits' });

  it('passes the model', () => {
    expect(p.script).toContain("-m 'gpt-5.6-sol'");
  });

  it('asks codex to write its final message to the run directory', () => {
    expect(p.script).toContain("-o '/repo/.sonata/runs/abc123/last-message.txt'");
  });

  it('names the instructions file in the prompt', () => {
    expect(p.script).toContain('/repo/.sonata/runs/abc123/instructions.md');
  });

  it('works outside a git repository', () => {
    expect(p.script).toContain('--skip-git-repo-check');
  });

  it('never passes exec-only flags to the interactive TUI', () => {
    // The TUI rejects --skip-git-repo-check outright; this shipped once.
    const tui = codexAdapter.plan({ ...base, mode: 'default' });
    expect(tui.script).not.toContain('--skip-git-repo-check');
  });

  it('disables approvals in non-interactive mode so it cannot hang', () => {
    expect(p.script).toContain('-c approval_policy="never"');
  });

  it('writes the exit sentinel with pipefail', () => {
    expect(p.script).toContain('set -o pipefail');
    expect(p.script).toContain("echo $? > '/repo/.sonata/runs/abc123/exit'");
  });

  it('escapes single quotes in paths rather than breaking the script', () => {
    const evil = codexAdapter.plan({ ...base, mode: 'plan', cwd: "/re'po" });
    expect(evil.script).toContain(`'/re'\\''po'`);
  });
});

describe('codexAdapter.describePrompt', () => {
  it('detects an approval request', () => {
    expect(codexAdapter.describePrompt(['Allow codex to run rm -rf build?']))
      .toContain('rm -rf build');
  });

  it('returns null when nothing is pending', () => {
    expect(codexAdapter.describePrompt(['reading src/a.ts'])).toBeNull();
  });
});

describe('configuredBaseUrl', () => {
  it('extracts a proxied base url', () => {
    const cfg = 'model_provider = "headroom"\nopenai_base_url = "http://127.0.0.1:8787/v1"\n';
    expect(configuredBaseUrl(cfg)).toBe('http://127.0.0.1:8787/v1');
  });

  it('returns null when codex uses the default endpoint', () => {
    expect(configuredBaseUrl('model = "gpt-5.6-sol"\n')).toBeNull();
  });

  it('ignores a commented-out override', () => {
    expect(configuredBaseUrl('# openai_base_url = "http://x/v1"\n')).toBeNull();
  });
});

describe('adapter registry', () => {
  it('resolves codex', () => {
    expect(getAdapter('codex').name).toBe('codex');
  });

  it('declares a harness-written report fallback', () => {
    expect(getAdapter('codex').fallbackReportFile).toBe('last-message.txt');
  });

  it('opencode declares no fallback, since it cannot write one', () => {
    expect(getAdapter('opencode').fallbackReportFile).toBeUndefined();
  });
});
