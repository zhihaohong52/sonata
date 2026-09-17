# Handoff — sonata after 0.10.0

Originally written 2026-09-04 at the end of the 0.6.0 session; the state
section was rewritten 2026-09-12 after 0.8.3. Read this before starting new
work. It records what is done, what is deliberately *not* done, what to pick
up if you want work, and the traps that have cost previous sessions real time.

**The short version:** every roadmap item is built, shipped and released, and
**nothing is queued**. The effort-tier work this file used to name as the one
open task shipped as #34 and is in 0.9.0; the sentence naming it as unpushed
survived two releases and sent at least one session looking for work that was
already merged, which is the failure this file exists to prevent. What remains
is judgement calls that belong to the user; read the 1.0 gate section before
going looking.

**0.10.0 (2026-09-17)** was the largest cut since 0.6.0: a third tier
(`normal`), the tier-selection rewrite, a local web UI on the router,
per-task-only ranking, the model-override and fan-out warnings, and dev build
stamps. The only open issue is #41 — two hardening guards on the UI's run
cache, neither a live defect.

## The tier set is three, not two (2026-09-16)

`[tiers.<role>]` now carries an **optional** `normal` list beside `simple` and
`complex`. Assume three tiers when reading anything below this section; the
narrative above and the incident records further down predate it and describe
two, which is what they were.

Each tier is one sort key: `complex` by capability, `normal` by capability per
task-dollar, `simple` by that same value ranking under a cost cap of 12x the
best-value model's own cost-per-task. `SIMPLE_CAPABILITY_FLOOR` is gone —
flooring the value tier makes it produce a list byte-identical to the cheap
one, which is measured in `docs/superpowers/specs/2026-09-16-three-tiers-design.md`.

**Nothing migrates.** `normal` is optional, so a config without one parses,
generates the same 8 agents and routes exactly as before; there is no
`schema_version` bump. A user gains the third tier by re-running `sonata init`.
Verified end to end: this repository's own config has no `normal` and still
syncs 8 agents, while a scratch three-tier config syncs 3 for one role.

The thing most likely to be got wrong next is **selection, not ranking**. Over
30 days of ledger, `complex` took 74% of tiered requests and 80% of spend,
because every agent description used to end "when unsure, use `-complex`".
`-normal` is now the default and the criteria are observable rather than
adjectival. Judge whether that worked with `sonata usage --by tier`, and if the
split has not moved, the next lever is structural rather than more wording.

## Where things stand

- `main` at `ed34902`, clean, in sync with origin. **`[Unreleased]` is not
  empty** — it carries the effort-level tier candidates (PR #28) and the three
  fixes from PR #32, so a release can be cut whenever the user wants one.
- **npm**: `@zhihaohong52/sonata@0.8.3`, `latest`, published 2026-09-12 from
  the pushed tag with every `release.yml` step green and provenance signed.
- **1975 tests across 101 files**, typecheck and build clean, verified on the
  merged tree.
- **Zero open issues, zero open PRs.** #29, #30 and #31 were opened and closed
  on 2026-09-14 by PR #32; see the sections below for what each one turned out
  to be.
- **All fourteen roadmap items remain ✅**, each named with the release it
  shipped in. `docs/roadmap.md` explains *why* each is shaped as it is; nothing
  since 0.6.0 has added or reopened a roadmap row, because everything after it
  came from running the thing rather than from the plan.
- **1.0 is still not tagged, on purpose.** Standing decision the user confirmed
  on 2026-09-02 ("close remaining items, don't tag 1.0 yet"); nothing since has
  changed it.

### What 0.7.0 – 0.8.3 added, and why

Read `CHANGELOG.md` for the detail. The shape of it:

- **Multi-tenant routing** — one router per machine, each request resolved to
  its own project's `sonata.toml` by a tenant id over the config's *realpath*.
  Cooldowns, budget, pricing and credentials all key off that tenant.
- **Pricing that admits what it does not know** — models.dev rates, an
  OpenRouter fallback for one unnamed provider, vendor-qualified key matching
  that refuses to pick between two disagreeing prices, and `pricing_provider` /
  `[price]` blocks now *preserved* across an `init` rewrite. That last one was
  a real data loss: read by `parseConfig`, written by nobody, so every `sonata
  init` silently un-priced the gateway and narrowed `[budget]` with it.
- **Real context windows** — windows come from models.dev instead of a 128000
  placeholder that 19 of 24 models on the development machine were carrying,
  and a tier whose every candidate clears 1M generates its alias with a `[1m]`
  suffix that Claude Code reads as "assume 1M" and strips before routing.
- **`sonata --version`**, which prints the version *and* the directory it ran
  from, because `sonata` on PATH runs `dist/` and two bugs in this repo were
  "fixed" while reproducing for exactly that reason.
- **`sonata agents`** (0.8.3) — see and re-rank each tier agent's ranked
  candidates without walking the wizard. It is the **second writer of
  `sonata.toml`**, and writes through `replaceTiersBlock`, which replaces the
  `[tiers]` tables alone and leaves every other byte alone. Round-tripping
  through `nativeTomlFor` was rejected deliberately: that rebuilds the file
  from a reconstructed `NativeCandidate[]`, which is the exact shape of the
  `pricing_provider` loss above.
- **`sonata reset`** (0.8.3) — undo what `init` wrote, at one scope, removing
  only what sonata wrote and keeping keys, ledger and caches.

## The 1.0 gate is not an item list — read this before inventing work

**Nothing is queued.** The effort-tier PRs this once named shipped as #34 in
0.9.0. Everything in
*this* section is about why "nothing left to build" still does not mean "time
to tag", which is a separate question and was true before the effort-tier work
existed.

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

## First external report — 2026-09-09

The 1.0 gate waits on external bug reports. The first arrived, from a Claude
session in the `teambuilding` project (gateway `anexto`, Azure `gpt-5.6-luna`,
Claude Code 2.1.260), and both defects reproduced and are fixed on `main`
(unreleased at the time of writing — see `[Unreleased]` in `CHANGELOG.md`):

1. **Native write-role agents 400 on every OpenAI-compatible provider** —
   Claude Code's Artifact tool schema carries a `\p{Cc}` regex Python's `re`
   cannot parse. `sanitizeToolSchemas` on the litellm path.
2. **`route session-start`'s port-collision refusal was swallowed by the hook.**
   The hooks now surface any non-zero exit as a `systemMessage`. **The collision
   itself was then designed away** — see the multi-tenant router below, after
   which two projects sharing a router port is the supported case.

Two of the reporter's suggestions were **not** taken, on purpose: an explicit
`tools:` allowlist for write roles (drops fan-out; the next tool with the same
shape breaks the same way — the transport is the right layer), and treating a
project `sonata.toml` that is byte-identical to the machine config as the same
config for port sharing (true only until one file is edited, after which the
daemon in the other project's cwd silently keeps serving the old one). Their
local workaround — a second router on `[native.ports] router = 4101` for that
project — is the documented shape and needs no undoing.

The reporter runs the npm install, so nothing above reaches them until a
release is cut. That is the user's call.

## Second external report — 2026-09-10, from a git worktree

Same reporter, same project, this time working in
`teambuilding/.claude/worktrees/foundation-1b`. Two findings, one fixed and one
not:

1. **A worktree resolved no project config** — `sonata.toml` is untracked, so
   `git worktree add` produces a directory with none of the project's sonata
   state, and everything run there fell through to the machine config or to
   none. Fixed: `configPath` now borrows the main checkout's config
   (`src/git-worktree.ts`), and `sonata doctor` names the worktree instead of
   repeating a bare "run `sonata route auto`". Confirmed live on a worktree of
   this repository. Note the reporter's hand-copied `sonata.toml` is still
   registered with the running router as its *own* tenant — that split is what
   the borrow removes once the copy is deleted.
2. **~~The settings `env` block is read at launch only~~ — RETRACTED
   2026-09-14; see "The launch-only finding was wrong" below.** What follows is
   the observation as recorded at the time. The dispatches really did 404; the
   inference drawn from them did not survive measurement.

   **The settings `env` block is read at launch only, on the current Claude
   Code build.** They wrote the env by hand into a *running* session's settings
   file, confirmed `route status` reported routing on, and two native agents
   dispatched from that session still 404'd at `api.anthropic.com` with the
   router logging nothing. The hooks themselves were confirmed firing in that
   session (`routing on; 2 subagent(s) running`), so it is not a write race,
   not a hook-wiring failure, and not worktree-specific. **This
   removes the measured fact `sonata route auto` is built on** — its design is
   "launch clean, route at SubagentStart" — so `sonata code`, or `route on`
   *before* launching, is the supported path today. Not fixed; see the
   `route auto` bullets in `CLAUDE.md` for the full history, including the
   reverted attempt that made it worse.

   Settled the same day: a `sonata code` relaunch **from the same worktree**
   routed correctly — 28 tier-alias requests in this repository's router log
   served to foreign models, no `sonata-*` alias reaching Anthropic, a native
   `code-simple` implementer completing and committing. A plain session
   launched a minute *before* its env was written did not. So the process
   environment works and the settings-file path does not, which is precisely
   the path `route auto` is built on.

   **Do not go looking for a local replacement — there probably isn't one.**
   `route auto`'s entire purpose was avoiding the Remote Control trade-off,
   and it did that by launching from a clean settings file (the one moment
   the gate reads the base URL) and routing afterwards via the per-request
   re-read. With the re-read gone, every remaining route into the router is a
   *launch-time* route: `sonata code` exports `ANTHROPIC_BASE_URL` into the
   process, `route on` writes it where launch will read it, and both lose
   Remote Control exactly as documented. `ANTHROPIC_BASE_URL` is process-wide
   and `isFirstPartyAnthropicBaseUrl` gates Remote Control, so there is no
   third position available to us.

   That makes this **upstream-blocked, not undesigned**. Having both back
   needs something from Claude Code — a per-subagent base URL, or a Remote
   Control gate not keyed on the process-wide one. Worth reporting upstream;
   not worth another local attempt, and specifically not worth re-trying the
   timer trick (`bdf8e27`), which failed tens of minutes in. The honest
   status to give a user today is: pick routing or pick Remote Control.

Routing settings and hooks are the one thing a worktree cannot borrow: Claude
Code reads `.claude/settings.local.json` relative to its own cwd, so they must
exist in the worktree. Given finding 2 above, launch with `sonata code` from
the worktree, or run `sonata route on` there *before* starting the session —
`route auto` installs the hooks but cannot route a session that has already
launched.

## The launch-only finding was wrong — corrected 2026-09-14

The 2026-09-10 conclusion above ("the settings `env` block is read at launch
only") was mistaken, and the "upstream-blocked, don't attempt another local
fix" verdict built on it is withdrawn. `route auto` is fixed on `main`'s
successor branch; this section records how, because the *evidence* that
overturned it is the part worth keeping.

**What was actually happening.** Mid-session `env` writes ARE picked up. What
fails is one subagent: the one whose start fires the `SubagentStart` hook has
already resolved its endpoint by the time the hook's write lands, so it alone
reaches `api.anthropic.com` and dies with `model_not_found`. Every earlier
session watched exactly that subagent fail and concluded nothing was read.

**The measurements** (Claude Code 2.1.270, all attributed per session id in the
ledger rather than by router log line — the log is shared by every routed
session on the machine, which is how the first attempt at this confounded two
sessions):

- A session that launched into a clean settings file picked up an env written
  mid-session by a `SubagentStart` hook at 18:53:32 and routed **231 requests**
  afterwards; its first routed request landed in the same second as the write.
- A subagent dispatched from that same session later routed normally
  (`sonata-review-simple -> deepseek-deepseek-flash`, 200).
- Removing the env does **not** stop a running session routing: 54 minutes and
  still routing, pinged every 8 minutes.
- A session launched clean and routed by its own `SessionStart` hook keeps
  Remote Control — confirmed by the user against the live session, and again by
  the cross-session messaging layer reporting it as Remote Control connected.

**The fix.** `cmdRouteSession('start')` writes the routing env — before any
subagent exists, so nothing races it — and schedules `cmdRouteSettle`, which
takes it back out a few seconds later in a detached child (the hook blocks the
session's own start, so the delay cannot be waited out in-process). The session
keeps routing on the value it has already read; the removal is what lets the
next session launch clean and keep Remote Control. Verified end to end: a
session launched against the built CLI routed 11 requests including a tier
alias, with the settings file clean again by the time it did.

**The `SubagentStart`/`SubagentStop` pair is kept, demoted to a repair path.**
The reverted `bdf8e27` experiment remains the honest limit: the value a session
holds is a cache with a lifetime, not a permanent state, and that session
lapsed after tens of minutes. 54 minutes is longer than that and still not a
proof of permanence. So a lapse must be *recoverable* rather than assumed away
— if one happens, the next foreign-model subagent's start re-writes the env and
the session picks it up again. **If you observe a lapse, that is the mechanism
to reach for; do not lengthen the settle delay, which cannot help.**

**Also fixed while measuring this: a collapsed tier agent could never route.**
`SONATA_AGENT_MATCHER` required a trailing hyphen, but a role whose `simple`
and `complex` lists are element-wise identical is generated as ONE agent named
for the role alone (`explore`). It matched nothing, fired no hook, and died at
Anthropic — indistinguishable from a broken agent. The boundary is now `(-|$)`.
This had been live for as long as `tiersCollapse` and the matcher have
coexisted, and no test compared them.

## Effort-level tier candidates — all three PRs written; **2 and 3 are open as #34 (`feat/effort-router`)**

A `[tiers]` candidate may pin a reasoning-effort level
(`"gpt-5.6-luna@xhigh"`), the catalog records which level each Artificial
Analysis row was scored at, and both writers of a tier list rank every scored
level of a model as its own candidate. Read
`docs/superpowers/specs/2026-09-13-effort-tiers-design.md` and its plan
(`docs/superpowers/plans/2026-09-13-effort-tiers-pr1.md`) before touching it;
the `CLAUDE.md` bullet is the short version. Merged 2026-09-13 as PR #28
(`2c4549f`); unreleased, sitting in `[Unreleased]`.

**A pinned level now reaches the model on both lanes** — that was PR 2
(`75e144d`, the router and the ledger) and PR 3 (the harness adapters), both
committed on `feat/effort-router` and neither pushed. What each one settled is
recorded under its own heading below.

**The facts below were verified on `ed34902`, before PR 2 and PR 3 — they are
kept as the "before" picture and every one of them is now out of date:**

- `reasoning_effort` appears in `src/` exactly once, as a *comment* in
  `src/effort.ts`. It is never constructed and never sent.
- `TierRoute.effort` is populated at `src/config.ts:802` and **read by
  nobody**. The only other `.effort` reads in the tree are catalog-internal
  (`src/catalog.ts:310-317`, `src/commands/catalog.ts:221`), which parse AA
  rows and have nothing to do with dispatch.
- `src/native/router.ts` contains no reference to effort at all.
- `src/ledger.ts` has no `effort` field.
- `src/commands/dispatch.ts` does not parse the `<key>@<effort>` grammar, so
  `--model luna@xhigh` today looks up a literal key named `luna@xhigh` and
  fails to find it.

### PR 2 — router injects `reasoning_effort`, ledger records it — **done, `75e144d`**

Spec §4, built as specified below. The router is the layer that knows a request's level, and a ledger row
should name it for the same reason it names the candidate that served the
request. The shape the spec settles:

- `withEffort(body, effort)` sets top-level `reasoning_effort` **and deletes
  `thinking` and `output_config.effort`**. This is the load-bearing detail:
  LiteLLM translates `thinking` into `reasoning_effort` when present, so
  leaving both in is how an explicit `xhigh` gets silently overwritten by
  `adaptive → medium`. A bare candidate leaves the body untouched.
- Both transports, for the reason `litellmBody` is one function. On `direct`
  the body is otherwise byte-identical because assistant blocks carry opaque
  vendor state; adding one top-level key leaves those alone. **What a direct
  upstream does with the key is an implementation-time probe** against
  OpenRouter's `/v1/messages` — ignored is fine, rejected means send unchanged
  and log `effort not sent`.
- Cooldowns and the capability-400 fingerprint stay keyed by **model, not
  variant**, so a 5xx from `luna@xhigh` also skips `luna@high` rather than
  retrying the same dead upstream. Already true today; do not "fix" it.
- Ledger row gains `effort`; `sonata usage --by effort` is one more entry in
  the existing dimension table.
- A stated limit worth keeping in the code: `drop_params: true` means a
  provider with no effort control drops the field silently, and the router
  cannot tell "honoured" from "dropped". Same class as unpriced volume —
  report unknown, never assume. The only evidence a level applied is per-task
  cost moving with it, which is why recording `effort` on the row is worth it.

**Note for whoever writes it:** `routeTierRequest` gained conversation
stickiness in PR #32, so the per-candidate body is now built as
`withModel(prepared, …)` where `prepared` may already have been through
`stripForeignThinking`. `withEffort` composes into that chain; it must not be
applied before the strip, since both touch `thinking`-adjacent fields for
different reasons.

### PR 3 — harness adapters — **done, on `feat/effort-router`**

Spec §5. Every mapping was probed against the real binary on 2026-09-14, per
the repo rule; the probe results, not documentation, are what each adapter
comment records.

- **codex** 0.153.4 — `-c model_reasoning_effort=<level>`, on `codex exec`
  *and* the interactive TUI. The run header prints `reasoning effort: xhigh`,
  so it demonstrably takes. An invalid level is refused by the *upstream*,
  naming exactly sonata's own `EFFORT_LEVELS`, so no mapping is needed.
- **opencode** 1.18.29 — `--variant <level>` on `opencode run`. Applied:
  reasoning tokens moved with it on an identical prompt (132 at `low`, 230 at
  `xhigh`) and the stored message records the variant. `--help` declares it
  `[string]`, not `[array]` like `-f`, so it is safe before the positional
  message. The level is passed through **unmapped** — models.dev publishes the
  legal set per *model* and `opencode run` drops an unknown variant silently,
  but substituting a nearby level would run at a setting the user never chose
  while still reporting it honoured.
- **pi** 0.85.1 — `--thinking <level>`, where sonata's `none` is **mapped** to
  pi's own `off`. Mapped rather than passed through because pi warns and
  continues at its default on a level it does not know, so an unmapped `none`
  would silently run *with* thinking.
- **reasonix** — **not installed on the probing machine**, so `effortHonoured`
  is `false` and the report is annotated. That is "unprobed", not "probed and
  found absent"; if you install it and find a control, set the flag true and
  capture the evidence under `tests/fixtures/panes/` like every other reasonix
  behaviour.
- **claude** — the level travels in the model name (`--model <key>@<effort>`),
  which `routeRequest` already splits. A flag here would be a second mechanism
  for something PR 2 already wired.

`LaunchPlan.effortHonoured` is **required, not optional**, so a new adapter
must answer rather than inherit a default. It claims the level reached the
command line, never that the model has that level — same unknowable as the
router's `drop_params`.

**The annotation wording deviates from the spec's literal string**, deliberately:
`[effort xhigh not honoured: sonata has no effort control for reasonix]`,
not `… reasonix has no effort control`. The spec's own instruction for reasonix
is to record it as unprobed rather than untested-but-assumed-absent, and the
original wording asserts an absence nobody measured.

**Two regressions PR 3 introduced and fixed before landing**, both found by a
`review-complex` pass over the diff and both verified in the tree first:

1. **An Anthropic-routed model name must not carry a level.** `routeRequest`
   skips the `<key>@<effort>` split for a `claude-` model, because such a
   request is forwarded byte-identical by contract — so appending a level does
   not reach the splitter, it reaches Anthropic as part of the model name and
   is rejected. A `[models]` entry with `harness = "claude"` and a `claude-…`
   id would have turned a working dispatch into a 404. `claude.ts` now leaves
   such a name bare and returns `effortHonoured: false`.
2. **The annotation belongs on *both* trusted branches.** It was on the
   report-present branch only, which dropped it on the `reportImpossible`
   (`[read-only run: …]`) path — un-degraded, trusted, and exactly where a
   read-only **reasonix** run lands, the one harness with no effort control.
   The note now rides both.

**Findings from that review left unfixed, in rough severity order.** None is
caused by PR 3; each is recorded here rather than folded in, because each
wants its own change.

1. **`src/adapters/claude.ts:71` + `:94` — the claude lane reports a crash as a
   success.** The script redirects stderr into `last-message.txt`, and that file
   is the adapter's `fallbackReportFile`. `decide` deliberately does not consult
   `exitCode` when a report exists, so a bad key, an unknown model id or any 4xx
   writes an error message that becomes the "report": the run is `DONE`,
   un-degraded, and `cmdDispatch` stops instead of trying the next ranked
   candidate. The contrast is real — opencode and pi send `2>&1` to the pane,
   and codex's fallback is written by codex itself via `-o`, so it can only hold
   the model's final message. Fixing it means deciding what belongs in that file
   at all; the `no tee` comment above it explains why the redirect exists.
2. **`src/commands/tail.ts:81-95` — `spoke` can be satisfied by a bare shell
   prompt.** `harnessOutput` filters blank lines, the launch marker and the
   `bash '…/harness.sh'` echo, and nothing else. On the claude read-only lane
   stdout goes to a file, so the prompt line tmux prints *after* the command
   survives the filter and `reportImpossible` yields `DONE` with a prompt line
   as the report. Latent: it needs `claude -p` to exit 0 with empty stdout,
   which was not confirmed. A `decide({canWriteReport: false, report: null,
   exitCode: 0, paneTail: ['…$']})` unit test would pin it.
3. **`sonata doctor` has no advisory for a candidate whose only route is a
   harness with no effort control** (spec §6's third line). PR 3 is what makes
   it derivable; it was not in PR 3's brief.
4. **`sonata runs` and `sonata status` show the bare key, not the variant.**
   `meta.effort` and the ledger row's `effort` both exist, so two runs of one
   model at different levels are distinguishable in the store and not in either
   view. `status` is PR 2's scope.
5. **Version gates admit builds the flags were never probed against**
   (`opencode.ts`, `pi.ts`, `codex.ts`). The probes were 1.18.29 / 0.85.1 /
   0.153.4; an older supported build that ignores an unknown flag rather than
   erroring would make `effortHonoured: true` a false claim. This is how every
   other flag in these adapters already works, which is why it is a note and
   not a change.

**Declined, with the reason, so nobody re-raises it:** the review asked for
captured fixtures under `tests/fixtures/panes/` for the probe output quoted in
the adapter comments (codex's `reasoning effort: xhigh` header, pi's `Warning:
Invalid thinking level`, opencode's token counts). Nothing in sonata *parses*
any of those strings — the repo rule exists for behaviour sonata detects, and
PR 3 added no pane assertion. Capturing them would mean manufacturing fixtures
for runs this session did not perform, which is worse than citing the probe.

**Known gap, recorded rather than fixed:** `sonata run --model` does *not*
accept the `<key>@<effort>` grammar — only `sonata dispatch` does, which is
what the spec asks for. Typing it on `run` fails loudly with `unknown model
"luna@xhigh"` and a list of defined models, so it is a papercut rather than a
silent mismatch; fix it by splitting in `cli.ts`'s `run` block the way the
dispatch block does.

**Two known gaps in the effort-tier work, recorded rather than fixed.**

1. **The upstream-id resolver's *scoring* half is untested.** `upstreamFor` is
   threaded through `expandCandidates` *and* through `proposeTiers`'
   `rankOf`/`eligible`/`isCheap`, so expansion and ranking always resolve the
   same name — but only the expansion half is asserted. Reverting
   `proposeTiers`' fifth argument alone leaves the suite green at 1933:
   `reconcileTierList` appends the pins at `rankOf === Infinity` instead of
   interleaving them, so every assertion still passes and the only difference
   is a tier ordered by the mid-score fallback. The masked failure is a
   mis-*ordering*, not a refusal that cannot be cleared, which is why this is
   recorded rather than blocking. Ten lines close it permanently: assert
   `proposeTiers(['luna','flash'], FAMILY_AA, ['codex','deepseek'], new Set(),
   upstreamFor)` places `luna@low` ahead of `luna@max` in `simple`.

2. **Resolving through the id is a silent ranking change for a key that spells
   one model and points at another.** An Azure-style deployment
   (`[models."gpt-5.6-luna"]` with `id = "my-gpt5-deployment"`) now scores from
   the curated/default table where it previously matched AA on its key. That is
   the intended direction — it is what the refusal and `sonata doctor` already
   treated as truth, and the ordinary case (`flash` for
   `deepseek-v4-flash-0731`) gets better — but it is untested and worth knowing
   before someone reports a tier that reordered itself.

**`sonata init` used to corrupt a `CLAUDE.md` that documents the markers**
(#29, fixed in PR #32). Markers were counted wherever they appeared, so a file
merely *quoting* `<!-- sonata:begin -->` and `<!-- sonata:end -->` in prose
looked like a well-formed pair and the managed block was spliced into the
middle of the sentence joining them — destroying the one paragraph that
explains the contract, in this repository's own `CLAUDE.md`. `standaloneMarkers`
(`src/init/guidance.ts`) now counts a marker only when it is the entire trimmed
content of its line. **If you find a `CLAUDE.md` in a checkout predating
2026-09-14 with `## Subagent lane` spliced mid-sentence, that is this bug and
the surrounding prose has to be restored by hand** — the splice is not
reversible from the file alone. Copies of the damage were kept in that
session's scratchpad and are gone now; `git show 2c4549f:CLAUDE.md` is the last
good version before the fix.

**`sonata init` now originates a `pricing_provider` for a gateway it writes
for the first time** (#31, fixed). Before this, nothing ever originated one and
`resolvePrice` returned `source: 'none'` at its `provider === undefined` guard
before models.dev was consulted — so a fresh config priced nothing, `[budget]
daily_usd` bounded $0 forever, and an OAuth gateway never reached
`relabelCovered`, reading as unpriced rather than `covered`. Two things worth
keeping in mind now that it exists: `MODELSDEV_PROVIDER_FOR_GATEWAY`
(`src/pricing.ts`) is a **separate table** from `PROVIDER_FOR_GATEWAY`
(`src/native/providers.ts`) and merging them would be a silent regression —
the first names models.dev ids, the second LiteLLM prefixes, and they disagree
on Gemini (`google` vs `gemini`); and the proposal fires **only for a gateway
absent from the config being rewritten**, which is what makes deleting the key
a permanent decline. Add a mapping only after checking the id against a real
models.dev feed.

**One asymmetry is known and deliberately left in place.** The init tier
*screen* widens a scope's rankable gateway names with the selected candidates'
gateways **and** the gateways that scope's config declares
(`interactive-state.ts`'s `declaredGatewayNames`, read by `app.tsx`), while
the init *writer* still derives them from candidates alone
(`gatewayNamesOf(nativeByKey)`, `src/init/plan.ts:146`). The two can disagree
only for a gateway declared in `[native.gateways]` that has **no** native
model whose key prefixes a harness-only key — no config producing that could
be constructed. If one arose, the screen would offer a row the writer's
`validTierKeys` lacks, and `reconcileTierList` would drop that saved key.
Widening the writer's universe changes init's write path for every user and
deserves its own review; the failure direction is a visible dropped key fixed
by re-ranking, not a wrong model.

## If you want work, in the order I would take it

**Do PR 2 of the effort-tier spec first** — it is the queued task, it is what
turns PR 1 from ranking metadata into behaviour, and it is self-contained. The
list below is what remains after it.

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

## The codex-oauth hole is found and closed (2026-09-09)

The 2026-09-03 section above stands as history; here is the correction. The
remaining hole was **not** in `system`: Claude Code 2.1.266 sends
mid-conversation system messages as a `role: "system"` turn inside
`messages`. Captured via a logging proxy in front of the router, probed
directly against LiteLLM (string `system` alone streams; plus a system turn
→ 400), fixed by `demoteSystemTurns` on the litellm path, verified live on a
scratch daemon. Item 1 of "If you want work" is done. Also learned on the
way: LiteLLM 1.98.0 reads `supports_system_message` from `litellm_params`,
not `model_info`, so sonata's declaration never took effect — harmless now,
worth cleaning up.

## One router for every project — built 2026-09-09, on `feat/multi-tenant-router`

The branch turns `sonata serve` into a single machine-wide router that resolves
each request's own `sonata.toml`. Read
`docs/superpowers/specs/2026-09-09-multi-tenant-router-design.md` (including its
live-run section) and `docs/superpowers/plans/2026-09-09-multi-tenant-router.md`
before touching it; `CLAUDE.md`'s "Tenancy" paragraph is the short version.
Unreleased at the time of writing, full suite green.

**Two defects were found by running it, not by reading it**, which is the
argument for keeping the live check in any future plan of this shape:

- One config registered as **two tenants** (`/var/…` and `/private/var/…`),
  because macOS symlinks `/var` and the path string was the identity. Duplicate
  LiteLLM entries, a needless restart, split cooldowns and budget. Tenant
  identity is now the realpath.
- `cmdRouteSubagent` wrote the routing env **without** the check every other
  entry point makes, so a dispatch from this repository was served by a stale
  2026-09-04 daemon running another project's config and failed against
  gateways this repository must not use. It now refuses a pre-multi-tenant
  router before writing anything.

**Upgrading starts with `sonata restart`.** Routing targets the machine port
now; a daemon predating this change still holding it answers with whatever
single config started it. That is refused rather than trusted, but the refusal
is a failure, not a fix — restart first.

**A trap this branch also exposed:** `tsconfig.json` includes `src/**` only, so
`npm run typecheck` never typechecks `tests/`. A changed dependency signature
therefore breaks test call sites with a clean typecheck, and only the full
`npx vitest run` catches it — two tasks here passed their targeted gates with
latent breaks for exactly that reason. Run the full suite before believing a
signature change is done.

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
- **A conversation now keeps the candidate that served it** (#30, fixed). The
  router used to pick a ranked candidate **per request**, so a conversation
  whose earlier requests were served by one model — carrying that model's
  extended-thinking blocks in its history — could fall through to a candidate
  that rejects them: `400 — The content[].thinking in the thinking mode must
  be passed back to the API`. Observed twice on 2026-09-13, both landing on
  `deepseek-deepseek-flash` after `gpt-5.6-luna` had served the earlier turns.
  `conversationKey` + `stripForeignThinking` (`src/native/router.ts`) fix it:
  the serving candidate is preferred on later turns, and a switch drops the
  previous model's thinking blocks rather than forwarding them. **The residual
  risk to know about** is that stickiness is keyed on a hash of the first
  message, so two agents opening with byte-identical text share a pin — which
  costs only a shared preference, never correctness, since the strip covers
  any switch either way.
- **`sonata usage` now reports candidates a request fell past.** The ledger had
  always recorded them in each row's `attempts` and nothing read them, which is
  why the original report of the bug above found no trace of the failing model
  and wrongly concluded the router had not recorded it. It had. If you are
  chasing a dead subagent, read the `fell past` line before concluding the
  router never saw the request.

### Git, PRs and review

- **CodeRabbit no longer auto-reviews this repository, and `pr-status.mjs`
  reports a clean PR as unclean because of it.** As of 2026-09-14 CodeRabbit
  posts a standing comment saying *"This repository does not receive automatic
  reviews because it has fewer than 10 stars"* (the repo has 1; PR #28 was
  reviewed automatically two days earlier, so this is a policy change, not a
  repo change). Two consequences, both of which cost time on PR #32:
  - **A review must be triggered by hand**, via the `🔍 Trigger review`
    checkbox in that comment. The user ticks it — do **not** post
    `@coderabbitai review`; that is an explicit standing instruction. One tick
    does cover subsequent pushes: CodeRabbit re-reviewed a follow-up commit on
    #32 unprompted and answered both threads within minutes.
  - **`node scripts/pr-status.mjs <n>` then exits 1 on a genuinely clean PR.**
    It reads the *latest bot comment* for a verdict, and the only bot comment
    is now that banner, which contains no verdict — so it prints `no
    recognisable verdict — findings outstanding` forever. The thread count is
    the signal that still works. On #32 the true state was `2 total, 0
    unresolved`, both resolved by CodeRabbit itself with an explicit
    confirmation on each thread, while the script still said findings were
    outstanding. **Read the threads and who resolved them; do not trust the
    exit code on this repo until the script is taught about the banner.**
- **The `CodeRabbit` status check reports SUCCESS for a review that never
  ran.** It went green on #32 while the only bot comment was the "fewer than 10
  stars" notice. Combined with `0 unresolved threads` — also true, because
  nothing had been reviewed — the PR looked fully green and was not reviewed at
  all. Two green ticks and an empty thread count are not evidence of a review;
  a CodeRabbit *review* object or a thread it resolved is.
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
- **Never merge on a thread count alone — run `node scripts/pr-status.mjs`.**
  CodeRabbit posts some findings as plain *issue comments* rather than review
  threads, so a PR can report "0 unresolved threads" while a P1 sits in a
  comment body; that is how a blocking finding on #23 was nearly merged past.
  The script reads mergeability, CI checks, threads *and* the latest bot
  verdict, and exits non-zero unless all four are clean. Its first run caught a
  failing CI check a manual sweep had missed, and later exposed an empty test
  file committed by mistake (96/97 files collected while every test passed).
- **This repository is under 10 stars, so CodeRabbit does not review
  automatically.** It posts an "IMPORTANT: Trigger review" notice instead,
  which `pr-status` reports as *no recognisable verdict* — correctly, since the
  alternative is calling an unreviewed PR clean. Comment `@coderabbitai review`
  to start one. Re-requests are **rate limited**, and the refusal ("Review rate
  limited … does not re-review already reviewed commits") looks identical
  whether the review has run or not; the reviews *do* land on their own
  schedule, so hammering the command achieves nothing. The user asked
  explicitly for that hammering to stop on 2026-09-12.
- **Resolving a conflict by keeping both sides needs reading afterwards.**
  Rebasing `feat/agents` onto a merged `feat/reset` this way produced a
  `CLAUDE.md` paragraph spliced from two half-sentences and a `src/cli.ts` that
  would not parse (the first command block lost its closing). Typecheck caught
  the code; only re-reading caught the prose. A CHANGELOG merge in an earlier
  session truncated six bullets to two the same way. Check a word count across
  the splice, or read it.
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
- **Claude Code's Bash-tool shell drops single-underscore zsh functions from
  its snapshot.** A `~/.zshrc` stub like `node() { _nvm_lazy_load; node "$@"; }`
  survives the snapshot but `_nvm_lazy_load` does not, so every `node`/`npm`
  in a tool shell prints `command not found: _nvm_lazy_load` and recurses to
  `FUNCNEST`. Fixed 2026-09-13 by renaming the helper to `nvm_lazy_load`;
  keep the lazy loading itself (it saves ~650 ms per shell, which the tmux
  panes `npm test` spawns pay). Within an already-broken session, prefix
  commands with `unset -f node npm npx nvm corepack; . ~/.nvm/nvm.sh >/dev/null;`.

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
