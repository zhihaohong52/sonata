# Model → provider routing: one model, many ways to reach it

**Status:** designed, not implemented
**Date:** 2026-09-22
**Ships in:** 0.12.0

## The decision

A tier ranks **models**. A model names the **providers** that serve it. A
provider names the **runners** that can reach it — sonata's own router, or a
harness.

```
(role, tier) → ranked models → ranked providers → runners
```

Today a tier entry is a single opaque key that fuses all three
(`anexto-gpt-5.6-luna`), so the same weights appear several times as unrelated
candidates and nothing can fall from one provider to another.

**And the ranking stops being stored at all.** `[tiers]` currently saves a
*ranking* — a frozen answer to a question the catalog keeps re-answering. It
becomes an optional hand override; absent, the order is derived from the
current catalog. Config stores what you chose; sonata computes what follows.

## Why

Three failures on 2026-09-21, all the same defect wearing different clothes.

**A provider's billing cap killed whole tiers.** `anexto` answered
`Budget exceeded: 200.0409 >= 200.0000` (402). Five of one project's eleven
native models are on anexto, so a dispatch paid five separate refusals — one
per model — to be told the same thing about the same account. Nothing could
say "same model, different provider" because no such relation existed.

**One model needed editing twice.** `glm-5.3-flash` was pinned at an effort
its endpoint refuses, and the fix had to be applied to *two* keys —
`anexto-glm-5.3-flash` and `openrouter-z-ai-glm-5.3-flash` — which are the
same weights spelled differently by two resellers.

**Tier depth is partly illusory.** Cooldowns key on the bare model key, so a
model's effort rungs all cool together. A tier that looks twelve deep may hold
three models; when one fails, its whole ladder goes with it.

The first is now survivable — 402 is retryable (#58) and cools the gateway
(#60) — but survivable is not the same as routable. A tier still cannot reach
the same model through a different account.

## Config shape

Measured on a real config (`insurance`), six keys are three models:

| logical model | anexto | openrouter / codex |
|---|---|---|
| `gpt-5.6-luna` | `gpt-5.6-luna` | codex: `gpt-5.6-luna` |
| `deepseek-v4.1-flash` | `deepseek-v4.1-flash` | openrouter: `deepseek/deepseek-v4.1-flash` |
| `glm-5.3-flash` | `glm-5.3-flash` | openrouter: `z-ai/glm-5.3-flash` |

Note every provider spells the model differently, so a vendor-neutral key must
carry a per-provider `id`.

```toml
[models."gpt-5.6-luna"]
context_window = 1050000

  [models."gpt-5.6-luna".providers.codex]
  id = "gpt-5.6-luna"
  harness.codex = "gpt-5.6-luna"

  [models."gpt-5.6-luna".providers.anexto]
  id = "gpt-5.6-luna"
  harness.opencode = "anexto/gpt-5.6-luna"

[tiers."code"]
complex = ["gpt-6-astra@low", "gpt-5.6-luna@max"]
```

### Model × provider × runner is three axes, not two

An earlier draft folded harnesses in as a kind of provider. The config
disproves it: `anexto-gpt-5.6-luna` today carries **both**
`gateway = "anexto"` *and* `harness = "opencode"`,
`harness_id = "anexto/gpt-5.6-luna"` — same weights, same billing account, two
runners. Meanwhile `openrouter-z-ai-glm-5.3-flash` carries the provider
*inside* its harness id, and `gpt-6-astra` on codex has no provider segment at
all, because codex has no provider dimension.

Provider is primary in the nesting because it is the axis routing acts on:
cooldowns, `[budget]`, pricing and the 402/401 failover are all per account.
Nesting by runner instead would scatter one account across several blocks.

Folding the two axes together would also have cost the `529`-then-`dispatch`
boundary. The router must only ever consider native runners; the harness lane
is what a tier reaches *after* the router gives up.

### Fields

- `context_window` moves to the model, with an optional per-provider override,
  because resellers do cap it.
- `providers_order` on a model is the optional hand override; absent means
  derived.
- A provider block with `id` is natively routable; one with `harness.<name>`
  is dispatchable. Both is normal and is what today's unified entry already
  expresses.

## Which provider serves a model is derived

Hand-ranking providers on every model does not scale: a four-role config is
already ~12 models × up to 6 effort rungs. Sonata ranks providers from data it
already holds — the per-model price (models.dev, `pricing_provider`) and live
health (the cooldown maps) — cheapest healthy first.

`avoid_gateways` keeps its current meaning as the global demotion, and
`providers_order` is the per-model override. Both are preserved across an
`init` rewrite, as `avoid_gateways` already is.

This mirrors `proposeTiers`: sonata derives the ordering, the user overrides
where they disagree, and the override survives re-proposal.

## Which models a tier ranks is derived too, and never stored

The catalog moves. Measured during this design session: a morning read of the
AA catalog had no `mimo-v2-6-pro` at all; the `06:27Z` refetch added it, and it
immediately became the knee of the frontier *and* dominated `gpt-5.6-luna@max`.
A ranking written two hours earlier was already wrong.

`[tiers]` is only refreshed by `sonata init --repropose-tiers`, which nobody
runs. 0.11.0 shipped a `tier freshness` doctor check to report the resulting
staleness, which is a band-aid over a design that stores a derived value.

**`[models]` holds the universe you selected. `[tiers]` becomes an optional
override.** Absent — the normal case — the order is computed at resolve time:

1. The **Pareto frontier** over (intelligence, cost per task) across the
   selected models.
2. `simple` — the cheap end, under the existing `SIMPLE_COST_CEILING` (12x).
3. `normal` — the **knee**, the last point before the frontier's slope
   collapses.
4. `complex` — the cheapest candidate within `AA_CAPABILITY_TIE_MARGIN` of the
   most capable, i.e. never paying more for a difference inside measurement
   noise.

When a new model lands you add it to `[models]`, run `sonata catalog update`,
and every tier re-ranks itself. No `--repropose-tiers`, no stale-ranking check,
and no "two eras in one config" — which is the shape of both the inverted tier
split in 0.11.0 and the `@none` bug of 2026-09-21.

### Why the frontier, and why not a ratio

`intelligence / cost` is a *scalarisation*: it asserts one exchange rate
everywhere. It does land on the frontier — if B dominates A then
`ratio(B) >= ratio(A)` — but always at its cheapest end, because a cost
spanning 332x swamps capability. Measured: it ranks `luna@low` (21.0,
$0.0098) as 6x better value than `mimo-v2.6-pro` (46.3, $0.1332), for a model
less than half as capable. That is why `simple` and `normal` collapsed onto the
same pick under the old rule.

The defect is not the cost axis. `I/C` is already logarithmic in both:
maximising it is maximising `log I - log C`. The error is treating
**intelligence** multiplicatively. AA's Intelligence Index is an index on a
bounded scale — 21 to 46.3 is not "2.2x smarter", differences in index points
are meaningful and ratios are not — while cost is genuine ratio scale.
`ΔI / Δlog C` matches the nature of each axis; `I/C` does not.

Dominance itself is **scale-free**: it survives any monotone transform of
either axis, so frontier membership owes nothing to how a chart is drawn. The
knee is scale-dependent in principle, but was checked both ways on real data
and picks the same point under linear and log cost.

### What this replaces

`COMPLEX_COST_BAND`, added 2026-09-22 and the source of two defects in a day,
is **deleted**. It credited a rung with its family's best score, and that
credit leaked across families: `sol@high` (really 42.3) was compared as 47.0
and beat `mimo` at 46.3 despite costing more. On one real config it put **five
strictly dominated candidates above mimo**. The frontier makes that
unrepresentable — a dominated candidate can never outrank what dominates it —
and the tie margin, which already exists and already means "this gap is
benchmark noise", does the job the band was invented for.

### Degradation

- No catalog: the built-in table, as today.
- Stale catalog: still ranks; `doctor` reports the age.
- A model the catalog does not score: cannot be ranked, so it goes last as a
  fallback rather than vanishing.
- The resolver reads the catalog **once per tenant load**, not per request.

### The honest costs

- The request path gains a catalog dependency. It is a cached read, but it is
  new coupling on the path where failure means a dead agent.
- A ranking can change with no edit to any file, after a `catalog update`. The
  ledger records which candidate served each request, so it stays auditable
  after the fact, but there is no diff to point at beforehand.

### Interaction with providers

The frontier is computed over **models**, and providers rank underneath a
model as in the rest of this document. A model appears on the frontier once,
at its best available price across its providers — otherwise one model on
three gateways would occupy three frontier points and crowd out genuinely
different models.

## Grouping is proposed, never inferred at request time

`sonata init` groups providers using `normalizeModelName` — already proven on
this exact case, since `z-ai/glm-5.3-flash` and `glm-5.3-flash` both normalize
to `glm-5-3-flash` for scoring today — and writes the grouping into
`sonata.toml`. The router never re-derives identity.

The distinction matters because a wrong grouping is not a bad ordering, it is
a request served by a *different model than the tier named*. Identity must be
a fact in the file, reviewable, not a heuristic re-evaluated per request.
`migrateLegacyConfig` already refuses to merge two models that normalize
alike; the same guard applies here.

## The request path

`resolveTierAlias` flattens the tier into the flat `TierRoute[]` the router
already consumes — each model in tier order, its providers in derived order —
taking **native runners only**. `sonata dispatch` walks the same structure
taking harness runners.

Flattening rather than nesting is deliberate. `routeTierRequest` holds a great
deal of hard-won behaviour: sticky conversations and `stripForeignThinking`,
capability-400 fingerprint counting, usage recording, the budget gate, the 529
exhaustion message. A nested loop would split every one of those across two
levels. Flattening changes the *identity* of a route and the cooldown lookup,
and leaves the loop's shape alone — the request path is where a bug means a
dead agent rather than a poor ordering.

### Four concerns, four keys

`TierRoute.key` splits into `model` + `provider`. That split is the reason
this is safe to build:

| concern | keyed on |
|---|---|
| candidate cooldown | `(tenant, model, provider)` |
| provider cooldown | `(tenant, provider)` — shipped in #60, unchanged |
| capability-400 counts | `(tenant, model, provider, fingerprint)` |
| **sticky conversation** | `(tenant, model)` |

### The sticky key must not include the provider

This is the one place where being wrong is invisible.

`stripForeignThinking` fires when the serving candidate changes, because
extended-thinking blocks carry opaque vendor state the issuing model requires
echoed back. Those blocks belong to the **model**. `glm-5.3-flash` served by
anexto on one turn and openrouter on the next is the same weights, and its
thinking is still valid.

If sticky keyed on `(model, provider)`, every provider failover mid-conversation
would strip the transcript's thinking for no reason. Nothing would error. The
agent would simply get worse, and the cause would be unrecoverable from the
symptom. **Provider failover must be invisible to the conversation.**

### LiteLLM deployment naming

One model now has several deployments, so the name must carry the provider:
`<tenant>/<model>@<provider>`. `litellm.ts` already warns that a duplicate
`model_name` makes LiteLLM choose between deployments itself — which would
take the ranking away from sonata and break the direct transport besides,
since an `anthropic` api-key gateway never passes through LiteLLM at all.

### Effort stays on the model

Tier candidates remain `<model>@<effort>`. Levels are scored per model by
Artificial Analysis, but *accepted* per endpoint — `glm-5.3-flash@none` is
served by anexto and refused by openrouter, whose 400 says "Reasoning is
mandatory for this **endpoint**".

That refusal is exactly a `(model, provider)` capability-400, the mechanism
shipped on 2026-09-21 including the `Reasoning is mandatory` signature. It
cools that pair and the next provider is tried. The failure self-heals with no
new config and no table of per-provider capabilities that sonata does not own
and cannot verify.

## Cooldown observability

The cooldown maps are currently unreadable — module-level `Map`s whose only
accessor is a test seam. When a tier exhausts, nothing can say why, which is
how two sessions on 2026-09-21 ended up reading serve logs and `lsof` to
diagnose a routing failure.

`GET /__sonata/api/cooldowns` joins the existing JSON API
(`api/usage`, `api/session/<id>`, `api/run/<id>`), and `sonata status` prints
it — scoped to the project by default, see below.

The map values gain a **reason** alongside the expiry. A bare timestamp says
something is wrong; the reason answers the question:

```json
{
  "providers": [
    { "provider": "anexto", "secondsLeft": 42,
      "reason": "account-level refusal (402)", "project": "…/insurance" }
  ],
  "candidates": [
    { "model": "glm-5.3-flash", "provider": "openrouter", "secondsLeft": 17,
      "reason": "capability 400: Reasoning is mandatory" }
  ]
}
```

This is also how the two cooldown scopes become testable against a live
router rather than inferred from behaviour.

## `sonata status` scopes to the project

`sonata status` reads the machine-wide ledger and filters only by *session* —
never by project. The default narrows to "the most recent session", computed
across every tenant, so running it inside one project can display another
project's session in full. `LedgerRow` has carried `project` since
multi-tenant routing landed; nothing reads it.

- **Default: this project.** Rows are filtered to the resolved tenant.
- **`--global`: every project.** Named to match `sonata route status
  --global`, which already means exactly this.
- `--session` and `--all` are unchanged and orthogonal: they select along the
  *session* axis, `--global` along the *project* axis. `--all` means every
  session, not every project, and the help text has to say so or the two will
  be read as synonyms.

The project is resolved the same way the router resolves a tenant, not by a
bare `cwd` comparison. A linked worktree borrows its main checkout's config
and shares its tenant id, so it must see that checkout's rows rather than an
empty list.

The same scoping applies to the cooldown output above: cooldowns are keyed by
tenant, so by default a project sees its own and `--global` shows every
tenant's.

## Migration

`schema_version` 3, following the pattern `migrateLegacyConfig` already
established for `[generate.*]` → `[models]` + `[tiers]`:

- A v2 config **keeps loading**, grouped in memory by the same
  `normalizeModelName` that `init` would use. Nothing breaks on upgrade.
- `sonata init` writes the new shape and stamps v3.
- Mixing the two shapes in one file is refused.
- `sonata doctor` reports a flat-key config and names `sonata init`.

Only a reproposed config becomes forward-incompatible, so the cost is opt-in.
That matters: on 2026-09-21 a config hand-edited to a value its running router
did not know failed to load *entirely*, taking all four roles down rather than
the one entry. The v3 stamp makes an older sonata refuse with
`upgrade sonata` instead of blaming a value.

**Migration loses information, deliberately.** A tier listing both
`anexto-glm-5.3-flash@none` and `openrouter-z-ai-glm-5.3-flash@none` collapses
to one `glm-5.3-flash@none`. A hand-ranked model order becomes a derived
provider order. That is the point of the change, but it is a real loss and
`init` should say so rather than perform it silently.

## doctor

- **grouping check** — every provider under one model key must normalize to
  the same catalog family. A wrong grouping routes to a model the tier did not
  name, and is otherwise silent.
- **unreachable provider** — a provider named on a model with no gateway and
  no harness configured.
- **flat-key config** — names `sonata init` (above).
- **`tier freshness` is deleted, not carried over.** It exists to report that a
  saved ranking has gone stale, and nothing saves a ranking any more. Keeping a
  check for a condition that can no longer arise would be the band-aid
  outliving the wound.
- **`effort freshness` carries over unchanged** — it reports a saved `@none`
  pin the catalog contradicts, and hand-written pins still exist.
- **catalog age becomes load-bearing rather than advisory.** With the ranking
  derived, a stale catalog no longer means "the proposal you were offered was
  computed on old numbers", it means "every tier is ordered on old numbers
  right now". Same check, higher severity.

## Non-goals

- **Harness-lane usage accounting** stays out (issue #47). A `dispatch` run
  never transits the router; this change does not alter that.
- **Cross-provider load balancing.** Providers are a ranked fallback chain,
  not a pool. Sonata picks the first healthy one, as it does for models.
- **Per-provider effort tables.** See *Effort stays on the model*.
- **LiteLLM-side model groups.** Sonata keeps the choice: the direct transport
  bypasses LiteLLM entirely, and cooldowns, budget and ranking are sonata's.

## Risks

**The sticky/cooldown key split is the main one.** Two identities on one
route, where conflating them degrades agents silently. It needs a test that a
provider switch preserves thinking blocks and a model switch strips them.

**Derived provider ranking depends on pricing coverage.** A gateway with no
`pricing_provider` prices nothing, so its models cannot be ordered by cost and
fall back to health only. `doctor` already reports unpriced gateways; this
gives that warning teeth it did not have.

**`429` in the provider-scoped set rests on inference**, not evidence — a
gateway may rate-limit per key or per model and neither has been probed. It is
bounded by the 60s cooldown and documented at the constant, with the one-line
narrowing named.
