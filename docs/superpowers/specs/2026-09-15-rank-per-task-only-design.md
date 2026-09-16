# Rank on dollars per task only

## Decision

`sonata init` offers and ranks a model only when the cached Artificial Analysis
catalog publishes `cost_per_task` for that candidate. This applies to unknown,
new, custom, BYOK, and scored-but-uncosted models alike. The restriction stops
at proposal and offering: `parseConfig`, tier resolution, routing, sync, and
dispatch continue to accept a hand-added model exactly as before.

## Evidence

Artificial Analysis publishes two incompatible price units. `cost_per_task`
is dollars to complete one benchmark task; Sonata's `blendedPriceUsd` is a 3:1
computed dollars-per-token rate. A conversion requires actual token use, so
neither unit can order the other. The prior sort guard stopped cross-unit
arithmetic, but the ranking UI still printed both values in one column.

A live AA measurement found 650 distinct models, 641 scored, and only 141
(22%) with `cost_per_task`; 509 had no task cost and 296 of those still had
per-token pricing. The split tracks recency rather than provider: the median
release for costed models was 2026-06, compared with 2025-09 for uncosted
models. Gemini 3.8 Flash demonstrated the UI failure: `@low` displayed
$1.50/1M beside `@medium` at $0.931/task, despite those values not being
comparable.

## Behaviour

- `proposeTiers` filters to per-task-costed candidates, then keeps the existing
  complex capability and simple capability-per-task-dollar ordering.
- The model picker and ranking screens exclude uncosted candidates and state
  their names, the reason, and the hand-edit escape hatch.
- `sonata doctor` reports configured tier models that would no longer be
  offered; this is advisory because routing remains valid.
- `sonata agents` is intentionally different: its rows retain every value
  already in a tier, including uncosted hand additions. `RankedSelect` drops
  seeds missing from its rows, so filtering there would silently delete a
  model on write. A byte-identical no-op round-trip test protects this.

## Rejected alternatives

1. **Keep uncosted models as an unranked fallback tail.** This still exposes
   incomparable prices in a ranking workflow and makes fallback order appear
   meaningful when no valid cost comparison exists.
2. **Exclude only AA-scored-but-uncosted models, but offer unknown models.** An
   unknown model has no task cost either, so this would preserve an arbitrary
   exception exactly where users are least able to validate it.
