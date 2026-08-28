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

## Twelve items, four movements

Status legend: ✅ shipped · ⏳ not started.

### I. Measurement — the promise sonata sells and does not keep

| # | Item | Priority | Size | Status |
|---|---|---|---|---|
| 01 | `sonata usage` — a token and cost ledger | P0 | M | ✅ shipped in [0.3.0](https://github.com/zhihaohong52/sonata/pull/3) |
| 02 | Route ledger, and a `sonata status` that answers "who actually served this?" | P0 | S | ✅ shipped in [0.3.0](https://github.com/zhihaohong52/sonata/pull/3) |
| 03 | `sonata runs` — surface the list that already exists | P1 | XS | ✅ shipped in [0.3.0](https://github.com/zhihaohong52/sonata/pull/3) |
| 04 | Budget guardrails | P1 | S | ⏳ deferred to 1.0 — a consumer of the ledger; wait until real usage numbers exist before designing a cap around them |

### II. Reliability — the two things that already bit, on record

| # | Item | Priority | Size | Status |
|---|---|---|---|---|
| 05 | A daemon lifecycle you can trust (instance-id handshake, actionable takeover) | P0 | S–M | ✅ shipped in [0.3.0](https://github.com/zhihaohong52/sonata/pull/4) |
| 06 | `sonata init` hardening — the front door is the largest, least-tested file | P0 | L | ⏳ not started |
| 07 | Close the last false-success gap (worktree delta captured at launch and exit) | P1 | S | ⏳ not started |

### III. Distribution — can a stranger actually run this?

| # | Item | Priority | Size | Status |
|---|---|---|---|---|
| 08 | Publish to npm, and automate the release | P0 | S | ⏳ not started |
| 09 | Own the LiteLLM dependency — manage it, don't replace it (pinned managed venv, doctor installs/repairs) | P0 | M | ⏳ not started |

### IV. Contract — the part where the number stops being decorative

| # | Item | Priority | Size | Status |
|---|---|---|---|---|
| 10 | Config schema v1, with migration that runs on load | P0 | S–M | ⏳ not started |
| 11 | `sonata doctor --json` | P1 | S | ⏳ not started |
| 12 | One report-contract manifest | P2 | M | ⏳ not started |

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
  will generate the bug reports 1.0 needs to have already answered. *Items
  06 · 08 · 09.*
- **1.0 — "Freeze the contract."** Schema version and load-time migration,
  structured doctor output, budget caps, the false-success check, and one
  report manifest. Ship 1.0 only after 0.4 has been in strangers' hands
  long enough to know what you would regret freezing. *Items 04 · 07 · 10 ·
  11 · 12.*

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
- **A rendering or streaming layer.** Parity with a native Claude subagent
  is the ceiling, not a floor. Work aimed above it was considered earlier
  and declined; nothing has changed.
- **An MCP server.** Removed on purpose in 0.2.0. Bash commands with a
  working allow-list beat RPC tools the permission classifier judges
  inconsistently — that failure was observed, not theorised.
- **More harness adapters.** The adapter boundary is proven at five.
  Additional harnesses are contributor work, not launch-blocking work —
  and each one added before 1.0 is another surface to freeze.
- **Telemetry.** A tool whose whole premise is routing your credentials
  through a local proxy does not get to phone home.
