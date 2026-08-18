import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCodexModels, codexAdapter, configuredBaseUrl, projectTrusted } from '../../src/adapters/codex.js';
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

  it('forces read-only and non-interactive for the review role in acceptEdits', () => {
    const p = codexAdapter.plan({ ...base, role: 'review', mode: 'acceptEdits' });
    expect(p.script).toContain('-s read-only');
    expect(p.script).not.toContain('workspace-write');
    expect(p.interactive).toBe(false);
  });

  it('forces read-only for the review role even in bypassPermissions', () => {
    const p = codexAdapter.plan({ ...base, role: 'review', mode: 'bypassPermissions' });
    expect(p.script).toContain('-s read-only');
    expect(p.script).not.toContain('danger-full-access');
  });

  it('keeps workspace-write for the code role in acceptEdits', () => {
    const p = codexAdapter.plan({ ...base, role: 'code', mode: 'acceptEdits' });
    expect(p.script).toContain('-s workspace-write');
  });

  it('reports whether the effective invocation can write the report', () => {
    for (const role of ['review', 'explore', 'plan']) {
      for (const mode of ['plan', 'default', 'acceptEdits', 'bypassPermissions'] as const) {
        expect(codexAdapter.plan({ ...base, role, mode }).canWriteReport).toBe(false);
      }
    }
    expect(codexAdapter.plan({ ...base, role: 'code', mode: 'plan' }).canWriteReport).toBe(false);
    expect(codexAdapter.plan({ ...base, role: 'code', mode: 'acceptEdits' }).canWriteReport).toBe(true);
    expect(codexAdapter.plan({ ...base, role: 'code', mode: 'bypassPermissions' }).canWriteReport).toBe(true);
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

  it('keeps the TUI stdout attached to the terminal', () => {
    expect(p.script).not.toContain('tee');
  });

  it('quits after the model writes its report', () => {
    expect(p.script).toContain("while [ ! -f '/repo/.sonata/runs/abc123/report.md' ]; do sleep 2; done");
    expect(p.script).toContain('tmux send-keys -t "$SESSION" C-u');
    expect(p.script).toContain('tmux send-keys -t "$SESSION" C-d');
    expect(p.script.indexOf('C-u')).toBeLessThan(p.script.indexOf('C-d'));
  });

  it('does not seed the composer because codex receives the prompt as argv', () => {
    expect(p.script).not.toContain('tmux send-keys -t "$SESSION" -l');
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

  it('keeps non-interactive output in harness.log', () => {
    expect(p.script).toContain("2>&1 | tee -a '/repo/.sonata/runs/abc123/harness.log'");
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

/**
 * Driven by real captures rather than invented text. The patterns these
 * replace matched none of what codex actually prints, so a run waiting for
 * approval was reported STALLED — invisible to a test written from the same
 * imagination as the regex.
 */
function fixture(name: string): string[] {
  const path = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/panes', name);
  return readFileSync(path, 'utf8').split('\n');
}

describe('codexAdapter.describePrompt — against captured codex output', () => {
  it('detects a real command approval', () => {
    const prompt = codexAdapter.describePrompt(fixture('codex-approve-command.txt'));
    expect(prompt).toContain('Would you like to run the following command?');
  });

  it('returns the whole block, so the caller can see what it is approving', () => {
    const prompt = codexAdapter.describePrompt(fixture('codex-approve-command.txt'))!;
    expect(prompt).toContain('rm file.txt');
    expect(prompt).toContain('1. Yes, proceed (y)');
    expect(prompt.split('\n').length).toBeGreaterThan(1);
  });

  it('detects the directory-trust prompt that blocks a run before it starts', () => {
    const prompt = codexAdapter.describePrompt(fixture('codex-trust-directory.txt'));
    expect(prompt).toContain('Do you trust the contents of this directory?');
  });

  it('returns null when nothing is pending', () => {
    expect(codexAdapter.describePrompt(['reading src/a.ts'])).toBeNull();
  });

  it('does not park the run on the model\'s own prose about approvals', () => {
    expect(codexAdapter.describePrompt([
      'I will approve the PR once CI is green.',
      'Should I allow the deploy to proceed?',
    ])).toBeNull();
  });
});

describe('codexAdapter.approveKeys', () => {
  it('answers yes with the accelerator alone, with no trailing Enter', () => {
    // Codex acts on `y` immediately; a following Enter would land in the
    // composer and submit an empty message.
    expect(codexAdapter.approveKeys.yes).toEqual(['y']);
  });

  it('denies with Escape, since codex offers no `n` accelerator', () => {
    expect(codexAdapter.approveKeys.no).toEqual(['Escape']);
  });
});

describe('projectTrusted', () => {
  const cfg = [
    '[projects."/Users/j/trusted"]',
    'trust_level = "trusted"',
    '',
    '[projects."/Users/j/untrusted"]',
    'trust_level = "untrusted"',
    '',
    '[tui]',
    'theme = "dark"',
  ].join('\n');

  it('is true for a directory codex has been trusted in', () => {
    expect(projectTrusted(cfg, '/Users/j/trusted')).toBe(true);
  });

  it('is false for a directory recorded as untrusted', () => {
    expect(projectTrusted(cfg, '/Users/j/untrusted')).toBe(false);
  });

  it('is false for a directory codex has never seen', () => {
    expect(projectTrusted(cfg, '/Users/j/unknown')).toBe(false);
  });

  it('does not read trust from a following section', () => {
    const spill = '[projects."/a"]\n\n[projects."/b"]\ntrust_level = "trusted"\n';
    expect(projectTrusted(spill, '/a')).toBe(false);
  });

  it('treats regex metacharacters in the path literally', () => {
    const dotted = '[projects."/Users/j/a.b"]\ntrust_level = "trusted"\n';
    expect(projectTrusted(dotted, '/Users/j/axb')).toBe(false);
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

describe('parseCodexModels', () => {
  const real = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../fixtures/codex/model-list.json'),
    'utf8',
  );

  // Captured from a live `codex app-server` model/list call on codex-cli
  // 0.147.0. Codex has no `models` subcommand, which is why its models used to
  // be hand-written into sonata.toml.
  it('reads a real model/list response', () => {
    const refs = parseCodexModels(real);
    expect(refs.map((r) => r.ref)).toEqual([
      'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini',
    ]);
    expect(refs[0]).toEqual({
      harness: 'codex', provider: 'codex', id: 'gpt-5.6-sol', ref: 'gpt-5.6-sol', name: 'GPT-5.6-Sol',
    });
  });

  // Codex ids are bare, which parseConfig enforces. A provider-qualified ref
  // would produce the key codex-codex-gpt-5.6-sol and an id the config rejects.
  it('keeps ids bare, so the config key is codex-<id>', () => {
    expect(parseCodexModels(real).every((r) => !r.ref.includes('/'))).toBe(true);
  });

  it('omits hidden models', () => {
    const body = JSON.stringify({ result: { data: [
      { id: 'visible', displayName: 'V', hidden: false },
      { id: 'internal', displayName: 'I', hidden: true },
    ] } });
    expect(parseCodexModels(body).map((r) => r.id)).toEqual(['visible']);
  });

  it('accepts the result object on its own', () => {
    const body = JSON.stringify({ data: [{ id: 'gpt-5.5', hidden: false }] });
    expect(parseCodexModels(body).map((r) => r.id)).toEqual(['gpt-5.5']);
  });

  it('returns nothing rather than throwing on junk, an error, or a missing id', () => {
    expect(parseCodexModels('not json')).toEqual([]);
    expect(parseCodexModels('null')).toEqual([]);
    expect(parseCodexModels(JSON.stringify({ error: { message: 'not logged in' } }))).toEqual([]);
    expect(parseCodexModels(JSON.stringify({ result: { data: [{ displayName: 'no id' }] } }))).toEqual([]);
  });
});
