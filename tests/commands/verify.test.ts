import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdVerify } from '../../src/commands/verify.js';

function runDirWith(meta: object): string {
  const cwd = mkdtempSync(join(tmpdir(), 'verify-'));
  const dir = join(cwd, '.sonata', 'runs', 'abc123');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));
  return cwd;
}

describe('cmdVerify', () => {
  const meta = { id: 'abc123', model: 'opencode-openrouter-kimi-k3', harness: 'opencode', role: 'explore' };

  it('confirms a run that exists', () => {
    const res = cmdVerify({ cwd: runDirWith(meta), id: 'abc123' });
    expect(res.ok).toBe(true);
    expect(res.detail).toContain('opencode-openrouter-kimi-k3');
  });

  it('fails for an id with no run, naming where it looked', () => {
    const res = cmdVerify({ cwd: runDirWith(meta), id: 'nope' });
    expect(res.ok).toBe(false);
    expect(res.detail).toContain('nope');
  });

  it('fails when the model does not match, naming both', () => {
    const res = cmdVerify({ cwd: runDirWith(meta), id: 'abc123', model: 'something-else' });
    expect(res.ok).toBe(false);
    expect(res.detail).toContain('something-else');
    expect(res.detail).toContain('opencode-openrouter-kimi-k3');
  });
});

describe('cmdVerify — unusable meta', () => {
  it('does not report ok for meta that is not an object', () => {
    // Reading fields off 42 yields undefined, which read as a successful
    // verification of a run that, so far as the meta says, never happened.
    for (const body of ['42', '"x"', '[]', 'null', 'true']) {
      const res = cmdVerify({ cwd: runDirWith(JSON.parse(body)), id: 'abc123' });
      expect(res.ok).toBe(false);
    }
  });

  it('does not report ok when the meta names no model', () => {
    expect(cmdVerify({ cwd: runDirWith({ id: 'abc123' }), id: 'abc123' }).ok).toBe(false);
  });
});
