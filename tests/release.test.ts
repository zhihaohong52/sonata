import { describe, it, expect } from 'vitest';
import { promoteUnreleased, sectionFor, assertNextVersion } from '../scripts/release.mjs';

const PREAMBLE = `# Changelog

All notable changes to this project are documented in this file.
`;

const changelog = (unreleased: string) => `${PREAMBLE}
## [Unreleased]
${unreleased}
## [0.3.4] - 2026-08-29

### Fixed
- something older
`;

describe('promoteUnreleased', () => {
  const filled = changelog(`
### Added
- a thing

### Fixed
- another thing
`);

  it('dates the section under the released version', () => {
    const out = promoteUnreleased(filled, '0.4.0', '2026-08-31');
    expect(out).toContain('## [0.4.0] - 2026-08-31');
  });

  it('leaves a fresh empty Unreleased section above it for the next cycle', () => {
    const out = promoteUnreleased(filled, '0.4.0', '2026-08-31');
    const headings = [...out.matchAll(/^## .+$/gm)].map((m) => m[0]);
    expect(headings).toEqual([
      '## [Unreleased]',
      '## [0.4.0] - 2026-08-31',
      '## [0.3.4] - 2026-08-29',
    ]);
  });

  it('keeps the entries, the preamble and every older section', () => {
    const out = promoteUnreleased(filled, '0.4.0', '2026-08-31');
    expect(out).toContain('All notable changes');
    expect(out).toContain('- a thing');
    expect(out).toContain('- another thing');
    expect(out).toContain('## [0.3.4] - 2026-08-29');
    expect(out).toContain('- something older');
  });

  it('refuses a changelog with no Unreleased section', () => {
    // Releasing from a changelog that was never written to would silently
    // publish a version with no notes, and the GitHub Release body is read
    // straight out of this file.
    expect(() => promoteUnreleased(`${PREAMBLE}\n## [0.3.4] - 2026-08-29\n`, '0.4.0', '2026-08-31'))
      .toThrow(/Unreleased/);
  });

  it('refuses an Unreleased section with nothing in it', () => {
    expect(() => promoteUnreleased(changelog('\n'), '0.4.0', '2026-08-31')).toThrow(/empty/i);
  });

  it('is idempotent in shape: promoting twice yields one Unreleased heading', () => {
    const once = promoteUnreleased(filled, '0.4.0', '2026-08-31');
    const refilled = once.replace('## [Unreleased]\n', '## [Unreleased]\n\n### Fixed\n- later fix\n');
    const twice = promoteUnreleased(refilled, '0.4.1', '2026-09-01');
    expect([...twice.matchAll(/^## \[Unreleased\]$/gm)]).toHaveLength(1);
    expect(twice).toContain('## [0.4.1] - 2026-09-01');
    expect(twice).toContain('## [0.4.0] - 2026-08-31');
  });
});

describe('sectionFor', () => {
  // The release workflow uses this for the GitHub Release body, so it must
  // return one version's notes and never bleed into the next section.
  const released = `${PREAMBLE}
## [Unreleased]

## [0.4.0] - 2026-08-31

### Added
- the new thing

## [0.3.4] - 2026-08-29

### Fixed
- the old thing
`;

  it('returns only that version’s notes', () => {
    const body = sectionFor(released, '0.4.0');
    expect(body).toContain('- the new thing');
    expect(body).not.toContain('- the old thing');
    expect(body).not.toContain('## [0.3.4]');
  });

  it('returns undefined for a version not in the file', () => {
    expect(sectionFor(released, '9.9.9')).toBeUndefined();
  });
});

describe('assertNextVersion', () => {
  it('accepts a higher semver', () => {
    expect(() => assertNextVersion('0.4.0', '0.3.4')).not.toThrow();
  });

  it('rejects a version that is not semver', () => {
    expect(() => assertNextVersion('v0.4', '0.3.4')).toThrow(/semver/i);
  });

  it('rejects numeric identifiers padded with leading zeroes', () => {
    // SemVer 2.0.0 disallows these, and `\d+` per component happily accepts
    // them. `01.0.0` compares as 1.0.0 and so clears the greater-than check,
    // and the changelog heading is written before `npm version` ever sees it —
    // leaving an invalid version in a file the GitHub Release body is read
    // from.
    for (const bad of ['01.0.0', '0.04.0', '0.3.04']) {
      expect(() => assertNextVersion(bad, '0.3.4'), bad).toThrow(/semver/i);
    }
  });

  it('still accepts legitimate zero components', () => {
    expect(() => assertNextVersion('1.0.0', '0.3.4')).not.toThrow();
    expect(() => assertNextVersion('0.4.0', '0.3.4')).not.toThrow();
  });

  it('rejects a version equal to or below the current one', () => {
    // Re-releasing a version silently overwrites a tag and confuses npm.
    expect(() => assertNextVersion('0.3.4', '0.3.4')).toThrow(/greater/i);
    expect(() => assertNextVersion('0.3.3', '0.3.4')).toThrow(/greater/i);
  });

  it('compares numerically, not as strings', () => {
    // '0.10.0' < '0.9.0' as strings — the classic release-script bug.
    expect(() => assertNextVersion('0.10.0', '0.9.0')).not.toThrow();
    expect(() => assertNextVersion('0.9.0', '0.10.0')).toThrow(/greater/i);
  });
});
