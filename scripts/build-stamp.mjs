#!/usr/bin/env node
/**
 * Stamp a local build so `sonata --version` can name it.
 *
 * A development install's manifest version is whatever the last release set,
 * so every clone on every commit claims the same number — and `sonata` on PATH
 * runs `dist/`, not `src/`, which is how a fix can land and appear not to.
 * The stamp makes the running build identifiable without touching
 * `package.json`, which `scripts/release.mjs` and the release tag must keep
 * agreeing about.
 *
 * Skipped on CI, so nothing a release builds carries a `-dev` suffix.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

// `npm publish` runs the build through prepublishOnly, and the tarball ships
// dist/ — a stamp written there would reach users as a `-dev` version.
if (process.env.CI !== undefined || process.env.SONATA_RELEASE_BUILD !== undefined) process.exit(0);
if (!existsSync(dist)) process.exit(0);

const git = (...args) => {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    // Not a checkout, or no git. A stamp without a commit is still useful.
    return '';
  }
};

const now = new Date();
const p = (n, width = 2) => String(n).padStart(width, '0');
// Local time, not UTC: this is read beside a wall clock, and a user comparing
// a build to "the one I made just now" should not have to convert.
const builtAt = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`
  + `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;

const commit = git('rev-parse', '--short', 'HEAD');
const dirty = git('status', '--porcelain') !== '';

writeFileSync(
  join(dist, 'build-info.json'),
  `${JSON.stringify({ builtAt, commit: commit === '' ? 'unknown' : commit, dirty }, undefined, 2)}\n`,
);
