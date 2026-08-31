#!/usr/bin/env node
/**
 * `npm run release -- <version>` — prepare a release commit and its tag.
 *
 * Every release before this one was assembled by hand: edit CHANGELOG.md,
 * bump package.json, write the commit, create the tag. That worked, and it
 * also meant the changelog was reconstructed at release time from memory and
 * git log, which is the moment you are least able to say why a change
 * mattered. Entries now accumulate under `## [Unreleased]` while the work is
 * fresh, and this promotes that section to a dated heading.
 *
 * It deliberately does NOT push. `release.yml` fires on the tag, and pushing
 * is what publishes to npm — that stays a separate, deliberate act.
 *
 * The pure halves are exported for tests; the CLI only runs when this file is
 * executed directly.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const UNRELEASED = '## [Unreleased]';

/** Semver triple compare — string compare puts 0.10.0 below 0.9.0. */
function compare(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

export function assertNextVersion(next, current) {
  // `\d+` per component would accept `01.0.0`, which SemVer 2.0.0 disallows —
  // and it compares as 1.0.0, so it clears the greater-than check below and
  // reaches the CHANGELOG heading, which is written before `npm version` ever
  // sees the string. `(0|[1-9]\d*)` is the spec's own numeric identifier.
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(next)) {
    throw new Error(`release: "${next}" is not a semver version (expected MAJOR.MINOR.PATCH, no leading v or leading zeroes)`);
  }
  if (compare(next, current) <= 0) {
    throw new Error(`release: ${next} must be greater than the current version ${current}`);
  }
}

/**
 * Moves the accumulated `[Unreleased]` entries under a dated version heading
 * and opens a fresh empty `[Unreleased]` above it.
 *
 * Refuses an absent or empty section rather than producing a version with no
 * notes: `release.yml` reads the GitHub Release body straight back out of
 * this file, so an empty section ships as an empty release.
 */
export function promoteUnreleased(changelog, version, date) {
  const start = changelog.indexOf(UNRELEASED);
  if (start === -1) {
    throw new Error(`release: CHANGELOG.md has no "${UNRELEASED}" section to promote`);
  }
  const bodyStart = start + UNRELEASED.length;
  const nextHeading = changelog.indexOf('\n## ', bodyStart);
  const body = (nextHeading === -1 ? changelog.slice(bodyStart) : changelog.slice(bodyStart, nextHeading));
  if (body.trim() === '') {
    throw new Error('release: the [Unreleased] section is empty — write the notes before releasing');
  }
  return changelog.slice(0, start) +
    `${UNRELEASED}\n\n## [${version}] - ${date}` +
    changelog.slice(bodyStart);
}

/** One version's notes, for the GitHub Release body. */
export function sectionFor(changelog, version) {
  const heading = new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\][^\\n]*$`, 'm');
  const match = heading.exec(changelog);
  if (match === null) return undefined;
  const bodyStart = match.index + match[0].length;
  const nextHeading = changelog.indexOf('\n## ', bodyStart);
  const body = nextHeading === -1 ? changelog.slice(bodyStart) : changelog.slice(bodyStart, nextHeading);
  return body.trim();
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function main(argv) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const pkgPath = join(root, 'package.json');
  const changelogPath = join(root, 'CHANGELOG.md');

  // `--notes <version>` prints one version's CHANGELOG section on stdout.
  // `release.yml` uses it for the GitHub Release body, so the notes and the
  // changelog have exactly one source; the alternative was inlining this
  // extraction into YAML, where it is neither reviewed nor tested.
  if (argv[0] === '--notes') {
    const version = argv[1];
    if (version === undefined) throw new Error('usage: release.mjs --notes <version>');
    const body = sectionFor(readFileSync(changelogPath, 'utf8'), version);
    if (body === undefined) throw new Error(`release: CHANGELOG.md has no section for ${version}`);
    process.stdout.write(`${body}\n`);
    return;
  }

  const version = argv[0];
  if (version === undefined) {
    throw new Error('usage: npm run release -- <version>   (e.g. npm run release -- 0.4.0)');
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

  assertNextVersion(version, pkg.version);

  // A dirty tree would sweep unrelated edits into the release commit, and the
  // tag would then name a tree nobody reviewed.
  if (git('status', '--porcelain') !== '') {
    throw new Error('release: working tree is not clean — commit or stash first');
  }
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch !== 'main') {
    throw new Error(`release: on branch ${branch}, expected main`);
  }

  const date = new Date().toISOString().slice(0, 10);
  const promoted = promoteUnreleased(readFileSync(changelogPath, 'utf8'), version, date);
  writeFileSync(changelogPath, promoted);

  // `npm version` keeps package-lock.json in step; doing it by hand is how the
  // lock drifts from the manifest. --no-git-tag-version because the commit and
  // the annotated tag are made below, together, with the notes as the message.
  execFileSync('npm', ['version', version, '--no-git-tag-version'], { cwd: root, stdio: 'inherit' });

  const notes = sectionFor(promoted, version) ?? '';
  git('add', 'CHANGELOG.md', 'package.json', 'package-lock.json');
  execFileSync('git', ['commit', '-m', `chore(release): v${version}`, '-m', notes], { cwd: root, stdio: 'inherit' });
  execFileSync('git', ['tag', '-a', `v${version}`, '-m', `v${version}\n\n${notes}`], { cwd: root, stdio: 'inherit' });

  console.log(`\nPrepared v${version}. Nothing has been pushed.`);
  console.log('Review the commit, then:  git push --follow-tags');
  console.log('The tag is what triggers release.yml and publishes to npm.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
