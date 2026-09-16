import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBuildInfo, stampedVersion } from '../src/build-info.js';

describe('stampedVersion', () => {
  it('leaves a published version untouched', () => {
    // No stamp is the published case, where the manifest version is the truth
    // and appending to it would disagree with npm.
    expect(stampedVersion('0.9.1', undefined)).toBe('0.9.1');
  });

  it('names when a local build was made', () => {
    expect(stampedVersion('0.9.1', { builtAt: '20260916-104311', commit: 'abc1234', dirty: false }))
      .toBe('0.9.1+dev.20260916-104311');
  });

  it('sorts after its own release, never before it', () => {
    // The first version emitted `0.9.1-dev-<ts>`, a semver *prerelease*, which
    // sorts BELOW 0.9.1 — so a build newer than the release announced itself
    // as older. Metadata after `+` is ignored for precedence, so this cannot
    // happen again.
    const stamped = stampedVersion('0.9.1', { builtAt: '20260916-104311', commit: 'abc1234', dirty: false });
    expect(stamped.includes('-dev')).toBe(false);
    expect(stamped.split('+')[0]).toBe('0.9.1');
  });

  it('marks a build made from a dirty worktree', () => {
    // The commit does not describe this build, which is exactly when saying so
    // matters most.
    expect(stampedVersion('0.9.1', { builtAt: '20260916-104311', commit: 'abc1234', dirty: true }))
      .toBe('0.9.1+dev.20260916-104311.dirty');
  });
});

describe('readBuildInfo', () => {
  const write = (body: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'sonata-stamp-'));
    writeFileSync(join(dir, 'build-info.json'), body);
    return dir;
  };

  it('reads a stamp', () => {
    const dir = write(JSON.stringify({ builtAt: '20260916-104311', commit: 'abc1234', dirty: true }));
    expect(readBuildInfo(dir)).toEqual({ builtAt: '20260916-104311', commit: 'abc1234', dirty: true });
  });

  it('reports no stamp rather than throwing', () => {
    // Absent is the normal case twice over — a published install and `npm run
    // dev` both have none — so every unreadable shape degrades the same way.
    expect(readBuildInfo(mkdtempSync(join(tmpdir(), 'sonata-stamp-')))).toBeUndefined();
    expect(readBuildInfo(write('not json'))).toBeUndefined();
    expect(readBuildInfo(write(JSON.stringify({ commit: 'abc1234' })))).toBeUndefined();
    expect(readBuildInfo(write(JSON.stringify({ builtAt: '' })))).toBeUndefined();
  });

  it('fills in an absent commit and defaults dirty to false', () => {
    const dir = write(JSON.stringify({ builtAt: '20260916-104311' }));
    expect(readBuildInfo(dir)).toEqual({ builtAt: '20260916-104311', commit: 'unknown', dirty: false });
  });
});
