# Roadmap to 1.0

Source of record: [Sonata 1.0 Roadmap](https://claude.ai/code/artifact/bc30e9cb-aac7-473c-a79a-a26d8f882c8b)
(a claude.ai Artifact, private). This page mirrors its content and tracks
shipped-status against it — update both when an item lands, since the
artifact isn't otherwise linked from anywhere in this repo.

Assembled originally from the working tree at `9bf46e5`, `CHANGELOG.md`
history, and the [2026-08-18 architecture review](reviews/2026-08-18-architecture-review.md).

## What 1.0 has to mean here

Not "more features." Three promises the pre-1.0 releases can't currently
keep — every item below exists to close one of them:

- **You can install it** without cloning a repository, and without
  installing Python by hand to reach the default (native) path.
- **You can prove it worked** — which model actually served the turn, what
  it cost, and whether the cost story the README sells is true for you.
- **Your config survives** — a `sonata.toml` written on launch day still
  loads at 1.9, with migration that runs itself.

## Fourteen items, four movements

Status legend: ✅ shipped · 🔸 in progress · ⏳ not started.

### I. Measurement — the promise sonata sells and does not keep

| # | Item | Priority | Size | Status |
|---|---|---|---|---|
| 01 | `sonata usage` — a token and cost ledger | P0 | M | ✅ shipped in [0.3.0](https://github.com/zhihaohong52/sonata/pull/3) |
| 02 | Route ledger, and a `sonata status` that answers "who actually served this?" | P0 | S | ✅ shipped in [0.3.0](https://github.com/zhihaohong52/sonata/pull/3) |
| 03 | `sonata runs` — surface the list that already exists | P1 | XS | ✅ shipped in [0.3.0](https://github.com/zhihaohong52/sonata/pull/3) |
| 04 | Budget guardrails | P1 | S | ✅ shipped, unreleased — `[budget] daily_usd` (`src/budget.ts`), enforced at the top of `routeRequest` above **both** the tier and direct branches, since a cap on one of two paths is not a cap. It sums the ledger's priced rows for the current UTC day and refuses at or past the cap with a 429 naming the cap, the spend and the file to edit; both halves are re-read per request, so raising the cap frees the router without a restart. The two things it cannot see are stated in the refusal itself rather than papered over — **priced volume only** (unpriced is never folded in as zero, so real spend can exceed the cap) and the **native path only** (`sonata dispatch` never transits the router). The refusal is deliberately not ledgered: a row records a request that was forwarded, and putting avoided spend into the store that defines spend is how the number stops meaning what it says. What the deferral was waiting for — forecasting, per-role splits, auto-tuning — still has no usage data behind it and is still not built |

### II. Reliability — the two things that already bit, on record

| # | Item | Priority | Size | Status |
|---|---|---|---|---|
| 05 | A daemon lifecycle you can trust (instance-id handshake, actionable takeover) | P0 | S–M | ✅ shipped in [0.3.0](https://github.com/zhihaohong52/sonata/pull/4) |
| 06 | `sonata init` hardening — the front door is the largest, least-tested file | P0 | L | ✅ shipped in [0.4.0](https://github.com/zhihaohong52/sonata/releases/tag/v0.4.0) — `init.ts` 1502 → 184 lines, decomposed into `src/init/` (discover / validate / plan / apply / interactive-state / scripted-state / toml) with end-to-end tests for the pipeline. The interactive TUI **has** now been hand-driven through `/cmux` (2026-08-31), which found two functional bugs no test had: a confirm summary promising 8 agent files where `sync` writes 4, and a gateway reported keyless one line above `✓ stored the key`. The Ink stdin-teardown class remains knowingly uncovered |
| 07 | Close the last false-success gap (worktree delta captured at launch and exit) | P1 | S | ✅ shipped, unreleased — `src/worktree.ts` hashes `git rev-parse HEAD` + `git status --porcelain` + a `git hash-object` blob hash for every not-committed-clean path into `meta.worktreeAtLaunch`; the launch wrapper writes the same capture before the exit sentinel and `tail` compares against that rather than sampling live. It **annotates rather than degrades** (`[no worktree change: …]` prefixed to the trusted report branch only): `degraded` means sonata cannot mechanically trust the result, and a run that correctly concluded no change was needed is a legitimate outcome — degrading it would trade this check's false successes for false alarms instead of removing either. **Inert outside git**: no repo, no git, any failure → `undefined`, read as *unknown*, never as "unchanged", because a check for silent failures must not invent one. Read-only roles skip it. Four traps the design avoids: the launch sample is taken *after* `createRun`, so sonata's own `.sonata/` scaffolding is in both samples and a repo that does not ignore it still compares usefully; HEAD is in the hash, so a run whose only trace is a commit — leaving a clean tree — still registers; the closing sample is captured by the wrapper rather than by `tail`, which may not look for hours, by which time the tree belongs to whoever is using the repository; and the capture hashes file *content*, because `status` alone reports the identical modified-but-unstaged line however many times that path is rewritten |
| 13 | A repeating 400 must cool a candidate down — a permanently-broken model currently absorbs its whole tier ([spec](specs/2026-08-30-routing-reliability-defects.md)) | P0 | S | ✅ fixed, unreleased — a fingerprinted 400 repeated 3× consecutively now cools the candidate the way a 5xx does, while every other 400 is still returned to the caller with its body intact. The signature allow-list carries only measured strings, and now carries **two**: `thought_signature`, and — added 2026-09-03 — `System messages are not allowed`, the Codex backend's refusal, captured live as `litellm.BadRequestError: ChatgptException … Received Model Group=gpt-5.6-terra` on a request the router had already flattened. That reverses a judgement made a session earlier, when the same addition was declined on the grounds its 2026-08-30 evidence predated the 2026-08-28 `flattenSystemBlocks` + `supports_system_message: false` fix; fresh evidence *after* that fix, on a verified-current `dist/`, says the pair is not sufficient and the remaining hole is unidentified. Cooling the candidate turns that into a survivable fallback ending in a 529 naming `sonata dispatch`, instead of a bare 400 that kills the subagent |
| 14 | A killed subagent pins routing on for good, and `sonata route off` does not clear it ([spec](specs/2026-08-30-routing-reliability-defects.md)) | P0 | S | ✅ fixed, unreleased — `route off` now clears `route-subagents.json` too, so the documented recovery recovers. Two defects that produced the pin from ordinary use are fixed with it: the writer and cleaner defaulted to different scopes, and guarded one file with two different locks. The deadlock review found in the proposed fix is covered by a test that reproduces it in 2036 ms against `withSessionLock`'s 2000 ms deadline |

### III. Distribution — can a stranger actually run this?

| # | Item | Priority | Size | Status |
|---|---|---|---|---|
| 08 | Publish to npm, and automate the release | P0 | S | ✅ shipped in [0.4.0](https://www.npmjs.com/package/@zhihaohong52/sonata) — `npm run release -- <version>` promotes `[Unreleased]`, bumps the manifest and lock, and tags; `release.yml` publishes on the pushed tag via npm trusted publishing (OIDC) with provenance, storing no token. **Correction to what this entry previously said**: the bootstrap does *not* require publishing by hand first. `npm trust github <pkg> --file release.yml --repo <owner/repo> --allow-publish` (npm 11.10+) configures a trusted publisher for a package that does not exist yet — only the npmjs.com *web UI* has that limitation. 0.4.0 was in fact published manually before this was known. Remaining: run that `npm trust` command, or 0.4.1 reaches the publish step with no OIDC and fails after the tag is already pushed |
| 09 | Own the LiteLLM dependency — manage it, don't replace it (pinned managed venv, doctor installs/repairs) | P0 | M | ✅ fixed, unreleased — and the answer turned out to be better than managing it. A gateway declares its `provider`; an Anthropic-native one is reached **directly by sonata's own router with no LiteLLM in the path**, so a config whose gateways all speak Anthropic needs no LiteLLM, no venv and no Python at all. When one *is* needed, sonata installs its own venv pinned to `1.98.0` (`sonata litellm install`; `init` offers it, `doctor` reports six distinct states, `serve` refuses rather than installing because it runs headless from a SessionStart hook). `litellmRequired` counts every routable model, not just tier members — a bare model key never calls `resolveTier` |

### IV. Contract — the part where the number stops being decorative

| # | Item | Priority | Size | Status |
|---|---|---|---|---|
| 10 | Config schema v1, with migration that runs on load | P0 | S–M | ✅ shipped, unreleased — `schema_version` stamped by `init`, read by `parseConfig`, which walks the file forward through an ordered chain (`src/migrations.ts`) before field-level validation and refuses a stamp newer than it understands. Migration is **in-memory**: an old file keeps loading, and no read-only command rewrites it. The chain ships empty on purpose — v1 names the shape `parseConfig` already accepts, so what ships is the mechanism, the stamp and the refusal, with composition proven against a synthetic chain |
| 11 | `sonata doctor --json` | P1 | S | ✅ shipped, unreleased — `cmdDoctor` already returned a structured `{ ok, checks }`; the flag just exposes it, so it round-trips exactly what the text output was rendering |
| 12 | One report-contract manifest | P2 | M | ✅ shipped, unreleased — `src/report-contract.ts` owns `report.md`, referenced by the prompt, the watcher, the store, `sonata runs` and `tail`, where five bare copies of the string previously had nothing forcing them to agree. It owns the **file, not the verdict**: `decide()` in `tail.ts` keeps the degraded / report-impossible rules, because that predicate is a state machine over exit code, timeout and pane output whose every clause was written against an observed failure, and re-expressing it as a one-line helper would have to drop clauses to fit — the simplified version calls a *crashed* read-only run "report impossible", which is exactly the silent success those clauses exist to catch. `fallbackReportFile` stays per-adapter for the mirror-image reason: which file a harness writes is harness knowledge |

## Three releases, in dependency order

Measurement first because it backs the claim the product is sold on.
Distribution second because it is cheap and gates everyone else's ability
to try any of it. Freeze last.

- **0.3 — "Prove it works, and stop lying about the daemon."** The cost
  ledger, the route ledger, the run list, and an instance-identity
  handshake in `serve`. After this release, every claim sonata makes about
  itself is checkable by its user. *Items 01 · 02 · 03 · 05 — all shipped
  (2026-08-28).*
- **0.4 — "Let strangers in."** npm publish with an automated release, a
  managed LiteLLM venv, and a decomposed, end-to-end-tested `init`. This is
  the release that converts a repository into a product — and the one that
  will generate the bug reports 1.0 needs to have already answered. Two
  P0 reliability defects found in live use (a broken model absorbing its
  tier; a killed subagent pinning routing on for good) belong here too —
  shipping the install path while those defects are open would hand new
  users the very things that bit the existing ones. *Items 06 · 08 · 09 ·
  13 · 14.*

  **0.4.0 shipped 2026-08-31 carrying 06 and 08 only**, and 13 · 14 followed
  in 0.4.1. With 09 landed (unreleased), every item in this milestone is
  done — the version number describes the code it ships, not the completeness
  of the milestone, and the milestone is what closes here. Item 09's answer
  turned out better than the one the milestone asked for: rather than only
  managing the Python dependency, sonata now avoids needing it at all
  whenever a gateway speaks Anthropic natively.
- **1.0 — "Freeze the contract."** Schema version and load-time migration,
  structured doctor output, budget caps, the false-success check, and one
  report manifest. Ship 1.0 only after 0.4 has been in strangers' hands
  long enough to know what you would regret freezing. *Items 04 · 07 · 10 ·
  11 · 12.*

  **All five landed unreleased as of 2026-09-03, so every one of the
  fourteen items is now done — and 1.0 is deliberately still not tagged.**
  The milestone's own gate is not an item list: it is *"after 0.4 has been
  in strangers' hands long enough to know what you would regret freezing."*
  0.4 published to npm on 2026-08-31 and 0.5 on 2026-09-02; the elapsed
  time is days, and no external bug report has arrived to be answered. What
  the code can do is finished. What the gate asks for is exposure, and
  tagging 1.0 to celebrate an empty checklist would freeze a contract
  nobody outside this repository has tried to use — which is the one
  mistake this milestone was written to prevent.

## Explicitly not in 1.0

Naming these is half the value of the plan. Each has been considered and
declined, with the reason attached.

- **Native Windows.** Sonata drives tmux process groups and job control
  directly. This is a permanent documented non-goal, not an open question;
  WSL stays best-effort and untested.
- **Mid-stream failover.** Retry is pre-first-byte by design, which is
  exactly why it never corrupts a response in flight. Failing over
  mid-stream means buffering, which forfeits streaming. The 529-and-retry
  path already covers the case that matters.
- **A rendering or streaming layer.** For rendering and streaming, parity
  with a native Claude subagent remains the ceiling, not a floor. Agent
  fan-out is the deliberate exception granted on 2026-08-30; it does not
  reopen work on either declined layer.
- **An MCP server.** Removed on purpose in 0.2.0. Bash commands with a
  working allow-list beat RPC tools the permission classifier judges
  inconsistently — that failure was observed, not theorised.
- **More harness adapters.** The adapter boundary is proven at five.
  Additional harnesses are contributor work, not launch-blocking work —
  and each one added before 1.0 is another surface to freeze.
- **Telemetry.** A tool whose whole premise is routing your credentials
  through a local proxy does not get to phone home.
