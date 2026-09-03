/**
 * Did the run actually change anything?
 *
 * A dispatched run can finish `DONE`, un-degraded, with a confident report —
 * "fixed the bug", "added the test" — having touched nothing at all. Every
 * other guard in sonata checks whether the harness *reported* (an exit
 * sentinel, a report file, provenance); none checks whether the repository
 * moved. That is the last shape of false success the report contract cannot
 * see, because a model that did nothing and a model that did everything write
 * the same file.
 *
 * The check is a fingerprint, not a diff: one hash over `git rev-parse HEAD`,
 * `git status --porcelain`, and a blob hash for the content of every path git
 * does not consider committed-clean. That covers a commit, a staged or unstaged
 * edit, a newly created file, a deletion — every way a run is supposed to leave
 * a mark.
 *
 * **It is inert outside git.** Sonata dispatches in whatever directory it is
 * pointed at, and plenty of them are not repositories. A missing repo, a
 * missing `git`, a permissions failure — every one returns `undefined`, which
 * callers read as "unknown", never as "unchanged". A feature that exists to
 * catch a silent failure must not invent one.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The raw capture the launch wrapper writes the moment the harness exits, and
 * hashes here.
 *
 * The bytes are stored rather than the finished hash because the wrapper is
 * bash: a second implementation of the formula is precisely the kind of
 * duplicate definition that drifts without anything failing loudly. Here there
 * is nothing left to duplicate — the formula is "sha256 of this stream", and
 * both ends run the same `WORKTREE_CAPTURE_SH` to produce it.
 */
export const WORKTREE_CAPTURE_FILE = 'worktree-capture';

/**
 * The one definition of what gets fingerprinted, run by both ends: directly by
 * `worktreeFingerprint` for the launch sample, and embedded in the launch
 * wrapper for the closing one. Two samples that disagree about what they
 * measure are worse than no check at all, so there is exactly one script.
 *
 * It writes three NUL-separated sections to stdout — NUL because it cannot
 * occur in any of them, so no two different readings can run together at a
 * join and hash alike. Exiting non-zero (outside a repository) is how both
 * callers learn to report *unknown*.
 *
 * **Section 3 is why this is not just status.** `git status --porcelain`
 * records which paths are in what state and never their content: measured, a
 * tracked file that is already ` M` at launch and edited again reports the
 * identical line, and so does an existing `??` file whose content is replaced.
 * A run that only touched work already in progress — the ordinary case when
 * dispatching mid-feature — would have been reported as having changed
 * nothing. So every path git does not consider committed-clean is content
 * hashed with `git hash-object`, which is exact for binaries too, costs one
 * process, and writes nothing (no `-w`, so no object enters the user's repo:
 * this check must stay read-only).
 *
 * Three details are load-bearing:
 *
 * - **`.sonata` is excluded from the enumeration.** `status` collapses an
 *   untracked directory to a single entry, but `ls-files -o` lists every file
 *   under it — including the `report.md`, `exit` and capture files this very
 *   run is about to write. In a repository that does not ignore `.sonata/`,
 *   enumerating them would make *every* run look changed, which fails in the
 *   useless direction: an annotation that is always present says nothing.
 * - **`git diff --cached` is the fallback** for a repository with no commits,
 *   where `HEAD` does not resolve and the first form is a fatal error.
 * - **`[ -f "$p" ]` filters before hashing.** A path in the list may not exist
 *   (a deletion, which section 2 already records) or may be git's quoted
 *   rendering of a name containing a control character, which `--stdin-paths`
 *   cannot resolve. Dropping those degrades that one path to status-only
 *   rather than failing the whole capture into "unknown".
 */
export const WORKTREE_CAPTURE_SH = [
  'git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 1',
  'git rev-parse HEAD 2>/dev/null || true',
  "printf '\\0'",
  'git -c core.quotePath=false status --porcelain',
  "printf '\\0'",
  'sonata_paths=$(',
  "  { git -c core.quotePath=false ls-files -o --exclude-standard -- . ':!.sonata'",
  "    git -c core.quotePath=false diff --name-only HEAD -- . ':!.sonata' 2>/dev/null \\",
  "      || git -c core.quotePath=false diff --name-only --cached -- . ':!.sonata' 2>/dev/null",
  '  } | sort -u',
  ')',
  'printf \'%s\\0\' "$sonata_paths"',
  'if [ -n "$sonata_paths" ]; then',
  '  printf \'%s\\n\' "$sonata_paths" \\',
  '    | while IFS= read -r sonata_p; do [ -f "$sonata_p" ] && printf \'%s\\n\' "$sonata_p"; done \\',
  '    | git hash-object --stdin-paths',
  'fi',
].join('\n');

function fingerprintOf(capture: Buffer): string {
  return createHash('sha256').update(capture).digest('hex');
}

/**
 * A hash of the working tree's current state, or `undefined` when `cwd` is not
 * a usable git repository.
 *
 * The capture is hashed as **bytes**, never as a decoded string: it carries
 * path names straight from git, and a name that is not valid UTF-8 would
 * otherwise be replaced character-for-character and stop distinguishing two
 * different trees.
 */
export function worktreeFingerprint(cwd: string): string | undefined {
  try {
    return fingerprintOf(execFileSync('bash', ['-c', WORKTREE_CAPTURE_SH], {
      cwd,
      // stderr is discarded rather than inherited: outside a repository git
      // writes "not a git repository" to it, and that is an expected answer
      // here, not something to put in front of the user mid-run.
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    }));
  } catch {
    return undefined;
  }
}

/**
 * The fingerprint the launch wrapper captured as the harness exited, or
 * `undefined` when this run has none.
 *
 * Absence is the ordinary answer in three cases, all of them *unknown* rather
 * than "unchanged": a read-only role, for which no capture is requested; a
 * working directory that is not a git repository, where the wrapper removes the
 * file rather than leaving the empty one the redirection created, since an
 * empty capture would otherwise hash to a perfectly stable value; and a run
 * launched by a sonata predating the capture.
 */
export function worktreeFingerprintAtExit(runDir: string): string | undefined {
  try {
    return fingerprintOf(readFileSync(join(runDir, WORKTREE_CAPTURE_FILE)));
  } catch {
    return undefined;
  }
}

/**
 * Whether the tree is byte-for-byte where it was at launch — `undefined` when
 * either end of the comparison is missing.
 *
 * The two undefined cases are deliberately indistinguishable from each other
 * and from "not a repository": a run recorded before `worktreeAtLaunch`
 * existed, and a repository that has since become unreadable, are both
 * *unknown*. Returning `false` for either would claim the run made a change on
 * no evidence; returning `true` would accuse it of doing nothing on no
 * evidence. Only a comparison with both ends present says anything.
 *
 * The closing sample comes from `runDir`'s capture when there is one, and only
 * otherwise from the live tree. Sampling live is a measurement of *now*, not of
 * the run: `sonata tail` may first observe a finished run seconds or hours
 * after it exited, and anything that touched the repository in between — the
 * user's own editing, a concurrent dispatch, a revert — lands in the answer.
 * The capture is taken by the launch wrapper before it writes the exit
 * sentinel, so nothing can be read as finished until its closing state is
 * already recorded.
 */
export function worktreeUnchangedSince(
  launchFingerprint: string | undefined,
  cwd: string,
  runDir?: string,
): boolean | undefined {
  if (launchFingerprint === undefined) return undefined;
  const current = (runDir === undefined ? undefined : worktreeFingerprintAtExit(runDir))
    ?? worktreeFingerprint(cwd);
  if (current === undefined) return undefined;
  return current === launchFingerprint;
}
