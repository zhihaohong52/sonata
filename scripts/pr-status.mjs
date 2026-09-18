#!/usr/bin/env node
/**
 * Poll open pull requests for review state.
 *
 * Exists because a thread count is not a safe green light. CodeRabbit posts
 * some findings as **plain issue comments** rather than as review threads, so
 * a PR can report "0 unresolved threads" while a P1 sits in a comment body —
 * which is exactly how a blocking finding was nearly merged past on #23. This
 * reads both, and says plainly when a verdict cannot be found at all.
 *
 *   node scripts/pr-status.mjs                 # every open PR, once
 *   node scripts/pr-status.mjs 22 23 24        # specific PRs
 *   node scripts/pr-status.mjs --watch         # poll until something changes
 *   node scripts/pr-status.mjs --watch=30      # ... every 30s (default 60)
 *
 * Exit code is 0 when every PR examined is mergeable, CI-green, has no
 * unresolved threads and no outstanding findings; 1 otherwise. That makes it
 * usable as a gate: `node scripts/pr-status.mjs && gh pr merge …`.
 */
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const BOT = 'coderabbitai[bot]';

/**
 * Classify the latest bot comment.
 *
 * Order matters: a clean verdict wins over the rate-limit note, because that
 * note describes the *extra* `review` command being refused, not the review
 * that already ran. Treating it as a finding marked clean PRs dirty on the
 * first run of this script.
 */
const CLEAN = /I found (?:no|zero) (?:new )?issues?|No new issues? found|found no issue/i;
const FINDING = /I found (?:\d+|one|two|three|several)\b|blocking case/i;
const NOT_RUN = /Review rate limited|Action not completed/i;
/**
 * The count CodeRabbit puts at the top of a *review* body. This is the
 * authoritative signal and the script missed it for months: it read only issue
 * comments, where the walkthrough lives, and the walkthrough does not carry
 * this line. Every PR therefore reported "no recognisable verdict — findings
 * outstanding", including clean ones, which is how a guard stops being read.
 */
const ACTIONABLE = /\*\*Actionable comments posted:\s*(\d+)\*\*/i;
/**
 * Pre-merge checks the walkthrough reports outside any thread — docstring
 * coverage, title and description checks. A finding here has no review thread
 * to resolve, so counting threads alone reports the PR clean while a warning
 * sits in the comment. That is the failure this script was written for.
 */
const FAILED_CHECKS = /###\s*❌\s*Failed checks\s*\((\d+)\s*[^)]*\)/i;
/** The repository is below the star threshold, so no review ran at all. */
const NO_AUTO_REVIEW = /does not receive automatic reviews/i;
/**
 * The commit the walkthrough describes.
 *
 * The comment is edited in place on every push, so its timestamp says when it
 * was last touched and nothing about what it covers: measured on #48, a
 * walkthrough updated at 06:49 still described a commit from 06:34, two pushes
 * back. Without this the pre-merge warnings it carries are reported as current
 * when they may already be fixed — the same "always fires" failure that made
 * the old verdict line unreadable.
 */
const REVIEWED_UP_TO = /up to `([0-9a-f]{5,40})`/i;

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function openPrNumbers() {
  return JSON.parse(gh(['pr', 'list', '--state', 'open', '--json', 'number']))
    .map((pr) => pr.number);
}

/**
 * Everything one PR's verdict depends on, in four calls.
 *
 * Threads, comments and reviews are all fetched because a finding can be in
 * any of them: an inline thread, a walkthrough comment (where pre-merge checks
 * live and there is nothing to resolve), or a review body (where the
 * actionable count is). Reading fewer than all three is how this script
 * reported every PR as unverdicted for weeks.
 */
function prState(number) {
  const view = JSON.parse(gh([
    'pr', 'view', String(number), '--json',
    'title,mergeable,mergeStateStatus,headRefOid,statusCheckRollup,baseRefName',
  ]));
  const threads = JSON.parse(gh([
    'api', 'graphql', '-f',
    `query={repository(owner:"zhihaohong52",name:"sonata"){pullRequest(number:${number})` +
    '{reviewThreads(first:100){nodes{isResolved path line}}}}}',
  ])).data.repository.pullRequest.reviewThreads.nodes;
  const comments = JSON.parse(gh([
    'api', `repos/zhihaohong52/sonata/issues/${number}/comments`,
  ]));
  // Reviews, not just comments: the actionable-comment count lives in a review
  // body, and a PR's verdict cannot be read without it.
  // `--paginate --slurp`: the endpoint returns 30 reviews per page in
  // chronological order, and CodeRabbit posts several per push — so on a busy
  // PR the newest review, the one carrying the verdict, is not on page one.
  // Reading page one alone silently graded a PR on a stale review.
  const reviews = JSON.parse(gh([
    'api', '--paginate', '--slurp', `repos/zhihaohong52/sonata/pulls/${number}/reviews`,
  ])).flat();
  return { view, threads, comments, reviews };
}

/**
 * Read the bot's verdict, or say plainly that there is not one.
 *
 * Never returns "clean" from an absence. A missing review, an unrecognised
 * wording, a rate limit and a repository below the review threshold are each
 * reported as outstanding with their own message, because the failure this
 * script exists to prevent is a PR merged past a finding nobody read.
 */
function verdictOf(comments, reviews, unresolved, head) {
  const bot = comments.filter((c) => c.user?.login === BOT);
  const botReviews = (reviews ?? []).filter((r) => r.user?.login === BOT && String(r.body ?? '') !== '');
  if (bot.length === 0 && botReviews.length === 0) {
    return { text: 'no review yet', outstanding: true, at: undefined };
  }

  const lastComment = bot[bot.length - 1];
  const commentBody = String(lastComment?.body ?? '');
  const at = lastComment?.created_at;

  // The authoritative signal. `Actionable comments posted: N` counts inline
  // findings, each of which becomes a review thread — so it is reconciled
  // against the unresolved count rather than read alone: N findings all
  // resolved is a clean PR, and reporting it as outstanding is what trained
  // everyone to ignore this line.
  const lastReview = botReviews[botReviews.length - 1];
  const actionable = ACTIONABLE.exec(String(lastReview?.body ?? ''));
  const checks = FAILED_CHECKS.exec(commentBody);
  const failedChecks = checks === undefined || checks === null ? 0 : Number(checks[1]);
  // Whether those checks describe the commit that would be merged. Reported
  // rather than discarded: "unknown for this head" is not "clean", but a
  // warning that may already be fixed reads differently from one that stands.
  const upTo = REVIEWED_UP_TO.exec(commentBody)?.[1];
  const staleNote = upTo !== undefined && head !== undefined && !String(head).startsWith(upTo)
    ? ` — describes ${upTo}, head is ${String(head).slice(0, upTo.length)}, so it may already be fixed`
    : '';

  if (actionable !== null && actionable !== undefined) {
    const posted = Number(actionable[1]);
    const reviewedAt = lastReview.submitted_at ?? at;
    if (failedChecks > 0) {
      return {
        text: `${posted} actionable, ${unresolved} unresolved · ${failedChecks} failed pre-merge check(s) — in the walkthrough, not a thread${staleNote}`,
        outstanding: true,
        at: reviewedAt,
      };
    }
    if (posted === 0) return { text: 'no actionable comments', outstanding: false, at: reviewedAt };
    if (unresolved === 0) {
      return { text: `${posted} actionable, all resolved`, outstanding: false, at: reviewedAt };
    }
    return { text: `${posted} actionable, ${unresolved} unresolved`, outstanding: true, at: reviewedAt };
  }

  // No review body at all. Say which kind of absence it is, because the fix
  // differs: a rate limit clears on its own, a repo below the star threshold
  // needs a review run by hand. Checked *after* the actionable count, not
  // before: the walkthrough carries this notice even on a PR that was
  // reviewed, so reading it first reported a fully reviewed PR as unreviewed.
  if (NO_AUTO_REVIEW.test(commentBody)) {
    return { text: 'no automatic review on this repo — run one by hand', outstanding: true, at };
  }

  // Older wording, kept because a PR reviewed before the format changed still
  // has to be readable. A finding is checked first and a clean verdict second;
  // a comment can carry both when the bot answers one point and raises another.
  const finding = FINDING.exec(commentBody);
  if (finding && !CLEAN.test(commentBody)) return { text: finding[0], outstanding: true, at };
  const clean = CLEAN.exec(commentBody);
  if (clean) {
    return failedChecks > 0
      ? { text: `${clean[0]}, but ${failedChecks} failed pre-merge check(s)`, outstanding: true, at }
      : { text: clean[0], outstanding: false, at };
  }
  if (NOT_RUN.test(commentBody)) return { text: 'review did not run (rate limited)', outstanding: true, at };
  // No recognised verdict is itself the finding: the wording may have changed,
  // and silently reporting "clean" is the failure this script exists to stop.
  return { text: 'no recognisable verdict — read the comment', outstanding: true, at };
}

/** One PR's status block, and whether it is clean enough to merge. */
function report(number) {
  const { view, threads, comments, reviews } = prState(number);
  const unresolved = threads.filter((t) => !t.isResolved);
  const checks = (view.statusCheckRollup ?? [])
    .map((c) => `${c.name ?? c.context}=${c.conclusion ?? c.state}`);
  const failing = checks.filter((c) => !/=(SUCCESS|NEUTRAL|SKIPPED)$/.test(c));
  const verdict = verdictOf(comments, reviews, unresolved.length, view.headRefOid);

  const clean = view.mergeable === 'MERGEABLE'
    && view.mergeStateStatus === 'CLEAN'
    && unresolved.length === 0
    && failing.length === 0
    && !verdict.outstanding;

  const lines = [
    `${clean ? '✓' : '•'} #${number}  ${view.title}`,
    `    ${view.mergeable}/${view.mergeStateStatus}  base=${view.baseRefName}  head=${view.headRefOid.slice(0, 7)}`,
    `    checks   ${checks.join(', ') || '(none)'}`,
    `    threads  ${threads.length} total, ${unresolved.length} unresolved`,
    `    verdict  ${verdict.text}${verdict.at ? `  (${verdict.at})` : ''}`,
  ];
  for (const t of unresolved) lines.push(`      ! ${t.path}:${t.line}`);
  if (verdict.outstanding) lines.push('      ! findings outstanding — read the bot comment, not just the threads');
  return { clean, text: lines.join('\n'), fingerprint: `${view.headRefOid}|${unresolved.length}|${verdict.at}|${verdict.text}` };
}

function main() {
  const args = process.argv.slice(2);
  const watchArg = args.find((a) => a.startsWith('--watch'));
  const numbers = args.filter((a) => /^\d+$/.test(a)).map(Number);
  const intervalMs = watchArg
    ? Math.max(15, Number(watchArg.split('=')[1] ?? 60)) * 1000
    : undefined;

  const targets = numbers.length > 0 ? numbers : openPrNumbers();
  if (targets.length === 0) {
    console.log('no open pull requests');
    return 0;
  }

  const run = () => {
    const results = targets.map(report);
    console.log(`${new Date().toISOString()}  ${targets.length} PR(s)\n`);
    for (const r of results) console.log(`${r.text}\n`);
    return results;
  };

  if (intervalMs === undefined) {
    return run().every((r) => r.clean) ? 0 : 1;
  }

  const state = { previous: run().map((r) => r.fingerprint).join('\n'), failures: 0 };
  console.log(`watching every ${intervalMs / 1000}s — Ctrl-C to stop\n`);
  const timer = setInterval(() => {
    const outcome = watchTick({
      poll: () => targets.map(report),
      state,
      log: (line) => console.log(line),
      maxFailures: MAX_WATCH_FAILURES,
    });
    if (outcome === 'stop') clearInterval(timer);
  }, intervalMs);
  return 0;
}

/**
 * How many consecutive failed polls end the watch.
 *
 * A blip should not stop it; a revoked token or a deleted repository should
 * not be retried in silence for hours.
 */
export const MAX_WATCH_FAILURES = 5;

/**
 * One poll of the watch loop: `'continue'` to keep watching, `'stop'` to end.
 *
 * Extracted and exported so the failure path is testable, and — critically —
 * so a throw cannot escape into `setInterval`. It previously could: a
 * transient `gh` error became an uncaught exception that killed the process
 * while `process.exitCode` was already 0, so the watch exited *successfully*
 * having stopped watching. Seen twice in one session, both ending
 * `error connecting to api.github.com` then `[exited with code 0]`.
 *
 * That is the worst available failure for this tool, because the conventions
 * say to keep a watch running for as long as a PR is open: a watch that has
 * silently died looks exactly like one reporting a quiet PR.
 *
 * A failure is therefore announced rather than swallowed, the counter resets
 * on success so blips hours apart never accumulate, and the give-up is stated.
 */
export function watchTick({ poll, state, log, maxFailures }) {
  let results;
  try {
    results = poll();
  } catch (error) {
    state.failures += 1;
    const why = error instanceof Error ? error.message.split('\n')[0] : String(error);
    if (state.failures >= maxFailures) {
      log(`${new Date().toISOString()}  giving up after ${state.failures} failed polls — ${why}`);
      return 'stop';
    }
    log(`${new Date().toISOString()}  poll failed (${state.failures}/${maxFailures}), still watching — ${why}`);
    return 'continue';
  }
  state.failures = 0;
  const now = results.map((r) => r.fingerprint).join('\n');
  if (now === state.previous) return 'continue';
  state.previous = now;
  log(`${new Date().toISOString()}  change detected\n`);
  for (const r of results) log(`${r.text}\n`);
  if (results.every((r) => r.clean)) {
    log('all clean');
    return 'stop';
  }
  return 'continue';
}

// Only run the CLI when invoked as the program, so a test can import
// `watchTick` without the script polling GitHub on import — the same hazard
// `invokedAsProgram` guards in `src/cli.ts`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
