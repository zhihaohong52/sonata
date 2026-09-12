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

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function openPrNumbers() {
  return JSON.parse(gh(['pr', 'list', '--state', 'open', '--json', 'number']))
    .map((pr) => pr.number);
}

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
  return { view, threads, comments };
}

function verdictOf(comments) {
  const bot = comments.filter((c) => c.user?.login === BOT);
  if (bot.length === 0) return { text: 'no review yet', outstanding: true, at: undefined };
  const last = bot[bot.length - 1];
  const body = String(last.body ?? '');
  const at = last.created_at;

  // A finding is checked first and a clean verdict second; a comment can carry
  // both when the bot answers one point and raises another.
  const finding = FINDING.exec(body);
  if (finding && !CLEAN.test(body)) return { text: finding[0], outstanding: true, at };
  const clean = CLEAN.exec(body);
  if (clean) return { text: clean[0], outstanding: false, at };
  if (NOT_RUN.test(body)) return { text: 'review did not run (rate limited)', outstanding: true, at };
  // No recognised verdict is itself the finding: the wording may have changed,
  // and silently reporting "clean" is the failure this script exists to stop.
  return { text: 'no recognisable verdict — read the comment', outstanding: true, at };
}

function report(number) {
  const { view, threads, comments } = prState(number);
  const unresolved = threads.filter((t) => !t.isResolved);
  const checks = (view.statusCheckRollup ?? [])
    .map((c) => `${c.name ?? c.context}=${c.conclusion ?? c.state}`);
  const failing = checks.filter((c) => !/=(SUCCESS|NEUTRAL|SKIPPED)$/.test(c));
  const verdict = verdictOf(comments);

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

  let previous = run().map((r) => r.fingerprint).join('\n');
  console.log(`watching every ${intervalMs / 1000}s — Ctrl-C to stop\n`);
  const timer = setInterval(() => {
    const results = targets.map(report);
    const now = results.map((r) => r.fingerprint).join('\n');
    if (now === previous) return;
    previous = now;
    console.log(`${new Date().toISOString()}  change detected\n`);
    for (const r of results) console.log(`${r.text}\n`);
    if (results.every((r) => r.clean)) {
      console.log('all clean');
      clearInterval(timer);
    }
  }, intervalMs);
  return 0;
}

process.exitCode = main();
