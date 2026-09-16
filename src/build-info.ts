import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What a local build stamps beside itself.
 *
 * Written by `scripts/build-stamp.mjs` on every `npm run build` that is not a
 * release build, so a development install can say *when* it was built. The
 * commit is recorded alongside because a timestamp alone cannot distinguish a
 * rebuild of the same code from a rebuild of different code.
 */
export interface BuildInfo {
  /** Local time, `yyyymmdd-hhmmss` — the same clock the user reads. */
  builtAt: string;
  /** Short commit the build came from, or `unknown` outside a git checkout. */
  commit: string;
  /** Whether the worktree had uncommitted changes at build time. */
  dirty: boolean;
}

/**
 * The version string a build reports.
 *
 * A published install has no stamp and reports the manifest version unchanged
 * — that number is the truth there, and appending anything to it would make
 * `sonata --version` disagree with npm. A local build reports
 * `<version>+dev.<timestamp>`, because the manifest version of a development
 * install is whatever the last release set and says nothing about the code
 * actually running: two clones at different commits both claim `0.9.1`.
 *
 * **Build metadata, not a prerelease.** The first version of this emitted
 * `<version>-dev-<timestamp>`, which is a valid semver *prerelease* — and a
 * prerelease sorts *below* its release, so a build made from code newer than
 * 0.9.1 announced itself as older than 0.9.1. Anything that compared them
 * would have got the answer backwards, which is the one question the stamp
 * exists to answer. Metadata after `+` is ignored for precedence entirely, so
 * the string says "0.9.1 plus these local changes" and claims nothing about
 * what version is coming next.
 *
 * `.dirty` rides on the end when the worktree was not clean, since that is
 * exactly the build whose commit does not describe it.
 */
export function stampedVersion(version: string, info?: BuildInfo): string {
  if (info === undefined) return version;
  return `${version}+dev.${info.builtAt}${info.dirty ? '.dirty' : ''}`;
}

/**
 * Read the stamp sitting beside the executing file, or `undefined`.
 *
 * Absent is the normal case twice over: a published install never has one, and
 * neither does `npm run dev`, which runs `src/` through tsx and was never
 * built. So an unreadable or malformed stamp degrades to "no stamp" rather
 * than throwing — a version command that fails tells you less than a version
 * command that omits one field.
 */
export function readBuildInfo(dir: string): BuildInfo | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'build-info.json'), 'utf8')) as Partial<BuildInfo>;
    if (typeof parsed.builtAt !== 'string' || parsed.builtAt === '') return undefined;
    return {
      builtAt: parsed.builtAt,
      commit: typeof parsed.commit === 'string' && parsed.commit !== '' ? parsed.commit : 'unknown',
      dirty: parsed.dirty === true,
    };
  } catch {
    return undefined;
  }
}
