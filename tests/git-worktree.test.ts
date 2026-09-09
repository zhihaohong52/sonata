import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mainWorktreeDir } from '../src/git-worktree.js';
import { configPath } from '../src/config.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });

/** A real repository with one linked worktree — the shape this exists for. */
function repoWithWorktree(): { main: string; worktree: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-')));
  const main = join(root, 'main');
  mkdirSync(main);
  git(main, 'init', '-q', '.');
  git(main, 'config', 'user.email', 'a@b.test');
  git(main, 'config', 'user.name', 'a');
  writeFileSync(join(main, 'a'), 'hi\n');
  git(main, 'add', 'a');
  git(main, 'commit', '-qm', 'x');
  const worktree = join(root, 'wt1');
  git(main, 'worktree', 'add', '-q', worktree, '-b', 'wt1');
  return { main, worktree };
}

const MINIMAL = `
[models."m"]
harness = "codex"
id = "gpt-5.6-sol"

[generate.roles]
code = ["m"]
`;

describe('mainWorktreeDir', () => {
  it('resolves a linked worktree to the main checkout', () => {
    const { main, worktree } = repoWithWorktree();
    expect(mainWorktreeDir(worktree)).toBe(main);
  });

  it('answers null for the main checkout itself', () => {
    const { main } = repoWithWorktree();
    expect(mainWorktreeDir(main)).toBeNull();
  });

  it('answers null outside a repository', () => {
    expect(mainWorktreeDir(mkdtempSync(join(tmpdir(), 'plain-')))).toBeNull();
  });

  it('answers null for a .git file with no commondir (a submodule)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sub-'));
    const gitDir = join(dir, 'gitdir');
    mkdirSync(gitDir);
    writeFileSync(join(dir, '.git'), `gitdir: ${gitDir}\n`);
    expect(mainWorktreeDir(dir)).toBeNull();
  });

  it('answers null for a malformed .git file rather than throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bad-'));
    writeFileSync(join(dir, '.git'), 'not a pointer at all\n');
    expect(mainWorktreeDir(dir)).toBeNull();
  });
});

describe('configPath in a linked worktree', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'wt-home-'));
  });

  const writeGlobal = () => {
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(join(home, '.config', 'sonata', 'sonata.toml'), MINIMAL);
  };

  it("borrows the main checkout's config", () => {
    const { main, worktree } = repoWithWorktree();
    writeFileSync(join(main, 'sonata.toml'), MINIMAL);
    expect(configPath(worktree, home)).toBe(join(main, 'sonata.toml'));
  });

  it("prefers the main checkout's config over the machine one", () => {
    const { main, worktree } = repoWithWorktree();
    writeFileSync(join(main, 'sonata.toml'), MINIMAL);
    writeGlobal();
    expect(configPath(worktree, home)).toBe(join(main, 'sonata.toml'));
  });

  it("prefers the worktree's own config over the main checkout's", () => {
    const { main, worktree } = repoWithWorktree();
    writeFileSync(join(main, 'sonata.toml'), MINIMAL);
    writeFileSync(join(worktree, 'sonata.toml'), MINIMAL);
    expect(configPath(worktree, home)).toBe(join(worktree, 'sonata.toml'));
  });

  it('still falls through to the machine config when the main checkout has none', () => {
    const { worktree } = repoWithWorktree();
    writeGlobal();
    expect(configPath(worktree, home)).toBe(join(home, '.config', 'sonata', 'sonata.toml'));
  });
});
