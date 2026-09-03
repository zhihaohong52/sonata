# Handoff — sonata after 0.6.0

Written 2026-09-04, at the end of the session that shipped 0.6.0. Read this
before starting new work. It records what is done, what is deliberately *not*
done, what to pick up if you want work, and the traps that have cost previous
sessions real time.

**The short version:** everything on the roadmap is built, shipped and
released. There is no queued task. The next move is a judgement call that
belongs to the user, not a checklist item — so read the 1.0 gate section
before you go looking for something to do.

## Where things stand

- `main` at `9035218`, clean, in sync with origin. `[Unreleased]` is empty.
- **npm**: `@zhihaohong52/sonata@0.6.0`, `latest`, published 2026-09-03 from
  the pushed tag with every `release.yml` step green.
- **All fourteen roadmap items are ✅ and every one is in a published
  release.** `docs/roadmap.md` names the release each shipped in and explains
  *why* each is shaped the way it is. 0.6.0 carried the last four — 04
  (budget guardrails), 07 (worktree delta), 10 (config schema v1), 12
  (report-contract manifest).
- **1523 tests across 85 files**, typecheck and build clean, verified on the
  merged `main` before tagging. The "two unidentified test failures" line that
  haunted several handoffs has not reproduced in many consecutive full runs —
  treat it as resolved.
- **Zero open issues, zero open PRs** on GitHub.
- **1.0 is still not tagged, on purpose.** Standing decision the user
  confirmed on 2026-09-02 ("close remaining items, don't tag 1.0 yet"); nothing
  since has changed it.

## There is no queued task — read this before inventing one

The roadmap's 1.0 gate is not an item list. It is *"ship 1.0 only after 0.4
has been in strangers' hands long enough to know what you would regret
freezing."*

- 0.4.0 published 2026-08-31; 0.5.0 and 0.5.1 on 2026-09-02; 0.6.0 on
  2026-09-03.
- Elapsed exposure: **days**. No external issue, no external bug report, no
  evidence yet of how anyone outside this repository uses it.

**Do not read "nothing left to build" as "time to tag".** Everything the
checklist could contribute is spent — every item is shipped *and* released, so
no future release can move this gate by closing work. Only two things can: an
external bug report arriving and being answered, or the maintainer deciding
the exposure so far is enough. Both are the user's calls. Tagging 1.0 to
celebrate an empty checklist would freeze a contract nobody outside this
repository has tried to use, which is the exact mistake the milestone was
written to prevent.

Two things treated as 1.0-relevant that were never item-list rows:

- **Nested native agents recurse without bound.** A `code-complex` agent can
  call itself; there is no depth counter, and `sonata usage` attributes cost
  per session rather than to the dispatch that caused it. Item 04 caps the
  *total*, so the blast radius is bounded — but a whole-machine daily ceiling
  is not a per-run guard.
- **A session that will not route is indistinguishable from one that will**
  until a dispatch dies with `model_not_found`. See the traps section.

## If you want work, in the order I would take it

All five are cheap and none blocks anything.

1. **The codex-oauth system-message hole** — the best open lead in the repo,
   and the only one that is a real defect rather than a polish item. Detail in
   the next section. Capture the exact request body the router sends to
   LiteLLM for a codex-oauth gateway and diff it against one that succeeds.
2. **`openrouter` has no `provider` set** in the *machine* config
   (`~/.config/sonata/sonata.toml` — this repo's own `sonata.toml` has only
   the codex gateway), so it falls through `providerForBaseUrl` to `openai`
   and its models still go through LiteLLM. Adding `provider = "anthropic"`
   flips them to the direct path; that exact config was verified live in an
   earlier session. Verified still absent 2026-09-04.
3. **Item 04 has no `sonata doctor` surface.** A configured budget cap is
   invisible until it refuses. A line naming the cap and today's spend costs
   very little and removes a silent-until-it-bites surprise.
4. **Item 07 is not surfaced in `sonata runs`.** `TailResult.worktreeUnchanged`
   already exists; only the report prefix consumes it today.
5. **`deepseek`, `mistral`, `groq` sit in `PROVIDER_FOR_GATEWAY` without live
   verification.** The table's own comment says only exercised endpoints
   belong there, so a wrong row is a real defect — but nobody has hit one,
   which is why this is last.

## The correction that went the other way — codex-oauth 400s

The 2026-09-02 handoff told the next session **not** to add `System messages
are not allowed` to `CAPABILITY_400_SIGNATURES` on the old evidence, and to
reproduce live against a freshly built `dist/` first. That was the right
instruction, it was followed, and **the reproduction succeeded**:

- A `code-complex` dispatch on 2026-09-03 returned `400
  litellm.BadRequestError: ChatgptException - {"detail":"System messages are
  not allowed"}. Received Model Group=gpt-5.6-terra`.
- `dist/` was checked, not assumed: `dist/native/router.js` and
  `dist/native/litellm.js` were both newer than any `src/` file, the running
  daemon predated neither, and both `flattenSystemBlocks` (4 occurrences) and
  `supports_system_message` (1) were present in the built output.
- `flattenSystemBlocks` is called on **both** litellm paths in `router.ts`, so
  the request that failed had already been flattened.

**Conclusion: the 2026-08-28 `flattenSystemBlocks` + `supports_system_message:
false` pair is necessary but not sufficient, and the remaining hole is
unidentified.** Both fixes stay — this was an addition, not a replacement. The
signature is now in the allow-list, so three consecutive identical failures
cool the candidate and the tier falls through to a 529 naming `sonata
dispatch`, instead of a bare 400 that reads as a defect in the agent's own
work. The defect is *survivable*, not fixed.

## Standing constraints from the user — do not rediscover these

- **Never dispatch to `anexto` from this repository.** Route to `luna` and
  `terra` only; no `anexto-*` subagents here. The gateway still exists in the
  machine config, which is not permission to use it. An earlier handoff listed
  verifying anexto as a follow-up — that follow-up is **withdrawn, not
  pending**.
- **Never kill the router.** This repo's sessions route through it; killing it
  severs the session's own connection. See the traps section for how.
- **Commit and push without asking** — finishing a change here includes
  pushing it.
- **Batch fixes per review round into one commit**, and **always resolve a
  review thread after replying to it** — not optional.
- **No PRD gate and no Obsidian vault for this repo.** Specs live in
  `docs/superpowers/specs/`. The global CLAUDE.md vault workflow does not
  apply here.

## Design reference — do NOT re-derive, read these

| What | Where |
|---|---|
| The LiteLLM design, incl. a **retracted finding** and a live-evidence table | `docs/superpowers/specs/2026-09-01-litellm-strategy-design.md` |
| The executed plan, incl. **five things it got wrong** | `docs/superpowers/plans/2026-09-01-litellm-strategy.md` |
| Provider/transport model, direct-path auth boundary | `CLAUDE.md`, "Native path" |
| The 1.0 gate, in the roadmap's own words | `docs/roadmap.md` |
| Why item 07 annotates instead of degrading; why item 12 left the verdict alone | `docs/roadmap.md` items 07 and 12, plus module headers in `src/worktree.ts` / `src/report-contract.ts` |
| Why tiers rank on capability-per-task-dollar, and what the floor and ceiling each protect against | `CLAUDE.md`, the `proposeTiers` bullets |

The spec keeps corrections visible rather than quietly fixing them — Finding 3
is a retraction with the evidence that overturned it, and the codex-oauth
section above is a second one. Match that style: a reversal with its evidence
is worth more than a clean document.

## Traps that have bitten previous sessions

### Routing and dispatch

- **Foreign-model dispatch from a normal session still does not reliably
  work.** Two dispatches failed in one session for two *different* reasons:
  one `model_not_found` (the alias reached `api.anthropic.com`, not the
  router) and one the codex 400 above (which *did* route). Routing state
  looked correct in both cases — `sonata route status` showed auto:on,
  `ANTHROPIC_BASE_URL` was in the settings file, both agent ids were in
  `.sonata/route-subagents.json`. **`/cmux` — launching a session while
  routing is already on — is the reliable routed-session path.**
- **When both tier candidates share a gateway, fallback buys nothing.**
  `gpt-5.6-luna` and `gpt-5.6-terra` are both on the codex-oauth gateway, so a
  gateway-level failure exhausts the tier identically. Don't retry a dispatch
  into the same gateway expecting a different answer — implement directly, or
  pick a tier whose candidates span gateways.
- **Never `pkill -f` anything matching the CLI.** A `pkill -f "cli.js serve"`
  aimed at a scratch router also killed the live daemon. Kill only a pid
  something recorded — `serve-state-<port>.json`'s `routerPid`, or
  `lsof -nP -iTCP:<port> -sTCP:LISTEN`.
- **Give a scratch `serve` a scratch `HOME`.** One started with the real HOME
  overwrites the live serve state and deletes it on stop, after which `sonata
  restart` refuses.

### Git, PRs and review

- **Deleting a base branch CLOSES the PR stacked on it — GitHub does not
  retarget.** Merging PR #12 with `--delete-branch` closed PR #13 outright,
  and a closed PR whose base is gone can be neither reopened nor retargeted
  (`Cannot change the base branch of a closed pull request`). Recovery has a
  required order: push the old base sha back to recreate the branch, `gh pr
  reopen`, `gh pr edit --base main`, delete the temp branch, then rebase. If
  the base merged with `--rebase`, the branch's commits are on `main` under
  *new* shas so it will also read `CONFLICTING` — `git rebase --onto
  origin/main <old-base>` fixes that, and `git cherry -v` separates
  already-landed commits from new ones. **Retarget before deleting a base, or
  merge the stack bottom-up in one pass.**
- **A CodeRabbit tick can belong to an older head.** After a force-push, check
  `reviews.nodes[].commit.oid` against `headRefOid` before treating a review as
  current. When a rebase is genuinely content-neutral you can prove the review
  still applies: `git diff <old-base>..<old-head>` against `git diff
  origin/main..<new-head>` came back byte-identical here.
- **`reviewThreads(first: 50)` silently drops threads past 50.** Always use
  `first: 100`.
- **`gh pr merge` and `git push --force-with-lease` get blocked by the
  permission classifier** in auto mode, repeatedly and unpredictably. Hand them
  to the user rather than retrying — same instability documented for the
  dispatch tools in `CLAUDE.md`.
- **`gh search issues` returned unparseable output** for every query tried;
  `gh issue list --repo <owner/repo>` worked immediately.

### Build, test and tooling

- **`sonata` on PATH runs `dist/`, not `src/`.** Two bugs in this repo's
  history were "fixed" and kept reproducing for exactly this reason. `npm run
  build` before believing any live result.
- **Bare `grep` goes through a shim** that prints a count but not the matching
  lines. Use `/usr/bin/grep`. `src/native/router.ts` contains a NUL byte, so
  add `-a` when searching it.
- **CI has no `uv`.** A test that shells out to an installer takes seconds
  locally (warm uv cache) and times out at 30s on CI.
- **A probe can be swallowed.** `apply` catches install failures by design, so
  a probe that *throws* from the installer proves nothing. Probe with a side
  effect that survives a catch — a marker file works.
- **npm's registry lags its own publish.** After `release.yml` goes green the
  registry can serve the *previous* version for a minute or more ("your
  package is being processed"). Poll the registry; don't treat the workflow's
  exit code as proof the version is installable.
- **claude-mem can silently stop recording.** 13.24.0 ships the *unchanged*
  13.23.1 bundle, so its hook reads a version mismatch, kills the worker,
  respawns the same bundle, and loops — 2,674 kills in 11.5 hours here. It
  reports itself as `OpenRouter network error: Unable to connect`, which is
  Bun's generic string for a fetch killed with its process, not a network
  fault. Upstream: thedotmack/claude-mem#3857. If session memory looks empty,
  compare the plugin manifest version against `curl -s
  localhost:37703/api/version` before believing any network diagnosis. The
  local patch is four `sed`s and **reverts on any plugin update**.

## Working agreements

- `superpowers:brainstorming` before any new feature — required by the user's
  global instructions.
- `/code-review` before merging. CodeRabbit reviews every PR and its findings
  have been consistently worth acting on.
- Verify what an agent or a reviewer *claims*; several findings in this repo's
  history were confidently wrong, and several were confidently right after a
  previous session had dismissed them.
- Releases are prepared locally and published by the tag: `npm run release --
  <version>` then `git push --follow-tags`. Changelog entries accumulate under
  `[Unreleased]` while the work is fresh — not reconstructed from `git log` at
  release time.
