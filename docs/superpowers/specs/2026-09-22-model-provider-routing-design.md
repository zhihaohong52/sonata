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
override.** Absent — the normal case — the order is computed at resolve time.

### The derivation, in three steps

**1. The Pareto frontier** over (cost per task, intelligence), across the
selected models. Dominance is scale-free: it survives any monotone transform
of either axis, so frontier membership owes nothing to how a chart is drawn.

**2. Cut the wasteful tail.** Walk down from the most expensive end of the
frontier, cutting while a rung's marginal return `ΔI / Δlog C` is below one
third of the frontier's median slope; stop at the first rung that pays.

Measured on the 2026-09-22 catalog, the slopes are:

```
granite      -> luna@low       55.8 / decade
luna@low     -> luna@medium    19.8
luna@medium  -> luna@high      15.8
luna@high    -> luna@xhigh      8.7
luna@xhigh   -> mimo           60.4
mimo         -> astra@medium    3.1   <- the knee crossing: 11.6x for +3.3
astra@medium -> astra@high     26.4
astra@high   -> astra@xhigh    11.9
astra@xhigh  -> astra@max       2.0   ┐
astra@max    -> fable@xhigh     1.9   ├ cut
fable@xhigh  -> fable@max       1.9   ┘
median 11.9, bar 4.0
```

`astra@max` buys **+0.3 index points for 41% more money**. That is the rung
this step exists to remove, and the tail generalises: three rungs at the top
of the frontier return under 2 points per cost decade while the median rung
returns 11.9.

**Trailing only, never the middle.** `mimo -> astra@medium` is 3.1/decade and
also below the bar, but it is the frontier *crossing a capability gap* rather
than waste — there is simply nothing between 46.3 and 49.6 at any price.
Cutting there would sever the frontier at the knee and leave `complex` leading
with `mimo`, which is `normal`'s lead: the tier-collapse failure that
`SIMPLE_CAPABILITY_FLOOR` already caused once and was deleted for.

**The bar is relative, not absolute**, because the whole point is that the
frontier moves. A fraction of the median slope re-derives itself from whatever
the catalog now holds; a constant like "10 points per decade" would silently
become wrong the first time the index rescaled.

**3. The knee** — Kneedle on (log₁₀ cost, intelligence) normalised to the unit
square: the frontier point furthest above the chord joining its endpoints.
This reproduces Artificial Analysis's own published line exactly (12 points,
knee at `mimo-v2-6-pro`), which is the check that validated the computation.

The knee is **derived, not configured**. A new model lands on the frontier,
the knee moves itself, and the tier boundary follows. There is no threshold to
tune and none to go stale — which is the answer to "what if a new luna drops
tomorrow and raises the frontier again."

**Order matters: the knee is computed on the FULL frontier, before step 2's
gate.** Kneedle measures against a chord between the frontier's endpoints, and
the gate removes the far endpoint — so gating first moves the knee, and the
knee would then inherit the gate's tuned fraction, destroying the one property
that makes it trustworthy. Measured on the agentic frontier of a real config:
the last rung is `glm-5.3-flash → astra@max` at **0.1 per decade** (+0.1
capability for 12.9x the cost), and cutting it moves the knee from
`glm-5.3-flash` ($0.2533) to `luna@medium` ($0.0156) — **16x apart**, on the
model that leads the default tier. Knee first, gate second.

### Each tier ranks on its own metric, so each has its own frontier

`capabilityOf` (agentic) and `reasoningOf` (intelligence) already split this
way, for measured reasons recorded in `catalog.ts`. The frontier and knee are
therefore computed **per tier, on the metric that tier ranks by** — bounding a
value tier with a knee derived from a metric it does not rank on is the same
unit-mixing error as comparing `cost_per_task` with `blendedPriceUsd`.

They genuinely differ. On one real config:

| metric | knee | used by |
|---|---|---|
| agentic | `glm-5.3-flash` — $0.2533, 50.9 | `simple`, `normal` |
| intelligence | `mimo-v2-6-pro` — $0.1332, 46.3 | `complex` |

### The tiers

| tier | metric | population | order |
|---|---|---|---|
| `simple` | agentic | capped at `SIMPLE_COST_CEILING` (12x) × the best-value cost | value |
| `normal` | agentic | everything | **the knee, then value** |
| `complex` | intelligence | everything | capability, knee-and-above first |

**`normal` leads with the knee, and that is the point of computing one.** The
earlier draft used the knee only as a boundary, so the best balance point on
the frontier led nothing and was merely a divider — the analysis was performed
and then discarded. `normal` is the *default* tier and means "you know what to
change but not exactly how"; leading it with the cheapest model available
(agentic 16.1) is not a sensible default, and it also gave `simple` and
`normal` the same lead, which is the collapse `SIMPLE_CAPABILITY_FLOOR` caused
and was deleted for. The knee is exactly the model that answers "good enough,
without paying for the top".

The cost is real and stated: on the config measured, `normal`'s lead moves
from `luna@low` ($0.0098, agentic 16.1) to `glm-5.3-flash` ($0.2533, agentic
50.9) — **26x the price for 3.2x the capability**, on the tier that takes most
traffic. `[budget] daily_usd` is what bounds the consequence.

**`complex` puts the knee-and-above first, then everything below it**, rather
than excluding below-knee models. The knee decides the *lead*, not membership:
a tier that excluded them had five live candidates on a real config, so a
provider-wide 402 — the failure that started this redesign — would exhaust it
to the harness lane while `sol@xhigh` (44.0) and `terra@max` (42.1) sat
unused. Gated rungs go last of all, after the below-knee tail: if everything
better is cooling you would rather run `sol@xhigh` at $1.18 than `astra@max`
at $3.26 for one more index point.

### A consequence worth stating plainly

Under per-tier metrics, **`mimo-v2-6-pro` leads no tier**, despite being the
knee that validated this whole computation against AA's chart. It is the knee
on the *intelligence* axis, and that axis belongs to `complex`, whose job is
the strong end — so there its knee is a floor rather than a lead. On the
*agentic* axis the value tiers rank by, the knee is `glm-5.3-flash`, and that
is what leads `normal`.

This is a real consequence of choosing per-tier metrics rather than a defect,
but it is the kind of thing that looks like a defect later. The alternative —
one intelligence frontier for all three tiers — would make `mimo` lead
`normal`, at the price of ranking the value tiers by a metric they do not
sort on.

### Dominated models need no special handling, and that is provable

The intuition is that a dominated model must be explicitly demoted so it never
outranks the model beating it. It does not:

> If X dominates Y then `I_X ≥ I_Y` and `C_X ≤ C_Y`, with at least one strict.
> Capability order puts X first by definition. Value order puts X first too,
> since `I_X/C_X ≥ I_Y/C_Y` — the numerator is no smaller and the denominator
> no larger.

Checked exhaustively against the catalog: **1762 dominating pairs, zero
violations under either sort key.** So a dominated model stays in the list as
fallback depth and simply never appears ahead of its dominator. Nothing is
excluded, and the earlier draft's explicit demote pass is deleted — it was not
merely redundant, it introduced an inversion, ranking `luna@high` (32.1) above
`terra@high` (34.2) inside a capability-ordered tier.

**Only the tail cut in step 2 is demoted explicitly**, to the end of each list,
because a capability sort would otherwise lead `complex` with exactly the rung
the gate rejected. It is demoted rather than dropped, for the reason
`avoid_gateways` demotes: avoiding something should cost preference, not depth.

### Worked example: a real config

Seven families, 25 costed effort variants: `luna`, `terra`, `sol`, `astra`,
`mimo-v2.6-pro`, `glm-5.3-flash`, `deepseek-v4.1-flash`.

```
agentic frontier    luna@low → luna@medium → luna@high → luna@xhigh
                    → mimo → glm-5.3-flash → astra@max
  knee              glm-5.3-flash   ($0.2533, agentic 50.9)
  gate cuts         astra@max       (glm → astra@max is 0.1/decade)

intelligence frontier  luna@low → luna@medium → luna@high → luna@xhigh
                       → mimo → astra@medium → astra@high → astra@xhigh
                       → astra@max
  knee                 mimo         ($0.1332, intelligence 46.3)
  gate cuts            astra@max    (+0.3 for 41% more = 2.0/decade)

simple    luna@low → luna@medium → luna@none → luna@high → luna@xhigh
normal    glm-5.3-flash → luna@low → luna@medium → luna@none → luna@high → …
complex   astra@xhigh → astra@high → astra@medium → sol@max → mimo
          → astra@low → sol@xhigh → …
```

Three distinct leads — cheap, balanced, strong — where the previous rules gave
`simple` and `normal` the same one.

`astra@max` is cut by the gate on **both** axes, for different reasons: on
intelligence it buys +0.3 for 41% more, and on agentic it buys +0.1 for 12.9x
more. That a single rung is independently rejected by two metrics is the
clearest evidence the gate is measuring something real.

The other finding is about `terra`: `luna@max` (agentic 42.1, $0.1783) beats
`terra@high` (36.7, $0.3379) on both axes, and `terra@none`, `terra@low` and
`terra@medium` are dominated likewise. **Four of terra's six rungs are dead
weight**, while the saved config ranks terra above luna in `complex` on the
assumption that terra is the stronger family.

### Why the frontier, and why not a ratio

`intelligence / cost` is a *scalarisation*: it asserts one exchange rate
everywhere. It does land on the frontier — if B dominates A then
`ratio(B) >= ratio(A)` — but always at its cheapest end, because a cost
spanning 332x swamps capability. Measured: **`mimo-v2-6-pro` is the knee of the
frontier and ranks 12th of 129 by `I/C`.** Ranking by value structurally
buries the knee, because `I/C` is maximised exactly where cheapness stops
paying. That is why a model on the frontier was never being selected, and it
is why `I/C` is the wrong sort key for `complex` specifically.

The defect is not the cost axis. `I/C` is already logarithmic in both:
maximising it is maximising `log I - log C`. The error is treating
**intelligence** multiplicatively. AA's Intelligence Index is an index on a
bounded scale — 21 to 46.3 is not "2.2x smarter", differences in index points
are meaningful and ratios are not — while cost is genuine ratio scale.
`ΔI / Δlog C` matches the nature of each axis; `I/C` does not. This is why the
*gate* uses the marginal form and the *value tiers* keep the ratio: within the
cheap end an exchange rate is a reasonable approximation, and across the whole
range it is not.

### What this replaces

`COMPLEX_COST_BAND`, added 2026-09-22 and the source of two defects in a day,
is **deleted**. It credited a rung with its family's best score, and that
credit leaked across families: `sol@high` (really 42.3) was compared as 47.0
and beat `mimo` at 46.3 despite costing more. On one real config it put **five
strictly dominated candidates above mimo**. The frontier makes that
unrepresentable, and the proof above means it needs no machinery to enforce.

### Degradation

- No catalog: the built-in table, as today.
- Stale catalog: still ranks; `doctor` reports the age.
- A model the catalog does not score: cannot be ranked, so it goes last as a
  fallback rather than vanishing.
- **Fewer than three frontier points**: no knee is computed. `normal` falls
  back to plain value order and `complex` to plain capability order over
  everything. Kneedle needs a chord to measure against, and two points *are*
  the chord, so every point sits on it.
- **A zero cost per task** is treated as unscored rather than as free. Six
  models in the catalog report `0`, which makes `I/C` infinite and would put
  a model scoring 3.8 ahead of everything. Missing data is the likelier
  reading than genuinely free inference.
- The resolver reads the catalog **once per tenant load**, not per request.

### The honest costs

- The request path gains a catalog dependency. It is a cached read, but it is
  new coupling on the path where failure means a dead agent.
- A ranking can change with no edit to any file, after a `catalog update`. The
  ledger records which candidate served each request, so it stays auditable
  after the fact, but there is no diff to point at beforehand.
- The `1/3` in step 2 is the one tuned constant in the design. It is anchored
  to the median so it moves with the data, but the fraction itself is a
  judgement. Measured sensitivity on the 2026-09-22 catalog:

  | fraction | bar | cut |
  |---|---|---|
  | 1/8 | 1.5 | nothing |
  | 1/6 | 2.0 | fable@xhigh, fable@max |
  | **1/4 – 1** | **3.0 – 11.9** | **astra@max, fable@xhigh, fable@max** |

  So `1/3` sits in the middle of a wide plateau rather than on a knife edge —
  but the plateau exists only because this catalog has a **gap** in its slope
  distribution, from 2.0 straight to 11.9, with nothing between. A future
  catalog whose top rungs return middling value would have no such gap, and
  the fraction would start to matter. That is a property of the data, not of
  the design, and it is the thing to re-measure rather than assume. (Note 1/6
  lands at 1.98 and misses `astra@max` at 2.0 by two hundredths, which is the
  kind of edge this table exists to expose.)

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

**The wasteful-tail gate is the only part of the ranking with a tuned
number.** Everything else is derived: dominance is scale-free, the knee is
computed from the frontier's own shape, and neither needs a constant. The
`1/3` does, and the sensitivity table above shows it currently sits on a wide
plateau *because this catalog happens to have a gap in its slope
distribution*. If a future catalog fills that gap the fraction starts to
matter, and the symptom would be the top of `complex` moving between catalog
refreshes for no visible reason. The check is to re-run the sensitivity table
after a refresh, not to trust the plateau.

**Deriving the ranking makes `complex`'s lead a moving target.** Today the
ledger records which candidate served each request, so it is auditable after
the fact — but a user who has budgeted around `complex` leading with a $1.40
model can have it lead with a $3.26 one after a `catalog update` they did not
think of as a config change. `[budget] daily_usd` bounds the damage and
`sonata agents` shows the current order, but there is deliberately no
notification, and a "your ranking changed" report is the obvious follow-up if
this bites.
