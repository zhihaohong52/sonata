# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/) informally
(pre-1.0, so minor bumps can carry breaking changes).

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
