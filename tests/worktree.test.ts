import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { worktreeFingerprint, worktreeUnchangedSince } from '../src/worktree.js';

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'ignore'] });
}

/** A real repository, since the whole point is what git actually reports. */
function initRepo(dir: string): void {
  git(['init'], dir);
  // Set locally rather than relying on a global identity: CI has none, and
  // `git commit` fails without one.
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  writeFileSync(join(dir, 'seed.txt'), 'seed\n');
  git(['add', '.'], dir);
  git(['commit', '-m', 'seed'], dir);
}

describe('worktreeFingerprint', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sonata-worktree-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is undefined outside a git repository', () => {
    // The inert case, and the one that matters most: sonata dispatches into
    // whatever directory it is pointed at, and a non-repository must produce
    // "unknown", never an error and never a false "unchanged".
    expect(worktreeFingerprint(dir)).toBeUndefined();
  });

  it('is stable when nothing changes', () => {
    initRepo(dir);
    expect(worktreeFingerprint(dir)).toBe(worktreeFingerprint(dir));
  });

  it('moves when a tracked file is edited', () => {
    initRepo(dir);
    const before = worktreeFingerprint(dir);
    writeFileSync(join(dir, 'seed.txt'), 'edited\n');
    expect(worktreeFingerprint(dir)).not.toBe(before);
  });

  it('moves when an untracked file appears', () => {
    initRepo(dir);
    const before = worktreeFingerprint(dir);
    writeFileSync(join(dir, 'fresh.txt'), 'new\n');
    expect(worktreeFingerprint(dir)).not.toBe(before);
  });

  it('moves when work is committed, leaving a clean tree', () => {
    // `git status --porcelain` alone returns to empty after a commit, so
    // without HEAD in the hash a run whose only trace is a commit would look
    // like a run that did nothing — the exact false negative this check exists
    // to avoid.
    initRepo(dir);
    const before = worktreeFingerprint(dir);
    writeFileSync(join(dir, 'seed.txt'), 'edited\n');
    git(['commit', '-am', 'work'], dir);
    expect(worktreeFingerprint(dir)).not.toBe(before);
  });

  it('works in a repository with no commits yet', () => {
    // No HEAD to resolve, but a working tree worth fingerprinting. Going inert
    // here would silently disable the check for a freshly initialised repo.
    git(['init'], dir);
    writeFileSync(join(dir, 'only.txt'), 'x\n');
    expect(worktreeFingerprint(dir)).toBeTypeOf('string');
  });

  it('ignores files under an ignored directory', () => {
    // Sonata writes its own run scaffolding into `.sonata/` inside cwd. When
    // that is ignored it must not register as the run's work; when it is not
    // ignored, git lists the directory once rather than enumerating it, so
    // files added inside still do not move the fingerprint.
    initRepo(dir);
    writeFileSync(join(dir, '.gitignore'), '.sonata/\n');
    git(['add', '.gitignore'], dir);
    git(['commit', '-m', 'ignore'], dir);
    const before = worktreeFingerprint(dir);
    mkdirSync(join(dir, '.sonata', 'runs', 'abc'), { recursive: true });
    writeFileSync(join(dir, '.sonata', 'runs', 'abc', 'report.md'), 'done\n');
    expect(worktreeFingerprint(dir)).toBe(before);
  });
});

describe('worktreeUnchangedSince', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sonata-worktree-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is undefined when there is no launch fingerprint', () => {
    // A run recorded before the field existed. Unknown, not "changed".
    initRepo(dir);
    expect(worktreeUnchangedSince(undefined, dir)).toBeUndefined();
  });

  it('is undefined when the directory is not a repository', () => {
    expect(worktreeUnchangedSince('abc123', dir)).toBeUndefined();
  });

  it('is true when nothing moved', () => {
    initRepo(dir);
    expect(worktreeUnchangedSince(worktreeFingerprint(dir), dir)).toBe(true);
  });

  it('is false when something moved', () => {
    initRepo(dir);
    const launch = worktreeFingerprint(dir);
    writeFileSync(join(dir, 'seed.txt'), 'edited\n');
    expect(worktreeUnchangedSince(launch, dir)).toBe(false);
  });
});
