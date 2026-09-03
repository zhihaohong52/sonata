# Handoff — sonata, with all fourteen roadmap items closed

Written 2026-09-03. Read this before starting new work; it records what is
done, what is deliberately *not* done, and the environment traps that cost
previous sessions real time.

## Current state — every roadmap item shipped, 1.0 deliberately not tagged

- `main` at `36c4440` (`feat: budget guardrails and the worktree-delta check`).
  `18146cc` (`chore(release): v0.5.1`) is the last tagged release; five
  commits of unreleased work sit on top of it.
- **Published to npm**: `@zhihaohong52/sonata@0.5.1`, `latest`.
- **All fourteen roadmap items are now ✅.** This session closed the last
  four — `10` (config schema v1), `12` (report-contract manifest), `04`
  (budget guardrails) and `07` (worktree delta) — plus a serve-state fix and
  an init ranking fix. `docs/roadmap.md` carries the full status text for
  each; every entry says *why* it is shaped the way it is, not just that it
  landed.
- **1475 tests across 84 files**, typecheck and build clean. One full-suite
  run this session, green; no flakiness observed. The "two unidentified test
  failures" line that persisted across several handoffs has now not
  reproduced in many consecutive full runs — treat it as resolved.
- **1.0 is still not tagged, on purpose.** See the gate section below. This is
  the standing decision the user confirmed on 2026-09-02 ("close remaining
  items, don't tag 1.0 yet") and nothing since has changed it.

## The correction the last handoff asked for was made — and it went the other way

The 2026-09-02 handoff told the next session **not** to add `System messages
are not allowed` to `CAPABILITY_400_SIGNATURES` on the old evidence, and to
reproduce live against a freshly built `dist/` first. That was the right
instruction, it was followed, and **the reproduction succeeded**:

- A `code-complex` dispatch on 2026-09-03 returned
  `400 litellm.BadRequestError: ChatgptException - {"detail":"System messages
  are not allowed"}. Received Model Group=gpt-5.6-terra`.
- `dist/` was checked, not assumed: `dist/native/router.js` and
  `dist/native/litellm.js` were both newer than any `src/` file, the running
  daemon predated neither, and both `flattenSystemBlocks` (4 occurrences) and
  `supports_system_message` (1) were present in the built output.
- `flattenSystemBlocks` is called on **both** litellm paths in `router.ts`, so
  the request that failed had already been flattened.

**Conclusion: the 2026-08-28 `flattenSystemBlocks` + `supports_system_message:
false` pair is necessary but not sufficient, and the remaining hole is
unidentified.** Both fixes stay — this is an addition, not a replacement. The
signature is now in the allow-list, so three consecutive identical failures
cool the candidate and the tier falls through, ending in a 529 that names
`sonata dispatch` instead of a bare 400 that reads as a defect in the agent's
own work.

**The unidentified hole is the best open lead in this repo.** Someone should
capture the exact request body the router sends to LiteLLM for a codex-oauth
gateway and diff it against a request that succeeds. It is a defect that is
now *survivable* rather than fixed.

## Design reference — do NOT re-derive, read these

| What | Where |
|---|---|
| The LiteLLM design, incl. a **retracted finding** and a live-evidence table | `docs/superpowers/specs/2026-09-01-litellm-strategy-design.md` |
| The executed plan, incl. **five things it got wrong** | `docs/superpowers/plans/2026-09-01-litellm-strategy.md` |
| Provider/transport model, direct-path auth boundary | `CLAUDE.md`, "Native path" |
| The 1.0 gate, in the roadmap's own words | `docs/roadmap.md` |
| Why item 07 annotates instead of degrading; why item 12 left the verdict alone | `docs/roadmap.md` items 07 and 12, and the module headers in `src/worktree.ts` / `src/report-contract.ts` |

The spec keeps corrections visible rather than quietly fixing them — Finding 3
is a retraction with the evidence that overturned it, and the section above is
a second one. Match that style.

## Is it ready for 1.0? The checklist says yes. The gate says no.

The roadmap's gate is not an item list. It is *"ship 1.0 only after 0.4 has
been in strangers' hands long enough to know what you would regret
freezing."*

- 0.4.0 published 2026-08-31; 0.5.0 on 2026-09-02; 0.5.1 the same day.
- Elapsed exposure: **days**. No external issue, no external bug report.

So the work is finished and the waiting is not. Tagging 1.0 to celebrate an
empty checklist would freeze a contract nobody outside this repository has
tried to use — the exact mistake the milestone was written to prevent. **The
next release should be an 0.6.0 carrying the unreleased work**, which gets it
into strangers' hands, which is the only thing that moves the gate.

Two things treated as 1.0-relevant that are not on the item list:

- **Nested native agents recurse without bound.** A `code-complex` agent can
  call itself; there is no depth counter, and `sonata usage` attributes cost
  per session rather than to the dispatch that caused it. Item 04 now caps
  the *total* — the blast radius is bounded even though the attribution is
  not — but a whole-machine daily ceiling is not a per-run guard.
- **A session that will not route is indistinguishable from one that will**
  until a dispatch dies with `model_not_found` (see quirks below).

## Open follow-ups — none blocking, all cheap

- **Cut 0.6.0.** Five commits of unreleased work, `[Unreleased]` is written
  and accurate. `npm run release -- 0.6.0` then `git push --follow-tags`.
- **The codex-oauth system-message hole** — see the correction section. Best
  open lead; a captured request body probably settles it.
- **`openrouter` has no `provider` set**, so its 5 models still go through
  LiteLLM. Adding `provider = "anthropic"` flips them to the direct path; that
  exact config was verified live.
- **`deepseek`, `mistral`, `groq`** sit in `PROVIDER_FOR_GATEWAY` without live
  verification. The table's own comment says only exercised endpoints belong
  there, so a wrong row is a real defect.
- **Item 04 has no `sonata doctor` surface.** A configured cap is invisible
  until it refuses. A line in doctor naming the cap and today's spend would
  cost very little.
- **Item 07 is not surfaced in `sonata runs`.** `TailResult.worktreeUnchanged`
  exists; only the report prefix consumes it today.

Note on `anexto`: the previous handoff listed verifying it as a follow-up.
**The user has since ruled it out of this repository entirely** — route to
`luna` and `terra` only, and never dispatch to an `anexto-*` subagent. That
follow-up is withdrawn, not pending.

## Environment quirks that bit this session

- **Foreign-model dispatch from a normal session still does not work.** Two
  dispatches failed this session for two *different* reasons: one with
  `model_not_found` (the alias reached `api.anthropic.com`, not the router)
  and one with the codex 400 above (which *did* route, proving routing was on
  for that request). Routing state looked correct in both cases — `sonata
  route status` showed auto:on, `ANTHROPIC_BASE_URL` was in the session's
  environment, and both agent ids were in `.sonata/route-subagents.json`.
  **`/cmux` (launch a session while routing is already on) is the reliable
  routed-session path.**
- **When both tier candidates share a gateway, fallback buys nothing.**
  `gpt-5.6-luna` and `gpt-5.6-terra` are both on the codex-oauth gateway, so a
  gateway-level failure exhausts the tier identically. Don't retry a dispatch
  into the same gateway and expect a different answer — implement directly, or
  pick a tier whose candidates span gateways.
- **Never `pkill -f` anything matching the CLI.** A `pkill -f "cli.js serve"`
  aimed at a scratch router also killed the live daemon. Kill only a pid
  something recorded — `serve-state-<port>.json`'s `routerPid`, or
  `lsof -nP -iTCP:<port> -sTCP:LISTEN`. **This session routes through the
  router; killing it severs the session's own connection.**
- **Give a scratch `serve` a scratch `HOME`.** One started with the real HOME
  overwrites the live serve state and deletes it on stop, after which `sonata
  restart` refuses.
- **CI has no `uv`.** A test that shells out to an installer takes seconds
  locally (warm uv cache) and times out at 30s on CI.
- **A probe can be swallowed.** `apply` catches install failures by design, so
  a probe that *throws* from the installer proves nothing. Probe with a side
  effect that survives a catch — a marker file works.
- **Bare `grep` goes through a shim** that prints a count but not the matching
  lines. Use `/usr/bin/grep`. `src/native/router.ts` contains a NUL byte, so
  add `-a` when searching it.
- **`sonata` on PATH runs `dist/`.** Two bugs in this repo's history were
  "fixed" and kept reproducing for exactly this reason — and this session
  spent real time ruling it out before accepting the codex 400 as genuine.
  `npm run build` before believing any live result.

## Suggested skills for the next session

- `superpowers:brainstorming` before any new feature — required by the user's
  global instructions, and this repo has no PRD gate (specs live in
  `docs/superpowers/specs/`, **not** the Obsidian vault).
- `/code-review` before merging; CodeRabbit reviews every PR and its findings
  have been consistently worth acting on.
- Batch fixes per review round into one commit, and always resolve a thread
  after replying to it.
