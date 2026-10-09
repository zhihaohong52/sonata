# CLAUDE.md

This file provides guidance to AI assistants when working with this repository. For a human-readable overview, see `@README.md`. **Starting a session? Read `docs/HANDOFF.md` first** — current state, open follow-ups, and the environment traps that have cost previous sessions real time. The full design record behind the rules below lives in `docs/internals/` (see *Where the detail lives*); design notes and the implementation plan live in `docs/superpowers/`; lessons about dispatching work through sonata are in `docs/dispatching-work-through-sonata.md`.

## Project Overview

**Sonata** — foreign-model subagents for Claude Code. It lets you dispatch a subagent backed by a different model, through the ordinary Agent tool. Same interface, same working directory, same report contract — different brain. Motivations: cost (cheap high-cache models for mechanical work) and diversity of judgement (a different model family reviews Claude's work).

**Tier agents are the default path.** `sonata init` generates one agent per role × present tier (`code-simple`, `code-normal`, `code-complex`, `review-simple`, …), up to 12 agents, each running *natively inside Claude Code's own loop* — its tools, its permission modes, no separate TUI. An agent's frontmatter names a router alias (`model: sonata-code-simple`), not a specific model; a local routing proxy (`sonata serve`) resolves the alias against `[tiers.<role>]`'s ranked model list and tries each candidate in order, skipping one that's cooling down after a recent failure (`src/native/router.ts`). This is the same native path described below — the three tiers add distinct ranking and fallback choices on top of it.

**`sonata dispatch` is the fallback lane**, for when every native route in a tier has failed (or when a model has no native route at all, only a harness one): it launches the foreign model in *its own* CLI (OpenCode, Codex, Pi, or Reasonix) in a detached tmux session, blocking until the run finishes, needs approval, or stalls, trying the next ranked harness candidate on a thrown launch, a degraded finish, or an empty report. Sonata composes the role prompt + CLAUDE.md + task and reads completion from an exit sentinel + report file (never scraped from the terminal); a run that dies without writing a report is marked `degraded` so results are never falsely trusted. There is no MCP server — `dispatch`/`wait`/`approve` are Bash commands, allow-listed the same way the old MCP tools were.

**Status:** Working, early. Engine and the OpenCode/Codex/Pi/Reasonix adapters are complete and tested end-to-end against real models; so is the native path, including tier resolution and ranked fallback. Published to npm as `@zhihaohong52/sonata`; `npm link` from a clone is the development install.

## Requirements

- Node 22+
- tmux (every harness runs inside a tmux session) — `brew install tmux`
- macOS or Linux (Windows unsupported; WSL untested)
- At least one harness authenticated: OpenCode, Codex CLI (`codex login`), Pi, Reasonix (`reasonix setup`), or Claude Code
- LiteLLM for native gateways that need translation — sonata installs and pins its own
  (`sonata litellm install`); an Anthropic-native gateway needs none, and neither does Python

## Where the detail lives

This file is the day-to-day summary. The full design record — every measured
fact, reverted experiment and "why not the obvious fix" — moved to
`docs/internals/`. **Read the matching page before changing the code it
describes**; most of these rules exist because the obvious change was tried
and broke something.

| Page | Covers |
|---|---|
| `docs/internals/cli-reference.md` | Every command in full, the release/publish process, and the complete `route auto` history (including the superseded "env is read at launch only" measurements) |
| `docs/internals/architecture.md` | Design points: worktree fingerprint, harness-lane usage reading, tier ranking (`proposeTiers`, AA catalog, effort levels), `avoid_gateways`/`gateway_order`, pricing and models.dev |
| `docs/internals/configuration.md` | `sonata.toml` in full: schema_version, `[budget]`, `[models]`/`[tiers]`, legacy migration, keys/ids, BYOK, CLAUDE.md guidance block, init logging |
| `docs/internals/native-path.md` | Router tenancy, LiteLLM management, OAuth gateways (codex/copilot), ChatGPT token lineage, credential-store reads, opencode.ai session header, request transforms, serve state/restart |
| `docs/internals/permission-modes.md` | Per-harness permission-mode mapping and the capture hook |
| `docs/internals/limitations.md` | Known limitations, router fallback/400 handling, conversation affinity |
| `docs/internals/conventions.md` | Full text and history of the conventions below |
| `docs/guide/` | User-facing reference (README stays the front door) |

## Commands

```bash
npm install        # install dependencies
npm run build      # tsc → dist/
npm run typecheck  # tsc --noEmit
npm test           # vitest run (~2670 tests; needs tmux — runs against a fake harness)
npm run dev        # tsx src/cli.ts

npm link           # puts `sonata` on your PATH (development install)

npm run release -- 0.4.0   # promote [Unreleased] → dated section, bump manifest + lock,
                           # commit `chore(release): v0.4.0`, annotate the tag. Pushes nothing.
git push --follow-tags     # this is what publishes: the tag fires release.yml
```

**Which number to bump.** Pre-1.0 this project sets its own rule: **patch**
(`0.12.0` → `0.12.1`) for changes that do not affect what sonata does — fixes,
refinements, docs, a screen presenting data sonata already reported; **minor**
(`0.12.x` → `0.13.0`) for a change to sonata's function — how it routes, ranks,
prices or dispatches, a new config key, or behaviour a user relies on
changing. When unsure, ask rather than pick. **1.0 is gated on exposure, not a
checklist** (`docs/roadmap.md`).

**Releases:** changelog entries accumulate under `## [Unreleased]` as work
lands (`scripts/release.mjs` refuses an empty one; `release.yml` reads the
Release body from `CHANGELOG.md`). Publishing is npm trusted publishing (OIDC)
— no token in secrets. Details: `docs/internals/cli-reference.md`.

**`sonata` on PATH runs `dist/`, not `src/`.** After changing `src/`, run
`npm run build`, or the global command keeps the old behaviour — two bugs here
were "fixed" and kept reproducing for this reason. `sonata --version` on a
local build reports `<version>+dev.<stamp>` plus the commit, which tells you
which install answered.

### CLI at a glance

Full behaviour and rationale for each: `docs/internals/cli-reference.md`.

- `sonata init` — first offers a Yes/No update for each harness behind its npm latest, before any model is listed, since catalogues can be version-gated (`src/init/harness-updates.ts`; unattended runs never update); then the interactive wizard (config scope → providers → provider rank → models → roles → per-role tier rankings); writes `[models]`+`[tiers]`, generates agents, offers hooks/skill/routing/CLAUDE.md block. `A` on a ranking screen accepts it and all later ones (`acceptRemainingTiers`/`seededRankingFor`). Unattended: `--yes`, `--providers`, `--models`, `--roles`, `--config-scope`, `--scope`, `--routing`, `--guidance`, `--prune`
- `sonata upgrade` — `npm install -g` the latest release when it is newer; refuses a development (`npm link`) install, detected by its build stamp
- `sonata doctor` — tmux, harnesses, auth, permission hook, tier routing (and which of five reasons a session isn't routed), stale MCP registrations, legacy configs, unpriced gateways, catalog coverage then freshness
- `sonata reset [--global] [--yes]` — removes only what sonata wrote at one scope; keeps keys, ledger, caches, run store
- `sonata agents [--list] [--json]` — view/re-rank tier agents; the second writer of `sonata.toml`, via `replaceTiersBlock` (rewrites only `[tiers.*]`, parses back before writing)
- `sonata sync [--prune]` — regenerate agent files from `sonata.toml`
- `sonata run` / `sonata dispatch (--tier <role>-<tier> | --model <key>) [--task-file <path>] "<task>"` — harness-lane launch; `dispatch` blocks and falls through ranked harness candidates
- `sonata wait` / `sonata approve` / `sonata tail` / `sonata log <id>` / `sonata verify <id>` / `sonata runs` / `sonata gc` — run lifecycle and inspection (`runLogFile` in `src/run-log.ts` decides which log)
- `sonata auth list|add|remove|login <gateway>` — gateway keys (never logged); also the Artificial Analysis key
- `sonata catalog [update]` — AA model-ranking cache (never committed; license forbids redistribution)
- `sonata litellm install|status` — sonata's own pinned LiteLLM venv (`1.98.0`)
- `sonata serve [--daemon]` / `sonata restart` — **the** machine router (one per machine, multi-tenant); `restart` kills only pids sonata recorded
- `sonata code` — Claude Code session routed through the router
- `sonata route on|off|status|auto|manual [--global]` — route plain `claude` sessions; `auto` keeps Remote Control (SessionStart routes then settles; SubagentStart/Stop pair is the repair path; matcher `^(native-)?(code|review|explore|plan)(-|$)` — the `(-|$)` is load-bearing)
- `sonata usage [...]` / `sonata status [...]` — ledger reports (both lanes; unpriced volume reported beside priced, never folded in)

## Architecture

```
Claude Code
    │  Agent(subagent_type: "code-simple")
    ▼
sonata-code-simple   (native — Claude Code's own loop, model: sonata-code-simple)
    │
    ▼
router  (sonata serve — one per machine; each request resolved to its own project's config)
    │  resolveTierAlias against [tiers.code].simple, ranked candidates,
    │  cooldown on failure, first response < 500 wins
    ▼
litellm → flash-1   (or the next-ranked model)

     ── every native candidate exhausted (529) ──
                        ▼
sonata dispatch --tier code-simple "<task>"
    │  harness-routed candidates, ranked, launched by cmdRun/cmdWait
    ▼
opencode → deepseek-v4-flash   (or codex, pi, or reasonix)
```

Invariants to hold when changing code (reasons in `docs/internals/architecture.md`):

- **Dispatch tools must be allow-listed** (`Bash(sonata dispatch:*)`, `Bash(sonata wait:*)`, `Bash(sonata approve:*)`); the auto-mode classifier is not stable on them. There is no MCP server.
- **`sonata dispatch` never parses harness output** — it reads run state only. All harness-specific knowledge lives in its adapter.
- **Completion = exit sentinel + report file**, never terminal scraping. No report → `degraded`. A timed-out run (`run_timeout_seconds`) is `DONE`, degraded, `[timed out: …]`.
- **Worktree fingerprint** (`src/worktree.ts`): annotates `[no worktree change: …]`, never degrades; inert outside git; skipped for read-only roles; capture lands after the sentinel.
- **Harness-lane usage** is read from each harness's own store after the run (`src/harness-usage.ts`); `usage` is required on `HarnessAdapter`; matching never guesses; unknown is never zero; claimed once per run.
- **Tier ranking**: only models AA prices per task are ranked; `complex` by capability, `normal` by value led by the knee, `simple` = value order capped at `SIMPLE_COST_CEILING` × best-value cost. **Do not reinstate `SIMPLE_CAPABILITY_FLOOR`.** `avoid_gateways` demotes (never excludes); `gateway_order` only breaks ties.
- **Effort levels**: candidates are `<key>@<effort>`; a bare scored key is refused at load. On the harness lane each adapter reports `effortHonoured` (required); an unhonoured level is annotated, never degraded.
- **`sonata init` deletes whatever it does not write back** — `nativeTomlFor` must round-trip every key `parseConfig` reads. Add a round-trip test through `parseConfig` for any new config key.
- **Pricing**: `pricing_provider` names the models.dev provider; OpenRouter is the only unnamed fallback; ambiguous matches stay unpriced. `MODELSDEV_PROVIDER_FOR_GATEWAY` ≠ `PROVIDER_FOR_GATEWAY` — never fold them together.
- **Usage comes from the SSE stream**, not LiteLLM cost headers (structurally 0 when streaming).
- **Launch retries only on tmux "server exited unexpectedly"** (`retryWhenServerExits`).
- **`sonata init`'s TUI is Ink** (`src/tui-ink/`); `src/tui.ts` primitives stay for the remaining non-Ink prompts. A prompt must `ref()` stdin while waiting.

### Source layout

```text
src/
├── cli.ts                CLI entry point; arg parsing, then delegates to src/commands/*
├── commands/             command implementations (approve, auth, catalog, code, dispatch, doctor, gc, init, log, route, run, runs, serve, status, sync, tail, usage, verify, wait)
├── init/                 init pipeline — discover.ts (machine state, gathered once), validate.ts (shared problem list, both paths), plan.ts (every write as one InitPlan value), apply.ts (I/O only), interactive-state.ts + scripted-state.ts (two front ends, one InitState), toml.ts (nativeTomlFor), guidance.ts (the managed CLAUDE.md block that makes tier agents the default subagent lane)
├── config.ts             config resolution (project → machine), sonata.toml parsing (unified [models], [tiers]), KNOWN_HARNESSES, isReadOnlyRole, resolveTierAlias, harnessModelFor
├── catalog.ts            model normalization (normalizeModelName), curated capability/cost table, proposeTiers, AA catalog cache (loadAaCatalog, aaCatalogPath, AA_ATTRIBUTION)
├── effort.ts             the reasoning-effort enum, the <key>@<effort> candidate grammar, and AA's parenthetical parser — no imports, so config.ts and catalog.ts both use it
├── detect.ts             harness catalogues (`opencode models`, `pi --list-models`, reasonix doctor) → ModelRef, provider grouping; WELL_KNOWN_PROVIDER_URLS
├── migrations.ts         schema_version stamp, the ordered migration chain, applyMigrations (runs inside parseConfig, before field validation)
├── normalize.ts          config/model normalization; migrateLegacyConfig ([generate.roles]/[generate.native] → [models]+[tiers])
├── roles.ts              role prompt composition
├── report-contract.ts    the one definition of where a run's result lives (report.md) and how it is composed into a role prompt — the *verdict* (degraded / reportImpossible) stays in tail.ts's decide()
├── settings.ts           permission-hook scope settings, SONATA_TOOLS allow-list
├── store.ts              run state storage
├── tmux.ts               tmux session lifecycle (detached sessions, pane diffing)
├── run-log.ts          which file is a run's log (`runLogFile`: a non-interactive run's harness.log when it has content, else events.jsonl) and how a harness log is cleaned — shared by `sonata log` and the web UI's run detail
├── tui.ts                Minimal zero-dependency TUI primitives — pure parseKey/reduce/renderList so list behaviour is testable without a TTY; retained for the non-Ink prompts (init's hook scope, tier-routing offer, prune confirm)
├── watchdog.ts           run timeout enforcement
├── git-worktree.ts       resolves a linked git worktree to its main checkout (pure fs: the `.git` pointer file + its gitdir's `commondir`), so `configPath` can borrow that checkout's sonata.toml — distinct from worktree.ts, which fingerprints *changes*
├── worktree.ts           git worktree fingerprint (HEAD + `status --porcelain` + a blob hash per dirty path) sampled at launch and captured again by the launch wrapper at exit, so a run that finished having changed nothing says so; inert outside git
├── mode.ts               permission-mode mapping (plan/default/acceptEdits/bypassPermissions/auto)
├── ledger.ts             the router's append-only usage ledger (one JSON line per request, daily files under ~/.config/sonata/usage/, 30-day retention)
├── budget.ts             [budget] daily_usd — priced spend for the current UTC day (spentTodayUsd) and the router's refusal message (budgetRefusal)
├── pricing.ts            per-model/per-gateway price tables, optional UTC price windows, 0-vs-unpriced resolution
├── modelsdev.ts          models.dev per-token rate cache (per-token rates for public serving providers)
├── sessions.ts           session → project map for attributing native requests to a project
├── native/               native path — credentials.ts (gateway keys), litellm.ts (managed LiteLLM child config, now fed by unified [models] too), router.ts (local routing proxy; tier alias resolution, ranked fallback, cooldowns), models.ts (BYOK /models discovery), usage.ts (token accounting from the SSE stream)
├── types.ts              shared types
├── tui-ink/              Ink app for `sonata init`; components/ranked-select-state.ts + ranked-select.tsx (RankedSelect — selection order is the ranking), components/models-step.tsx (live /models refresh over the harness catalogue)
└── adapters/
    ├── types.ts          HarnessAdapter interface (plan, canPromptForApproval, promptPatterns, describePrompt, health)
    ├── index.ts          adapter registration
    ├── opencode.ts       smallest example adapter
    ├── codex.ts          most complete adapter
    ├── pi.ts             pi adapter
    ├── reasonix.ts       reasonix adapter — the only harness whose TUI sonata seeds itself
    └── claude.ts         claude harness adapter — headless `claude -p`, no TUI; native runs assume `sonata serve` is up

tests/                   vitest suite against a fake harness + captured fixtures in tests/fixtures/panes/ and tests/fixtures/aa/ (synthetic Artificial Analysis catalog fixture)
roles/                   role definitions (code, review, explore, plan) — owned by sonata, not the harness
skills/loop/SKILL.md     sonata-loop — the tier-routed feature loop skill sonata init installs
hooks/                   capture-mode.mjs + hooks.json — the PreToolUse permission hook
docs/                    HANDOFF.md (read first: state, open follow-ups, environment traps) + internals/ (the full design record moved out of CLAUDE.md) + dispatching-work-through-sonata.md + roadmap.md (1.0 roadmap and the source of record for it; it no longer mirrors anything, so update it here when an item ships) + guide/ (user-facing reference, split out of README.md — README stays the front door and links here) + reviews/ (architecture review) + superpowers/ (plans + specs, permanent design-history record, indexed in docs/superpowers/README.md)
```

### Adding a harness

The adapter boundary is the extension point — one new file plus registration:
1. `src/adapters/<name>.ts` — export a `HarnessAdapter` (interface in `src/adapters/types.ts`; implement `plan`, `canPromptForApproval`, `promptPatterns`/`describePrompt`, `usage` — read the harness's own store, or answer `unobservable` with a reason — and optional `health`)
2. `src/adapters/index.ts` — register it
3. `src/config.ts` — add the name to `KNOWN_HARNESSES`
4. `tests/adapters/<name>.test.ts` — follow an existing adapter's tests

**Probe the real binary before writing an adapter** — every adapter bug found so far was invisible in documentation and obvious on the first real run. If you claim a harness prints something, capture it into `tests/fixtures/panes/` and test against that.


## Permission modes

Sonata mirrors Claude Code's permission mode onto the harness; a sonata agent
is never more permissive than its session, and **a mode a harness cannot honour
is refused, never quietly downgraded**. The mode reaches sonata only through
the PreToolUse hook (`hooks/capture-mode.mjs`); without it sonata assumes
`default`, so opencode/pi dispatches refuse. `auto` maps to `acceptEdits`.
Never pass codex's `--dangerously-bypass-approvals-and-sandbox` or reasonix's
`-y`/`--auto`. Per-harness mapping: `docs/internals/permission-modes.md`.

## Configuration

Exactly one config resolves (`configPath`, `src/config.ts`): `./sonata.toml`,
else a linked worktree's main checkout's `sonata.toml`, else
`~/.config/sonata/sonata.toml`. Never merged. Routing settings/hooks are the
one thing a worktree cannot borrow — run `sonata route auto` in the worktree.

```toml
schema_version = 1

[models."flash"]
gateway = "acme"                    # native route
id = "deepseek-v4-flash-0731"

[models."kimi-k3"]
harness = "opencode"                # harness route (dispatch fallback)
id = "openrouter/kimi-k3"

[native.gateways."acme"]
base_url = "https://gateway.acme.example/v1"

[tiers.code]
simple  = ["flash", "kimi-k3"]      # ranked — first is tried first
normal  = ["flash", "kimi-k3"]      # optional; absent is valid, empty is refused
complex = ["kimi-k3", "flash"]

[budget]
daily_usd = 25
```

Rules that bite (full reference: `docs/internals/configuration.md`):

- **Top-level keys (`schema_version`, `avoid_gateways`, `gateway_order`) go above every table header** — a bare key after one belongs to that table.
- **Keys are always quoted** via `tomlKey` (`[models.grok-4.5]` nests wrongly); escape control characters everywhere.
- A newer `schema_version` than supported is refused; migration is in-memory only.
- `[tiers]` and legacy `[generate.*]` may not coexist; legacy configs migrate on `sonata init`.
- `tiersCollapse` is the single definition of "element-wise identical" tiers (one collapsed agent per role).
- `[budget] daily_usd` counts priced volume only; non-positive/non-numeric is refused at parse time.
- `claude-` model keys/ids are refused — that prefix routes to Anthropic (`isAnthropicRoutedName`).
- `sonata init` owns the managed CLAUDE.md block between standalone `<!-- sonata:begin -->`/`<!-- sonata:end -->` lines only; mismatched markers are refused, not repaired.
- A tier agent's `model` frontmatter is overridden by the Agent tool's `model` argument — which silently defeats routing.

## Native path

Foreign models run inside Claude Code's own loop through the local router
(`sonata serve`). Summary — the full record is `docs/internals/native-path.md`:

- **One router per machine, multi-tenant**: each request resolves to a tenant (a realpath'd `sonata.toml`) via the authenticated `x-sonata-project` header, then `sessions.json`, then the machine config. Cooldowns, budget and credentials are per tenant. Ports come only from the machine config.
- **Transport is derived from `provider` + `auth`**: `anthropic` api-key gateways go direct (credential swapped, body byte-identical); everything else goes through LiteLLM, started lazily and only when needed; `serve` never installs it.
- **Request transforms on the LiteLLM path only**: `litellmBody = demoteSystemTurns ∘ sanitizeToolSchemas ∘ flattenSystemBlocks`, plus `repairNamelessToolCalls` and `stripForeignThinking` on every transport. Anthropic requests stay byte-identical.
- **OAuth gateways** (`codex-oauth`, `copilot-oauth`) drive LiteLLM's own authenticator; sonata implements no OAuth. A harness-sourced ChatGPT token has exactly one writer once LiteLLM runs — do not reintroduce a live sync.
- **Fallback**: ranked candidates, first < 500 wins, 60 s cooldown; a 400 is terminal except the captured signature lists and message-less 400s; exhaustion returns 529 naming the `sonata dispatch` command.
- **Auto-routed tiers** (`[auto_route]`, `src/native/auto-route.ts`): `sonata-<role>-auto` gets one Jev tier decision per conversation, asked at one `base_url` (TypeSafe by default, OpenRouter, or a local `jev-compatible-server`) using the best JevBench-scored model there unless `model` pins one; fail-open to `normal`, and the chosen alias then takes the unchanged tier path.
- **Never kill the router by hand** — use `sonata restart`, which kills only recorded pids.
- Routing through the proxy costs Remote Control for sessions *launched* routed; `route auto` exists to avoid that.

## Security

Sonata launches other coding agents on your machine — they run **as you**, with your files and credentials. Codex and reasonix both offer a real sandbox (reasonix reports its own `write_roots`, which follow `--dir`); pi has none, and opencode's is advisory. Sonata never bypasses a harness's own safety flags; credentials stay with the harness (sonata reads harness config for health reporting but does not copy/forward/log API keys). Prompt injection is a real risk with foreign models — for untrusted code, dispatch read-only roles or run in a container.
The native router transits the session credential locally and unmodified; native keys flow store → environment → LiteLLM only.

## Known limitations

See `docs/internals/limitations.md` (maintainer detail) and
`docs/guide/limitations.md` (user-facing). Most relevant day to day: nested
native agents have no recursion limit or per-run attribution; concurrent
same-harness dispatches in one directory report usage `unobservable`; prompt
detection is regex with `STALLED` as the backstop.

## Conventions

Full text and history: `docs/internals/conventions.md`.

- **PR status**: run `node scripts/pr-status.mjs <n>` as soon as a PR opens and keep `--watch=60` running while any PR is open (agents add `--until-change` and restart after each change). Never merge on thread count alone — CodeRabbit also posts findings as plain comments.
- **CodeRabbit does not auto-review this repo** (under 10 stars): request the *first* review with `@coderabbitai review`. After fixing findings, push, reply on each thread, and resolve it — never request a re-review.
- **Non-trivial work goes through a PR** — anything touching money (pricing, ledger, `[budget]`), security, routing, or config parsing. Docs, `CHANGELOG.md` and one-line fixes may go direct to `main`.
- **Batch into omnibus PRs**; land every commit first, trigger review once, then push only review fixes (and say when you do).
- **Close issues with `Closes #n`** in the PR description; refer to pull requests as `PR #n`.
- **Harness-specific knowledge stays inside its adapter**; evidence over inference — capture real output into `tests/fixtures/panes/`. Probe the real binary before writing an adapter.
- **Tests need no API keys** and run on a private tmux server (`tests/global-setup.ts`); run one suite at a time. Run `npm test` and `npm run typecheck` before a PR.
- **The launch wrapper must `fg %1` the harness, unredirected** — a redirected `fg` leaves it stopped on SIGTTIN.
- **`sonata dispatch` relays; it never reasons about or parses harness output.**

<!-- sonata:begin -->
## Subagent lane

When this session is routed, execute implementation through the sonata tier
agents (`code-simple`, `code-normal`, `code-complex`, `review-*`, `explore-*`, `plan-*`)
rather than Claude's own general-purpose subagents. That is what sonata is
for: cheap models for mechanical work, and a different model family reviewing
Claude's own code.

Match the tier to the work. `-simple` is writable without asking a question
(one or two files, no interface change). `-normal` is the default: you know
what to change but not exactly how. `-complex` needs a design decision, or
"done" is still ambiguous.

**Your config decides which of those exist** — `sonata agents` lists them, and
a config written before the `normal` tier has only `-simple` and `-complex`.
Where there is no `-normal`, prefer `-simple` for work you could write without
asking a question and `-complex` for the rest; where a role's tiers are
identical, sonata generates one agent named for the role alone.

Size is not difficulty — a large mechanical change is `simple`, a three-line
change that decides an interface is `complex`. Start at the tier the task
needs rather than a rung higher: a task that fails review is re-run one tier
up, so starting low is cheap to correct.

Dispatch them with **no `model` argument**. Each agent pins its routed model
in frontmatter, and the Agent tool's own `model` parameter overrides that — so
passing one runs the agent on a Claude model that never reaches the router.
Nothing errors and nothing warns: every `review-*` dispatch quietly becomes
Claude reviewing Claude, which is the one thing this lane exists to prevent.
Choosing the tier **is** the model choice.

**This section addresses the session dispatching agents, not an agent reading
it inside its own run.** `CLAUDE.md` is injected into every subagent, so a
tier agent sees this text too — it is not an instruction to that agent to fan
out. Each generated agent carries its own `## Fanning out` rule, which binds
it to delegating *downward only* (`complex` may reach `normal` and `simple`,
`normal` may reach `simple`, `simple` may reach nothing). Fanning a task out
is your decision to make here, where the agent count is visible, by
dispatching several scoped agents yourself.

If a tier agent fails with `model_not_found`, the session is **not routed** —
that is a setup problem, not a broken agent. Run `sonata doctor`, and start
the session with `sonata code` (or `sonata route on` before launching).
<!-- sonata:end -->
