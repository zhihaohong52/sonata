# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/) informally
(pre-1.0, so minor bumps can carry breaking changes).

## [Unreleased]

### Added
- **`sonata doctor --json`** (roadmap item 11). `cmdDoctor` already returned a
  structured `{ ok, checks }`; the CLI only ever rendered it as text. `--json`
  prints that same structure verbatim, so scripts and CI can gate on doctor's
  output instead of scraping stdout.

### Fixed
- **Adding a model to an existing config no longer skips ranking.**
  `reconcileTierList` (`sonata init`'s tier merge) always appended a
  newly-added model after every model already in `[tiers]`, regardless of how
  it actually compared — a model that `sonata catalog`'s capability-per-dollar
  ranking would put first landed last, tried only after every existing
  candidate had already failed. It now inserts the new model at the rank the
  fresh proposal gives it relative to the models already kept, without
  reordering anything the user (or a prior run) already ranked.

## [0.5.0] - 2026-09-02

### Upgrading

**Existing native-path installs need one command after upgrading:**
`sonata litellm install`. Sonata now runs its own pinned LiteLLM rather than
whatever `litellm` happened to be on `PATH`, and `sonata serve` refuses to
start — naming that command — rather than silently using a version its
behaviour was never measured against. `sonata doctor` reports the same thing.

Two configs need nothing at all: one whose gateways all speak the Anthropic
Messages API natively (no LiteLLM is used, so none is required), and one that
does not use the native path.

`wire_format` is superseded by `provider` but still parses, so no config edit
is required. `sonata init` writes the new key from now on.

### Added
- **Sonata manages its own LiteLLM, and often needs none at all.** A gateway now
  declares a `provider` (superseding `wire_format`), and the transport is
  derived from it: a gateway that speaks the Anthropic Messages API natively is
  reached **directly by sonata's own router, with no LiteLLM in the path** —
  which also keeps `cache_control` that the LiteLLM path discards on every tier
  request, and round-trips `redacted_thinking` byte-identical. A config whose
  routable models all sit on such gateways needs no LiteLLM, no venv and no
  Python whatsoever. `pip install 'litellm[proxy]'` is no longer a step anyone
  performs by hand.
- **`sonata litellm install|status`.** When LiteLLM *is* needed, sonata installs
  its own venv at `~/.config/sonata/litellm`, pinned to exactly `1.98.0` — the
  version every LiteLLM behaviour recorded in `CLAUDE.md` was measured against.
  The install is atomic: any existing venv is moved aside and restored if the
  install throws, so a network failure leaves `missing` (which has a working
  repair) rather than a half-built environment, and a failed upgrade does not
  cost you the working install you had. `uv` is used when present (seconds, and
  it can fetch a conforming interpreter); `python3 -m venv` otherwise, and both
  run against one test suite. `sonata init` offers the install, `sonata doctor`
  reports it, and **`sonata serve` never installs** — it is started headless
  from a SessionStart hook, where a silent multi-minute install is
  indistinguishable from a hang. Verified live on the pip path (29–36 s),
  producing a venv whose `litellm --version` really answers `1.98.0`; `doctor`
  reports `broken` — not `ok` — for a venv whose interpreter has gone, which is
  the failure a file-exists check cannot see.
- Each gateway's own LiteLLM provider prefix is emitted (`gemini/<id>` for a
  Google gateway rather than `openai/<id>`), so a request reaches the vendor's
  native API instead of a compatibility shim — which is where vendor-specific
  state such as Gemini's `thought_signature` has nowhere to live.

### Changed
- `sonata doctor`'s LiteLLM check reports one of six states, each naming its own
  repair. It previously printed `not found — pip install 'litellm[proxy]'` for
  every cause, including the one where nothing needs LiteLLM at all — where the
  correct answer is that its absence is fine, not that something is broken. A
  LiteLLM on `PATH` is now reported as information and explicitly not used:
  `which litellm` resolving says a script exists, not that an importable
  LiteLLM does.


## [0.4.1] - 2026-09-01

### Fixed
- **A model that rejects every request no longer absorbs its whole tier.** A
  400 was returned as the answer and never cooled the candidate down, so a
  permanently-broken model stayed the first non-cooling candidate forever and
  killed every agent that reached it — retry could not recover, because the
  failure never earned a cooldown. Observed live: `gemini-3.7-flash` rejects
  every multi-turn tool-use request (LiteLLM does not preserve Gemini 3's
  `thought_signature`), and once the candidates ranked above it were cooling it
  took four consecutive requests and two agents with it. The symptom read as
  "the model is flaky".

  A 400 is now told apart by *fingerprint*, not by status: a recognised
  capability failure repeated three times consecutively cools the candidate,
  and everything else is still returned to you with its body intact, because
  only you can tell a genuine client error from a broken model.
- **`sonata route off` now recovers a project whose routing is pinned on.** A
  subagent killed before its `SubagentStop` hook leaves its id in
  `.sonata/route-subagents.json`; the count never returns to zero, routing
  stays on, and every session launched afterwards loses Remote Control. The
  documented recovery did not recover — it cleared the session registry and the
  env but left the subagent registry untouched, so the pin survived its own fix
  and the next `SubagentStart` took the count 6 → 7, never 0.
- **Two registry defects that produced that pin from ordinary use.** The writer
  and the cleaner of `route-subagents.json` defaulted to *different scopes*, so
  a caller omitting `scope` wrote one file and cleared another. And the two
  guarded that one file with two *different* locks, which exclude nothing: a
  `SubagentStart` could read the pre-clear list, pause, and write it back after
  a cleanup, restoring every id the cleanup had just erased.

### Changed
- `tests/commands/tail.test.ts` waits for tmux to render rather than sleeping a
  fixed 100 ms. The flake blocked an `npm publish`, and `prepublishOnly` runs
  this suite — a release gate that fails on timing rather than on correctness
  teaches you to re-run a red suite instead of read it.

## [0.4.0] - 2026-08-31

### Added
- Generated agents can spawn subagents of their own. Write-capable roles
  already inherited the agent tools, since they carry no `tools:` line at all;
  read-only roles are now granted them explicitly (`Agent, Task, Workflow` —
  `Task` is the pre-rename alias, and a stale name in an allow-list matches
  nothing).

  Read-only agents also carry a `## Delegating` section telling them to
  delegate only to other read-only roles, because delegating to a `code-*`
  agent writes to the repository through it. **That is guidance, not
  enforcement**: `tools:` frontmatter grants tools, not permitted argument
  values, so nothing stops a read-only agent from naming a write-capable
  subagent. Nothing bounds recursion depth either — see Known Limitations in
  `CLAUDE.md` for the full shape of what is unguarded.
- `sonata init`'s tier screens take `A` to accept the ranking every remaining
  screen would have opened with, so four roles no longer cost eight
  near-identical confirmations. It is not a shortcut past the picker: it
  applies the same seed-then-filter the screen itself applies, so a model
  whose provider is deselected is dropped exactly as confirming would drop it.
- `npm run release -- <version>` prepares the release commit and its tag from
  the `[Unreleased]` section above, and `release.yml` publishes on the pushed
  tag using npm trusted publishing (OIDC) with provenance — no long-lived
  token in repository secrets.

### Changed
- `src/commands/init.ts` went from 1502 lines to 184, decomposed into a
  pipeline under `src/init/` (discover → interactive/scripted state → validate
  → plan → apply). Every write is expressed as one `InitPlan` value and all
  I/O is confined to `apply`, so what the wizard is about to do can be
  inspected without performing it.
- `sonata doctor` now says *why* tier routing is not detected rather than only
  what to run. Five states printed one sentence naming the fix; the one that
  bit in practice was hooks belonging to a *different* sonata install, where
  the advice was to run the command that was already correctly applied.

### Fixed
- `sonata init`'s confirm summary counted agent files as roles × models, a
  rule `sonata sync` does not use — a four-role config on two models was
  promised 8 files and given 4, on the one screen whose purpose is to say what
  is about to be written. `tiersCollapse` is now the single definition shared
  by the code that writes the files, routes to them, and counts them.
- A gateway whose API key was typed during `sonata init` was reported as
  having none, immediately above the line confirming the key had been stored.
- The models step could not be used at the size it reaches in practice: the
  picker filters as you type and shows a `Filter:` field, but its footer never
  said so, and on a 396-model list that is the difference between a usable
  list and an unusable one. It now also shows how many are selected, and
  labels the bulk toggle with what it will act on.
- Confirming a tier screen with nothing selected did nothing at all, against a
  footer promising `enter confirm` — indistinguishable from a hang.
- `Write these changes?` was asked on a cleared screen, because the prompt
  draws in the alternate screen buffer and hid the summary printed just above
  it. The prompt now carries its own copy of what it is asking about.
- `sonata usage` printed a nameless row for requests that never resolved a
  model, and misaligned every column once a model key exceeded 30 characters.

## [0.3.4] - 2026-08-29

### Fixed
- `sonata init` wrote `avoid_gateways` *after* the `[models."…"]` tables, and a
  bare TOML key belongs to the table above it — so the key became a field of
  the last model entry and `parseConfig` never saw it. The setting was written,
  silently ignored, and the next `sonata init` re-proposed the very ordering it
  exists to prevent. `sonata doctor` reported no failures throughout.

  If you set `avoid_gateways` on 0.3.3 and have run `sonata init` since, check
  that the key sits at the very top of `sonata.toml`, above every `[table]`
  header; move it there if not.

## [0.3.3] - 2026-08-29

### Added
- `avoid_gateways` — a top-level list of gateway names whose models rank
  *last* within every tier. Ranking optimises capability per task-dollar and
  knows nothing about whether a gateway is reliable, rate-limited, or simply
  one you would rather not send work to; the only remedy was reordering
  `[tiers]` by hand, which the next `sonata init` re-proposed away.

  It demotes rather than excludes, so those models stay as fallback
  candidates and avoiding a gateway costs preference rather than the depth a
  ranked tier exists to provide. A name matching no gateway is refused at
  parse time — the setting's failure mode is that its absence is invisible, so
  a typo would otherwise read as "not avoided".

  ```toml
  avoid_gateways = ["flaky-gw"]
  ```

## [0.3.2] - 2026-08-29

Tier ranking, mostly. Tiers were ordered on a coding index and a per-1M price
that almost never matched a model; they are now ordered on how well a model
does *agentic* work and what one task actually costs.

### Added
- `sonata doctor` reports the ranking catalog's freshness, and says when there
  is none. Advisory rather than blocking — a stale catalog still produces
  tiers, just from superseded scores, so the failure is a silently wrong
  ordering rather than an error.

### Changed
- Tiers rank on Artificial Analysis's **agentic index** and **cost per task**,
  read from their free `language/models` endpoint. Every sonata role runs as an
  agentic subagent driving tools in a loop, which the agentic index measures
  more closely than a coding score; and cost per task prices the *work* rather
  than the tokens, where a per-1M rate says nothing about how many tokens a
  model spends reaching an answer.
- **`simple` now ranks by capability per task-dollar**, where it used to take
  the most capable model that happened to be cheap — backwards for a tier whose
  purpose is cost. `complex` still ranks by raw capability. A relative floor
  (0.75 of the best model you selected) keeps a very cheap, very weak model from
  winning on ratio alone.
- `sonata catalog update` fetches every page of the paginated endpoint and
  refuses a response whose intelligence-index version changes mid-fetch, since
  two versions are not comparable scales.

### Fixed
- Codex models are declared as not supporting system messages. The Codex
  backend refuses any `role: system` with
  `{"detail":"System messages are not allowed"}`, and LiteLLM's chatgpt
  provider does not normalise it — [BerriAI/litellm#22968](https://github.com/BerriAI/litellm/issues/22968)
  reports exactly this and its fix, PR #22967, was closed without merging.
  Flattening the system block array was necessary but not sufficient; the two
  now work as a pair.
- Model names are matched against the catalog by stripping the provider
  prefixes actually in your config, not a hardcoded list. Any gateway nobody
  had thought to hardcode fell through to "capable, not cheap" and dropped out
  of the simple tier — and when no model clears the cheap bar, simple mirrors
  complex and the tier stops discriminating at all. On a real 17-model config
  the simple tier went from 2 models to 7.
- The tier ranking screen for a role's *second* tier opened with nothing
  ranked and could not be confirmed, trapping the wizard. It only happened when
  no tiers were saved yet — that is, on a first run.

### Notes
- Ranking is no longer per-role: one agentic measure serves all four roles, so
  `sonata init` proposes the same tiers for each. Per-role `[tiers]` lists are
  still honoured, and can still be ranked differently by hand.
- An existing `[tiers]` is never overwritten by a changed proposal — saved
  rankings win. To adopt this one, remove `[tiers]` from `sonata.toml` and
  re-run `sonata init`.

## [0.3.1] - 2026-08-28

Almost entirely `sonata init`: the wizard now asks providers what they serve
rather than trusting a cached harness catalogue, and stops offering the same
credential twice.

### Added
- The models step asks each gateway what it actually serves
  (`GET <base_url>/models`) instead of trusting the harness catalogue, which
  keeps listing models a gateway has dropped and misses ones it has added.
  A gateway that does not answer — unreachable, no key, OAuth, timed out —
  keeps its harness list, so a failed refresh degrades to the previous
  behaviour rather than emptying the picker. Models already listed keep their
  existing key, so a refresh never silently deselects what you had chosen.
- The import screen names the harness each provider came from
  (`acme · via opencode · key from sonata`). It matters because providers
  are deduped by name: several harnesses can serve one, only the first is
  shown, and it is that one's credential the import uses.

### Fixed
- `init` offered one provider per harness rather than one per credential, so
  the same ChatGPT subscription appeared twice — once as `codex`, once as
  opencode's `openai`, whose entry is the identical OAuth credential. Picking
  both wrote one subscription as two gateways serving overlapping models under
  different keys, doubling the generated agents. The canonical provider is now
  kept per OAuth kind, and only when it is actually offered, so a machine with
  opencode and no codex still reaches ChatGPT.
- Re-entering an already-configured provider's name under "Add a custom
  provider" dead-ended on `"<name>" is already a provider`, with no route back
  to that provider. It now redirects into re-entering its credential.
- A gateway no harness discovers any more (unlinked from opencode, say) could
  not be re-authenticated through the wizard at all; its base URL now falls
  back to the one already recorded in `sonata.toml`.
- A tier-ranked model whose provider had been deselected was resurrected by
  merely confirming the tier screen.
- A gateway named in `sonata.toml` was credited to a harness whose provider
  name only coincidentally matched, pre-selecting a harness that was never
  chosen and could not be unticked.

### Notes
- Codex and Copilot are deliberately excluded from the live refresh: their
  credentials are OAuth, not bearer keys, and neither serves an
  OpenAI-shaped `/models`. Codex's catalogue already comes from
  `codex app-server`'s `model/list`, so it is live by another route.

## [0.3.0] - 2026-08-28

### Fixed
- `sonata route auto` degraded into `sonata route on`. Routing turned on at
  SessionStart and off only when the *last* registered session ended, which
  with overlapping sessions is never — so the settings file stayed dirty and
  every session after the first launched into it and lost Remote Control,
  which is the one thing auto mode exists to prevent. Routing now follows the
  foreign-model subagents that actually need it: a `SubagentStart` /
  `SubagentStop` hook pair, matched to sonata's own agents, turns it on for
  the duration of a run and off again after. Sessions launch — and stay — in
  a clean file unless a foreign model is working.
- `autoInstalled` now requires all four hooks, so an install predating the
  change is reported by `sonata doctor` as stale rather than working. It
  would otherwise carry only the session pair and never route at all. Fix by
  re-running `sonata route auto`.
- `sonata restart` could report false success against a stale daemon still
  holding the router port: `startServeDaemon` accepted any healthy sonata
  router as proof its own spawn had bound. It now generates a random instance
  id, hands it to the child it spawns, and waits for a router reporting that
  exact id — never a stale survivor. `stopServe`'s dead-end refusal (a router
  with no recorded pid) now prints an actionable `kill <pid>` suggestion via
  a print-only `lsof -ti:<port> -sTCP:LISTEN` lookup; sonata still never
  kills a pid it did not itself record.

### Added
- `sonata usage`, `sonata status` and `sonata runs`, over a new append-only
  ledger the router writes (one JSON line per request, daily files under
  `~/.config/sonata/usage/`, 30-day retention).
- Per-model and per-gateway price tables in `sonata.toml`, with optional UTC
  time windows for providers that charge different rates off-peak.
- `sonata catalog update` also caches per-token rates from ai-pricing.fyi.

### Notes
- `sonata usage` measures the native path only; `sonata dispatch` runs never
  transit the router and cannot be measured.
- Unpriced volume is reported separately and never summed into the total.

## [0.2.1] - 2026-08-26

### Fixed
- `sonata init`'s "Import from other harnesses" screen pre-ticked a
  candidate by bare provider name, not by its exact `<harness>/<provider>`
  key — so if the same provider name was configured through one harness
  (e.g. opencode), a different harness's row for that same name (e.g. Pi)
  showed as pre-selected too, every run, with no way to make it stick
  unticked. Fixed by matching on exact key (`alreadyImportedKeys`,
  `src/tui-ink/app-state.ts`).
- The model-registry restart snapshot in `sonata serve` only hashed
  `unifiedModels`, so a gateway-only edit (`base_url`/`wire_format`/`auth`/
  `credential_source`) or an edit to a legacy `[native.models]` entry's
  `id`/`gateway` never triggered a LiteLLM restart. Now hashes
  `native.models` and `native.gateways` too.
- `deriveInitState`'s `roles` returned `[]` (not `undefined`) for a
  native-only unified config with neither `[tiers]` nor a legacy
  `generate.native` table, which `sonata init --yes` read as "zero roles
  selected" and refused with "no roles selected". A related gap in the
  same code path — the `configuredGateways` scan only read legacy
  `[native.models]`, never `unifiedModels` — meant such a config's gateway
  was rejected as unknown before role selection was ever reached.
- `configNativeCandidates` returned only unified or only legacy model
  candidates depending on which was non-empty, silently dropping a
  legacy-only key from a transitional config that has both. Now merges
  the two, scoped to untiered configs only — `parseConfig` mirrors every
  unified model into `native.models` whenever `[tiers]` is present, so
  treating that projection as independent legacy data on a *tiered*
  config would have shadowed each model's own harness routing.
- `RankedSelect`'s caller-supplied footer (e.g. the Artificial Analysis
  attribution line) replaced the `space`/`[ ]`/`enter`/`back`/`esc`
  control legend outright instead of appearing alongside it, making the
  tier-ranking screen's own controls undiscoverable whenever a footer was
  set.
- The bounded exit wait added for the model-registry restart escalates to
  `forceKill` (SIGKILL) once and gives up rather than hanging
  `litellmReady` forever against a LiteLLM child that ignores SIGTERM.
- `activeModelsJson` (now `activeNativeSnapshot`) is committed only after
  the replacement LiteLLM config and credentials are prepared
  successfully — a gateway added before its credential was available used
  to mark the change "handled" regardless, so fixing the credential
  afterward never retried the restart.

### Docs
- Added release dates to every CHANGELOG entry; linked it from the
  README, with a version badge.
- Tagged and released `v0.1.0` and `v0.2.0` — both had bumped
  `package.json` but were never tagged, so GitHub's Releases page had
  been stuck reporting `v0.0.3` as latest.

## [0.2.0] - 2026-08-25

Tier routing: agents are now generated per role × difficulty tier, backed by
a ranked model list the native router tries in order — with a CLI fallback
to the model's own harness when every native route fails. The MCP server is
removed.

### Added
- **Tier agents.** `sonata init`/`sonata sync` generate one agent per role ×
  tier (`code-simple`, `code-complex`, `review-simple`, …) instead of one per
  role × model. Each agent's frontmatter names a router alias
  (`model: sonata-code-simple`), not a specific model. A role whose `simple`
  and `complex` lists are element-wise identical collapses to a single agent
  (`sonata-code`).
- **Unified `[models]` + `[tiers]` config.** A `[models."<key>"]` entry can
  carry a native route (`gateway`/`id`/`context_window`), a harness route
  (`harness`/`harness_id`), or both — one model reachable two ways.
  `[tiers.<role>]` is `{ simple: [...], complex: [...] }`, ranked by
  position. `resolveTierAlias`/`harnessModelFor` (`src/config.ts`) resolve an
  alias to its ranked routes.
- **Ranked native fallback in the router.** `sonata serve`'s router resolves
  a `sonata-<role>-<tier>` alias against `[tiers]` and tries each native
  candidate in rank order, skipping one in a 60-second post-failure
  cooldown. The first response that isn't ≥500 or 429 (rate-limited) goes to
  the client; every candidate exhausted returns 529 naming the CLI fallback.
- **`sonata dispatch`** — a blocking CLI (`--tier <role>-<tier>` or `--model
  <key>`) that tries each harness-routed candidate in rank order, moving to
  the next on a thrown launch, a degraded finish, or an empty report.
  Replaces the MCP `dispatch`/`wait`/`approve` tools entirely: the same
  three verbs now exist as Bash commands
  (`Bash(sonata dispatch|wait|approve:*)`), allow-listed the same way.
- **Model catalog.** `normalizeModelName`, a curated capability/cost table,
  and `proposeTiers` (`src/catalog.ts`) rank a role's selected models into
  `simple`/`complex`. `sonata catalog update` optionally refreshes the
  ranking from a user's own Artificial Analysis API key
  (`sonata auth add artificialanalysis`) — coding index for capability,
  blended price for cost. Never bundles or redistributes Artificial
  Analysis's own data.
- **Legacy config migration.** A config still in the pre-tier
  `[generate.roles]`/`[generate.native]` shape is migrated automatically the
  next time `sonata init` runs (`migrateLegacyConfig`, `src/normalize.ts`) —
  every model and role assignment carries through, including a harness-only
  model with no native route. `sonata doctor` warns on a config that hasn't
  migrated yet.
- **`sonata route --global`.** `on|off|auto|manual|status` all take a
  project or machine-wide scope now, writing to `~/.claude/settings.json`
  instead of the project's `settings.local.json`. The session registry
  stays per-project regardless of scope.
- **`sonata-loop` skill** (`skills/loop/SKILL.md`) — plan a feature, route
  each task to a tier by difficulty, gate behind review with an
  escalate-to-`complex`-after-two-failures rule, final review. Installed by
  `sonata init`.
- **`sonata serve` respawns its LiteLLM child** if it exits on its own,
  instead of leaving the router answering every request with a dead
  upstream until someone notices and runs `sonata restart` by hand. A
  crash-loop guard (5 respawns/60s by default) gives up and logs why rather
  than respawning forever against a genuinely broken gateway.
- `sonata doctor` gains checks for a tiered config with no routed session,
  a legacy (pre-`[tiers]`) config, and a stale `.mcp.json`/`~/.claude.json`
  registration of the now-removed MCP server.

### Changed
- `sonata init`'s tier-assignment step (`RankedSelect`,
  `src/tui-ink/components/ranked-select*`) replaces the old "same models for
  every role?" choice and per-role model picker: selection order **is** the
  ranking, seeded from the cached Artificial Analysis catalog when one
  exists, else built-in defaults.
- A 429 from a native candidate is now treated as a retryable failure
  (cooldown + fallback), not returned to the client as if healthy.

### Removed
- **The MCP server** (`src/mcp/`) is deleted entirely — `dispatch`, `wait`,
  and `approve` are Bash commands now, not MCP tools. `sonata mcp` no
  longer exists as a command.

### Fixed
Found via a live smoke test and an automated PR review, both against this
same change:
- `sonata init --routing project|global|skip` was accepted by the wizard's
  state but the CLI never parsed the flag.
- `sonata dispatch` discarded the real reason a launch or wait failed,
  showing only an opaque `FAILED (degraded)`; the caught error's message is
  now recorded per attempt and printed.
- `sonata dispatch` re-opened a full wait window on every `RUNNING` result
  instead of returning control to the caller, so `sonata wait <id>` was
  unreachable and a dispatch could block indefinitely.
- `sonata dispatch` fell through to the next harness candidate when
  observing a successfully-launched run failed, risking two harnesses
  concurrently modifying the same working tree.
- `sonata dispatch --tier sonata-code-simple` (prefixed form) derived the
  role by splitting the raw option, yielding `"sonata"` instead of `"code"`.
- A unified `[models]` entry's `gateway` was never validated against
  `[native.gateways]` (unlike the legacy `[native.models]` path); an unknown
  gateway parsed fine and crashed `sonata serve` later.
- `sonata doctor`'s tier-routing check treated any `ANTHROPIC_BASE_URL` as
  routed without comparing it to the configured router port, so a stale
  port from a since-changed `[native.ports].router` still counted as
  routed.
- Re-initializing an already-tiered config silently dropped harness-only
  models (no native route) and could leave `[tiers]` referencing a model
  just deselected from the native picker, which `sonata sync` then rejected
  as an unknown model.
- `sonata restart`/`stopServe`'s startup-failure cleanup path could
  schedule a doomed LiteLLM respawn against a temp directory the same
  cleanup had just deleted.

## [0.1.0] - 2026-08-25

`sonata route auto|manual` — no-wrapper native routing that keeps Remote
Control, the first user-facing feature since 0.0.3.

## [0.0.3] - 2026-08-24

Documents the "Import from other harnesses" screen doubling as an unimport
toggle. Native-path work (subagent-model dispatch through a local routing
proxy) landed in this cycle.

## [0.0.2] - 2026-08-23

Per-gateway credential sources: `sonata auth login <gateway>` drives
LiteLLM's own device-login flow as a subprocess; `sonata init`/`sonata doctor`
ask and report where each gateway's credential comes from.

## [0.0.1] - 2026-08-11

First tagged release. Foreign-model subagents for Claude Code: dispatch a
subagent backed by OpenCode, Codex, or Pi through the ordinary Agent tool.

- Provider selection from each harness's own model catalogue.
- Machine-level config resolution (`./sonata.toml`, else
  `~/.config/sonata/sonata.toml`), with `sonata init` keeping the config and
  its generated agents in the same scope.
- Per-role models via `[generate.roles]`, replacing an earlier flat
  `roles`/`models` pair.
- Wrapper agents hold only `mcp__sonata__run`/`tail`/`approve` and no Bash;
  `sonata mcp` serves those tools over stdio; `sonata verify` confirms a run
  reached the foreign harness; `sonata doctor` checks the dispatch path end
  to end.
