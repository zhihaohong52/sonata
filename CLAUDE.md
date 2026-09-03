# CLAUDE.md

This file provides guidance to AI assistants when working with this repository. For a human-readable overview, see `@README.md`. **Starting a session? Read `docs/HANDOFF.md` first** — current state, open follow-ups, and the environment traps that have cost previous sessions real time. Design notes and the implementation plan (including defects found by running it) live in `docs/superpowers/`; lessons about dispatching work through sonata are in `docs/dispatching-work-through-sonata.md`.

## Project Overview

**Sonata** — foreign-model subagents for Claude Code. It lets you dispatch a subagent backed by a different model, through the ordinary Agent tool. Same interface, same working directory, same report contract — different brain. Motivations: cost (cheap high-cache models for mechanical work) and diversity of judgement (a different model family reviews Claude's work).

**Tier agents are the default path.** `sonata init` generates one agent per role × difficulty tier (`code-simple`, `code-complex`, `review-simple`, …), each running *natively inside Claude Code's own loop* — its tools, its permission modes, no separate TUI. An agent's frontmatter names a router alias (`model: sonata-code-simple`), not a specific model; a local routing proxy (`sonata serve`) resolves the alias against `[tiers.<role>]`'s ranked model list and tries each candidate in order, skipping one that's cooling down after a recent failure (`src/native/router.ts`). This is the same native path described below — tiers just add ranking and fallback on top of it.

**`sonata dispatch` is the fallback lane**, for when every native route in a tier has failed (or when a model has no native route at all, only a harness one): it launches the foreign model in *its own* CLI (OpenCode, Codex, Pi, or Reasonix) in a detached tmux session, blocking until the run finishes, needs approval, or stalls, trying the next ranked harness candidate on a thrown launch, a degraded finish, or an empty report. Sonata composes the role prompt + CLAUDE.md + task and reads completion from an exit sentinel + report file (never scraped from the terminal); a run that dies without writing a report is marked `degraded` so results are never falsely trusted. There is no MCP server — `dispatch`/`wait`/`approve` are Bash commands, allow-listed the same way the old MCP tools were.

**Status:** Working, early. Engine and the OpenCode/Codex/Pi/Reasonix adapters are complete and tested end-to-end against real models; so is the native path, including tier resolution and ranked fallback. Published to npm as `@zhihaohong52/sonata`; `npm link` from a clone is the development install.

## Requirements

- Node 22+
- tmux (every harness runs inside a tmux session) — `brew install tmux`
- macOS or Linux (Windows unsupported; WSL untested)
- At least one harness authenticated: OpenCode, Codex CLI (`codex login`), Pi, Reasonix (`reasonix setup`), or Claude Code
- LiteLLM for native gateways that need translation — sonata installs and pins its own
  (`sonata litellm install`); an Anthropic-native gateway needs none, and neither does Python

## Commands

```bash
npm install        # install dependencies
npm run build      # tsc → dist/
npm run typecheck  # tsc --noEmit
npm test           # vitest run (1177 tests; needs tmux — runs against a fake harness)
npm run dev        # tsx src/cli.ts

npm link           # puts `sonata` on your PATH (development install; users get
                   # it from `npm install -g @zhihaohong52/sonata`)

npm run release -- 0.4.0   # promote [Unreleased] → a dated section, bump the
                           # manifest + lock, commit `chore(release): v0.4.0`,
                           # annotate the tag. Pushes nothing.
git push --follow-tags     # this is what publishes: the tag fires release.yml
```

**Releases are prepared locally and published by the tag.** Changelog entries
accumulate under `## [Unreleased]` while the work is fresh, rather than being
reconstructed at release time from `git log` — the moment you are least able
to say why a change mattered. `scripts/release.mjs` promotes that section and
refuses an absent or empty one, because `release.yml` reads the GitHub Release
body straight back out of `CHANGELOG.md`. The workflow re-runs the same
composite action CI does (`.github/actions/verify`) — one definition, since a
release path that has quietly stopped matching the path gating merges is worth
nothing — and refuses outright if the tag and `package.json` disagree.

**Publishing uses npm trusted publishing (OIDC), so no npm token is stored in
repository secrets.** The trust relationship is configured once, from the CLI:

```bash
npm trust github @zhihaohong52/sonata \
  --file release.yml --repo zhihaohong52/sonata --allow-publish
```

**`npm trust` works on a package that does not exist yet** — only the
npmjs.com *web UI* has the chicken-and-egg limitation, and an earlier version
of this file wrongly recorded that limitation as npm's. 0.4.0 was published by
hand because of that mistake; nothing after it needs to be. The operation
requires 2FA on the account, and npm requires 2FA (or a bypass token, itself
[being retired](https://github.blog/changelog/2026-07-08-npm-install-time-security-and-gat-bypass2fa-deprecation/))
to publish anything at all.

`publishConfig` sets `access` but **not** `provenance`: provenance needs CI's
OIDC token, so declaring it in the manifest would break any local publish —
which is exactly the escape hatch you want available when the pipeline is the
thing that is broken.

**Trusted publishing makes GitHub repository write access equivalent to
publish rights.** npm says so when configuring it. For a solo repository that
is the same trust boundary as before; adding collaborators changes that, and
`--environment` (a protected GitHub environment with required reviewers) is
how it narrows.

The CLI (after `npm link`):
- `sonata init` — set up sonata (interactive wizard; asks the config scope, then providers, models, roles, per-role models, then ranks each role's selected models into `simple`/`complex` tiers — pre-sorted from a cached Artificial Analysis catalog when one exists, else built-in defaults. Left goes back a screen, skipping any answered by a flag; `A` on a ranking screen confirms it **and every screen after it** with the ranking each would have opened on — a tier screen per role × tier means four roles cost eight near-identical confirmations, and `acceptRemainingTiers` (`src/tui-ink/app-state.ts`) applies `seededRankingFor` so the result is indistinguishable from pressing enter through the rest, verified by writing a byte-identical `sonata.toml`. **Seeding alone is not that answer**, which is what made the first version of this wrong: `tierPickerKeys` withholds a key that has a native route but whose provider is deselected this session, and `RankedSelect` drops any seeded value missing from its rows — so confirming a screen writes the tier *without* that key, while bulk acceptance skipped the component and kept it. `seededRankingFor` reproduces both steps; writes `[models]`+`[tiers]`, generates one agent per role × tier, offers the permission hook, installs the `sonata-loop` skill, offers `sonata route auto`). A config still in the older `[generate.roles]`/`[generate.native]` shape is migrated automatically (`migrateLegacyConfig`, `src/normalize.ts`). Unattended flags: `--yes`, `--providers`, `--models`, `--roles`, `--config-scope project|global`, `--scope project|global|skip`, `--routing project|global|skip`, `--prune`
- `sonata doctor` — check tmux, harnesses, auth, versions, permission hook, tier routing (a tiered config with no routed session — and **which** of the five reasons it is not routed: nothing installed, hooks belonging to a *different* sonata install, an install carrying only the pre-subagent session pair, global routing that cannot serve a project holding its own `sonata.toml`, or a base URL left pointing at a since-changed router port; `diagnoseRouteAuto`/`routingFailureDetail`. All five printed one sentence naming only the fix, so a user who had just run `sonata route auto` was told to run it again), stale MCP registrations, legacy (pre-`[tiers]`) configs, ranking-catalog **coverage then freshness** (advisory: a catalog older than `AA_CATALOG_MAX_AGE_DAYS`, or none at all, still ranks — on superseded scores or the built-in table — so the failure is a silently-wrong ordering rather than an error. Coverage is checked *first* because age is the wrong instrument for the failure it was standing in for: a catalog fetched yesterday is "fresh" and still knows nothing about a model released today. `catalogCoverage` (`src/catalog.ts`) asks whether the catalog scores the models this config actually tiers, and names the ones it cannot. Tier lists hold config *keys* while the catalog is keyed by upstream *id*, so `cmdDoctor` resolves each key through `native.models` **and** `models` before asking — comparing keys would report every hand-named model as unscored)
- `sonata sync` — regenerate agent files from `sonata.toml`; Claude Code picks them up automatically. When `[tiers]` is set, generates only tier agents (one per role × tier, or one collapsed agent when a role's `simple`/`complex` lists are element-wise identical) — legacy per-model generation is skipped entirely. Supports `--prune`
- `sonata run` — launch a run, print its id
- `sonata dispatch (--tier <role>-<tier> | --model <key>) [--task-file <path>] "<task>"` — blocking CLI dispatch with ranked harness fallback: tries each harness-routed candidate in order, moving to the next on a thrown launch, a degraded finish, or an empty report; prints the state, the model that ran, and the report. This is the fallback lane a tier agent reaches for when the router's native candidates are all exhausted (529 names the exact command). `PAUSED` prints `sonata approve <id>`; `RUNNING` prints `sonata wait <id>`; a `FAILED` outcome (every candidate failed) exits 1 with the ranked attempt history
- `sonata tail` — human/debugging view of a run (PROGRESS | PAUSED | DONE | STALLED)
- `sonata approve` — answer a pending approval
- `sonata log <id>` — print a run's whole transcript; the after-the-fact companion to `tmux attach`
- `sonata verify <id> [--model <key>]` — verify a completed run
- `sonata auth` — manage native-path gateway keys (`list`, `add <gateway>`, `remove <gateway>`, `login <gateway>`; keys live in the store, never logged). Also how an Artificial Analysis key reaches `sonata catalog update`: `sonata auth add artificialanalysis`
- `sonata catalog [update]` — bare `catalog` reports the cached model-ranking catalog's age and count, or points at `update`; `update` fetches `artificialanalysis.ai`'s models endpoint with the stored key (sent via `x-api-key`, never argv/logged) and caches `normalizeModelName` → coding index + blended price for `proposeTiers` to rank against. AA's free-tier license forbids redistributing its data, so the response is never committed — only a hand-invented fixture is
- `sonata litellm install|status` — install or report sonata's own pinned LiteLLM venv (`~/.config/sonata/litellm`, pinned to `1.98.0`). `status` reports one of six states — `not-required` when no gateway in the config routes through it, which is a healthy answer and not a missing dependency. `install` is a no-op for such a config
- `sonata serve` — run the native router, and its managed LiteLLM child **only when the config needs one** (`litellmRequired`): an Anthropic-only config starts no child, needs no port, and prints `no litellm needed by this config`. `--daemon` re-execs the CLI detached, **waits until the router answers**, then prints the pid, port and log path; a detached child that failed would otherwise report success and leave no server. Its output goes to `~/.config/sonata/logs/serve-<timestamp>.log`, since a detached process has nowhere else to say why it stopped. Watches its LiteLLM child and respawns it in place if it exits on its own (a crash-loop guard gives up after 5 respawns/60s)
- `sonata restart` — kills whatever sonata router currently holds the configured port (a stale daemon, or another native router) using only a pid `cmdServe` itself recorded, then starts a fresh daemon. Plain `sonata serve --daemon` cannot recover from this case: it just times out against `EADDRINUSE` with "the daemon did not answer", which reads as a startup failure rather than "something else already has it". See `stopServe`/`cmdRestart` in Configuration below.
- `sonata code` — launch a Claude Code session routed through the local proxy (passes `claude` args through); auto-starts `sonata serve --daemon` when the router is down
- `sonata route on|off|status [--global]` — route every plain `claude` session launched in the project through the proxy, not just ones `sonata code` starts: it writes the routing `ANTHROPIC_BASE_URL` env into `.claude/settings.local.json` (or, with `--global`, `~/.claude/settings.json`) and installs a SessionStart hook (`hooks/ensure-serve.mjs`) that keeps the router up, so editor integrations and `.mcp.json` entries route too. `off` removes both; `status` reports which scope(s) — project, global, or both — currently route. The session registry stays per-project regardless of scope: a global hook fires in every directory, but routing state still follows each session's own project
- `sonata route auto|manual [--global]` — routing that keeps Remote Control. `auto` installs a SessionStart hook that turns routing on and a SessionEnd hook that turns it back off (`hooks/route-session.mjs`, whose body is `sonata route session-start|session-end --id <id>` so the logic is tested TypeScript rather than hook script). Each session therefore *launches* from a file with no `ANTHROPIC_BASE_URL` in it — which is the only moment Claude Code consults it for the Remote Control gate — and is routed from its first request, because the settings `env` is re-read per request. Session ids are counted in `.sonata/route-sessions.json`: `route off` fires only when the last one ends, since an auto session (unlike a `route on` one) has no exported env and *would* lose routing mid-run if a sibling cleaned the file. A session killed before its SessionEnd hook leaves its id behind and routing on — the safe failure direction, costing one launch's Remote Control rather than silently demoting a native agent to Claude; `sonata route off` clears the registry. `manual` removes the hook pair. `cmdRouteSession` validates the project has a config before touching the registry, so a global hook firing in a configless directory throws before writing anything
  - **Routing follows subagents, not sessions.** `auto` installs a *second* hook pair — `SubagentStart`/`SubagentStop` (`hooks/route-subagent.mjs`, matcher `SONATA_AGENT_MATCHER` = `^(native-)?(code|review|explore|plan)-`) — and those are what actually route. `cmdRouteSession` only starts the daemon and counts liveness; it deliberately does **not** route. So a session launches, and stays, in a clean settings file unless a foreign-model subagent is running, which is how *every* session keeps Remote Control rather than only the first. `cmdRouteSubagent` counts running subagents so one finishing cannot un-route its siblings mid-task, and the last session out clears any leaked subagent references — a subagent killed before its `SubagentStop` would otherwise pin routing on for good.
  - **Two measured facts justify that shape.** **Adding** the routing env is picked up by an already-running session within seconds — verified live 2026-08-27 with routing off at dispatch, the `SubagentStart` hook turning it on, and the router logging `model=sonata-explore-simple -> gpt-5.6-luna -> litellm` moments later, which is why a subagent's very first request is already routed. **Removing** it is observed only eventually, on a timescale not yet measured.
  - **That first fact did not reproduce on 2026-09-01, and the failure is silent.** Two `code-simple` subagents dispatched from a session launched into a clean settings file both died with `model_not_found` for `sonata-code-simple` — the alias reached `api.anthropic.com`, not the router. The `SubagentStart` hook *had* fired both times (`.sonata/route-subagents.json` held the agent id and `.claude/settings.local.json` held `ANTHROPIC_BASE_URL`), and the second attempt started with the env already in place for minutes, so this is not a write race. `env | grep ANTHROPIC` in that session confirmed the variable was never in its process environment. Whether the per-request re-read regressed, or the 2026-08-27 session had been launched routed and only appeared to pick it up, is not established — but a session that will not route cannot be told apart from one that will, except by dispatching and watching it fail. A session launched *while* routing is already on works, which is why `/cmux` is the reliable way to get a routed session today.
  - **Do not "fix" Remote Control by cleaning the file on a timer after SessionStart.** That was tried (`bdf8e27`, reverted in `f5ca015`) on the theory that a routed session *latches* — that once it has read `ANTHROPIC_BASE_URL`, removing the key cannot un-route it. Two fresh sessions appeared to confirm it, each still routing across several turns after removal. **The latch is a cache with a lifetime, not a permanent state.** The session that developed the change kept working for tens of minutes and then began sending `sonata-*` aliases to `api.anthropic.com`, which answers "issue with the selected model … it may not exist". That is worse than the bug it replaced: losing Remote Control is visible at launch, whereas a foreign-model agent dying mid-task reads as a defect in the agent's own work.
  - **An install predating this carries only the session pair, and would never route.** `autoInstalled` therefore requires all four hooks, so `sonata doctor` reports a stale install rather than a working one; the fix is re-running `sonata route auto`
- `sonata usage [--since 7d] [--by model|role|tier|gateway|session|project] [--session <id>] [--json]` — tokens and cost from the router's ledger. **Native path only**: a `sonata dispatch` run executes in the foreign CLI's own process and never transits the router, so its tokens are unobservable. Unpriced volume is reported beside the priced total, never folded into it — a total that treats unknown as zero under-reports silently
- `sonata status [--session <id>|--all]` — whether the router is up and on which port, then the recent alias → candidate served → tokens → failed attempts decisions from the ledger (the last hour by default; `--session` narrows to one session, `--all` skips the narrowing). Reachability and routing-state live in `sonata route status`, which reports whether *settings* route this project's sessions
- `sonata runs [--json]` — list this project's dispatch runs. `sonata log <id>` previously required an id with no way to find one
- `sonata gc` — kill finished tmux sessions

## Architecture

```
Claude Code
    │  Agent(subagent_type: "code-simple")
    ▼
sonata-code-simple   (native — Claude Code's own loop, model: sonata-code-simple)
    │
    ▼
router  (sonata serve)
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

Key design points:
- **The three dispatch tools must be allow-listed**, which `sonata init` now does and `sonata doctor` checks. In Claude Code's `auto` mode an un-allow-listed tool is judged per call and the decisions are not stable: on 2026-08-12 a wrapper had `run` allowed and `tail` allowed twice then denied twice mid-run ("Blocked by classifier"), so a foreign model kept writing to the repository with nothing able to observe it. `run` executes code and is the one the classifier tends to permit, which makes the failure silent by construction. Those tools are `Bash(sonata dispatch:*)`, `Bash(sonata wait:*)`, and `Bash(sonata approve:*)` — the tool surface moved from MCP to Bash, but the allow-listing story is unchanged: the classifier is still not to be trusted with these calls.
- **There is no MCP server.** `sonata dispatch` blocks until a reportable state the same way the old MCP `dispatch` tool did, and `sonata wait`/`sonata approve` resume or unblock a specific run by id — but as ordinary Bash commands a model runs itself, not RPC calls a wrapper relays. `Bash(sonata:*)` was tested against the old MCP-only setup and found to be silently ignored by Claude Code; the current `Bash(sonata dispatch:*)`-style entries are the real, working allow-list form.
- **`sonata dispatch` never parses harness output**; it only reads run state (state, degraded, report) from `cmdRun`/`cmdWait`. All harness-specific knowledge lives in one adapter file.
- **Completion is read from an exit sentinel and a report file**, never scraped from the terminal. If a harness dies without a report, sonata returns the captured pane and marks the result `degraded`.
- **A finished run also reports whether the worktree moved** (`src/worktree.ts`). Every other guard checks whether the harness *reported*; none checked whether the repository changed, so a run could finish `DONE`, un-degraded, claiming "fixed the bug" having touched nothing — the one shape of false success the report contract cannot see, since a model that did nothing writes the same file as one that did everything. `cmdRun` hashes a capture of `git rev-parse HEAD` + `git status --porcelain` + a `git hash-object` blob hash per not-committed-clean path into `meta.worktreeAtLaunch`; the launch wrapper writes the same capture before the exit sentinel and `tail` compares, surfacing `TailResult.worktreeUnchanged`. **The content hashes are not optional**: `status` records which paths are in what state and never their content, so a file already modified-but-unstaged at launch and edited again reports the identical line — the ordinary mid-feature case, silently reported as "changed nothing". `WORKTREE_CAPTURE_SH` is the single definition both ends run (Node via `bash -c`, the wrapper inline), because two samples that disagree about what they measure are worse than no check; the fingerprint is then just sha256 of those bytes, so there is no formula left to reimplement in bash. `.sonata` is excluded from the enumeration — `status` collapses an untracked directory to one entry but `ls-files -o` lists every file under it, including the `report.md`/`exit`/capture files the run itself is about to write, which would mark every run as changed. `git hash-object` is called without `-w`, so nothing enters the user's object store. Three deliberate constraints: it is **inert outside git** (no repo, no git, any failure → `undefined`, read as *unknown*, never as "unchanged" — a check for silent failures must not invent one); it **annotates rather than degrades**, prefixing the report with `[no worktree change: …]`, because `degraded` means sonata cannot mechanically trust the result and a run that correctly concluded no change was needed is legitimate — degrading it would trade false successes for false alarms rather than removing either; and read-only roles skip it entirely, since a review or explore run is not expected to leave a mark. The launch sample is taken *after* `createRun`, so sonata's own `.sonata/` scaffolding is present in both samples and a repo that does not ignore it still gets a usable comparison. HEAD is in the hash so a run whose only trace is a commit — leaving a clean tree — still registers.
- **Progress comes from diffing the tmux pane.** You can attach to any live run: `tmux attach -t sonata-<id>` (`-r` read-only) — so you can correct a cheap model mid-run.
- **`run_timeout_seconds` is a hard cap** enforced by a watchdog inside the launched shell; on expiry the whole process group is killed and the run is reported `DONE`, `degraded`, report beginning `[timed out: …]`.
- **`sonata init`'s interactive TUI is an Ink app** (`src/tui-ink/`), not the hand-rolled prompt functions. The pure list primitives in `src/tui.ts` (`parseKey`/`reduce`/`renderList`) and the `select`/`confirm`/`runList` prompts are retained for the non-Ink interactive prompts that remain — init's hook-scope, tier-routing offer, and confirm steps, and `cli.ts`'s `confirm` — and are intentionally not deleted.
- **The provider-setup step is a menu**: `Import from other harnesses` bulk-imports providers with detected Codex or OpenCode credentials, while `Add provider` lets the user pick any known provider or enter a fully custom provider (name, base URL, and wire format). Custom providers always use API-key authentication; Sonata has no generic OAuth flow beyond the Codex and GitHub Copilot LiteLLM-backed device flows.
- **The models step asks each gateway what it serves**, rather than trusting a harness catalogue (`src/tui-ink/components/models-step.tsx`). A harness snapshot keeps listing a model the gateway has since dropped and misses one it has since added, so on entering the step every selected gateway with a base URL, a resolvable key, and non-OAuth auth is queried in parallel; `mergeLiveCandidates` (`src/tui-ink/app-state.ts`) then **replaces** that gateway's candidates, which is what actually retires a stale entry. Three things keep this safe: a gateway that does not answer (unreachable, empty, timed out, no key) keeps its harness list, so a failed refresh degrades to the old behaviour rather than emptying the picker; a **custom** provider added this run is the one case that still picks models on its own screen, because `allNativeCandidates` is computed at startup and cannot contain a provider that did not exist then — an *existing* gateway does not, since the models step refreshes it with the very key just typed (`state.byokKeys`), and asking twice is what produced the duplicate-key bug; an id the harness already listed **keeps its existing candidate key**, since the key addresses `nativeKeys` and the written config and reconstructing it would silently deselect the user's choices; and OAuth gateways are skipped outright, because a subscription credential is not a bearer key and those endpoints are not OpenAI-shaped (ChatGPT's is `backend-api/codex`, Copilot needs a token exchange first).
- **`normalizeModelName` strips *configured* provider prefixes, not a hardcoded list.** A model key is `<gateway>-<id>`, so recovering the id needs the gateway names; the built-in list (`openrouter-`, `openai-`, `google-`, `anthropic-`) can only cover providers someone thought to hardcode, and every other user's gateway fell through to the `default` catalog entry — capable, *not cheap* — silently dropping its models out of the simple tier. When no model clears the cheap bar, `proposeTiers`' fallback makes simple mirror complex, so the tier stops discriminating at all. Callers pass their gateway names (`gatewayNamesOf`, `src/commands/init.ts`); prefixes are matched longest-first so `openai-codex-x` loses the whole gateway name rather than the shorter `openai-`.

- **An OpenRouter ref needs two more repairs before it can be scored.** Its serving-variant suffix (`:free`, `:nitro`, `:floor`) picks a route for the *same weights*, so `normalizeModelName` strips it — unambiguous, since `:` appears in no name AA publishes, and measured: `openrouter-nvidia-nemotron-3-super-120b-a12b:free` matched nothing while AA held that exact row minus the suffix. Separately, a sonata key flattens `vendor/model` to `vendor-model`, and by lookup time the slash `normalizeModelName` would have cut on is long gone — so `z-ai/glm-5.2` looks up `z-ai-glm-5.2` while AA files it as `glm-5.2`. `aaLookupNames` offers up to two shortened spellings *after* the full name, and `aaEntryFor` is the single lookup both `lookupModel` and `scoreFor` route through. Three properties bound the guess so it can only ever add a score where there was none: the full name is tried first and **always wins**, so this cannot move a model that already matches; a shortened name is accepted only on an *exact* catalog hit; and a candidate must still carry a version digit, so `gemini-2.5-flash-lite` never offers `flash-lite` — a family, not a model, and exactly the sort of name another vendor also publishes under. Three of five OpenRouter models on a real config were mis-scored by this.

- **Tiers rank on agentic capability per task-dollar, from AA's free language endpoint.** `sonata catalog update` reads `/api/v2/language/models/free` (paginated) rather than `/data/llms/models`, because only it publishes `artificial_analysis_intelligence_index_cost.cost_per_task` — the dollars to run one benchmark task, which prices the *work* instead of the tokens — and `artificial_analysis_agentic_index`, the closest published proxy to what a sonata subagent does. Every role is an agentic subagent, so one metric serves all four; `capabilityOf`/`costOfEntry` (`src/catalog.ts`) fall back to coding index and a computed 3:1 blend for models AA has not scored or costed. **`complex` sorts by raw capability** (cost breaks ties); **`simple` sorts by capability per task-dollar**, which is the opposite of what it used to do — it took the *most capable* model that happened to be cheap, when a cost tier should take the most capability *per dollar*. `SIMPLE_CAPABILITY_FLOOR` (0.75, relative to the best model the user actually selected) stops a very cheap, very weak model winning on ratio alone; when nothing clears it, the fallback value-ranks the whole set rather than emptying the tier. It controls *both* depth and the leader: a tier is a ranked fallback list, so a floor strict enough to admit one model leaves the router nothing to fall through to, while a looser one can also admit a cheaper model that then outranks the rest on value — measured on a real config, 0.85 admitted one model and 0.75 admits four with a different model first. The cache records `intelligence_index_version`, and a fetch whose version changes mid-pagination is refused — two scales are not comparable.

- **Simple-tier *admission* uses the same measure as simple-tier *ranking*, and it is relative.** It did not: admission tested `blendedPriceUsd <= AA_CHEAP_BLENDED_PRICE_USD` — dollars per 1M **tokens** — while ordering inside the tier used `costPerTask`, dollars per unit of **work**. A model can be dear per token and cheap per task, and the gate then refuses the very model the ranking would have led with: `gemini-3.8-flash` is $1.50/1M and $0.577/task, refused at *any* catalog freshness; so is `gemini-3.7-flash` at the same rate. `proposeTiers` now admits on `costPerTask <= min(costPerTask over eligible leaders) × SIMPLE_COST_CEILING` (12) — relative for the same reason `SIMPLE_CAPABILITY_FLOOR` is, and measured over `preferred` for the same reason the floor is. Measured on two real configs: three admitted models → four (Gemini 3.8 Flash ranked, previously absent outright) and three → five. **Only a model that could actually enter the tier may set the ceiling** — `eligible` (capable, and clear of the floor) gates both who sets the bar and who is judged against it, so the two cannot drift apart. The floor reads every leader safely because it is a `Math.max`, which a weak model cannot drag down; the ceiling is a `Math.min`, which one absolutely can. Measured on the existing `junk` fixture: at $0.001/task it set a $0.012 ceiling nothing eligible could clear, `simple` came back empty, and the fallback mirrored `complex` — carrying a model far too dear for grunt work into the cheap tier. Two further deliberate limits. Only *per-task* costs enter the ratio, never `rankOf().price`, which falls back to a per-1M rate — the two are different units two orders of magnitude apart, and a ratio mixing them would refuse an uncosted model on a unit error. And a model AA has not costed per task keeps the absolute judgement it had before (the curated table, or the per-1M bar), which is the pre-existing behaviour for exactly the models this has no better information about; with nothing costed at all there is no ceiling and nothing changes. `AA_CHEAP_BLENDED_PRICE_USD` therefore survives as the fallback bar, not the gate.

- **`avoid_gateways` demotes a gateway, it does not exclude it.** Ranking optimises capability per task-dollar and knows nothing about whether a gateway is reliable, rate-limited, or simply one you would rather not send work to — a hand-reordered `[tiers]` fixes that until the next `sonata init` re-proposes it away. A top-level `avoid_gateways = ["<name>"]` (not inside `[tiers]`, whose keys must all be roles) sorts that gateway's models *after* every other one in both tiers, so they survive as fallback candidates and avoiding a gateway costs preference rather than the depth a ranked tier exists to provide. `parseConfig` refuses a name matching no gateway — the setting's failure mode is that its absence is invisible, so a typo would read as "not avoided". The simple tier's capability floor is measured over the models that can actually lead (`preferred`), since including an avoided model there could raise the bar until nothing preferred qualifies. `nativeTomlFor` writes the key back out: dropping it would be exactly the bug it exists to prevent.

- **A tier is a rank, not a fixed model.** `RankedSelect` (`src/tui-ink/components/ranked-select*`) lets `sonata init` capture a *ranking* rather than a set: selection order **is** the ranking, so no separate up/down step is needed to express "try this one first, that one if it fails". `proposeTiers` (`src/catalog.ts`) seeds the initial order from a cached Artificial Analysis catalog (coding index for capability, blended price for cost) when one exists, falling back to a curated table otherwise.
  - **The list is drawn in rank order, and the cursor addresses a display position, not an item.** `rsOrder` puts ranked models first in rank order, then the rest; `RsState.cursor` indexes *that*. Rows used to be drawn in item order with the rank as a marker, which is what made `[`/`]` read as broken — reported as "[ and ] does not work in sonata TUI" against a real 19-row screen whose markers ran `· · · · 1. 5. · · · · · · 2. 6. · · 3. 7. ·`. Reordering swapped two *numbers* between rows that were nowhere near each other and left the highlight where it was, so one press was often invisible and two were a round trip; the sixteen unranked rows did nothing at all, correctly, with nothing on screen to say why. Drawing in rank order makes a ranked item's display position *be* its rank position, which is what lets `moveUp`/`moveDown` need no lookup and lets the cursor travel with the row. `toggle` follows the same rule — the highlight tracks the item across the block boundary — so `[` right after `space` reorders the model just picked rather than whichever row slid into the vacated slot.
- **Usage is read from the SSE stream, not from LiteLLM's cost headers.** LiteLLM does emit `x-litellm-response-cost-*` with no database configured, but headers flush before the body, so on a streaming request no output token exists yet and the cost is structurally `0` — and every Claude Code request streams. Tokens come from `message_start` merged with the final `message_delta`; sonata computes cost itself. The headers still carry `x-litellm-model-name` (which ranked candidate served) and `x-litellm-call-id`, which the ledger records as `litellmModel` and `callId`.
- **A scraped price is only applied where the gateway says which public provider it is.** ai-pricing.fyi prices public serving providers, and one model spans an 8× range across five of them, so inferring which one a gateway resells would produce a number wrong by most of its own magnitude. Absent `pricing_provider`, the row is `unpriced`. ai-pricing.fyi also does not model peak/off-peak pricing, hence the UTC `price.windows` overrides.

### Source layout

```text
src/
├── cli.ts                CLI entry point; arg parsing, then delegates to src/commands/*
├── commands/             command implementations (approve, auth, catalog, code, dispatch, doctor, gc, init, log, route, run, runs, serve, status, sync, tail, usage, verify, wait)
├── init/                 init pipeline — discover.ts (machine state, gathered once), validate.ts (shared problem list, both paths), plan.ts (every write as one InitPlan value), apply.ts (I/O only), interactive-state.ts + scripted-state.ts (two front ends, one InitState), toml.ts (nativeTomlFor)
├── config.ts             config resolution (project → machine), sonata.toml parsing (unified [models], [tiers]), KNOWN_HARNESSES, isReadOnlyRole, resolveTierAlias, harnessModelFor
├── catalog.ts            model normalization (normalizeModelName), curated capability/cost table, proposeTiers, AA catalog cache (loadAaCatalog, aaCatalogPath, AA_ATTRIBUTION)
├── detect.ts             harness catalogues (`opencode models`, `pi --list-models`, reasonix doctor) → ModelRef, provider grouping; WELL_KNOWN_PROVIDER_URLS
├── migrations.ts         schema_version stamp, the ordered migration chain, applyMigrations (runs inside parseConfig, before field validation)
├── normalize.ts          config/model normalization; migrateLegacyConfig ([generate.roles]/[generate.native] → [models]+[tiers])
├── roles.ts              role prompt composition
├── report-contract.ts    the one definition of where a run's result lives (report.md) and how it is composed into a role prompt — the *verdict* (degraded / reportImpossible) stays in tail.ts's decide()
├── settings.ts           permission-hook scope settings, SONATA_TOOLS allow-list
├── store.ts              run state storage
├── tmux.ts               tmux session lifecycle (detached sessions, pane diffing)
├── tui.ts                Minimal zero-dependency TUI primitives — pure parseKey/reduce/renderList so list behaviour is testable without a TTY; retained for the non-Ink prompts (init's hook scope, tier-routing offer, prune confirm)
├── watchdog.ts           run timeout enforcement
├── worktree.ts           git worktree fingerprint (HEAD + `status --porcelain` + a blob hash per dirty path) sampled at launch and captured again by the launch wrapper at exit, so a run that finished having changed nothing says so; inert outside git
├── mode.ts               permission-mode mapping (plan/default/acceptEdits/bypassPermissions/auto)
├── ledger.ts             the router's append-only usage ledger (one JSON line per request, daily files under ~/.config/sonata/usage/, 30-day retention)
├── budget.ts             [budget] daily_usd — priced spend for the current UTC day (spentTodayUsd) and the router's refusal message (budgetRefusal)
├── pricing.ts            per-model/per-gateway price tables, optional UTC price windows, 0-vs-unpriced resolution
├── aipricing.ts          ai-pricing.fyi per-token rate cache (per-token rates for public serving providers)
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
docs/                    HANDOFF.md (read first: state, open follow-ups, environment traps) + dispatching-work-through-sonata.md + roadmap.md (1.0 roadmap, mirrors a claude.ai Artifact — update both when an item ships) + guide/ (user-facing reference, split out of README.md — README stays the front door and links here) + reviews/ (architecture review) + superpowers/ (plans + specs, permanent design-history record, indexed in docs/superpowers/README.md)
```

### Adding a harness

The adapter boundary is the extension point — one new file plus registration:
1. `src/adapters/<name>.ts` — export a `HarnessAdapter` (interface in `src/adapters/types.ts`; implement `plan`, `canPromptForApproval`, `promptPatterns`/`describePrompt`, optional `health`)
2. `src/adapters/index.ts` — register it
3. `src/config.ts` — add the name to `KNOWN_HARNESSES`
4. `tests/adapters/<name>.test.ts` — follow an existing adapter's tests

**Probe the real binary before writing an adapter** — every adapter bug found so far was invisible in documentation and obvious on the first real run. If you claim a harness prints something, capture it into `tests/fixtures/panes/` and test against that.

## Permission modes

Sonata mirrors the Claude Code permission mode onto the harness; a sonata agent is never more permissive than the session that spawned it. Where a harness cannot honour a mode, sonata refuses the run rather than downgrading quietly.

- **OpenCode** (`opencode run` has no approval UI — it either proceeds unasked or auto-rejects): `plan` → plan agent, no approve; `default` → **refused** for write-capable roles; `acceptEdits`/`bypassPermissions` → build agent, auto-approve.
- **Pi** (no sandbox, `--tools` allowlist is real): `plan` → `--tools read,grep,find,ls`; `default` → refused for write-capable roles; `acceptEdits`/`bypassPermissions` → all built-in tools.

**A read-only run cannot write `report.md`** on either opencode or pi, so sonata takes terminal output as the report and does NOT mark such a run degraded (`LaunchPlan.canWriteReport`). Pi's allowlist removes the write tool; opencode's `plan` agent is *instructed* not to modify files and declines — weaker enforcement, identical reporting consequence. Probed directly: a run asked only to write one file wrote nothing and reported "blocked by policy, not by error".
- **Codex** (real sandbox, TUI prompts): `plan` → `codex exec` read-only; `default` → interactive TUI with `approval_policy=on-request` workspace-write; `acceptEdits` → `codex exec` workspace-write; `bypassPermissions` → `codex exec` danger-full-access. The TUI stdout stays attached to tmux: piping it through `tee` makes codex print `Error: stdout is not a terminal` and exit 0. A report watcher clears its composer and sends Ctrl-D once `report.md` lands. Sonata never passes `--dangerously-bypass-approvals-and-sandbox`.
- **Reasonix** (real approval cards, so `default` is honoured): `plan` and every read-only role → `run --permission-mode dontAsk`; `default` → interactive TUI with `--permission-mode ask`; `acceptEdits` and `bypassPermissions` → `run` with the same-named mode.
  - `--permission-mode plan` is **refused by `reasonix run`** ("requires an interactive session", exit 2), so read-only work uses `dontAsk` instead. That is real enforcement, probed: a run asked to read one file and write another read it fine and was refused both the write tool and the shell fallback. It cannot write `report.md` either, so `canWriteReport` is false.
  - **Never use `-y`/`--auto`.** It aliases reasonix's own `auto`, which is wider than Claude Code's — it skips risk prompts for things like `git push`. Claude's `auto` maps to `acceptEdits`, so always pass `--permission-mode` explicitly.
  - Reasonix loads the working directory's `.mcp.json` on top of its own config, so a dispatched model inherits whatever MCP servers the project defines — sonata itself is not one of them (there is no MCP server anymore), but a project's own servers still apply. `sonata doctor` warns on a `.mcp.json` that still registers a stale `sonata` entry (`staleMcpRegistration`), naming `claude mcp remove sonata`.
- **Claude Code** (`claude -p` is headless and has no TUI): `plan`, `default`, `acceptEdits`, and `bypassPermissions` map directly to Claude Code's corresponding permission modes. Read-only roles use Claude's restricted tool set; native runs assume `sonata serve` is already up so the session is routed to the foreign model.

The permission mode is not exposed as an env var, so this needs a **PreToolUse hook** (`hooks/capture-mode.mjs`), which `sonata init` offers to install at project or global scope. Without it sonata assumes `default` — for opencode/pi that means dispatches refuse, so `sonata doctor` reports a missing hook as a blocker.

**Where the mode is stored mirrors config resolution.** A project with its own `sonata.toml` or `.sonata/` gets `<cwd>/.sonata/session-<id>.json`; a project relying only on `~/.config/sonata/sonata.toml` gets `~/.config/sonata/session-<id>.json`; a directory with neither is left alone. That second case matters — the hook is installed globally and fires on every Bash call, so writing into the repo would scatter `.sonata/` directories across the machine. `readPermissionMode` reads the same two locations in the same order.

**`auto` mode** (Claude Code's current default) maps to `acceptEdits`. Residual gap: the foreign harness has no classifier, so it will run things auto mode would have blocked. Dispatch in `plan` mode, or to a read-only role, when that matters.

## Configuration

Sonata resolves exactly one config, in this order (`configPath` in `src/config.ts`):

1. `./sonata.toml` — the current repository, wins outright
2. `~/.config/sonata/sonata.toml` — the machine

A project config **replaces** the machine one; they are never merged, so it is always possible to say which file produced a run. `sonata doctor` prints the resolved path.

```toml
# sonata.toml
schema_version = 1                  # which shape this file is in

[models."flash"]
gateway = "acme"                    # native route: resolves through the router
id = "deepseek-v4-flash-0731"
context_window = 128000

[models."kimi-k3"]
harness = "opencode"                # harness route: sonata dispatch falls back to this
id = "openrouter/kimi-k3"

[native.gateways."acme"]
base_url = "https://gateway.acme.example/v1"

[tiers.code]
simple  = ["flash", "kimi-k3"]       # ranked — first is tried first
complex = ["kimi-k3", "flash"]

[tiers.review]
simple  = ["kimi-k3"]
complex = ["kimi-k3"]

avoid_gateways = ["flaky-gw"]   # rank this gateway's models last, but keep them as fallbacks

[budget]
daily_usd = 25                 # router refuses past this much priced spend per UTC day

[run]
tail_window_seconds   = 20     # how long `sonata tail` blocks per call
stall_timeout_seconds = 120    # silence before a run is reported STALLED
run_timeout_seconds   = 1800   # hard cap; the run is killed at this point
dispatch_window_seconds = 1500 # blocking window for sonata wait/dispatch
```

- **`schema_version` stamps the shape, and migration runs on load** (`src/migrations.ts`). `parseConfig` reads the stamp off the raw TOML, walks the file forward through an ordered chain **before** any field-level validation, and records the pre-migration number as `SonataConfig.schemaVersion` — read after migrating, it would always answer "current", and `sonata doctor` could never report a file as behind. A stamp *newer* than `CURRENT_SCHEMA_VERSION` is **refused**: a best-effort parse of a future shape does not fail, it succeeds and means something else. Absent means version 0, which is a real version, not a malformed file; a present-but-nonsense value is an error, because reading it as 0 would migrate a file whose author believed it was stamped. Migration is **in-memory only** — `sonata init` is the sole writer of `sonata.toml` (`sonata sync` regenerates agents and never touches it), so no read-only command rewrites your config. The chain ships **empty on purpose**: v1 names the shape `parseConfig` already accepts, so a v0 file needs no transform to load, and inventing one would risk the path that already works. `applyMigrations` takes the list as a parameter so composition is proven against a synthetic chain rather than asserted about an empty one, and it advances past a version with no step rather than looping forever. The stamp is written **above every table header** for the same reason `avoid_gateways` must be — a bare key after one belongs to *that table*.
- **`[budget] daily_usd` is a ceiling the router enforces, and it is honest about what it cannot see** (`src/budget.ts`). Before forwarding *anything* — checked at the top of `routeRequest`, above both the tier and direct branches, since a cap enforced on one of two paths is not a cap — the router sums the ledger's **priced** rows for the current UTC day and refuses at or past the cap with a 429 naming the cap, the spend, and the file to edit. Both halves are re-read per request, so raising the cap frees the router without `sonata restart`. Two limits are stated in the refusal itself rather than papered over: it counts **priced volume only** (the ledger reports unpriced volume separately and never folds it in as zero, so a cap that only sees the priced part can be exceeded — counting unknown as zero would make it quietly permissive in the case the user is least able to notice), and it covers the **native path only** (`sonata dispatch` runs execute in the foreign CLI's own process and never transit the router). The refusal is deliberately *not* written to the ledger: a row records a request the router forwarded, and putting avoided spend into the store that defines spend is how the number stops meaning what it says. Absent `[budget]` means no cap; a non-numeric or non-positive `daily_usd` is **refused at parse time**, because a cap's only visible effect is a refusal that has not happened yet, so one silently dropped for being the wrong type reads exactly like one that is working. No forecasting, no per-role split, no auto-tuning — those need usage data nobody has measured yet.
- **`[models."<key>"]` is unified: a native route (`gateway`/`id`/`context_window`), a harness route (`harness`/`harness_id`), or both** (`UnifiedModelConfig`, `src/config.ts`) — one model can be reachable two ways: natively through the router, and as a `sonata dispatch` fallback candidate through its harness. `harnessModelFor(config, key)` maps a unified entry's harness half onto the shape `cmdRun` already consumes, so a unified-only key dispatches with no legacy `[models]` entry needed.
- **`[tiers.<role>]` is `{ simple: string[], complex: string[] }`**, keys into `[models]`, ranked — position is priority, not a separate field. `resolveTierAlias(config, "sonata-<role>-<tier>")` resolves an alias to its ranked routes (`TierRoute[]`, each `{ key, native?, harness? }`); it collapses to the unsuffixed `sonata-<role>` alias only when a role's `simple` and `complex` lists are *element-wise* identical (same models, same order) — a role whose tiers differ even slightly keeps both aliases live.
- **`parseConfig` refuses *mixing* `[tiers]` with legacy `[generate.roles]`/`[generate.native]`** in the same file — not refusing a legacy-only config outright, since that would brick every existing install the moment this shipped. A legacy config still parses (with a `sonata doctor` warning pointing at `sonata init`) until it's migrated; a migrated config cannot re-grow the old tables.
- **A legacy config migrates automatically** (`migrateLegacyConfig`, `src/normalize.ts`, run by `cmdInit` whenever it loads a config with `generate` data and no `[tiers]`): every `[native.models]` entry becomes a unified native-routed entry; every legacy harness entry becomes a harness-routed entry keyed by `normalizeModelName(key)` — merged onto a native entry when its `id` normalizes to the same upstream (one model, two routes), or kept under its original un-normalized key when two *different* models would otherwise collide on the same normalized name (verified: never silently merges two different models). `[tiers.<role>]` is seeded native-first from `generate.native` + `generate.roles`, deduplicated. A harness-only model with no native counterpart — invisible to the current native-candidate picker — is still carried through into the rewritten config rather than silently dropped.
- **Keys are always quoted.** An unquoted `[models.grok-4.5]` nests as `models → "grok-4" → "5"` and silently stops describing the model it names. Every key and value is written through `tomlKey`, which also escapes control characters. This includes `credential_source` on `[native.gateways]`: its values are `sonata`, `codex`, and `opencode`; when absent, today's credential resolution is unchanged. `parseConfig` refuses `credential_source = "codex"` with `auth = "api-key"` because a Codex subscription is not a bearer API key and the metered endpoint authenticates before failing on quota — see `docs/guide/codex-subscription.md`. Native API-key gateways may also set `wire_format` to `openai` (the default) or `anthropic`; it is refused on OAuth-auth gateways and supports fully custom providers entered through `sonata init`'s Add provider flow.
- **The key is `<harness>-<provider>-<model>`, slashes flattened to dashes**, and doubles as the agent filename (`code-<key>.md`). The harness segment is load-bearing: pi and opencode can serve the identical ref. Flattening is *not* injective (`opencode/go-x` and `opencode-go/x` collide), so `init` checks the keys it is about to write.
- **Ids are provider-qualified for opencode, pi and reasonix**, bare for codex; `parseConfig` enforces this per harness. Picker rows are labelled `<harness>/<provider>/<model>` (`refLabel`), because opencode and pi can serve the identical `provider/model` — labelling by ref alone printed two identical rows that also shared a selection value.
- **Each role chooses its own ranked model list, per tier,** through `[tiers.<role>]`; `sonata sync` generates only tier agents when `[tiers]` is set (skipping legacy per-model generation entirely) — one agent per role × tier, or one collapsed agent when a role's `simple`/`complex` lists are element-wise identical.
- **`tiersCollapse` (`src/config.ts`) is the single definition of "element-wise identical".** Three call sites had each rebuilt that predicate — `cmdSync`, which *writes* the agent files; `resolveTierAlias`, which *routes* to them; and `sonata init`'s confirm summary, which *counts* them. The third had rebuilt it as roles × models, so a four-role config on two models promised 8 files and `sync` then wrote 4 — wrong on the one screen whose entire job is to say what is about to be written. Comparison is ordered, because a tier is a ranking: the same models in a different order are a different fallback chain.
- Four roles ship: `code`, `review`, `explore`, `plan`. The last three are read-only, enforced by the harness (read-only sandbox on codex, tool allowlist on pi, read-only agent on opencode, `dontAsk` on reasonix); a read-only native tier agent can delegate writes through a `code-*` subagent, guarded only by prompt text.
- `sonata init` discovers OpenCode, Pi and Reasonix models (reasonix's catalogue and its per-provider auth state both come from `reasonix doctor --json`). Codex has no provider dimension and is added by hand; hand-written entries survive `sonata init`, which carries through any model whose harness it does not manage.
- **BYOK: a provider can be named directly, with no harness installed.** `init`
  offers ~30 well-known providers from `WELL_KNOWN_PROVIDER_URLS` as a `byok`
  pseudo-harness, alongside the existing `config` one — both bypass the harness
  filter in `providersForHarnesses`, which is what makes the zero-harness case
  work. A provider a harness already covers gets no BYOK row, so it is never
  offered twice. Having no harness is a **warning**, not the blocking error it
  used to be; that downgrade is where the zero-harness claim actually lives.
  - Models come from `GET <base_url>/models` (`src/native/models.ts`), which
    returns a `FetchModelsResult`, not a bare list. **Only 401/403 map to
    `unauthorized`** — that is the one failure whose fix is a different key, so
    it gets its own screen offering a re-prompt. 404, 429, non-JSON and a
    payload with no `data` array stay on the manual-ids path: a provider with no
    `/models` endpoint has nothing wrong with its key, and re-prompting there
    misdiagnoses in the opposite direction from the bug the split exists to fix.
    Fetched ids run through `isAnthropicRoutedName` for the same reason harness
    candidates do.
  - **The rejection screen must keep a way past itself.** Some providers 403 a
    key that is fine for inference, so "keep it and type ids by hand" sits
    beside "re-enter the key"; forcing the retry would trap that user in a loop.
    The retry carries an `attempt` counter because retyping the *same* key
    changes no effect dependency — and a retry usually is the same key, typed
    again by someone who believes they mistyped it.
  - **Keys are written once, after the confirm gate.** They live in
    `InitState.byokKeys` in memory only — `runInitTui` renders in-process and
    serializes nothing — so a cancelled wizard leaves no credential behind.
    There is deliberately **no `--key` flag**: it would put a credential in argv
    and shell history. The scripted path requires `sonata auth add <gateway>`
    first and refuses by name if the key is missing.
  - `byokCandidateKey` is exported and shared rather than inlined: the wizard
    puts the key into `nativeKeys` and `cmdInit` looks the candidate up by it,
    so two copies of the formula is how the two stop agreeing.
- **A gateway unattributable to a single harness is offered as `config/<gateway>`.**
  `deriveInitState` (`src/init/helpers.ts`) names a gateway `config/<gateway>` when
  no harness offers it *or* when more than one distinct harness does — both are
  equally unattributable, since a bare gateway name in `sonata.toml` doesn't record
  which harness's discovery produced it (e.g. opencode and pi both separately
  cataloguing the same public gateway, verified live). The discover phase
  (`src/init/discover.ts`) synthesizes that row for both cases; previously it
  synthesized only the absent case, so an ambiguous gateway produced a
  `providerKey` that `offered` never contained, and scripted `sonata init --yes`
  rejected it as unknown before role selection was even reached. Crediting
  every overlapping harness would be just as wrong — it pre-selects a harness
  the user never actually chose, with no way to make it stick unticked.
- **A prompt must `ref()` stdin while it waits** (`src/tui.ts`, `readKeys`). A
  paused stdin's handle is *unreferenced*, so waiting on a keystroke is not work
  node knows about: with nothing else pending the process exits, code 0,
  mid-prompt. Nothing paused stdin before the Ink wizard existed; Ink pauses it
  on unmount, so **every prompt after the wizard died the instant it was
  drawn** — prompt on screen, shell back, exit 0, nothing written. That was
  "sonata init never saves the config", and it left no error because there was
  no error. `unref()` on the way out, or the last prompt hangs instead.
- **`sonata init` writes a log** (`src/commands/init-log.ts`) to
  `~/.config/sonata/logs/init-<timestamp>.log`, newest ten kept. The wizard owns
  the screen — Ink repaints and the list prompts use the alternate buffer, which
  is discarded on exit — so a run that dies mid-wizard otherwise leaves a
  restored shell and no trace. Every printed line is teed there, along with the
  resolved selections and any error. Keys are recorded as the gateway they
  belong to, never as their value. `cli.ts` prints the directory when a run
  fails or cancels. Logging never throws: an unwritable home degrades to
  `nullInitLog` rather than failing the command it was meant to explain.
- Run `sonata sync` after editing the config; Claude Code picks up the generated agents automatically. There is no MCP server to reconnect.

## Security

Sonata launches other coding agents on your machine — they run **as you**, with your files and credentials. Codex and reasonix both offer a real sandbox (reasonix reports its own `write_roots`, which follow `--dir`); pi has none, and opencode's is advisory. Sonata never bypasses a harness's own safety flags; credentials stay with the harness (sonata reads harness config for health reporting but does not copy/forward/log API keys). Prompt injection is a real risk with foreign models — for untrusted code, dispatch read-only roles or run in a container.
The native router transits the session credential locally and unmodified; native keys flow store → environment → LiteLLM only.

## Known Limitations

- **Nested native agents have unbounded recursion, unattributed cost, and no run-level observability.** A `code-complex` agent can call `Agent(subagent_type: "code-complex")` and recurse on itself because sonata has no depth counter; read-only roles rely on prompt text rather than enforcement because Claude Code's `tools:` frontmatter grants tools, not allowed argument values. `sonata usage` attributes the router ledger per session rather than to the dispatch that caused nested spend, so a runaway recursion is visible as a day's spend but not as *whose*. `[budget] daily_usd` now bounds the total — the blast radius is capped even though the attribution is not — but it is a whole-machine ceiling, not a per-run one. `sonata status`, `sonata runs`, and `sonata tail` assume one run = one model = one request chain, so nested agents have no representation in any of them.
- `sonata init` discovers models for all three harnesses. Codex has no `models` subcommand, so its catalogue comes from `codex app-server`'s `model/list` (JSON-RPC over stdio); the schema is generated by `codex app-server generate-json-schema` and a real response is captured in `tests/fixtures/codex/model-list.json`.
- **opencode's `event` table grows without bound** — 6.5 GB across 140k rows on the development machine, which is what produced `database is locked` under three concurrent dispatches. Sonata cannot prune another harness's store. Three concurrent runs against opencode 1.18.16 completed cleanly, so this is load- and size-dependent rather than a fixed limit; a run that dies without producing output is now reported `degraded` rather than silently succeeding.
- The published package ships `dist/` plus `roles/`, `hooks/` and `skills/` (`files` in `package.json`); a runtime asset added outside those is absent from the tarball and fails only at a user's install. CI runs `npm pack --dry-run` against a required-files list to catch that at merge time rather than at publish time.
- Prompt detection is regex against TUIs sonata does not control; `STALLED` timeout is the backstop. Codex prompt patterns are written from captured real output in `tests/fixtures/panes/`.
- Codex through a proxy needs that proxy up (`sonata doctor` checks the endpoint).
- `opencode run --format json` is broken upstream (v1.18.15 produces no output, never exits), so progress comes from pane text rather than a structured event stream. Pi's `--mode json` works; the adapter keeps a seam for adopting it.
- **An interactive run has to be told to stop.** Reasonix's TUI is a chat session: it does not exit when the task is
  done, so nothing writes the exit sentinel and a finished run sits at PROGRESS until the stall timeout, then gets
  killed and reported degraded with its report sitting right there. The adapter's watcher waits for `report.md` and
  then sends Ctrl-D, retrying until the sentinel appears. Ctrl-D, never the documented `exit` + Enter: typing blind
  races the TUI, and a run that typed `exit` landed the letters in an open approval card and the Enter picked
  whatever row was highlighted.
- **A prompt stays in the pane after it is answered, so it can be re-reported.** Prompt detection reads the current
  pane, and answering does not erase the block that matched. Under the one-call loop this is visible: a live
  reasonix dispatch on 2026-08-18 returned PAUSED for a prompt that had already been approved, so `approve` sent
  its `1` when no selection list was open and the digit landed in the composer as text. Two consequences —
  wasted approve/wait round trips, and a composer that is no longer empty.
- **Ctrl-D does not quit a reasonix TUI whose composer is not empty**, which is how the above turns a finished run
  into a STALLED one: the report was written, the quit watcher sent Ctrl-D, nothing happened, and no exit sentinel
  was ever produced. Clearing the line before quitting would fix the second half; the first half needs prompt
  detection to know what it has already answered.
- No streaming granularity guarantees — progress is whatever the harness prints.
- **`default` mode is verified live on codex and reasonix** (2026-08-18). A codex dispatch surfaced its
  directory-trust prompt as `PAUSED`, took `approve`, did the work and reached `DONE` un-degraded — the first
  time codex `default` has ever run. A reasonix dispatch went from 9 calls with duplicated prompts ending
  `STALLED`, to 5 calls, no duplicates, `DONE` with its report.
- **The harness conversation cannot be *pushed* into Claude Code turn by turn.** A subagent receives text only as tool results, and its parent receives only its final message, so no push channel exists to stream into. `tmux attach -r -t sonata-<id>` is the live view and `sonata log <id>` the after-the-fact one; `sonata tail` remains a human/debugging CLI command.
- **Tier fallback retries only before a response starts.** The router (`routeTierRequest`, `src/native/router.ts`) tries each `[tiers.<role>].<tier>` candidate in rank order and returns the first response with status < 500 — retry is inherently pre-first-byte, so it never interferes with an in-progress stream. A candidate that fails (a thrown fetch, or ≥500) cools down for `TIER_COOLDOWN_MS` (60s) so a burst of requests doesn't keep retrying a model that just failed; every native candidate exhausted returns 529 naming the `sonata dispatch --tier <role>-<tier>` fallback rather than a bare error.

## Native path

The native path runs foreign models inside Claude Code's own loop, tools, and permission modes through a local routing proxy. The harness path instead runs the foreign model's own loop in OpenCode, Codex, Pi, or Reasonix.

Its `[native]` config surface describes foreign `models`, `gateways`, and their `ports`; native model keys reach a role either through a unified `[models]` entry's `gateway`, listed in `[tiers.<role>]`, or (for a legacy config not yet migrated) `[generate.native]`. `sonata serve` runs the router, plus a managed LiteLLM child when — and only when — some routable model's gateway needs translating; `sonata code` launches a Claude Code session routed through it. `sonata route on` achieves the same routing for every plain `claude` launched in the project: it writes the routing `ANTHROPIC_BASE_URL` env into `.claude/settings.local.json` and installs a SessionStart hook (`hooks/ensure-serve.mjs`) so the router comes up like `sonata code` does — no wrapper needed. The Remote Control loss below then applies to every session in the project, not just wrapped ones, until `sonata route off`. Nuance, observed live 2026-08-25 on Claude Code 2.1.x: the Remote Control gate reads the base URL at session launch, but the settings `env` is picked up per-request — so a session already running when `route on` was issued keeps Remote Control *and* routes native agents (proven: a native-explore dispatch from such a session logged `-> litellm` on the router). Sessions launched after `route on` lose Remote Control as documented. The pickup is one-way: `route off` (also probed live) cleans the file for future sessions, but an already-routed session keeps sending through the router until restarted — the exported env survives the key's removal, so until then that session depends on the router staying up. `sonata route auto` turns that asymmetry from a curiosity into the supported way to route without losing Remote Control — see the command list above. **LiteLLM is conditional and managed.** `litellmRequired` (`src/native/providers.ts`) asks whether any
routable model — every `[models]` entry and every legacy `[native.models]` one, not just tier members,
since a request naming a bare model key never calls `resolveTier` — sits on a gateway whose transport is
`litellm`. When none does, `serve` starts no child, needs no port, and needs no Python. When one does,
sonata runs its own venv at `~/.config/sonata/litellm`, pinned to exactly `1.98.0` — the version every
LiteLLM behaviour recorded in this file was measured against. `init` installs it, `doctor` reports which
of six states it is in, and **`serve` never installs**: `hooks/ensure-serve.mjs` starts serve headless
from a SessionStart hook, where a silent multi-minute install is indistinguishable from a hang. A PATH
`litellm` is reported as information and never used — measured on the development machine, `which
litellm` resolves to a script whose interpreter cannot `import litellm`.

Sonata implements no OAuth itself; it drives LiteLLM's own authenticator as a subprocess, so no token passes through sonata's process memory. A login needs neither the codex CLI nor a prior `codex login`: LiteLLM's authenticator is a self-contained HTTP client, and the Codex OAuth app id is compiled into it. The login script calls `get_access_token()`, never `_login()` — only the former persists the token, while `_login()` starts a second device flow against an empty directory.

For Copilot, `api-key.json`, written by `get_api_key()`, proves entitlement. A bare `ghu_` token proves nothing: LiteLLM's Copilot credential is a GitHub App token with no OAuth scopes, while opencode's stored `gho_` token has only `read:user` and cannot be exchanged for a Copilot key. These are different credential kinds and remain distinct sources. Copilot's device flow polls for 60 seconds; ChatGPT's polls for 15 minutes. Copilot makes up to three attempts total, each with a fresh code.

The `sonata` credential source points LiteLLM's token directory at `~/.config/sonata/credentials/<gateway>/`, so refreshes persist across runs. The old temp-directory approach silently discarded every refresh; Copilot's `api-key.json` is short-lived and re-exchanged in place, so persistence is load-bearing. Never pass `api_base` for Copilot: `get_api_base()` reads `endpoints.api` from `api-key.json`, and business tenants have different endpoints.

There are two deliverables: (A) `sonata serve`/`sonata code` for a complete local routing path, and (B) the `claude` harness adapter for dispatching foreign-on-Claude-loop through `sonata dispatch`.

**A gateway declares how it authenticates.** `auth = "api-key"` (the default, so existing configs are unaffected) sends a stored bearer to `base_url`. `auth = "codex-oauth"` uses the ChatGPT subscription credential written by `codex login`, and takes **no** `base_url` — parsing refuses one, because that credential is refused by the metered `api.openai.com` with `insufficient_quota` *after* passing auth and scopes, and reaches only `https://chatgpt.com/backend-api/codex`. A subscription is not API credit; a config naming the metered URL authenticates and then 429s, which reads as a missing key. LiteLLM's `chatgpt` provider handles that endpoint, the Responses wire API, the mandatory streaming, and token refresh, so sonata emits `model: chatgpt/<id>` with `model_info.mode: responses` and **no** `api_base`/`api_key` — passing either overrides the provider and breaks it. Without `mode: responses` LiteLLM POSTs to the bare `backend-api/codex/` URL and gets a Cloudflare HTML page. Non-streaming calls hit an open upstream bug (BerriAI/litellm#25429) that streaming clients — Claude Code included — never reach. Full detail in `docs/guide/codex-subscription.md`.

**`auth = "copilot-oauth"`** uses opencode's GitHub Copilot login and emits `model: github_copilot/<id>` — no `mode` override, because Copilot speaks chat-completions. `serve` writes the `gho_` token to `access-token` and sets `GITHUB_COPILOT_TOKEN_DIR`; LiteLLM exchanges it for a Copilot key. **That exchange usually fails**: opencode's token carries scope `read:user` only, so GitHub answers `copilot_internal/v2/token` with 403, LiteLLM drops the deployment, and the request fails as "no healthy deployments" naming neither cause. So `init` and `doctor` check the `copilot` scope first (asking GitHub, failing closed) and refuse to offer models the credential cannot serve.

**One OAuth credential is offered as one provider.** opencode's `openai` entry is the *same* ChatGPT credential codex holds (identical `client_id`, which is how `oauthProvidersFor` recognises it), so both resolve to `codex-oauth`. Offering both let one subscription be configured as two gateways serving overlapping models under different keys (`gpt-5.6-luna` and `openai-gpt-5.6-luna`), doubling the generated agents for no added capability. `dedupeOauthProviders` (`src/commands/init.ts`) keeps the canonical provider per OAuth kind (`codex-oauth` → `codex`, `copilot-oauth` → `github-copilot`) — but only when that one is actually offered, so a machine with opencode and no codex still reaches ChatGPT through `openai`. It runs *after* the BYOK block, since that filter skips any name already in `offered` and would otherwise re-add the hidden provider as a BYOK row.

**`init` must never offer a model the router cannot reach.** Copilot, acme and anthropic all serve Claude models, and the router sends `claude-` upstream, so `parseConfig` refuses those ids — 27 such candidates were being offered, and selecting one wrote a config that then failed to load. `isAnthropicRoutedName` is the single definition, used by both the parser and the candidate filter.

**The router port's occupant is usually sonata.** `sonata run`/`sonata dispatch`
auto-start `sonata serve --daemon` when the router is down, so a prior dispatch
can leave a daemon holding the port long after that dispatch ended. `serve`
after that hits `EADDRINUSE`, and its old message called that "a non-sonata
listener", sending the user to hunt a foreign program that did not exist.
`occupiedPortMessage` asks the health endpoint first, which costs one request
and makes the message true.

**Serve state is keyed by router port, because daemons run in parallel.**
`serve-state-<port>.json` — one record per router, not one per machine. A
project with its own `sonata.toml` gets its own ports and therefore its own
daemon (the router resolves tiers with `loadConfig(<daemon cwd>, home)`, so a
shared daemon would serve every project the config of whichever directory
started it). With a single global `serve-state.json` those daemons overwrote
each other field by field: measured live on 2026-09-03 with two routers up
(:4100 pid 53992 and :4110 pid 72171, litellm children 73032 and 72298
respectively, confirmed by ppid), the one record read
`{routerPid: 72171, litellmPid: 73032}` — the *second* router paired with the
*first* router's child. `sonata restart` in either project would have killed
one daemon's router and the other's litellm, which reads as the surviving
project suddenly 502ing on every native request. `readServeStateFrom` still
falls back to the legacy unkeyed path, read-only, so a daemon started before
this change stays stoppable across the upgrade, and clears whichever file it
actually read rather than both.

**`sonata restart` clears that occupant instead of just naming it.** `cmdServe`
records `process.pid` as `routerPid` in `serve-state-<port>.json` once the
router successfully binds. `stopServe` reads that file, kills only the pids sonata
itself recorded (never a pid found by scanning the OS — the same discipline as
the pre-existing litellm-orphan kill), and polls the health endpoint until the
port actually frees before returning. `cmdRestart` runs that then
`startServeDaemon`. If the port answers as a sonata router but the state file
has no matching pid (a different sonata install, or state left by an older
version, or the record was lost — e.g. an unrelated `stop()` call deleted the
state file before this router's own `routerPid` write), `stopServe` refuses
rather than guessing — same principle as `occupiedPortMessage`; measured live,
this can leave a stale daemon surviving several `restart` attempts that each
report false success (`startServeDaemon` sees *a* sonata router answering and
declares victory, even though its own freshly-spawned instance already lost
the port race and shut itself down) until someone kills the stale pid by hand.

**`serve` watches its own LiteLLM child and respawns it if it exits on its
own** (`cmdServe`, `src/commands/serve.ts`) — the child dying used to go
unnoticed until the next request 502'd and someone ran `sonata restart` by
hand, with the router staying up and answering every request with a dead
upstream in the meantime. A crash-loop guard (5 respawns/60s by default) stops
trying and logs why rather than respawning forever against a genuinely broken
gateway. This is safe in a way an *external* health-probe respawn is not:
there is only ever one spawn racing here, never a second `serve` guessing
whether an existing one is healthy.

**The router logs which upstream served each request** — `POST /v1/messages
model=gpt-5.6-terra -> litellm`. `serve` never passed a `log` before, so that
line had never produced output, and LiteLLM's access log records the path and
status but not the model. That left "did this native agent really run on the
foreign model, or fall back to Claude?" answerable only by inference. It is now
evidence: a `claude-`-prefixed model logs `-> anthropic` and never reaches
LiteLLM at all, so a foreign-model line in `serve`'s log is proof of routing.

**Claude Code's `system` array must be flattened for codex.** Claude Code always
sends `system` as an array of text blocks. LiteLLM turns a *string* system prompt
into a `developer` message the Codex backend accepts, but leaves block arrays as
role `system` — and that backend answers `{"detail":"System messages are not
allowed"}`, a 400 naming neither the field nor the shape, so it reads as a model
or auth problem. Probed directly: a string system prompt streams fine, the
identical text as a one-element array 400s, an empty array is accepted.
`flattenSystemBlocks` (`src/native/router.ts`) joins the blocks with blank lines
on the **litellm path only** — an Anthropic request stays byte-identical, since
Anthropic understands its own shape. `cache_control` is dropped with the block
wrapper, costing prompt caching on this path; the alternative is a request that
cannot be sent. A non-text block (an image) has no string form, so the body is
passed through unchanged rather than silently losing content. Verified live: the
model obeys the flattened prompt, not just accepts it.

**Flattening alone is not enough: the codex model is also declared
`supports_system_message: false`.** The Codex backend refuses *any* `role:
system` message — not merely the block-array shape — with
`{"detail":"System messages are not allowed"}`, and LiteLLM's chatgpt provider
does not normalize it: BerriAI/litellm#22968 reports exactly this, and its fix
(PR #22967) was **closed without merging**, so 1.98.0 still emits the rejected
role. Observed live 2026-08-28: a tier request the router had already flattened
(`model=sonata-code-complex -> gpt-5.6-terra -> litellm`) still 400'd. The
declaration (`src/native/litellm.ts`) routes the prompt through LiteLLM's own
`map_system_message_pt` instead. The two fixes are a **pair**: that helper
concatenates onto message content and raises `can only concatenate list (not
"str") to list` on Claude Code's block arrays (BerriAI/litellm#32904), so
flattening to a string first is what keeps this off its crash path. Neither is
sufficient alone, and it is declared only for codex-oauth — an api-key gateway
takes a system message fine, and folding it there would degrade the prompt for
nothing.

**ChatGPT's Codex endpoint returns `output: []` under concurrent load, which LiteLLM surfaces as a 500.** When 8+ native agents dispatched simultaneously hit the same `codex-oauth` gateway, the upstream accepts the requests (no 429) but returns empty completions. LiteLLM's Responses API transformation (`transformation.py`) raises `ValueError: Unknown items in responses API response: []` and the proxy emits 500. The router (`src/native/router.ts`) catches 500 responses from LiteLLM whose body contains that string and re-emits them as 529 (overloaded) — Claude Code treats 529 as a retriable backpressure signal rather than a hard fault, so the turn is retried automatically. The match is string-level because the body is LiteLLM's rendered exception, not a structured field. LiteLLM 1.97.0 added an SSE recovery attempt for this case but still raises when recovery fails, so the router catch is still needed.

**A gateway declares its `provider`, and the transport is derived from it.**
`provider` supersedes `wire_format` (which still parses, and is folded into
`provider` at load) because the real axis is *which LiteLLM provider* — LiteLLM
picks its wire format from the prefix on `litellm_params.model`, so this one
decision determines whether a request reaches a vendor's native API or a
compatibility shim. `PROVIDER_FOR_GATEWAY` (`src/native/providers.ts`) carries
the prefix for gateways whose endpoint has been exercised, so a `google`
gateway emits `gemini/<id>` rather than `openai/<id>`; `openai` is the fallback
for the genuinely unknown, never the default for a known vendor. Transport is
**derived, never configured separately** (`transportFor`): `provider =
"anthropic"` with `auth = "api-key"` is reached **directly by sonata's own
router with no LiteLLM in the path**, every other api-key provider goes through
LiteLLM as `<provider>/<id>`, and an OAuth gateway's dialect is fixed by its
auth. Two keys that can disagree is the shape of the item-14 scope bug, where a
writer and a cleaner defaulted differently and ids leaked forever.

**The direct path is a third header mode, and that is a security boundary.**
`forwardDirect` strips the incoming `authorization`/`x-api-key` and injects
*that gateway's* key: the caller's credential is Claude Code's own Anthropic
credential, and forwarding it to a third-party gateway is a leak. The body is
passed through **unmodified** — no `flattenSystemBlocks`, so `cache_control`
survives, and assistant content blocks round-trip byte-identical because
`redacted_thinking` carries opaque vendor state (measured: Gemini's
`thought_signature` through OpenRouter) the upstream requires echoed back
exactly. Tier ranking, cooldowns, capability-400 fingerprinting, the 529
exhaustion message and usage recording are upstream-agnostic and shared by both
transports. `serve` resolves each direct gateway's key into a record the router
reads per request — without it every direct forward goes out with an empty
credential, which is how the transport shipped structurally dead until the
`serve` wiring landed.

**`serve` inherits LiteLLM's stdio.** A per-model startup failure appears only in LiteLLM's own output; discarding it is what turned a plain 403 into an unrelated-looking "no healthy deployments for this model".

**opencode's OAuth entries are not API keys.** `opencodeKeys()` resolves `type: api` entries only, which is correct — but the `type: oauth` ones (`openai`, `github-copilot`) were then invisible, so doctor reported "no key" for a credential sitting on disk. opencode's `openai` entry is the *same* ChatGPT credential codex holds (identical `client_id`), so `readChatGptOAuth` prefers codex and falls back to opencode; the `client_id` is checked, because another OpenAI grant would fail confusingly inside LiteLLM. opencode writes `expires: 0` on the Copilot entry to mean "never expires".

**`serve` must clean up on signals.** It runs until killed, so its signal handlers *are* its normal exit path; without them the run's temp directory survives, carrying the generated master key and, for a codex-oauth gateway, the ChatGPT credential. One such token was found in the system temp directory. `ServeDeps.tempDir` exists so tests never write into the real temp directory — two 0600 files carrying a test fixture's gateway URL were found there after a suite run.

Remote Control is the trade-off: `ANTHROPIC_BASE_URL` is process-wide, and `isFirstPartyAnthropicBaseUrl` gates Remote Control. Sessions launched by `sonata code` therefore lose Remote Control while routed through the local proxy.

The `claude-` prefix is load-bearing because the router sends that prefix to Anthropic. Native model keys and ids beginning with `claude-` are refused at parse time. Credentials flow only store → memory → LiteLLM environment; keys are never logged or put in a Claude conversation. The user starts `sonata serve`: the classifier correctly blocks launching an auth-forwarding proxy from inside a session.

The `claude` harness adapter is the simplest adapter: it runs headless `claude -p`, has no TUI, and maps permission modes directly. For native dispatches it assumes `sonata serve` is already running.

## Conventions

- **Harness-specific knowledge stays inside its adapter** — never in the CLI or `sonata dispatch`.
- **Evidence over inference** for harness behaviour: a captured fixture in `tests/fixtures/panes/` beats a plausible regex.
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
