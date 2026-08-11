import { describe, it, expect } from 'vitest';
import { piAdapter, countModelRows, parsePiRefs } from '../../src/adapters/pi.js';
import { getAdapter } from '../../src/adapters/index.js';

const base = {
  modelId: 'opencode-go/deepseek-v4-flash',
  role: 'code',
  cwd: '/repo',
  runDir: '/repo/.sonata/runs/abc123',
  instructionsPath: '/repo/.sonata/runs/abc123/instructions.md',
};

const READ_ONLY_TOOLS = '--tools read,grep,find,ls';

describe('piAdapter.plan — tool allowlist', () => {
  it('runs with all tools in acceptEdits', () => {
    const p = piAdapter.plan({ ...base, mode: 'acceptEdits' });
    expect(p.script).toContain('-p');
    expect(p.script).toContain("--model 'opencode-go/deepseek-v4-flash'");
    expect(p.script).not.toContain('--tools');
  });

  it('runs with all tools in bypassPermissions', () => {
    const p = piAdapter.plan({ ...base, mode: 'bypassPermissions' });
    expect(p.script).toContain('-p');
    expect(p.script).toContain('--model');
    expect(p.script).not.toContain('--tools');
  });

  it('restricts to read-only tools in plan mode', () => {
    const p = piAdapter.plan({ ...base, mode: 'plan' });
    expect(p.script).toContain(READ_ONLY_TOOLS);
  });

  it('restricts every read-only role to read-only tools in every mode', () => {
    for (const role of ['review', 'explore', 'plan']) {
      for (const mode of ['plan', 'acceptEdits', 'bypassPermissions', 'default'] as const) {
        const p = piAdapter.plan({ ...base, role, mode });
        expect(p.script).toContain(READ_ONLY_TOOLS);
      }
    }
  });
});

describe('piAdapter.plan — default mode', () => {
  it('refuses default mode rather than running a write-capable role ungated', () => {
    // pi cannot ask, so honouring "ask me first" is impossible. Running anyway
    // would exceed the permissions of the session that dispatched it.
    expect(() => piAdapter.plan({ ...base, mode: 'default' }))
      .toThrow(/cannot ask for approval/i);
  });

  it('still allows default mode for read-only roles, which never need to ask', () => {
    for (const role of ['review', 'explore', 'plan']) {
      const p = piAdapter.plan({ ...base, role, mode: 'default' });
      expect(p.script).toContain(READ_ONLY_TOOLS);
    }
  });

  it('never claims a plan is interactive, in any mode it will run', () => {
    for (const mode of ['plan', 'acceptEdits', 'bypassPermissions'] as const) {
      expect(piAdapter.plan({ ...base, mode }).interactive).toBe(false);
    }
    for (const role of ['review', 'explore', 'plan']) {
      expect(piAdapter.plan({ ...base, role, mode: 'default' }).interactive).toBe(false);
    }
  });
});

describe('piAdapter.plan — script shape', () => {
  const p = piAdapter.plan({ ...base, mode: 'acceptEdits' });

  it('prepends the pi bin dir, which is not on PATH', () => {
    expect(p.script).toContain('export PATH="$HOME/.local/bin:$PATH"');
  });

  it('guards the cd and writes the exit sentinel with pipefail', () => {
    expect(p.script).toContain("cd '/repo' || exit 97");
    expect(p.script).toContain('set -o pipefail');
    expect(p.script).toContain("echo $? > '/repo/.sonata/runs/abc123/exit'");
  });

  it('tees harness output to the run log', () => {
    expect(p.script).toContain("tee -a '/repo/.sonata/runs/abc123/harness.log'");
  });

  it('names the instructions file in the prompt', () => {
    expect(p.script).toContain('/repo/.sonata/runs/abc123/instructions.md');
  });

  it('escapes single quotes in paths rather than breaking the script', () => {
    const evil = piAdapter.plan({ ...base, mode: 'plan', cwd: "/re'po" });
    expect(evil.script).toContain("'/re'\\''po'");
  });
});

/**
 * pi has no permission popups — its docs say so explicitly — so no pattern
 * could ever fire. These tests pin that finding so it is not quietly "fixed"
 * back into a prompt pattern that never matches.
 */
describe('piAdapter — approvals are not possible', () => {
  it('never reports a pending prompt', () => {
    expect(piAdapter.describePrompt(['any', 'output', 'at all'])).toBeNull();
    expect(piAdapter.describePrompt([])).toBeNull();
  });

  it('offers no keys to answer with', () => {
    expect(piAdapter.approveKeys.yes).toEqual([]);
    expect(piAdapter.approveKeys.no).toEqual([]);
  });
});

describe('countModelRows', () => {
  const HEADER = 'provider     model              context  max-out  thinking  images';

  it('does not count the header as a model', () => {
    // `pi --list-models` always prints the header, so "output is non-empty"
    // would report an install with no provider as healthy.
    expect(countModelRows(`${HEADER}\n`)).toBe(0);
  });

  it('counts real rows', () => {
    const out = [HEADER, 'opencode-go  deepseek-v4-flash  1M  384K  yes  no', 'opencode-go  kimi-k3  1M  131.1K  yes  yes'].join('\n');
    expect(countModelRows(out)).toBe(2);
  });

  it('is zero for empty output', () => {
    expect(countModelRows('')).toBe(0);
    expect(countModelRows('\n  \n')).toBe(0);
  });
});

describe('parsePiRefs', () => {
  const HEADER = 'provider     model              context  max-out  thinking  images';

  it('joins the provider and model columns into a ref', () => {
    const out = [HEADER, 'opencode-go  deepseek-v4-flash  1M  384K  yes  no'].join('\n');
    expect(parsePiRefs(out)).toEqual([
      {
        harness: 'pi',
        provider: 'opencode-go',
        id: 'deepseek-v4-flash',
        ref: 'opencode-go/deepseek-v4-flash',
      },
    ]);
  });

  it('never treats the header as a model', () => {
    expect(parsePiRefs(`${HEADER}\n`)).toEqual([]);
  });

  it('ignores blanks and rows too short to carry a model', () => {
    expect(parsePiRefs('')).toEqual([]);
    expect(parsePiRefs('\n  \n')).toEqual([]);
    // The real format is unverified; a malformed row must be skipped, not
    // parsed into a ref with an undefined id.
    expect(parsePiRefs(`${HEADER}\nopencode-go\n`)).toEqual([]);
  });
});

describe('adapter registry', () => {
  it('resolves pi', () => {
    expect(getAdapter('pi').name).toBe('pi');
  });

  it('declares the supported version range and bin path', () => {
    const adapter = getAdapter('pi');
    expect(adapter.versionCommand).toEqual(['pi', '--version']);
    expect(adapter.supportedVersions).toBe('>=0.84.0 <1.0.0');
    expect(adapter.pathPrepend).toEqual(['$HOME/.local/bin']);
  });
});
