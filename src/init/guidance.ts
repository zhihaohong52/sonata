/**
 * The instruction that makes tier agents the default subagent lane.
 *
 * Claude Code discovers sonata's generated agents natively — they are ordinary
 * `.claude/agents/*.md` files and appear as ordinary subagent types. What it
 * does *not* do is prefer them: a subagent is chosen by matching the task
 * against each agent's `description`, and sonata's agents compete there with
 * `general-purpose`, `Explore` and `Plan`, all of which are broader and carry
 * no routing precondition. Left alone the pull is toward Claude's own
 * subagents, which is the opposite of why sonata is installed.
 *
 * Nothing sonata already writes can express that preference. Agent files
 * describe what each agent *does*; a skill is invoked rather than always
 * loaded. `CLAUDE.md` is the one file Claude Code reads in every session
 * unconditionally, so that is where the instruction has to live — even though
 * it is a file sonata does not own.
 *
 * Hence the markers. Sonata owns what is between them and nothing else: text
 * either side is preserved byte-for-byte, and a file whose markers do not pair
 * up is refused rather than repaired, because guessing where a hand-edited
 * block ends is how a paragraph the user wrote gets eaten.
 */

export const GUIDANCE_BEGIN = '<!-- sonata:begin -->';
export const GUIDANCE_END = '<!-- sonata:end -->';

/**
 * The managed block, markers included.
 *
 * The routing caveat is not decoration. `sonata route auto` does not work on
 * current Claude Code builds (the settings `env` block is read at launch
 * only), so a session that has not come up through `sonata code` or a
 * pre-launch `sonata route on` is unrouted — and a tier agent dispatched from
 * one fails with `model_not_found` against `api.anthropic.com`, which reads as
 * a defect in the agent rather than a missing routing step. Telling the reader
 * what that error means is the difference between a fixable setup problem and
 * an apparently broken feature.
 */
export function guidanceBlock(): string {
  return [
    GUIDANCE_BEGIN,
    '## Subagent lane',
    '',
    'When this session is routed, execute implementation through the sonata tier',
    'agents (`code-simple`, `code-complex`, `review-*`, `explore-*`, `plan-*`)',
    "rather than Claude's own general-purpose subagents. That is what sonata is",
    'for: cheap models for mechanical work, and a different model family reviewing',
    "Claude's own code.",
    '',
    'Match the tier to the work. `simple` is mechanical, well-specified and',
    'contained (one file, a clear spec, bulk edits); `complex` is cross-cutting,',
    'ambiguous, design-sensitive, or needs sustained reasoning. When unsure, use',
    '`-complex`.',
    '',
    'If a tier agent fails with `model_not_found`, the session is **not routed** —',
    'that is a setup problem, not a broken agent. Run `sonata doctor`, and start',
    'the session with `sonata code` (or `sonata route on` before launching).',
    GUIDANCE_END,
    '',
  ].join('\n');
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
    count += 1;
  }
  return count;
}

/**
 * Where the managed block sits, or `undefined` when there is none.
 *
 * Extracted so the merge and the removal cannot disagree about what counts as
 * a well-formed file. Every malformed shape throws here rather than being
 * repaired, for the reason the markers exist at all: each available repair —
 * inventing an end, reading a stray marker as prose, rewriting the first of
 * two blocks — can eat a paragraph the user wrote.
 */
export function locateGuidance(existing: string): { begin: number; end: number } | undefined {
  const begins = countOccurrences(existing, GUIDANCE_BEGIN);
  const ends = countOccurrences(existing, GUIDANCE_END);

  // Repeated markers are refused before any splice is attempted. `indexOf`
  // alone would span from the *first* begin to the *first* end, and in a file
  // shaped begin/…/begin/…/end that swallows the user text sitting between the
  // two begins. Two complete blocks are equally malformed: rewriting one would
  // leave the other behind to contradict it.
  if (begins > 1 || ends > 1) {
    throw new Error(
      `CLAUDE.md contains more than one sonata block (${begins} "${GUIDANCE_BEGIN}", `
      + `${ends} "${GUIDANCE_END}"). Leave exactly one, and run the command again.`,
    );
  }

  const begin = existing.indexOf(GUIDANCE_BEGIN);
  const end = existing.indexOf(GUIDANCE_END);

  // A marker without its partner means the file was hand-edited.
  if (begin !== -1 && end === -1) {
    throw new Error(
      `CLAUDE.md has an unterminated sonata block: "${GUIDANCE_BEGIN}" with no matching `
      + `"${GUIDANCE_END}". Restore the end marker, or delete the block, and run the command again.`,
    );
  }
  if (begin === -1 && end !== -1) {
    throw new Error(
      `CLAUDE.md has a stray "${GUIDANCE_END}" marker with no matching "${GUIDANCE_BEGIN}". `
      + 'Remove it, and run the command again.',
    );
  }
  if (begin !== -1 && end !== -1 && end < begin) {
    throw new Error(
      `CLAUDE.md has sonata markers in the wrong order ("${GUIDANCE_END}" before `
      + `"${GUIDANCE_BEGIN}"). Fix or delete the block, and run the command again.`,
    );
  }

  return begin === -1 ? undefined : { begin, end: end + GUIDANCE_END.length };
}

/**
 * Drop the managed block, leaving every other byte where it was.
 *
 * `undefined` means there was nothing to remove — the caller reports "no block
 * here" rather than rewriting a file it did not change.
 *
 * The one liberty taken is dropping the blank line an append separated the
 * block by, and it is deliberately narrow: *exactly* two trailing newlines
 * collapse to one, and nothing else is touched. A wider rule (`/\n{2,}$/`)
 * ate user content — a whitespace-only `CLAUDE.md` of three newlines came back
 * as one, which is bytes outside the markers, the one thing this must never
 * change. Without any rule, every merge/remove cycle would leave another blank
 * line behind.
 *
 * One case is genuinely unrecoverable: a file that ended *without* a trailing
 * newline was separated by two, and two is also what a file ending in one
 * newline produces. Those are indistinguishable after the fact, so such a file
 * comes back with a single trailing newline it did not have. Adding one byte
 * is the safe side of an ambiguity whose other side deletes one.
 */
export function removeGuidance(existing: string): string | undefined {
  const at = locateGuidance(existing);
  if (at === undefined) return undefined;
  const head = existing.slice(0, at.begin);
  const before = /(^|[^\n])\n\n$/.test(head) ? head.slice(0, -1) : head;
  const after = existing.slice(at.end).replace(/^\n+/, '');
  if (before === '') return after;
  return after === '' ? before : `${before}\n${after}`;
}

/**
 * Merge the managed block into an existing `CLAUDE.md`.
 *
 * Pure so the interesting behaviour — what survives, what is replaced, what is
 * refused — is testable without a filesystem. `existing` is `undefined` when
 * the file does not exist yet.
 */
export function mergeGuidance(existing: string | undefined, block: string): string {
  // Only a file that does not exist is written whole. A file that exists but
  // holds nothing but whitespace still has bytes, and replacing them outright
  // would be a change outside the markers — the one thing this must never do.
  if (existing === undefined) {
    return block.endsWith('\n') ? block : `${block}\n`;
  }

  const at = locateGuidance(existing);
  if (at !== undefined) {
    const before = existing.slice(0, at.begin);
    const after = existing.slice(at.end);
    return `${before}${block.trimEnd()}${after}`;
  }

  // No block yet: append, leaving every existing byte where it was. An empty
  // file has nothing to separate from, so it gets no invented blank lines.
  const separator = existing.length === 0
    ? ''
    : existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  const merged = `${existing}${separator}${block}`;
  return merged.endsWith('\n') ? merged : `${merged}\n`;
}
