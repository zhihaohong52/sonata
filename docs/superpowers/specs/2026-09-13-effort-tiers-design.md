# Effort levels in tiers: rank and dispatch the same model

Written 2026-09-13, after the observation that tier agents are dispatched
"as is" — no reasoning-effort setting at all — while the catalog that ranks
them scores each model at a specific effort. For the current generation the
effort is often the larger lever: **GPT-5.6 Luna at max out-scores GPT-5.6
Terra at every level below max, at an eighth of the cost per task.** Sonata
cannot express that today, and worse, it ranks a model at one effort and
runs it at another. This design makes effort a first-class part of a tier
candidate, ranks the variants Artificial Analysis already publishes, and
sends the chosen level upstream on both the native and the harness lane.

## The mismatch, measured

AA publishes one row per effort level and sonata already caches them under
the suffixed key (`gpt-5-6-luna-xhigh`, `gpt-5-6-terra-medium`). The
*unsuffixed* row is the model's highest setting. From this machine's
`~/.config/sonata/catalog.json` (agentic index / $-per-task):

| model | max | xhigh | high | medium | low |
|---|---|---|---|---|---|
| gpt-5.6-luna | 42.7 / $0.18 | 39.5 / $0.085 | 35.6 / $0.044 | 25.4 / $0.016 | 17.9 / $0.010 |
| gpt-5.6-terra | 43.7 / $1.40 | 42.2 / $0.63 | 37.6 / $0.34 | 31.4 / $0.18 | 27.3 / $0.14 |
| grok-4.6 | 53.4 / $1.86 | 52.7 / $2.32 | — | 51.2 / $1.50 | 42.2 / $0.48 |

A config key `gpt-5.6-luna` matches the unsuffixed row, so it is **ranked
as max-effort (42.7)**. The router sends no effort, so it **runs at whatever
the gateway defaults to** — and LiteLLM's messages passthrough translates
Claude Code's `thinking: {type: "adaptive"}` to `reasoning_effort:
"medium"` for a non-Claude model, so the likely answer is medium (25.4).
The ranking and the dispatch describe different models.

Two facts make the fix data-driven rather than a vendor table:

- **The wire path exists.** LiteLLM 1.98.0's Anthropic-messages passthrough
  accepts a top-level `reasoning_effort`
  (`llms/anthropic/experimental_pass_through/messages/transformation.py:70`)
  and maps it per provider — Responses `reasoning.effort`, Gemini thinking
  level, xAI `reasoning_effort`. `drop_params: true` (already set) means a
  provider without the control drops it silently rather than 400ing.
- **AA names the level, including the default row's.** The `name` field
  carries a trailing parenthetical: `GPT-5.6 Luna (max)` has slug
  `gpt-5-6-luna`; `GPT-5.6 Luna (low)` has `gpt-5-6-luna-low`; `Grok 4.6
  (high)` is `grok-4-6`; `Gemini 3.8 Flash (high)` is `gemini-3-8-flash`.
  So the wire name of the unsuffixed row is published, and the vocabulary is
  small. Tallied over all 647 rows on 2026-09-13: `high` 30, `medium` 21,
  `low` 20, `xhigh` 19, `max` 8, `minimal` 4, `Non-reasoning` 89,
  `Reasoning` 88, compound forms (`Reasoning, Max Effort`, `Adaptive
  Reasoning, High Effort`, `Non-reasoning, High Effort`), and noise that is
  not an effort at all (`Dec '24`, `Preview`, `Vision`, `32B`, `ChatGPT`).
  126 families have more than one variant.

## Decisions

Taken in the brainstorm, in the order they were asked:

1. **Scope: native path and harness dispatch both.** The router injects
   the level; each adapter maps it or says it cannot.
2. **Effort lives on the tier candidate, not the model.** Grammar
   `<key>@<effort>` inside `[tiers.<role>].<tier>`. Effort is "how hard to
   try" — a property of the ranked slot. One `[models]` entry per model; the
   same model may sit in `simple` at `high` and in `complex` at `xhigh`.
3. **A bare candidate whose model has effort variants is refused.** Not
   pass-through-with-a-warning, not silently pinned to the default level:
   the config does not load until the level is stated, and `sonata init`
   is the one-step fix. The user chose the loudest option knowingly.
4. **The wizard ranks one row per (model, effort) variant.** Every scored
   level is its own row in `RankedSelect`; the same model may appear twice
   in one list.
5. **A harness that cannot express the level runs at its default and the
   report is annotated**, not degraded, not skipped — the same shape as the
   worktree-unchanged annotation. Effort is a preference, not a safety
   boundary, so the permission-mode precedent (refuse rather than downgrade)
   does not apply.

And one taken in the design without asking, because the alternatives were
strictly worse: **the router sets `reasoning_effort` on the body per
candidate**, rather than emitting one LiteLLM deployment per variant with
`litellm_params.reasoning_effort`. A deployment per variant multiplies the
LiteLLM model list, ties an effort change to a LiteLLM restart, and does
nothing for the direct transport. The router already rewrites `model` per
candidate; one more field is the same transform.

## 1. Catalog: record effort and family per row

`sonata catalog update` (`src/commands/catalog.ts`) keeps
`normalizeModelName(slug)` → scores. It additionally parses the trailing
parenthetical of `name`:

- A token in the effort enum `{none, minimal, low, medium, high, xhigh,
  max}` — case-insensitive, matched as a whole word, including the compound
  `…, <Level> Effort` form — sets `effort`.
- `Non-reasoning` (either capitalisation) sets `effort: "none"`.
- A bare `Reasoning` with no level sets no effort: the vendor's default
  thinking, not a level sonata can name.
- Anything else sets no effort. The parser recognises the enum and nothing
  else — the enum is LiteLLM's own `reasoning_effort` set (plus `max`, which
  AA publishes and OpenAI accepts), so the vocabulary is bounded by the wire,
  not by a vendor table. A row with no parenthetical was scored with no
  reasoning level in play, so it is recorded at `none` (amended 2026-09-14;
  it was originally left as a bare model, which ranked on that row's score
  and then ran at the gateway's own effort).
- `family` is the name with the parenthetical stripped, run through
  `normalizeModelName`. The unsuffixed slug belongs to the family too; that
  is how a config's `gpt-5.6-luna` resolves to a family of six scored levels
  and learns that its default row is `max`.

Cache entries gain `{ family?: string, effort?: Effort }`. Both optional, so
a cache written by an earlier version still loads — it just carries no
families, which is the "cannot check" state below. A current `catalog update`
writes both on every row, a level-less one included. The fixture
`tests/fixtures/aa/models.json` grows a hand-invented family with a default
row and two suffixed rows (still synthetic, per AA's licence).

New in `src/catalog.ts`:

- `Effort` type and `EFFORT_LEVELS` — the single definition of the enum,
  used by the catalog parser, `parseConfig`, the router and the adapters.
- `catalogFamily(catalog, name)` → `{ default: Effort | undefined, variants:
  Map<Effort, AaEntry> } | undefined`. Resolves `name` through
  `aaLookupNames` the way `aaEntryFor` does, so an OpenRouter-flattened or
  `:free`-suffixed name finds its family the way it finds its score.
- `aaEntryFor(name, effort?)` — with an effort, returns the family variant
  at that level, else `undefined`; without one, unchanged.

## 2. Config: `<key>@<effort>` on tier candidates

In `src/config.ts`:

- `TierRoute` gains `effort?: Effort`. `resolveTierAlias` splits the suffix
  on the last `@` before the `[models]` lookup. `@` is not valid inside a
  model key today (keys are `<harness>-<provider>-<model>` with slashes
  flattened to dashes), so the split is unambiguous.
- `parseConfig` refuses an unknown level, an empty one (`luna@`), and a
  suffix on a key that does not exist in `[models]` — the last is the
  existing check, applied to the key half.
- `tiersCollapse` compares `(key, effort)` pairs. The same models at
  different efforts are a different fallback chain, so `simple = ["luna@high"]`
  and `complex = ["luna@max"]` keep both aliases live.
- `[models]` is untouched. `nativeTomlFor` and `replaceTiersBlock` write the
  suffix back verbatim; a round-trip test through `parseConfig` covers both
  writers, per the CLAUDE.md rule.
- `sonata dispatch --model <key>@<effort>` accepts the same grammar.

**The refusal for a bare key with variants lives in `loadConfig`, not
`parseConfig`.** `parseConfig` is pure text-in/config-out and has no
catalog; `loadConfig` has `home` and can load one. After parsing it walks
every tier candidate; for each *bare* one whose resolved upstream id has a
catalog family — which, since 2026-09-14, is every row the catalog holds: a
single "(Reasoning, Max Effort)" row is a family of one, and a row stating no
level is a family of one at `none`, because a bare key would otherwise rank on
that row's score and then run at the gateway's own effort. (This originally
required two or more stated levels.) It throws naming the
candidate, the family's default level, the levels available, and `sonata
init` as the fix. With no catalog cache the check is skipped — sonata
cannot know a family exists — and `sonata doctor` says so. The router loads
the tenant config per request through the same path, and a config error
there is already a 400 naming the parse error, so a bricked config fails
loudly on the first request rather than routing at an unstated effort.

## 3. Ranking and the wizard

`proposeTiers` (`src/catalog.ts`) takes the selected candidates and expands
each through `catalogFamily`: a model with a family becomes one candidate
per scored level, `{ key, effort, capability, costPerTask }`; a model
without one stays a single bare candidate scored as today. The existing
rules then apply unchanged — `complex` sorts by capability, `simple` by
capability per task-dollar above `SIMPLE_CAPABILITY_FLOOR` and under
`SIMPLE_COST_CEILING`, `avoid_gateways` demotes by gateway. On this
machine's config that yields

```
simple:  luna@high, luna@xhigh, luna@max, terra@high, …
complex: terra@max, luna@max, terra@xhigh, …
```

— the observation that started this, produced by the existing formula once
it can see the rows. The `simple` floor is measured over `preferred` leaders
as before; a family's variants are all leaders or all avoided together,
since avoidance is by gateway.

`RankedSelect` rows are variants. Label: `gpt-5.6-luna @xhigh   39.5
$0.085/task`. No new keys; `[`/`]` reorder as today. `seededRankingFor` and
`acceptRemainingTiers` operate on variant values, so `A` still writes a
byte-identical `sonata.toml`. `tierPickerKeys` withholds a whole family when
its provider is deselected this session, same as it withholds the key today.

`sonata agents` lists and re-ranks the same variant rows through the same
component, and its view shows the effort beside each candidate.

## 4. Router: inject effort per candidate

In `routeTierRequest` (`src/native/router.ts`), which already rewrites
`model` per candidate:

- When the candidate carries an effort, `withEffort(body, effort)` sets
  top-level `reasoning_effort` and **deletes `thinking` and
  `output_config.effort`** on that request. LiteLLM translates `thinking`
  into `reasoning_effort` when present; leaving both in is how an explicit
  `xhigh` gets overwritten by `adaptive → medium`. A bare candidate leaves
  the body untouched — exactly today's request.
- Applied on **both transports**, for the same reason `litellmBody` is one
  function. On the direct (Anthropic-wire) transport the body is otherwise
  passed through byte-identical because assistant content blocks carry
  opaque vendor state (`redacted_thinking`, Gemini's `thought_signature`);
  adding one top-level key leaves those blocks untouched. What a direct
  upstream does with `reasoning_effort` is an implementation-time probe
  against OpenRouter's `/v1/messages`: if it ignores the key, nothing more
  to do; if it rejects it outright, the direct path sends the request
  unchanged and the log line says `effort not sent`, consistent with
  decision 5.
- **Cooldown keys stay `<tenantId>/<key>`** — model, not variant. A ≥500
  from `luna@xhigh` cools `luna`, so `luna@high` two slots down is skipped
  rather than retried against the same dead upstream. The capability-400
  fingerprint keys by model for the same reason.
- The log line names the variant: `model=sonata-code-complex ->
  gpt-5.6-luna@xhigh -> litellm`.
- The ledger row gains `effort?: Effort`. `sonata status` shows the variant
  served; `sonata usage --by effort` is one more entry in the existing
  dimension table.

A stated limit: `drop_params: true` means a provider without an effort
control drops the field silently, and the router cannot tell "honoured"
from "dropped". Same class as unpriced volume — reported as unknown, never
assumed. The only evidence that a level was applied is the per-task cost in
the ledger moving with it, which is what makes recording `effort` on the
row worthwhile.

## 5. Harness adapters

- `LaunchPlan` input gains `effort?: Effort`; `HarnessAdapter.plan` decides
  what to do with it and reports `effortHonoured: boolean` on the plan.
  `cmdDispatch` passes the variant's effort through `cmdRun`. The effort
  travels beside the key, never inside `harness_id`; `harnessModelFor` is
  unchanged.
- **codex**: `-c model_reasoning_effort=<level>` on both `exec` and the TUI
  launch — the one mapping already known. Whether codex accepts every level
  for every model is the probe; a level codex refuses surfaces as a thrown
  launch → next candidate, which is the existing fallback rule.
- **opencode, pi, reasonix**: probe the real binary first, per the repo
  rule. Any of the three with a real control gets it; any without reports
  `effortHonoured: false`, and `tail` prefixes the report `[effort xhigh not
  honoured: <harness> has no effort control]` — annotating, not degrading.
  This spec states nothing about those three until a captured fixture in
  `tests/fixtures/panes/` says otherwise.

## 6. Everything that reads tiers

- `sonata sync`: agent files are unchanged in shape — they name an alias,
  not a model.
- `sonata doctor`: three new lines. A bare candidate with variants (doctor
  runs on a config that *failed* to load and must name why); "catalog
  absent, effort cannot be checked"; and, advisory, a candidate whose only
  route is a harness with no effort control.
- `sonata init`: a config carrying bare keys with variants is re-proposed
  through the expanded `proposeTiers`, so re-running init is the one-step
  fix; `--yes` does the same unattended.
- `docs/guide/` gains the grammar and the "ranked at ≠ dispatched at"
  explanation; CLAUDE.md gains the design points; `CHANGELOG.md` under
  `[Unreleased]`.

## 7. Testing

- Catalog: the parenthetical parser table-tested against the vocabulary
  tally above — every level, `Non-reasoning`, the compound forms, and every
  noise form → no effort; family grouping including an unsuffixed default.
- Config: `key@effort` round-trip through `parseConfig` → `nativeTomlFor`
  and → `replaceTiersBlock`; refusal of unknown and empty levels;
  `loadConfig` refusal with a fixture catalog and skip without one;
  `tiersCollapse` on `(key, effort)`.
- Ranking: `proposeTiers` over a synthetic family reproduces `luna@high`
  leading simple and `terra@max` leading complex; floor and ceiling still
  gate variants; `seededRankingFor` byte-identical on `A`.
- Router: body gains `reasoning_effort` and loses `thinking` /
  `output_config.effort` on both transports; a bare candidate's body is
  byte-identical; cooldown by model after a variant fails; ledger row
  carries `effort`.
- Adapters: the codex plan carries the flag; a no-control harness yields the
  annotation prefix through `tail`; fixtures captured from the real
  binaries.
- Live: one routed `code-complex` dispatch whose router log shows `@xhigh`
  and whose ledger cost per task moves with the level.

## Delivery

Three PRs, by the repo's own rule that anything touching money, routing or
config parsing gets a second reader:

1. **Catalog + config + ranking + wizard** — sections 1–3 and the `agents`
   editor. After this PR a config can state effort and be ranked on it;
   nothing sends it yet.
2. **Router + ledger** — section 4. After this PR the native path dispatches
   at the ranked level.
3. **Adapters** — section 5, gated on the real-binary probes.

## Out of scope

- Per-request effort chosen by the *caller* (a `code-complex` agent asking
  for `low` on an easy sub-task). The tier already encodes difficulty; a
  second axis inside it needs usage data nobody has.
- Effort for Claude models. Sonata refuses `claude-` ids at parse time and
  the Anthropic path is byte-identical by contract; Claude Code's own
  effort setting governs those.
- Anything about the *time* an effort costs. AA publishes latency
  (`median_time_to_first_token_seconds` is 127 s for Luna at max, 1.5 s at
  low); a tier is not ranked on it today and this design does not start.
