import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneAgents, staleAgents } from '../src/detect.js';

const MARKER = 'forwarding wrapper around the sonata runtime';

describe('pruneAgents', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'prune-'));
    writeFileSync(join(dir, 'code-old.md'), MARKER);
    writeFileSync(join(dir, 'code-keep.md'), MARKER);
    writeFileSync(join(dir, 'my-own-agent.md'), 'hand written, not sonata');
  });

  it('removes exactly the files it is given', () => {
    expect(pruneAgents(dir, ['code-old.md'])).toEqual(['code-old.md']);
    expect(existsSync(join(dir, 'code-old.md'))).toBe(false);
    expect(existsSync(join(dir, 'code-keep.md'))).toBe(true);
  });

  it('cannot touch a hand-written agent, because staleAgents never names one', () => {
    const stale = staleAgents(dir, ['code-keep']);
    expect(stale).not.toContain('my-own-agent.md');
    pruneAgents(dir, stale);
    expect(existsSync(join(dir, 'my-own-agent.md'))).toBe(true);
  });

  it('tolerates a file already gone', () => {
    // A concurrent sync removing it first is a race, not an error.
    expect(pruneAgents(dir, ['code-old.md', 'never-existed.md'])).toEqual(['code-old.md']);
  });
});
