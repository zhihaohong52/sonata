/**
 * Where a *linked git worktree* borrows its project state from.
 *
 * A `git worktree add` checkout is a different directory sharing one
 * repository, and everything sonata keys on `cwd` — `sonata.toml`, the
 * generated agents, `.claude/settings.local.json` — is untracked, so a
 * worktree starts life with none of it. A session launched there therefore
 * resolved no project config, fell through to the machine config (or none),
 * and native tier agents died with `model_not_found` against
 * `api.anthropic.com` — reported 2026-09-10 from a `teambuilding` worktree.
 *
 * Detection is pure filesystem, never `git rev-parse`: `configPath` is on the
 * router's per-request tenant-resolution path, and a subprocess per request is
 * not affordable. A linked worktree's `.git` is a *file* reading
 * `gitdir: <common>/worktrees/<name>`, and that directory holds a `commondir`
 * pointing back at the main checkout's `.git`. Both are plain text and stable
 * across every git version that has shipped worktrees.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * The main checkout backing `cwd`, or null when `cwd` is not a linked
 * worktree (an ordinary repository, a bare repo's `.git`, or no repo at all).
 *
 * Every malformed shape answers null rather than throwing: this sits under
 * config resolution, and a repository sonata cannot read must degrade to
 * today's behaviour rather than break a command that would otherwise work.
 */
export function mainWorktreeDir(cwd: string): string | null {
  const dotGit = join(cwd, '.git');
  let isFile: boolean;
  try {
    isFile = statSync(dotGit).isFile();
  } catch {
    return null;
  }
  // A directory means this *is* the main checkout; there is nothing to borrow.
  if (!isFile) return null;

  let pointer: string;
  try {
    pointer = readFileSync(dotGit, 'utf8');
  } catch {
    return null;
  }

  const match = /^gitdir:\s*(.+?)\s*$/m.exec(pointer);
  if (match === null) return null;
  const gitDir = isAbsolute(match[1]) ? match[1] : resolve(cwd, match[1]);

  // A submodule's `.git` file also points at a gitdir, but has no `commondir`
  // — so this check is what keeps a submodule from being read as a worktree.
  const commonFile = join(gitDir, 'commondir');
  if (!existsSync(commonFile)) return null;

  let common: string;
  try {
    common = readFileSync(commonFile, 'utf8').trim();
  } catch {
    return null;
  }
  if (common.length === 0) return null;

  const commonDir = isAbsolute(common) ? common : resolve(gitDir, common);
  // `commondir` names the main checkout's `.git`; its parent is the checkout.
  // A bare repository has no working tree, and the caller's own existsSync on
  // whatever it is looking for is what rejects that case.
  const main = dirname(commonDir);
  return main === cwd ? null : main;
}
