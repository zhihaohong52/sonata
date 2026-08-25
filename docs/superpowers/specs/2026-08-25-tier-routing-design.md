# Tier routing: native-first subagents, difficulty tiers, and the loop skill

**Date:** 2026-08-25
**Status:** Approved design, pre-implementation
**Release:** next minor (0.2.0)

## Summary

Sonata's agent surface today is role × model × path: ~50 generated agents, an
MCP server with wrapper agents for the harness path, and a parallel native
path. This design collapses that to **8 tier agents** (`code-simple`,
`code-complex`, `review-simple`, `review-complex`, `explore-simple`,
`explore-complex`, `plan-simple`, `plan-complex`), executed **native-first**
through the router, with the foreign harnesses demoted to a CLI-driven
fallback and the MCP server removed entirely.

The orchestrating Claude session judges task difficulty and picks a tier;
sonata resolves the tier to a concrete model and falls back down a ranked
list on failure. A packaged **loop skill** teaches the orchestrator to
compose these agents into a feature-development loop (plan → code → review →
fix → re-review).

## Decisions (from brainstorming, 2026-08-25)

| Question | Decision |
|---|---|
| Where does loop/workflow logic live? | Main Claude session + packaged skill. Sonata stays a dispatch layer; no workflow runtime in sonata. |
| Routing surface | Role × tier agents (`simple`/`complex`), all four roles. |
| Who assigns models to tiers? | Curated built-in catalog, refreshable from Artificial Analysis with the user's own free API key. |
| Fallback semantics | Auto-retry down the tier's ranked list on launch failure, upstream 5xx, or degraded/empty-report finish. |
| Per-model agents | Removed. Tiers replace them; a specific model is requested in the dispatch prompt or config, not the agent picker. |
| Native vs harness | No longer parallel surfaces. Native is the default execution path; harness is the fallback when every native route is down. |
| MCP | Removed entirely — server, wrapper agents, registration. Harness fallback is a blocking CLI over Bash. |
| `route auto` scope | Gains `--global` (hooks into `~/.claude/settings.json`). |

## 1. Config surface

`[generate.roles]`, `[generate.native]`, and the harness/native key split are
replaced by a unified model registry plus tier lists.

```toml
[models."deepseek-v4-flash"]
gateway = "anexto"              # native route (default execution path)
id = "deepseek-v4-flash-0731"   # upstream id at that gateway
harness = "opencode"            # optional fallback route
# harness_id defaults to "<gateway>/<id>" when gateway is set; required for
# harness-only models; override when the harness names the model differently

[models."gpt-5.6-terra"]
gateway = "openai"
id = "gpt-5.6-terra"

[tiers.code]
simple  = ["deepseek-v4-flash", "gpt-5.6-luna"]
complex = ["deepseek-v4-pro", "gpt-5.6-terra"]

[tiers.review]
simple  = ["kimi-k3-free"]
complex = ["gpt-5.6-sol"]

[tiers.explore]
simple  = ["deepseek-v4-flash"]
complex = ["deepseek-v4-flash"]   # identical lists → single `explore` agent

[tiers.plan]
simple  = ["gpt-5.6-sol"]
complex = ["gpt-5.6-terra"]
```

Rules, enforced by `parseConfig`:

- **Position is priority.** First entry is the main model; the rest are
  backups in order.
- Every tier entry must name a key in `[models]`.
- A model with no `gateway` is harness-only: legal in a tier list, but the
  router skips it and only the CLI fallback can run it. A model with no
  `harness` is native-only. At least one route is required.
- `claude-`-prefixed ids stay refused (`isAnthropicRoutedName`), same as
  today's native models.
- Model keys stay quoted through `tomlKey`; the flattening-collision check
  moves from the old `<harness>-<provider>-<model>` scheme to the new keys.
- A role whose `simple` and `complex` lists are element-wise identical
  collapses to one un-suffixed agent (`explore`), so the picker never shows a
  fake choice.

**Migration.** `sonata init` rewrites an existing config: `[native.models]`
entries become `[models]` entries with their `gateway`; harness model keys
(`opencode-anexto-deepseek-v4-flash-0731`) become `[models]` entries with
`harness` set and, where the same upstream model already exists natively, are
merged into that entry as its `harness` route. `[generate.roles]` /
`[generate.native]` lists seed the corresponding tier lists (role's list →
both tiers, main model first) so no selection is lost; the user then adjusts
in the tier picker. The old tables are refused by `parseConfig` after
migration with a message naming `sonata init`.

## 2. Agent generation (`sonata sync`)

`sync` generates at most 8 agent files, one per role × tier:

- Frontmatter `model: sonata-code-simple` — a **tier alias** the router
  resolves at request time. No concrete model is baked into any agent file,
  so editing tier lists needs no re-sync.
- Read-only roles keep their restricted tool set (`Read, Grep, Glob`), same
  as today's native agents; `code` gets all tools.
- Each description carries the difficulty heuristic for the orchestrator:
  *simple* = mechanical, well-specified, contained (single file, clear spec,
  bulk edit); *complex* = cross-cutting, ambiguous, design-sensitive, or
  needs sustained reasoning. Plus: "When unsure, use -complex."
- Wrapper agents (MCP-relaying `.md` files) are no longer generated;
  `--prune` removes them.

## 3. Router: tier resolution and native fallback

The router (`src/native/router.ts`) learns the `sonata-` model prefix:

- A request whose model is `sonata-<role>[-<tier>]` is resolved against
  `[tiers]` — config re-read per request — to the ranked model list, filtered
  to entries with a `gateway`.
- The router forwards to the first candidate. On failure **before any bytes
  have streamed to the client** — connect error, 5xx, or the known
  empty-completion signature — it retries the same request against the next
  candidate. Exhausting the list returns 529 with a body naming the CLI
  fallback: `all native routes for code-simple failed; run: sonata dispatch
  --tier code-simple`.
- Failure **after streaming has begun** surfaces as today (529 → Claude Code
  retries the turn, which re-enters the resolver).
- A model that failed gets a short in-memory cooldown (per router process,
  ~60s) so a retried turn skips straight to a working backup instead of
  re-proving the outage. Cooldown state is advisory only — never persisted.
- The proof-of-routing log line gains the resolution step:
  `POST /v1/messages model=sonata-code-simple -> deepseek-v4-flash -> litellm`.
- Non-`sonata-` models behave exactly as today (`claude-` → anthropic,
  everything else → litellm), so `sonata code` sessions and existing
  configs keep working mid-migration.

## 4. Harness fallback: CLI, no MCP

**Deleted:** `src/mcp/` (protocol, server, tools), `sonata mcp` command, MCP
registration in `settings.ts`/init/doctor, wrapper-agent generation, and the
`SONATA_TOOLS` allow-list entries. The engine — `store`, `tmux`, `watchdog`,
`roles`, all adapters — is untouched; it answers to the CLI instead.

**New command:** `sonata dispatch` — the MCP `dispatch` tool's semantics
moved to stdout:

```
sonata dispatch --tier code-simple [--model <key>] [--timeout <s>] "<task>"
```

- Resolves the tier list filtered to entries with a `harness` route (or the
  named `--model`), launches the run through the existing engine, blocks
  until a reportable state, prints state + report. `PAUSED` prints the
  prompt and the `sonata approve <id>` line; a non-terminal exit prints the
  `sonata wait <id>` line for resuming. Auto-retry down the list applies on
  launch failure and degraded/empty-report finishes, and the output names
  which model actually ran.
- Long runs: the orchestrator starts `sonata dispatch` in background Bash
  and resumes with `sonata wait` — which already exists.
- `init` allowlists `Bash(sonata dispatch:*)`, `Bash(sonata wait:*)`,
  `Bash(sonata approve:*)` in place of the three MCP tools, for the same
  classifier-stability reason recorded in `settings.ts`.
- `doctor` flags a leftover sonata entry in `.mcp.json`/`~/.claude.json`
  with the removal command.

The permission-mode story is unchanged: the PreToolUse capture hook, mode
mirroring per harness, and refusal rules all stay.

## 5. Catalog: auto-assignment of models to tiers

New `src/catalog.ts`:

- **Curated fallback**, shipped in the package: our own judgement (not
  Artificial Analysis data — their free tier licenses internal use only, no
  redistribution). A small table: normalized model name → `{ capable:
  boolean, cheap: boolean }`. Unknown models default to `capable, not
  cheap` — the safe direction; never silently demote a task to a weak model.
- **`sonata catalog update`**: fetches the Artificial Analysis Data API with
  the user's own free key (stored via `sonata auth add artificialanalysis` —
  the existing store; never argv, never logged). Caches Coding Index and
  price per model in `~/.config/sonata/catalog.json` with a fetched-at
  timestamp. Output prints the required attribution ("Model rankings by
  Artificial Analysis — artificialanalysis.ai"), as does any init screen
  showing AA-derived rankings. User-fetched data is the user's internal use;
  sonata never ships or redistributes it.
- **Normalization**: `normalizeModelName` strips harness/provider prefixes
  and date suffixes (`anexto-deepseek-v4-flash-0731` → `deepseek-v4-flash`),
  plus a small alias table for stubborn cases. Unmatched → curated fallback
  → default.
- **Classification** (at init, auto path): Coding Index ≥ threshold ⇒
  `complex`-eligible; among those, price ≤ threshold ⇒ also
  `simple`-eligible. Within a tier, rank by index descending, tie-break by
  price ascending. Thresholds are constants in `catalog.ts` with the
  rationale beside them, adjustable without touching init.

## 6. `sonata init`: the auto and manual pathways

The model-selection step becomes tier assignment:

- **Auto**: intersect discovered + configured models with the catalog, write
  the `[tiers]` proposal, show it on one confirm screen.
- **Manual**: the same proposal rendered as a reorderable picker per role ×
  tier — main model first, backups below. Manual is editing what auto
  proposed; one screen serves both pathways.
- init also offers `sonata route auto` (project scope or `--global`), since
  native-first execution requires a routed session. Declining leaves a
  doctor warning rather than a broken state: unrouted sessions send
  `sonata-*` models to api.anthropic.com, which rejects them — so `sync`
  writes into each agent description the note that a routed session is
  required, and `doctor` checks routing the way it already checks the
  permission hook.

### TUI changes (`src/tui-ink/`)

The wizard's front half (provider setup, import toggle, BYOK, model
discovery) is unchanged. The back half is rebuilt around tiers:

- The **roles `MultiSelect`** stays (which roles to generate agents for).
- The **"same models for every role?" choice and per-role `MultiSelect`
  screens are replaced** by one tier-assignment screen per selected role,
  showing `simple` and `complex` side by side, pre-filled with the catalog's
  auto proposal.
- **New `RankedSelect` component** (`components/ranked-select.tsx` + a pure
  `ranked-select-state.ts` reducer, following the `multi-select-state.ts`
  pattern): a multi-select where selection order is the ranking — selected
  items render as a numbered list (1 = main model, 2+ = backups) and
  re-selecting an item moves it, with keys to nudge an entry up/down. Order
  must survive round-trips: re-init reads `[tiers]` and pre-selects in
  stored order, not discovery order.
- A **catalog source line** on the tier screens: `rankings: Artificial
  Analysis (fetched 2026-08-25) — artificialanalysis.ai` when AA data backs
  the proposal (the required attribution), or `rankings: built-in defaults —
  refresh with sonata catalog update` for the curated fallback.
- A **routing step** after the hook-scope step: offer `sonata route auto`
  at project scope, `--global`, or skip — using the retained non-Ink
  `select` prompt, like the existing hook-scope step (and subject to the
  same stdin `ref()` discipline).
- The **confirm screen** summarizes tiers per role (`code: simple →
  deepseek-v4-flash (+1 backup) · complex → deepseek-v4-pro (+1 backup)`)
  in place of the per-role model list.
- Left-arrow back-navigation, flag skipping (`--yes` accepts the auto
  proposal wholesale), and the init log's selection recording all extend to
  the new steps.

## 7. `sonata route --global`

`route auto|manual|on|off` accept `--global`:

- Hooks/env are written to `~/.claude/settings.json` instead of the
  project's `settings.local.json`. The session registry stays per-project
  (`<cwd>/.sonata/route-sessions.json`) — routing decisions are still made
  where the session runs.
- The global SessionStart hook exits silently (status 0, no daemon spawn)
  when the session's cwd resolves no sonata config — machine-wide hooks must
  not spray node processes or `.sonata/` directories across unrelated
  projects (same discipline as `capture-mode.mjs`).
- `route status` reports which scope(s) are active; the ownership guards
  (`isLocalhostUrl`, never clobber a foreign `ANTHROPIC_BASE_URL`) apply to
  the global file identically.

## 8. The loop skill

Packaged as a Claude Code skill (`skills/loop/SKILL.md`), installed by init
alongside the hooks, invoked as `/sonata:loop <feature description>`:

1. **Plan** — dispatch `plan-complex` with the feature description; receive
   a task breakdown.
2. **Route** — for each task, judge difficulty with the tier heuristic and
   dispatch `code-simple` or `code-complex`.
3. **Gate** — after each task, dispatch `review-simple` on the diff. On
   findings: dispatch a fix (same tier), re-review. **Escalation rule:** a
   task that fails review twice at `simple` re-runs at `complex`. **Loop
   bound:** at most 3 fix iterations per task, then surface to the user.
4. **Final gate** — `review-complex` over the whole change before reporting
   completion.

The skill also names when *not* to loop (single-file fixes go straight to
one `code-*` dispatch) and reminds the orchestrator that harness fallback
exists (`sonata dispatch --tier …`) when a tier agent fails. No sonata
runtime is involved; the skill is orchestration knowledge only.

## 9. Testing

- **Config**: parse/normalize round-trips for `[models]` + `[tiers]`;
  migration fixtures from real 0.1.x configs (per-role format, native
  tables); collision and `claude-` refusal.
- **Router**: tier resolution, per-request re-read, fallback on 5xx /
  connect error / empty completion, no-retry after first streamed byte,
  cooldown skip, exhaustion → 529 with fallback text, log line shape — all
  against stub upstreams, no real gateways.
- **CLI dispatch**: against the existing fake harness — normal run, crash,
  approval prompt, watchdog kill, degraded finish, auto-retry to the next
  model; output includes which model ran.
- **Catalog**: normalization table, classification thresholds, AA fetch
  against a captured fixture response, missing-key and offline paths.
- **init/sync**: tier proposal from a fixture catalog, identical-list
  collapse, migration produces a config `parseConfig` accepts, agent files
  carry tier aliases.
- **TUI**: `ranked-select-state.ts` reducer tested pure (selection order =
  ranking, move up/down, re-select repositions, back-navigation preserves
  order) — no TTY needed, same approach as `multi-select-state.ts`; re-init
  round-trip pre-selects tier lists in stored order.
- **route --global**: scope targeting, silent no-config exit, ownership
  guards on the global file.
- Suite stays keyless and offline; AA and gateway interactions are fixtures.

## 10. Out of scope

- A workflow runtime inside sonata (the loop lives in the skill).
- Streaming-mid-response failover (retry is pre-first-byte only).
- Automatic tier re-ranking on a schedule (catalog updates are explicit).
- Cost tracking/budgets per run.
- Removing the harness engine or adapters — they remain, as the fallback.
