import { describe, expect, it } from 'vitest';
import { GUIDANCE_BEGIN, GUIDANCE_END, guidanceBlock, mergeGuidance } from '../../src/init/guidance.js';

describe('mergeGuidance', () => {
  const block = guidanceBlock();

  it('is the whole file when there is no CLAUDE.md yet', () => {
    const merged = mergeGuidance(undefined, block);
    expect(merged).toBe(block);
    expect(merged.endsWith('\n')).toBe(true);
  });

  it('appends to a file that has no sonata block, leaving it otherwise byte-identical', () => {
    const existing = '# My project\n\nSome instructions I wrote.\n';
    const merged = mergeGuidance(existing, block);
    expect(merged.startsWith(existing)).toBe(true);
    expect(merged).toContain(GUIDANCE_BEGIN);
  });

  it('replaces only what is between the markers', () => {
    const existing = [
      '# My project',
      '',
      'Text above.',
      '',
      GUIDANCE_BEGIN,
      'stale guidance from an older sonata',
      GUIDANCE_END,
      '',
      'Text below.',
      '',
    ].join('\n');
    const merged = mergeGuidance(existing, block);
    // The point of the markers: sonata owns what is between them and nothing
    // else, so a paragraph the user wrote either side must survive verbatim.
    expect(merged).toContain('Text above.');
    expect(merged).toContain('Text below.');
    expect(merged).not.toContain('stale guidance from an older sonata');
  });

  // "The file exists" is the condition for appending, not "the file has
  // content". Replacing a whitespace-only file wholesale still changes bytes
  // outside the markers, which is the one thing this must never do.
  it('preserves a whitespace-only CLAUDE.md rather than replacing it', () => {
    const existing = '\n\n\n';
    const merged = mergeGuidance(existing, block);
    expect(merged.startsWith(existing)).toBe(true);
    expect(merged).toContain(GUIDANCE_BEGIN);
  });

  it('preserves whitespace that is not a newline', () => {
    const merged = mergeGuidance('   ', block);
    expect(merged.startsWith('   ')).toBe(true);
    expect(merged).toContain(GUIDANCE_BEGIN);
  });

  it('writes the block alone into an existing but empty file', () => {
    // Nothing to preserve, so no leading blank lines invented either.
    expect(mergeGuidance('', block)).toBe(block);
  });

  it('is idempotent — merging twice produces identical bytes', () => {
    const existing = '# My project\n\nSome instructions.\n';
    const once = mergeGuidance(existing, block);
    expect(mergeGuidance(once, block)).toBe(once);
  });

  it('refuses a begin marker with no end marker rather than guessing where it stops', () => {
    // A half-marker means the file was hand-edited. Choosing an end point
    // would silently eat whatever the user wrote after it.
    const broken = `# My project\n\n${GUIDANCE_BEGIN}\nsomething\n`;
    expect(() => mergeGuidance(broken, block)).toThrow(/unterminated|marker/i);
  });

  // A second marker pair means the file has two blocks, or a hand-edit nested
  // one inside another. Replacing first-begin..first-end spans whatever lies
  // between them — including a user paragraph sitting between two begins — so
  // every repeated shape is refused rather than partially rewritten.
  it('refuses a file with two begin markers', () => {
    const broken = [
      '# Mine', '', GUIDANCE_BEGIN, 'first', '',
      'user text between the two begins', '',
      GUIDANCE_BEGIN, 'second', GUIDANCE_END, '',
    ].join('\n');
    expect(() => mergeGuidance(broken, block)).toThrow(/more than one|duplicate|repeated/i);
  });

  it('refuses a file with two end markers', () => {
    const broken = [
      '# Mine', '', GUIDANCE_BEGIN, 'body', GUIDANCE_END, '', 'text', '', GUIDANCE_END, '',
    ].join('\n');
    expect(() => mergeGuidance(broken, block)).toThrow(/more than one|duplicate|repeated/i);
  });

  it('refuses a file carrying two complete blocks', () => {
    const broken = [
      GUIDANCE_BEGIN, 'one', GUIDANCE_END, '', 'user text', '',
      GUIDANCE_BEGIN, 'two', GUIDANCE_END, '',
    ].join('\n');
    // Rewriting only the first would leave a stale second block behind,
    // silently contradicting it.
    expect(() => mergeGuidance(broken, block)).toThrow(/more than one|duplicate|repeated/i);
  });

  it('refuses an end marker with no begin marker', () => {
    const broken = `# My project\n\n${GUIDANCE_END}\n`;
    expect(() => mergeGuidance(broken, block)).toThrow(/marker/i);
  });
});

describe('guidanceBlock', () => {
  it('is delimited by the markers mergeGuidance looks for', () => {
    const block = guidanceBlock();
    expect(block.startsWith(GUIDANCE_BEGIN)).toBe(true);
    expect(block.trimEnd().endsWith(GUIDANCE_END)).toBe(true);
  });

  it('names the tier agents and the routing failure they produce when unrouted', () => {
    const block = guidanceBlock();
    expect(block).toContain('code-');
    expect(block).toContain('review-');
    // The caveat is the load-bearing half: an unrouted dispatch fails in a way
    // that reads as a broken agent rather than a missing `sonata code`.
    expect(block).toContain('model_not_found');
    expect(block).toContain('sonata doctor');
  });
});
