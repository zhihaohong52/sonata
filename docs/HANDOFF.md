# Handoff — sonata, after 0.5.0 + doctor --json

Written 2026-09-02 (afternoon session, after the 0.5.0 release). Read this
before starting new work; it records what is done, what is deliberately *not*
done, and the environment traps that cost previous sessions real time.

## Current state — 0.5.0 published, item 11 shipped unreleased

- `main` at `d54ae2d` (`feat: sonata doctor --json`), pushed. `03e04c9`
  (`chore(release): v0.5.0`) is the last tagged release; nothing has been cut
  since.
- **Published to npm**: `@zhihaohong52/sonata@0.5.0`, `latest`.
- **Roadmap item 11 (`sonata doctor --json`) is done**, unreleased. `cmdDoctor`
  already returned a structured `{ ok, checks }`; the CLI only rendered it as
  text. `--json` prints that structure verbatim — no new check logic, just the
  flag and a CLI-wiring test (`tests/cli-doctor.test.ts`, following the
  `cli-status.test.ts` pattern).
- **1411 tests across 80 files**, typecheck and build clean. Full suite run
  twice this session with no flakiness (matches the prior session's "13
  consecutive runs green" note) — treat the "two unidentified test failures"
  line from the previous handoff as resolved/unreproducible, not disproven.
- **Gate check performed 2026-09-02, per the user's request to "get to
  v1.0.0"**: the roadmap's own gate ("ship 1.0 only after 0.4 has been in
  strangers' hands long enough") is still unmet — no new stars/issues/forks
  since the last check. Decision (confirmed with the user): keep closing
  remaining items (04, 07, 10, 12, plus the open follow-ups below) without
  cutting v1.0.0 yet.

## A follow-up from the last handoff was investigated and should NOT be done as described

The previous handoff said the Codex `{"detail":"System messages are not
allowed"}` 400 (9 lines in
`~/.config/sonata/logs/serve-2026-08-30T14-39-39-137Z.log`) was "evidence-backed
and ready" to add as a second `CAPABILITY_400_SIGNATURES` entry
(`src/native/router.ts`). Checked before acting: the structural fix for exactly
this error (`supports_system_message: false` in `src/native/litellm.ts`,
commit `c0bbe6d`) landed **2026-08-28T17:26**, and the evidence log is from
**2026-08-30T14:39** — two days later. If the fix is doing its job this error
should not recur at all, so treating it as an ongoing capability gap and
cooling candidates down for it would be reacting to stale evidence rather than
a live defect — the far likelier explanation is this repo's own
recurring "`sonata` on PATH runs stale `dist/`" trap. **Not added.** Whoever
picks this up next should reproduce live against a freshly built `dist/`
before adding anything to that allow-list — don't just copy the old log
citation forward again.

## Design reference — do NOT re-derive, read these

| What | Where |
|---|---|
| The LiteLLM design, incl. a **retracted finding** and a live-evidence table | `docs/superpowers/specs/2026-09-01-litellm-strategy-design.md` |
| The executed plan, incl. **five things it got wrong** | `docs/superpowers/plans/2026-09-01-litellm-strategy.md` |
| Provider/transport model, direct-path auth boundary | `CLAUDE.md`, "Native path" |
| The 1.0 gate, in the roadmap's own words | `docs/roadmap.md` |

The spec keeps corrections visible rather than quietly fixing them — Finding 3
is a retraction with the evidence that overturned it. Match that style.

## Is it ready for 1.0? No — assessed 2026-09-02

The roadmap's own gate is *"ship 1.0 only after 0.4 has been in strangers'
hands long enough to know what you would regret freezing."* Measured that day:
**83 npm downloads, all on publish day; 0 issues; 0 stars; 0 forks.** There are
no strangers yet. Four items remain open — `04`, `07`, **`10` (P0, config
schema freeze)**, `12` (item `11` shipped this session, unreleased) — and item
10 got harder, not easier: `provider` superseded `wire_format` *that
morning*, and `litellmRequired`'s scope changed twice during implementation.

Two things treated as 1.0-blocking that are not on the item list:

- **Nested native agents recurse without bound.** A `code-complex` agent can
  call itself; there is no depth counter, and `sonata usage` attributes cost
  per session rather than to the dispatch that caused it. Item 04 is the
  deferred mitigation.
- **A session that will not route is indistinguishable from one that will**
  until a dispatch dies with `model_not_found` (see quirks below).

## Open follow-ups — none blocking, all cheap

- **`openrouter` has no `provider` set**, so its 5 models still go through
  LiteLLM. Adding `provider = "anthropic"` flips them to the direct path; that
  exact config was verified live.
- **`anexto` (13 models, the largest gateway) is untested for `/v1/messages`.**
  One request settles whether it can use the direct path.
- **`deepseek`, `mistral`, `groq`** sit in `PROVIDER_FOR_GATEWAY` without live
  verification in this session. The table's own comment says only exercised
  endpoints belong there, so a wrong row is a real defect.
- **Item 13's signature allow-list still has one entry** — see the correction
  above; do not add the "System messages are not allowed" signature on the old
  evidence, it needs fresh live reproduction first.
- **Two unidentified test failures** from a prior session — not reproduced in
  two full-suite runs this session (1411/1411 both times). Treat as resolved
  unless it recurs.

## Environment quirks that bit this session

- **Foreign-model dispatch from a normal session does not work right now.**
  Two `code-simple` subagents died with `model_not_found` — the alias reached
  `api.anthropic.com`, not the router. The `SubagentStart` hook *had* fired and
  the env *was* in `.claude/settings.local.json`; `env` confirmed it never
  reached the session's process. This contradicts CLAUDE.md's measured "picked
  up within seconds" claim, which is recorded there rather than resolved.
  **`/cmux` (launch a session while routing is already on) is the reliable
  routed-session path.**
- **Never `pkill -f` anything matching the CLI.** A `pkill -f "cli.js serve"`
  aimed at a scratch router on :4177 also killed the live daemon on :4100. Kill
  only a pid something recorded — `serve-state.json`'s `routerPid`, or
  `lsof -nP -iTCP:<port> -sTCP:LISTEN`.
- **Give a scratch `serve` a scratch `HOME`.** One started with the real HOME
  overwrites `~/.config/sonata/serve-state.json` and deletes it on stop,
  leaving the live daemon with no recorded pid — after which `sonata restart`
  refuses.
- **CI has no `uv`.** A test that shells out to an installer takes seconds
  locally (warm uv cache) and times out at 30s on CI. That is how CI caught two
  init tests running a real `pip install`; the giveaway in the log was
  `Terminate orphan process: pid (8113) (pip)`.
- **A probe can be swallowed.** `apply` catches install failures by design, so
  a probe that *throws* from the installer proves nothing. Probe with a side
  effect that survives a catch — this session used a marker file.
- **Bare `grep` goes through a shim** that prints a count but not the matching
  lines. Use `/usr/bin/grep`.

## Suggested skills for the next session

- `superpowers:brainstorming` before any new feature — required by the user's
  global instructions, and this repo has no PRD gate (specs live in
  `docs/superpowers/specs/`, **not** the Obsidian vault).
- `/code-review` before merging; CodeRabbit reviews every PR and its findings
  have been consistently worth acting on.
- Batch fixes per review round into one commit, and always resolve a thread
  after replying to it.
