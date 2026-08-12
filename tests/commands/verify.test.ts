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
