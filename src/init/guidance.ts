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
 *
 * The audience line is load-bearing for the same reason. This block is
 * injected into every *subagent* as well as the session, and its
 * fan-out-inside-the-lane paragraph reads, from inside a subagent, as standing
 * permission to spawn more. Measured 2026-09-17 in another repository: one
 * dispatched `review-complex` spawned 8 further `review-complex` agents and 4
 * `claude` ones, and its children spawned again — a tree that exhausted a $200
 * gateway cap. The reviewer had followed this paragraph correctly; the
 * paragraph was never addressed to it. Naming the audience costs three lines
 * and removes the misread.
 *
 * The `model`-argument caveat is here for a related reason: the *caller* is
 * what passes it, and this block is the only text the calling session reads
 * unconditionally. The generated agent's own warning arrives too late — by the
 * time its body is in context, the override has already taken effect. That
 * failure is completely silent, which is what makes stating it worth the
 * lines.
 */
export function guidanceBlock(): string {
  return [
    GUIDANCE_BEGIN,
    '## Subagent lane',
    '',
    'When this session is routed, execute implementation through the sonata tier',
    'agents (`code-simple`, `code-normal`, `code-complex`, `review-*`, `explore-*`, `plan-*`)',
    "rather than Claude's own general-purpose subagents. That is what sonata is",
    'for: cheap models for mechanical work, and a different model family reviewing',
    "Claude's own code.",
    '',
    'Match the tier to the work. `-simple` is writable without asking a question',
    '(one or two files, no interface change). `-normal` is the default: you know',
    'what to change but not exactly how. `-complex` needs a design decision, or',
    '"done" is still ambiguous.',
    '',
    '**Your config decides which of those exist** — `sonata agents` lists them, and',
    'a config written before the `normal` tier has only `-simple` and `-complex`.',
    'Where there is no `-normal`, prefer `-simple` for work you could write without',
    'asking a question and `-complex` for the rest; where a role\'s tiers are',
    'identical, sonata generates one agent named for the role alone.',
    '',
    'Size is not difficulty — a large mechanical change is `simple`, a three-line',
    'change that decides an interface is `complex`. Start at the tier the task',
    'needs rather than a rung higher: a task that fails review is re-run one tier',
    'up, so starting low is cheap to correct.',
    '',
    'Dispatch them with **no `model` argument**. Each agent pins its routed model',
    "in frontmatter, and the Agent tool's own `model` parameter overrides that — so",
    'passing one runs the agent on a Claude model that never reaches the router.',
    'Nothing errors and nothing warns: every `review-*` dispatch quietly becomes',
    "Claude reviewing Claude, which is the one thing this lane exists to prevent.",
    'Choosing the tier **is** the model choice.',
    '',
    '**This section addresses the session dispatching agents, not an agent reading',
    'it inside its own run.** `CLAUDE.md` is injected into every subagent, so a',
    'tier agent sees this text too — it is not an instruction to that agent to fan',
    'out. Each generated agent carries its own `## Fanning out` rule, which binds',
    'it to delegating *downward only* (`complex` may reach `normal` and `simple`,',
    '`normal` may reach `simple`, `simple` may reach nothing). Fanning a task out',
    'is your decision to make here, where the agent count is visible, by',
    'dispatching several scoped agents yourself.',
    '',
    'If a tier agent fails with `model_not_found`, the session is **not routed** —',
    'that is a setup problem, not a broken agent. Run `sonata doctor`, and start',
    'the session with `sonata code` (or `sonata route on` before launching).',
    GUIDANCE_END,
    '',
  ].join('\n');
}

/**
 * Every offset at which `marker` occupies a line of its own.
 *
 * A marker is a container only when it stands alone. Quoted inside a sentence
 * it is a *citation* — which is exactly how this repository's own `CLAUDE.md`
 * documents the contract, and counting those made the one file that explains
 * the markers the one file the writer ate: the prose mentions each marker
 * once, so the pair looked well-formed and the block was spliced into the
 * middle of the sentence joining them.
 *
 * Matching the trimmed line keeps an indented marker usable (a block nested in
 * a list still delimits), while the offsets returned are the marker's own, so
 * any leading whitespace stays outside the span and is preserved byte-for-byte
 * like every other byte the markers do not enclose.
 */
function standaloneMarkers(existing: string, marker: string): number[] {
  const found: number[] = [];
  for (let at = existing.indexOf(marker); at !== -1; at = existing.indexOf(marker, at + marker.length)) {
    // `lastIndexOf('\n', -1)` is -1 for a marker at offset 0, which lands the
    // line start on 0 — the same answer the general case gives.
    const lineStart = existing.lastIndexOf('\n', at - 1) + 1;
    const newline = existing.indexOf('\n', at);
    const lineEnd = newline === -1 ? existing.length : newline;
    if (existing.slice(lineStart, lineEnd).trim() === marker) found.push(at);
  }
  return found;
}

/**
 * Where the managed block sits, or `undefined` when there is none.
 *
 * Extracted so the merge and the removal cannot disagree about what counts as
 * a well-formed file. Every malformed shape throws here rather than being
 * repaired, for the reason the markers exist at all: each available repair —
 * inventing an end, reading a stray marker as prose, rewriting the first of
 * two blocks — can eat a paragraph the user wrote.
 *
 * Only a marker standing alone on its line counts. A file that merely *quotes*
 * the markers therefore has no block, which is the "not installed yet" state
 * and appends cleanly — rather than being read as a block spanning the prose
 * between them, which is what corrupted this repository's own `CLAUDE.md`.
 */
export function locateGuidance(existing: string): { begin: number; end: number } | undefined {
  const begins = standaloneMarkers(existing, GUIDANCE_BEGIN);
  const ends = standaloneMarkers(existing, GUIDANCE_END);

  // Repeated markers are refused before any splice is attempted. `indexOf`
  // alone would span from the *first* begin to the *first* end, and in a file
  // shaped begin/…/begin/…/end that swallows the user text sitting between the
  // two begins. Two complete blocks are equally malformed: rewriting one would
  // leave the other behind to contradict it.
  if (begins.length > 1 || ends.length > 1) {
    throw new Error(
      `CLAUDE.md contains more than one sonata block (${begins.length} "${GUIDANCE_BEGIN}", `
      + `${ends.length} "${GUIDANCE_END}"). Leave exactly one, and run the command again.`,
    );
  }

  const begin = begins[0] ?? -1;
  const end = ends[0] ?? -1;

  // A marker without its partner means the file was hand-edited. Both messages
  // name the standalone-line rule, because the other way to reach here is a
  // marker that IS in the file but quoted inside a sentence — and an error
  // saying "no matching end" about a file the user can see an end marker in
  // reads as sonata failing to find what is in front of it.
  if (begin !== -1 && end === -1) {
    throw new Error(
      `CLAUDE.md has an unterminated sonata block: "${GUIDANCE_BEGIN}" with no matching `
      + `"${GUIDANCE_END}" on a line of its own. Restore the end marker, or delete the block, `
      + 'and run the command again.',
    );
  }
  if (begin === -1 && end !== -1) {
    throw new Error(
      `CLAUDE.md has a stray "${GUIDANCE_END}" marker with no matching "${GUIDANCE_BEGIN}" `
      + 'on a line of its own. Remove it, and run the command again.',
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
  const tail = existing.slice(at.end);

  // A block with real content after it was put there by the *replace* path,
  // which preserves both surrounding spans byte-for-byte and inserts no
  // separator of its own. So there is nothing of sonata's to take back:
  // splicing out the markers and leaving every other byte alone is the exact
  // inverse. Touching the whitespace here is how user-authored blank lines on
  // either side got eaten.
  if (tail.trim() !== '') return `${head}${tail}`;

  // Otherwise the block sits at the end, where `mergeGuidance` appended it
  // after a separator it chose from the file's own trailing newlines. That
  // separator, and the block's trailing newline, are sonata's to remove.
  return /(^|[^\n])\n\n$/.test(head) ? head.slice(0, -1) : head;
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
