import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeAdapter } from '../../src/adapters/claude.js';
import { getAdapter } from '../../src/adapters/index.js';
import { KNOWN_HARNESSES, isAnthropicRoutedName } from '../../src/config.js';
import { splitCandidate } from '../../src/effort.js';

function cwdWithNative(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'sonata-claude-adapter-'));
  writeFileSync(join(cwd, 'sonata.toml'), `
[models."claude-test"]
harness = "claude"
id = "deepseek-v4-flash"

[native.models."deepseek-v4-flash"]
gateway = "acme"
id = "deepseek-v4-flash-0731"
context_window = 128000

[native.gateways."acme"]
base_url = "https://gateway.acme.example/v1"
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
    // The = form is load-bearing: the space form is variadic in claude's CLI
    // parser and swallows the prompt argument that follows.
    expect(plan.script).toContain('--allowedTools=Read,Grep,Glob,Bash');
    expect(plan.canWriteReport).toBe(false);
  });

  it('can write a report for a write-capable role', () => {
    expect(claudeAdapter.plan({ ...base, mode: 'acceptEdits' }).canWriteReport).not.toBe(false);
  });

  it('declares itself silent until exit, so pane silence is not a stall', () => {
    expect(claudeAdapter.plan({ ...base, mode: 'acceptEdits' }).silentUntilExit).toBe(true);
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

describe('claudeAdapter.plan — reasoning effort', () => {
  // The claude harness routes through sonata's own router, whose `routeRequest`
  // already splits `<key>@<effort>` off a bare model name and injects
  // `reasoning_effort`. So the level travels in the model name; inventing a
  // `claude` flag would be a second mechanism for something already wired.
  it('carries the level in the model name the router resolves', () => {
    const plan = claudeAdapter.plan({ ...base, mode: 'acceptEdits', effort: 'xhigh' });

    expect(plan.script).toContain(`--model 'deepseek-v4-flash@xhigh'`);
    expect(plan.effortHonoured).toBe(true);
  });

  it('leaves the model name bare when the candidate pins no level', () => {
    const plan = claudeAdapter.plan({ ...base, mode: 'acceptEdits' });

    expect(plan.script).toContain(`--model 'deepseek-v4-flash'`);
    expect(plan.script).not.toContain('@');
    expect(plan.effortHonoured).toBe(true);
  });
});

describe('claudeAdapter.plan — an Anthropic-routed model cannot carry a level', () => {
  // `routeRequest` splits `<key>@<effort>` off a bare model name ONLY when the
  // name is not Anthropic-routed — a `claude-` request is passed through
  // byte-identical by contract. So appending a level to such a name does not
  // reach the router's splitter: it reaches Anthropic, which rejects the model
  // outright. Effort for Claude models is out of scope by design; Claude
  // Code's own setting governs those.
  it('leaves the name bare and reports the level unhonoured', () => {
    const plan = claudeAdapter.plan({ ...base, modelId: 'claude-sonnet-5', mode: 'acceptEdits', effort: 'xhigh' });

    expect(plan.script).toContain(`--model 'claude-sonnet-5'`);
    expect(plan.script).not.toContain('claude-sonnet-5@');
    expect(plan.effortHonoured).toBe(false);
  });

  it('still reports honoured for a foreign model', () => {
    const plan = claudeAdapter.plan({ ...base, mode: 'acceptEdits', effort: 'xhigh' });
    expect(plan.effortHonoured).toBe(true);
  });
});

describe('claudeAdapter.plan — the name it emits is one the router will split', () => {
  // The two halves of this lane are otherwise tested apart: the adapter asserts
  // what it writes, the router asserts what it parses, and nothing checks they
  // agree. These are the router's own two predicates, applied to the adapter's
  // own output.
  const nameIn = (script: string): string => {
    const m = /--model '([^']*)'/.exec(script);
    if (m === null) throw new Error('no --model in the generated script');
    return m[1];
  };

  it('round-trips through the same splitter routeRequest uses', () => {
    const name = nameIn(claudeAdapter.plan({ ...base, mode: 'acceptEdits', effort: 'max' }).script);

    expect(isAnthropicRoutedName(name)).toBe(false);
    expect(splitCandidate(name)).toEqual({ key: 'deepseek-v4-flash', effort: 'max' });
  });
});

describe('claudeAdapter.plan — shell quoting', () => {
  // Every sibling adapter has one of these. It matters on this lane because
  // the model name is user-configured and now has a suffix appended to it
  // before quoting, so the quoting has to survive the concatenation.
  it('quotes a model id containing a single quote', () => {
    const plan = claudeAdapter.plan({ ...base, modelId: "od'd", mode: 'acceptEdits', effort: 'low' });
    expect(plan.script).toContain(`--model 'od'\\''d@low'`);
  });
});
