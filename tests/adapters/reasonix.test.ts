import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  reasonixAdapter,
  parseReasonixRefs,
  telemetryAnswered,
} from '../../src/adapters/reasonix.js';
import { getAdapter } from '../../src/adapters/index.js';

/**
 * Captured from reasonix v1.26.0, not composed by hand.
 *
 * `doctor.json` is verbatim stdout from `reasonix doctor --json`. The pane
 * files are verbatim `tmux capture-pane` output from live runs against a real
 * model — the plan-confirmation prompt, the tool approval card, and the model
 * asking the user a question mid-run.
 */
function fixture(dir: string, name: string): string {
  return readFileSync(join(import.meta.dirname, '../fixtures', dir, name), 'utf8');
}

function paneLines(name: string): string[] {
  return fixture('panes', name).split('\n');
}

const base = {
  modelId: 'custom-opencode-ai/deepseek-v4-flash',
  role: 'code',
  cwd: '/repo',
  runDir: '/repo/.sonata/runs/abc123',
  instructionsPath: '/repo/.sonata/runs/abc123/instructions.md',
};

const READ_ONLY_ROLES = ['review', 'explore', 'plan'];

describe('reasonixAdapter.plan — permission modes', () => {
  it('maps acceptEdits and bypassPermissions straight through', () => {
    expect(reasonixAdapter.plan({ ...base, mode: 'acceptEdits' }).script)
      .toContain('--permission-mode acceptEdits');
    expect(reasonixAdapter.plan({ ...base, mode: 'bypassPermissions' }).script)
      .toContain('--permission-mode bypassPermissions');
  });

  /**
   * `reasonix run --permission-mode plan` exits 2 with "requires an interactive
   * session", so plan mode cannot be the read-only mechanism. `dontAsk` denies
   * without prompting and works headlessly.
   */
  it('uses dontAsk for plan mode rather than reasonix plan mode', () => {
    const p = reasonixAdapter.plan({ ...base, mode: 'plan' });
    expect(p.script).toContain('--permission-mode dontAsk');
    expect(p.script).not.toContain('--permission-mode plan');
  });

  it('pins every read-only role to dontAsk in every mode', () => {
    for (const role of READ_ONLY_ROLES) {
      for (const mode of ['plan', 'default', 'acceptEdits', 'bypassPermissions'] as const) {
        const p = reasonixAdapter.plan({ ...base, role, mode });
        expect(p.script).toContain('--permission-mode dontAsk');
        expect(p.interactive).toBe(false);
      }
    }
  });

  /**
   * `-y`/`--auto` is an alias for reasonix's own `auto`, which skips risk-based
   * prompts for things like `git push`. Claude Code's `auto` maps to
   * acceptEdits, so reaching for the similarly named flag would silently widen
   * permissions. This test exists to stop it being "simplified" back in.
   */
  it('never uses reasonix auto mode, whose meaning is wider than Claude Code\'s', () => {
    for (const mode of ['plan', 'default', 'acceptEdits', 'bypassPermissions'] as const) {
      for (const role of ['code', ...READ_ONLY_ROLES]) {
        const { script } = reasonixAdapter.plan({ ...base, role, mode });
        expect(script).not.toMatch(/(^|\s)-y(\s|$)/);
        expect(script).not.toContain('--auto');
        expect(script).not.toContain('--permission-mode auto');
      }
    }
  });
});

describe('reasonixAdapter.plan — reporting', () => {
  /**
   * dontAsk refuses the write tool AND the shell fallback, so the model cannot
   * write report.md. Probed directly: a run asked to write one reported
   * "denied by permission policy" for both paths. Nothing went wrong, so such
   * a run must not be marked degraded.
   */
  it('knows a read-only run cannot write its own report', () => {
    for (const role of READ_ONLY_ROLES) {
      expect(reasonixAdapter.plan({ ...base, role, mode: 'acceptEdits' }).canWriteReport).toBe(false);
    }
    expect(reasonixAdapter.plan({ ...base, mode: 'plan' }).canWriteReport).toBe(false);
  });

  it('expects a report from a write-capable run', () => {
    for (const mode of ['acceptEdits', 'bypassPermissions', 'default'] as const) {
      expect(reasonixAdapter.plan({ ...base, mode }).canWriteReport).toBe(true);
    }
  });
});

describe('reasonixAdapter.plan — default mode uses the TUI', () => {
  const p = reasonixAdapter.plan({ ...base, mode: 'default' });

  it('is the second harness after codex that can honour default mode', () => {
    expect(reasonixAdapter.canPromptForApproval).toBe(true);
    expect(p.interactive).toBe(true);
    expect(p.script).toContain('--permission-mode ask');
    // The TUI is the whole point; `run` would never raise a prompt.
    expect(p.script).not.toContain('reasonix run');
  });

  /**
   * Probed: piping the TUI's stdout leaves the pane completely blank. A log
   * file is not worth a run nobody can see or answer, and nothing reads
   * harness.log as the report.
   */
  it('does not pipe the TUI, which would blank the pane', () => {
    expect(p.script).not.toContain('tee');
  });

  /**
   * The TUI ignores positional task text — probed, the composer comes up empty
   * — so the script types it in. It waits for the ready marker rather than
   * sleeping a fixed interval.
   */
  it('seeds the composer by addressing its own tmux session', () => {
    expect(p.script).toContain(`SESSION="$(tmux display-message -p '#S')"`);
    expect(p.script).toContain('Shift+Tab ask/auto/plan');
    expect(p.script).toContain('tmux send-keys -t "$SESSION" -l');
    expect(p.script).toContain('tmux send-keys -t "$SESSION" Enter');
  });

  it('types a single-line prompt, so it is not submitted halfway through', () => {
    const typed = p.script.match(/send-keys -t "\$SESSION" -l '([^\n]*)'/);
    expect(typed).not.toBeNull();
    expect(typed![1]).toContain('/repo/.sonata/runs/abc123/instructions.md');
    expect(typed![1]).not.toContain('\\n');
  });

  it('still writes the exit sentinel', () => {
    expect(p.script).toContain("echo $? > '/repo/.sonata/runs/abc123/exit'");
  });

  /**
   * The TUI is a chat session: it waits for the next message rather than
   * exiting. Left alone it never writes the exit sentinel, so a finished run
   * sits at PROGRESS until the stall timeout and is killed and reported
   * degraded — with its report sitting right there. Observed before this
   * existed.
   */
  it('quits the TUI once the report lands, so the run can finish', () => {
    expect(p.script).toContain("while [ ! -f '/repo/.sonata/runs/abc123/report.md' ]; do sleep 2; done");
    expect(p.script).toContain('tmux send-keys -t "$SESSION" C-d');
  });

  /**
   * Typing blind into a TUI races with it. A run that typed the documented
   * `exit` landed the letters in an open approval card and the Enter picked
   * whatever row was highlighted. Ctrl-D cannot select anything.
   */
  it('quits with Ctrl-D rather than typing exit into whatever is on screen', () => {
    expect(p.script).not.toContain("-l 'exit'");
  });

  it('stops sending Ctrl-D once the sentinel acknowledges the quit', () => {
    expect(p.script).toContain("[ -f '/repo/.sonata/runs/abc123/exit' ] && break");
  });
});

describe('reasonixAdapter.plan — script shape', () => {
  const p = reasonixAdapter.plan({ ...base, mode: 'acceptEdits' });

  it('guards the cd and writes the exit sentinel with pipefail', () => {
    expect(p.script).toContain("cd '/repo' || exit 97");
    expect(p.script).toContain('set -o pipefail');
    expect(p.script).toContain("echo $? > '/repo/.sonata/runs/abc123/exit'");
  });

  it('tees harness output to the run log', () => {
    expect(p.script).toContain("tee -a '/repo/.sonata/runs/abc123/harness.log'");
  });

  it('passes the model and names the instructions file', () => {
    expect(p.script).toContain("--model 'custom-opencode-ai/deepseek-v4-flash'");
    expect(p.script).toContain('/repo/.sonata/runs/abc123/instructions.md');
  });

  it('keeps text output, so the pane stays readable under tmux attach', () => {
    expect(p.script).toContain('--output-format text');
  });

  it('escapes single quotes in paths rather than breaking the script', () => {
    for (const mode of ['acceptEdits', 'default'] as const) {
      const evil = reasonixAdapter.plan({ ...base, mode, cwd: "/re'po" });
      expect(evil.script).toContain("'/re'\\''po'");
    }
  });
});

describe('reasonixAdapter — prompt detection', () => {
  it('detects the tool approval card', () => {
    const desc = reasonixAdapter.describePrompt(paneLines('reasonix-tool-approval.txt'));
    expect(desc).not.toBeNull();
    // The matched line is often the footer; the caller needs the tool name.
    expect(desc).toMatch(/will call tool write file report\.md/i);
    expect(desc).toMatch(/allow once/i);
  });

  it('detects the plan confirmation prompt', () => {
    const desc = reasonixAdapter.describePrompt(paneLines('reasonix-plan-confirm.txt'));
    expect(desc).not.toBeNull();
    expect(desc).toMatch(/plan ready above/i);
  });

  /**
   * The shape that would otherwise be missed: the model asking the *user* a
   * question blocks a dispatch exactly as hard as an approval does.
   */
  it('detects the model asking the user a question', () => {
    const desc = reasonixAdapter.describePrompt(paneLines('reasonix-question-prompt.txt'));
    expect(desc).not.toBeNull();
  });

  it('reports nothing for ordinary output', () => {
    expect(reasonixAdapter.describePrompt([])).toBeNull();
    expect(reasonixAdapter.describePrompt(['● Write(report.md)', '  1 + PROBE OK'])).toBeNull();
  });

  /**
   * Reasonix relays the model's own prose into the pane, so a loose pattern
   * would park a run in PAUSED over a sentence the model merely wrote.
   */
  it('does not fire on prose that merely mentions approval', () => {
    expect(reasonixAdapter.describePrompt([
      'I will now ask you to approve the deployment, and await your decision.',
      'Shall I proceed with the merge?',
    ])).toBeNull();
  });
});

describe('reasonixAdapter — answering a prompt', () => {
  /**
   * `1` is "Allow once" and acts immediately — no trailing Enter, which would
   * fall through to the composer and submit an empty message.
   *
   * Escape rather than `4` for deny: it is the documented deny key on the
   * approval card AND the only key that behaves correctly on the plan
   * confirmation prompt, where choosing the third option records `revise_plan`
   * and silently flips the session from Plan to Auto.
   */
  it('answers with keys that act immediately and carry no Enter', () => {
    expect(reasonixAdapter.approveKeys.yes).toEqual(['1']);
    expect(reasonixAdapter.approveKeys.no).toEqual(['Escape']);
    expect(reasonixAdapter.approveKeys.yes).not.toContain('Enter');
    expect(reasonixAdapter.approveKeys.no).not.toContain('Enter');
  });
});

describe('parseReasonixRefs', () => {
  const doctor = fixture('reasonix', 'doctor.json');

  /**
   * The probe machine had one provider serving twelve models and two serving
   * one each. Only the provider with a key can actually run anything.
   */
  it('reads every model of a real doctor listing', () => {
    const refs = parseReasonixRefs(doctor);
    expect(refs).toHaveLength(12);
    expect([...new Set(refs.map((r) => r.provider))]).toEqual(['custom-opencode-ai']);
    expect(refs[0]).toEqual({
      harness: 'reasonix',
      provider: 'custom-opencode-ai',
      id: 'deepseek-v4-flash',
      ref: 'custom-opencode-ai/deepseek-v4-flash',
    });
    expect(refs.every((r) => r.provider.length > 0 && r.id.length > 0)).toBe(true);
  });

  it('offers no model from a provider with no key', () => {
    // Offering one would put a model in the picker that fails on first dispatch.
    expect(parseReasonixRefs(doctor).some((r) => r.provider.startsWith('deepseek-'))).toBe(false);
  });

  /**
   * The singular `model` key is absent from a provider serving several models,
   * so keying off it would silently drop every multi-model provider — exactly
   * the providers worth having.
   */
  it('reads models[], not the singular model key', () => {
    const json = JSON.stringify({
      providers: [{ name: 'p', key_present: true, models: ['a', 'b'] }],
    });
    expect(parseReasonixRefs(json).map((r) => r.ref)).toEqual(['p/a', 'p/b']);
  });

  it('survives output that is not the expected shape', () => {
    expect(parseReasonixRefs('')).toEqual([]);
    expect(parseReasonixRefs('not json')).toEqual([]);
    expect(parseReasonixRefs('{}')).toEqual([]);
    expect(parseReasonixRefs('{"providers":"nope"}')).toEqual([]);
    expect(parseReasonixRefs('{"providers":[null,{},{"name":""}]}')).toEqual([]);
    expect(parseReasonixRefs('{"providers":[{"name":"p","key_present":true}]}')).toEqual([]);
  });
});

describe('telemetryAnswered', () => {
  /**
   * Until the question is answered, the first invocation blocks on "Allow
   * anonymous CLI usage statistics? [Y/n]:" before the agent starts — which
   * looks exactly like a model that never said anything.
   */
  it('is false for a config that has never answered', () => {
    expect(telemetryAnswered('')).toBe(false);
    expect(telemetryAnswered('[lsp]\nenabled = true\n')).toBe(false);
  });

  it('is true once answered either way', () => {
    expect(telemetryAnswered('cli_metrics = "off"\n')).toBe(true);
    expect(telemetryAnswered('cli_metrics = "on"\n')).toBe(true);
  });
});

describe('adapter registry', () => {
  it('resolves reasonix', () => {
    expect(getAdapter('reasonix').name).toBe('reasonix');
  });

  it('declares the supported version range', () => {
    const adapter = getAdapter('reasonix');
    expect(adapter.versionCommand).toEqual(['reasonix', '--version']);
    expect(adapter.supportedVersions).toBe('>=1.26.0 <2.0.0');
    expect(adapter.pathPrepend).toEqual([]);
  });
});
