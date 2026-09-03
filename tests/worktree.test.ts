import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  worktreeFingerprint, worktreeFingerprintAtExit, worktreeUnchangedSince,
} from '../src/worktree.js';
import { wrapWithTimeout } from '../src/watchdog.js';

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

describe('the fingerprint captured at exit', () => {
  let dir: string;
  let runDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sonata-worktree-exit-'));
    runDir = join(dir, '.sonata', 'runs', 'r1');
    mkdirSync(runDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Writes the real launch wrapper, exactly as `cmdRun` does, and returns a
   * function that runs it.
   *
   * Split in two because `cmdRun` samples `worktreeAtLaunch` *after* writing
   * this scaffolding, precisely so sonata's own files are present in both
   * samples. A test that samples before writing them measures sonata setting
   * itself up and calls it the run's work.
   */
  function stageWrapper(worktreeCwd: string | undefined, harness = 'true'): () => void {
    const harnessPath = join(runDir, 'harness.sh');
    writeFileSync(harnessPath, `#!/bin/bash\n${harness}\n`, { mode: 0o755 });
    const scriptPath = join(runDir, 'cmd.sh');
    writeFileSync(scriptPath, wrapWithTimeout({
      harnessScriptPath: harnessPath,
      runDir,
      timeoutSeconds: 60,
      interactive: false,
      worktreeCwd,
    }), { mode: 0o755 });
    return () => execFileSync('bash', [scriptPath], { cwd: dir, stdio: ['ignore', 'ignore', 'ignore'] });
  }

  function runWrapper(worktreeCwd: string | undefined, harness = 'true'): void {
    stageWrapper(worktreeCwd, harness)();
  }

  it('agrees byte-for-byte with the fingerprint Node computes live', () => {
    // The anti-drift test. The wrapper is bash and the hash is TypeScript, so
    // the two could only agree by the wrapper capturing raw git output and
    // Node owning the formula. Reimplementing sha256 over a NUL-separated pair
    // in shell is exactly what this proves unnecessary.
    initRepo(dir);
    writeFileSync(join(dir, 'work.txt'), 'from the harness\n');

    runWrapper(dir);

    expect(worktreeFingerprintAtExit(runDir)).toBe(worktreeFingerprint(dir));
  });

  it('agrees in a repository with no commits yet', () => {
    // `git rev-parse HEAD` fails here, and the live path folds that in as ''.
    // The wrapper has to produce the same empty head rather than no file.
    git(['init'], dir);
    writeFileSync(join(dir, 'only.txt'), 'x\n');

    runWrapper(dir);

    expect(worktreeFingerprintAtExit(runDir)).toBe(worktreeFingerprint(dir));
  });

  it('captures nothing outside a git repository', () => {
    // Unknown must stay unknown. The redirection creates the status file
    // before git can fail, and an empty status reads as a clean tree — so the
    // wrapper removes it rather than leaving that behind.
    runWrapper(dir);

    expect(worktreeFingerprintAtExit(runDir)).toBeUndefined();
  });

  it('captures nothing when the role asked for no fingerprint', () => {
    initRepo(dir);

    runWrapper(undefined);

    expect(worktreeFingerprintAtExit(runDir)).toBeUndefined();
  });

  it('survives a worktree edited after exit but before the first tail', () => {
    // The reason the capture exists. `sonata run` returns immediately and the
    // first `sonata tail` can arrive hours later; sampling the tree then
    // measures whatever the repository holds by then, not what the run left.
    // Here the run genuinely changes nothing and the user edits afterwards:
    // comparing live would report a change the run did not make.
    initRepo(dir);
    const run = stageWrapper(dir);
    const atLaunch = worktreeFingerprint(dir);

    run();

    writeFileSync(join(dir, 'user-edit.txt'), 'nothing to do with the run\n');

    expect(worktreeUnchangedSince(atLaunch, dir, runDir)).toBe(true);
    // Without the capture, the same comparison is at the mercy of that edit.
    expect(worktreeUnchangedSince(atLaunch, dir)).toBe(false);
  });

  it('still reports a run that did change the tree', () => {
    initRepo(dir);
    const run = stageWrapper(dir, `printf 'work\\n' > '${join(dir, 'changed.txt')}'`);
    const atLaunch = worktreeFingerprint(dir);

    run();

    expect(worktreeUnchangedSince(atLaunch, dir, runDir)).toBe(false);
  });

  it('falls back to the live tree for a run launched before captures existed', () => {
    // An in-flight run started by the previous sonata has no capture files.
    // That is unknown-at-exit, not "unchanged" — so the live sample, which is
    // what it would have got anyway, is still the right answer.
    initRepo(dir);
    const atLaunch = worktreeFingerprint(dir);

    expect(worktreeUnchangedSince(atLaunch, dir, runDir)).toBe(true);
    writeFileSync(join(dir, 'later.txt'), 'x\n');
    expect(worktreeUnchangedSince(atLaunch, dir, runDir)).toBe(false);
  });
});
