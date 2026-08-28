# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/) informally
(pre-1.0, so minor bumps can carry breaking changes).

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
