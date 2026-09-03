import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
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

  it('moves when a file that was already dirty at launch is edited again', () => {
    // `git status --porcelain` names the path and its state, never its
    // content: measured, a tracked file already ` M` reports the identical
    // line no matter how many times it is rewritten. Dispatching into a dirty
    // worktree is the ordinary mid-feature case, so without content hashing a
    // run that edited exactly the file you were already working on would have
    // been reported as having changed nothing.
    initRepo(dir);
    writeFileSync(join(dir, 'seed.txt'), 'edited by the user\n');
    const before = worktreeFingerprint(dir);
    writeFileSync(join(dir, 'seed.txt'), 'edited by the run\n');
    expect(worktreeFingerprint(dir)).not.toBe(before);
  });

  it('moves when an untracked file that already existed changes content', () => {
    // The same blind spot from the other direction: `?? notes.txt` is `??
    // notes.txt` whatever the file now holds.
    initRepo(dir);
    writeFileSync(join(dir, 'notes.txt'), 'from the user\n');
    const before = worktreeFingerprint(dir);
    writeFileSync(join(dir, 'notes.txt'), 'from the run\n');
    expect(worktreeFingerprint(dir)).not.toBe(before);
  });

  it('moves when an already-staged file is edited further', () => {
    // Staged at launch, so it is not "modified" relative to the index and only
    // `git diff --name-only HEAD` finds it. The content hash is taken from the
    // working tree, which is what actually moved.
    initRepo(dir);
    writeFileSync(join(dir, 'seed.txt'), 'staged\n');
    git(['add', 'seed.txt'], dir);
    const before = worktreeFingerprint(dir);
    writeFileSync(join(dir, 'seed.txt'), 'and then edited\n');
    expect(worktreeFingerprint(dir)).not.toBe(before);
  });

  it('is stable across repeated samples of a dirty tree', () => {
    // Content hashing must not make the fingerprint restless: hashing the same
    // unchanged files twice has to produce the same answer, or every run would
    // report a change.
    initRepo(dir);
    writeFileSync(join(dir, 'seed.txt'), 'dirty\n');
    writeFileSync(join(dir, 'extra.txt'), 'untracked\n');
    expect(worktreeFingerprint(dir)).toBe(worktreeFingerprint(dir));
  });

  it('moves when a binary file that was already dirty changes', () => {
    // `git diff` renders a binary change as "Binary files differ" with no
    // content, which is why the capture hashes blobs rather than a patch.
    initRepo(dir);
    writeFileSync(join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255]));
    const before = worktreeFingerprint(dir);
    writeFileSync(join(dir, 'blob.bin'), Buffer.from([0, 1, 3, 0, 255]));
    expect(worktreeFingerprint(dir)).not.toBe(before);
  });

  it('writes no git object while fingerprinting', () => {
    // `git hash-object` is called without `-w` on purpose. This check runs on
    // someone else's repository and must stay read-only; a fingerprint that
    // grows the object store is not inert.
    initRepo(dir);
    writeFileSync(join(dir, 'seed.txt'), 'dirty\n');
    writeFileSync(join(dir, 'fresh.txt'), 'untracked\n');
    const objects = (): string[] =>
      execFileSync('find', [join(dir, '.git', 'objects'), '-type', 'f'], { encoding: 'utf8' })
        .split('\n').filter(Boolean).sort();
    const before = objects();
    worktreeFingerprint(dir);
    expect(objects()).toEqual(before);
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

  it('reports a run that only edited a file already dirty at launch', () => {
    // End to end through the real wrapper, in the case `git status` alone is
    // blind to: the user has `seed.txt` half-edited, dispatches, and the run
    // edits that same file and nothing else. Status reads ` M seed.txt` at both
    // ends; only the content hash moves.
    initRepo(dir);
    writeFileSync(join(dir, 'seed.txt'), 'edited by the user\n');
    const run = stageWrapper(dir, `printf 'edited by the run\\n' > '${join(dir, 'seed.txt')}'`);
    const atLaunch = worktreeFingerprint(dir);

    run();

    expect(worktreeUnchangedSince(atLaunch, dir, runDir)).toBe(false);
  });

  it('is not moved by the run\'s own scaffolding when .sonata is not ignored', () => {
    // The exclusion that makes the above safe. `status` collapses an untracked
    // directory to one entry, but `ls-files -o` enumerates it — and between the
    // two samples this run writes `worktree-capture` and `exit` into its own
    // run directory. Counting those would mark every run as having changed
    // something, an annotation that is always present and therefore says
    // nothing.
    initRepo(dir);
    const run = stageWrapper(dir);
    const atLaunch = worktreeFingerprint(dir);

    run();

    expect(existsSync(join(runDir, 'exit'))).toBe(true);
    expect(worktreeUnchangedSince(atLaunch, dir, runDir)).toBe(true);
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
