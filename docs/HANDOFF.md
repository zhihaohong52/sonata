# Handoff — sonata, after 0.5.0

Written 2026-09-02, at the end of the session that executed the LiteLLM
strategy plan and released 0.5.0. Read this before starting new work; it
records what is done, what is deliberately *not* done, and the environment
traps that cost this session real time.

## Current state — 0.5.0 is published, 0.4 milestone closed

- `main` at `03e04c9` (`chore(release): v0.5.0`), tag `v0.5.0` pushed.
- **Published to npm**: `@zhihaohong52/sonata@0.5.0`, `latest`. Second fully
  automated OIDC publish — no token, provenance attached, every workflow step
  green including the tag/manifest guard.
- **1408 tests across 79 files**, typecheck and build clean.
- Only `main` exists, locally and remotely. Every merged branch was deleted
  (`feat/tier-routing` was `51ee929`; `litellm-venv` was `13b1ebb` — both
  recoverable from the reflog for ~90 days).
- Roadmap item **09 shipped**, and the answer beat the item: rather than only
  *managing* the Python dependency, sonata now often needs none at all.

## Immediate next step

**`npm run build` in the main checkout.** `sonata` on PATH runs `dist/`, and
that `dist/` predates the merge — so the installed command still has pre-0.5.0
behaviour (no direct transport, no conditional LiteLLM child). This trap has
now bitten this project **three times**; CLAUDE.md's Conventions section warns
about it and it still caught this session.

The managed venv is already installed on this machine (`litellm --version` →
`1.98.0`), so `serve` will not refuse after you rebuild.

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
no strangers yet. Five items remain open — `04`, `07`, **`10` (P0, config
schema freeze)**, `11`, `12` — and item 10 got harder, not easier: `provider`
superseded `wire_format` *that morning*, and `litellmRequired`'s scope changed
twice during implementation.

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
- **Item 13's signature allow-list still has one entry.** The Codex
  `{"detail":"System messages are not allowed"}` 400 appears on 9 lines of
  `~/.config/sonata/logs/serve-2026-08-30T14-39-39-137Z.log` and was never
  added — it is evidence-backed and ready.
- **Two unidentified test failures.** Two full-suite runs failed with 2 tests
  each; names were not captured (my error). Thirteen consecutive runs and two
  CI runs green since. Treat the suite as "green with one unexplained
  observation", not proven clean.

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
