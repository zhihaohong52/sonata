# Conventions — full text

Moved out of `CLAUDE.md` verbatim to keep that file within its size limit; `CLAUDE.md` keeps the day-to-day summary and points here.

- **Run `node scripts/pr-status.mjs <n>` the moment a PR is opened, and never merge on a
  thread count alone.** CodeRabbit posts some findings as **plain issue
  comments** rather than review threads, so a PR can report "0 unresolved
  threads" while a P1 sits in the comment body — which is how a blocking
  finding on #23 was nearly merged past. The script reads mergeability, CI
  checks, threads *and* the latest bot verdict, exits non-zero unless all four
  are clean, and reports "no recognisable verdict" rather than guessing when
  the wording changes. **Keep `--watch=60` running for as long as any PR is
  open** rather than checking back by hand: it prints only when something moves
  and stops itself when every open PR is clean, so a quiet watch costs nothing
  and a review landing two minutes after you stopped looking is not missed.
  **An agent running it in the background adds `--until-change`**: a plain
  watch ends only when every PR is clean, so a review landing *with* findings
  is printed and the process keeps polling, and nothing wakes the agent. That
  is how PR #65's findings sat unseen for two hours. Restart it after acting on
  each change. Opening a PR is
  not the end of the task — a review lands within a minute, and #48 was
  reported as finished while carrying four unresolved findings and two failed
  pre-merge checks. Its first run
  immediately caught a failing CI check that a manual sweep had missed.

- **Never request a re-review after fixing findings.** Push the fix, reply on
  each thread saying what changed, resolve the thread — that is the whole
  response. No `@coderabbitai review` comment: the reply and the resolve
  already answer the finding, and a re-review request adds a round trip plus a
  top-level comment to a PR whose threads are the record. The bot re-reads a
  pushed head on its own where that matters. Resolving is not optional — a
  finding fixed but left open reads as outstanding to the next reader.

- **Close issues with a keyword, and name pull requests as `PR #n`.** GitHub
  closes an issue when a merged PR's *description* carries `Closes #n` /
  `Fixes #n` / `Resolves #n`; a bare `#n` only links it, which is how #41
  stayed open through the PR that fixed it and had to be closed by hand. And a
  bare `#n` meaning a *pull* request is read as a linked issue — on #48 that
  produced an "out of scope changes" warning saying the PR did not implement
  issue #45, when the description meant PR #45. Both habits live in
  `.github/pull_request_template.md`, which is the only place they get read at
  the moment they matter. A duplicate closes with
  `gh issue close <n> --reason duplicate`, which records it as a duplicate
  rather than as done; there is no built-in duplicate *detector*, and at this
  repository's issue volume a bot for it would cost more than it saves.

- **Non-trivial work goes through a PR; docs and trivial fixes may go direct to
  `main`.** "Non-trivial" means anything touching money (pricing, the ledger,
  `[budget]`), security, routing, or config parsing — the paths where a plausible
  wrong value is worse than an error, and where a second reader is the control
  that catches it. **CodeRabbit does not review this repository
  automatically** — it skips repositories with fewer than 10 stars, saying so
  in its own comment — so a PR opened here gets **no review at all** until
  someone asks for one with a `@coderabbitai review` comment. That is what
  `pr-status.mjs`'s "no automatic review on this repo — run one by hand" means;
  it is an accurate reading, not a parsing failure, and it was misread as a
  stale verdict for most of a session. It also narrows the standing
  no-re-review rule below: that rule assumes the bot re-reads a pushed head on
  its own, which here it never does, so a *first* review must be requested by
  hand and a head pushed after a review stays unreviewed until it is.
  Direct-to-`main`
  stays fine for `CHANGELOG.md`, `docs/`, and one-line fixes. This is written
  down because it was learned the expensive way: the models.dev pricing
  overhaul (9 commits, +1302/-382, every one of them about how money is
  counted) went straight to `main` unreviewed and had to be rewound onto a
  branch afterwards to get a review at all.

- **Batch work into omnibus PRs, and trigger the review only once everything
  has landed.** Because this repository gets no automatic reviews (above), each
  PR costs a hand-typed `@coderabbitai review` against a limited free-tier
  allowance, so one PR carrying five changes buys five changes' worth of review
  for one request where five PRs would have spent five. That is the whole
  reason; it is a rate-limit adaptation, not a claim that large PRs review
  better.

  **The sequencing is the part that matters.** The bot reviews a *single head*
  and will not refresh on its own, so any commit pushed after the trigger rides
  in unreviewed. Measured: #52 was merged with its review two commits behind,
  and #53 with one. Land every commit first, trigger once, then push nothing
  but review fixes — and when a review fix *is* pushed, say so, because that
  head is now unreviewed too.

  **The cost is real and is accepted rather than denied.** A PR carrying five
  unrelated changes is harder to review than five carrying one, and #52 was
  already judged too broad at five while it was open. The mitigation is a
  description that separates the changes and states what was verified for each,
  not a claim that the size does not matter.

- **Harness-specific knowledge stays inside its adapter** — never in the CLI or `sonata dispatch`.
- **Evidence over inference** for harness behaviour: a captured fixture in `tests/fixtures/panes/` beats a plausible regex.
- **The suite's tmux sessions run on a private server** (`tests/global-setup.ts`, a vitest `globalSetup`): its own `TMUX_TMPDIR`, `TMUX` removed, and a server started from its own config — `/bin/sh` panes with no rc files and `HISTFILE=/dev/null`, `exit-empty off` so sonata's plain `tmux new-session` always reaches it rather than starting one that reads `~/.tmux.conf`. Panes used to run the user's login zsh on the user's own server: a pane killed ~100 ms after creation could die holding `~/.zsh_history.LOCK` and make the next pane's zsh wait 10 s (the flaky pane-poll timeouts), the suite appended its keystrokes to `~/.zsh_history`, and two suites at once collided on fixed session names (each suite now has its own server; nothing else two concurrent suites share has been checked, so run them one at a time). `src/tmux.ts` is untouched on purpose: a real dispatch pane keeps the user's login shell, whose rc files carry the harness's PATH. `tests/tmux.test.ts` asserts the environment reached the workers.
- **Tests need no API keys** — the suite runs against a fake harness (scripted binary replaying a normal run, a crash, a captured approval prompt, a hang the watchdog kills, a clean exit with no report, and a harness-written report).
- Run `npm test` and `npm run typecheck` before opening a PR; CI runs both on Linux with tmux installed.
- Escape control characters and keys everywhere they are written (TOML escaping) — see the duplicate-TOML-table and control-char fixes in git history.
- **`sonata` on PATH runs `dist/`, not `src/`.** After changing anything under `src/`, `npm run build` or the global command keeps the old behaviour. Two bugs in this repo's history were "fixed" but still reproducing for exactly this reason.
- **The launch wrapper must `fg` the harness, and must not redirect that `fg`.** `set -m` gives the harness its own
  process group so the watchdog can kill the tree, but that group is then not the terminal's foreground group, so any
  harness reading the terminal takes SIGTTIN and stops dead — pane frozen, process in state `T`, no exit sentinel,
  killed at the run timeout. `fg %1 >/dev/null 2>&1` runs, reports success, and leaves the job stopped anyway;
  only the unredirected `fg %1` actually hands over. Both verified against the same wrapper.
- **`sonata dispatch` relays; it must never reason about or parse harness output.** It reads run state (`state`, `degraded`, `report`) from `cmdRun`/`cmdWait` and decides only whether to try the next ranked candidate — the same discipline the old MCP wrapper agent followed, now enforced by there being no LLM in that loop at all.
