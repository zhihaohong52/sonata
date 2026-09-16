# Three tiers: simple, normal, complex

**Status:** approved design, not yet implemented
**Date:** 2026-09-16

## The decision

A role's `[tiers]` gains a third list. Each tier is **one pure sort key** over
the two quantities Artificial Analysis publishes — a coding index and a cost
per task — plus one gate on the cheapest tier:

```
simple  : value descending, capped at SIMPLE_COST_CEILING x the best-value model's $/task
normal  : value descending, uncapped
complex : capability descending, uncapped
```

where *value* is `codingIndex / costPerTask`: capability per dollar of work.

`normal` is **optional**. A config without it is valid, unchanged in behaviour,
and needs no migration — see *Compatibility*.

## Why three

Two quantities admit exactly three orderings — by cost, by value, by
capability — and sonata currently expresses two of them. `simple` is
value-ranked under a cost gate and `complex` is capability-ranked, so the
question a dispatcher cannot currently ask is "give me the best value, without
a price cap".

The three diverge on any config holding more than one model family. Measured on
a synthetic mixed set:

```
simple  : glm-flash      ($0.09)      cheapest under the cap
normal  : luna-high      (best idx/$) 31% more capable for 22% more money
complex : terra-max      (idx 77)     most capable
```

## What the measurements showed, including against this design

Every number below is from the live AA catalog on 2026-09-16, over the eleven
costed luna/terra effort variants in this machine's config.

**Cost varies far more than capability.** Across one family's effort levels the
index spans 1.7x (44.2 to 76.7) while cost spans 140x ($0.010 to $1.399). Every
result here follows from that asymmetry.

**Value ranking inverts capability ranking.** Ranked by `idx/$`, the *weakest*
candidate leads and the most capable comes last:

```
value      : luna-low(44.2) > luna-medium > luna-high > luna-xhigh > ... > terra-max(76.7)
capability : terra-max(76.7) > luna-max > terra-xhigh > ... > luna-low(44.2)
```

This is why `complex` keeps a capability sort rather than adopting the ratio:
the two are near-reverses, and a tier that exists to be capable cannot rank by a
metric that puts its weakest member first.

**A capability floor collapses value into cheapness.** With a floor at 75% of
the best model, `simple` (cheapest-first) and `normal` (value-first) produced
*byte-identical* lists — not merely the same head. Once a floor bounds
capability from below and the best model bounds it above, the index term is
nearly constant and the ratio is dominated by its denominator. **Flooring the
value tier turns it into the cheap tier**, which is why this design has no
capability floor and retires `SIMPLE_CAPABILITY_FLOOR`.

**A ceiling below 100% of its own anchor empties the tier.** Anchoring
`simple`'s cap to a *fraction* of the best-value model's cost excludes that
model by construction. At 10%, `simple` was empty. The ceiling is therefore a
multiplier at or above 1.

**The anchor is what makes the tier non-empty.** At >= 100% the best-value model
always clears its own cap, so `simple` can never be empty on any config and
needs no fallback rule. Depth on this machine's config:

| ceiling | cap | admitted |
|---|---|---|
| 100% | $0.010 | 1 of 11 |
| 200% | $0.020 | 2 |
| 600% | $0.059 | 3 |
| **1200%** | $0.118 | **4** |
| 4000% | $0.392 | 9 |

`SIMPLE_COST_CEILING` stays at **12** so this change alters *which quantity* the
cap is anchored to without also changing how deep the cheap tier has been in
practice. If the depth proves wrong it is one constant to move, against a
ranking change already proven separately.

## Known degeneracy, accepted deliberately

`simple` and `normal` share a sort key, so `simple` is a **bounded-cost prefix
of `normal`**: same first candidate, same order, fewer entries. They differ only
in how deep the fallback chain may reach and how much a single request may cost.

On a config made of effort variants of one family — which is exactly this
machine's — the two tiers therefore agree on every dispatch. That is a property
of the config, not of the design, and it resolves the moment a second model
family is present. It is recorded here because the alternative, a capability
floor on `simple`, was measured and rejected: it makes the tiers differ by
making `normal` lead with a model `simple` rejected as too weak, which is
incoherent rather than merely degenerate.

## Config surface

```toml
[tiers.code]
simple  = ["luna@low", "luna@medium"]
normal  = ["luna@low", "luna@medium", "luna@high", "terra@low"]   # optional
complex = ["terra@max", "luna@max", "terra@xhigh"]
```

- `normal` is optional; `simple` and `complex` stay required.
- Present-but-empty or non-string `normal` is refused at parse time, the same as
  the other two. Absent and empty are different states and only one is valid.
- `nativeTomlFor` **must emit `normal`**. `sonata init` is the sole writer of
  the whole file, so a key it reads and does not write back is deleted on the
  next run — the failure that silently un-priced gateways. A round-trip test
  through `parseConfig` is required, not a test asserting on emitted text.

## Alias grammar and resolution

- `sonata-<role>-normal` joins the existing suffixes; `TIER_NAMES` gains
  `'normal'`.
- `resolveTierAlias` returns `undefined` for a `-normal` alias on a role that
  has no `normal` list. It does **not** fall back to another tier: silently
  serving a different ranking than the alias names is the class of failure this
  repository has been bitten by repeatedly.
- `tiersCollapse` compares every list a role actually has. An unsuffixed
  `sonata-<role>` alias stays valid only when all present lists are
  element-wise identical, so it still cannot hide a tier choice.

## Agent generation

- One agent per role x present tier: 8 today, up to **12**.
- A role whose lists all collapse still generates one agent, as now.
- The `description` must state the three-way choice in terms a dispatching model
  can act on, since a mis-selection is silent. Draft:
  *simple* = mechanical, contained work where cost matters most;
  *normal* = the default, best capability per dollar;
  *complex* = cross-cutting, design-sensitive work needing the most capable
  model. **When unsure, use `-complex`** stays, and `-normal` is named the
  default so three options do not read as three equals.
- Both existing warnings ride on every generated agent unchanged: no `model`
  argument, and fan out only to sonata tier agents.

## Wizard, editor, doctor

- `proposeTiers` returns `{ simple, normal, complex }`. `simple` and `normal`
  share a sort; only the cap differs.
- Ranking screens go from 8 to 12 (4 roles x 3 tiers). `acceptRemainingTiers`
  and `seededRankingFor` already exist for exactly this pressure and must cover
  the third tier — including the `tierPickerKeys` hazard, where `RankedSelect`
  drops a seeded value missing from its rows.
- `sonata agents` lists role x tier, so it gains a third row per role. Its
  round-trip guard must be extended: a tier containing a hand-added uncosted key
  must survive a no-op edit byte-identically.
- `sonata doctor` reports a config carrying no `normal` as information, never a
  warning — it is a valid config, and saying otherwise would nag every install
  that predates this.

## Tier selection: the hard part

Three tiers are worth nothing if the dispatching model picks one of them for
everything. Measured on this machine's ledger over 30 days, it already does:

| tier | requests | share | priced spend |
|---|---|---|---|
| complex | 12,448 | 74% | $260.39 (80%) |
| simple | 4,271 | 26% | $64.56 |

**The cause is a sentence sonata writes itself.** Every generated
`description` ends "When unsure, use `-complex`", which instructs a model that
is already loss-averse about under-powering a task to default upward. Adding a
middle rung under that instruction produces a tier nothing selects.

**Why that instruction was right, and no longer is.** Defaulting up is rational
when escalation is expensive — a too-weak model burns a whole run and the
caller has to notice and retry. But the `sonata-loop` skill already gates every
task behind a review and re-runs at a higher tier on repeated failure, so
escalation is automatic and bounded. Once recovery is cheap, defaulting up
stops buying safety and only buys spend. **The default becomes `-normal`, and
the descriptions say why starting lower is safe: a task that fails review is
re-run a rung up.**

**Adjectives do not discriminate; tests do.** The current wording — mechanical,
cross-cutting, design-sensitive, ambiguous — are judgement calls, and a
loss-averse reader resolves every one of them upward. Each tier therefore gets
an *observable* criterion the model can actually evaluate against the task in
front of it:

- **simple** — the task is specified closely enough that the diff could be
  written without asking a question. Typically one or two files, no interface
  change. *Rename this symbol across the repo. Add the missing null check.
  Port these twelve call sites to the new helper.*
- **normal** — you know what to change but not exactly how; it requires reading
  the surrounding code to fit in, and may touch several files, but the shape of
  "done" is not in question. **This is the default.** *Add a flag to this
  command and test it. Fix this failing test. Extract this duplicated logic.*
- **complex** — the task requires a design decision that affects other
  components, or is ambiguous about what "done" means, so the first job is
  deciding what to build. *Design the retry semantics. This is slow and I don't
  know why. Restructure how X and Y communicate.*

The distinction to state plainly is **size is not difficulty**. A large
mechanical change is `simple`; a three-line change that decides an interface is
`complex`. Reading the current adjectives, a model maps "many files" onto
"cross-cutting" and escalates, which is exactly backwards.

**Verification is a measurement, not a review.** The ledger records the alias
per request, so `sonata usage --by tier` gives the distribution before and
after. The success criterion is that `normal` carries a real share and
`complex`'s share falls — not that the wording reads well. If the split is
unchanged a month after shipping, the descriptions failed and the next lever is
structural (for example, resolving the unsuffixed `sonata-<role>` alias to
`normal` so the lazy path is the middle one).

## Documentation and prompt surfaces

Two of these are behaviour rather than prose, and are listed first because
shipping the code without them leaves a third tier nothing dispatches to.

**`skills/loop/SKILL.md` — the escalation ladder is a rung longer.** The
`sonata-loop` skill currently routes a task to `simple` or `complex` and
re-runs at `complex` after two failed reviews at `simple`. With a middle rung
that becomes `simple -> normal -> complex`, and the rule needs restating: how
many failures escalate, and whether the final review gate stays at
`review-complex` (it should — a gate exists to be strict). This is the one
surface where a stale document silently changes what runs.

**`src/init/guidance.ts` — the managed `CLAUDE.md` block.** The only text a
routed session reads unconditionally, and the place the tier choice is
actually explained to the caller. It must name three tiers, say `-normal` is
the default, and keep both existing rules (no `model` argument; fan out only
to tier agents).

**Generated agent descriptions (`src/commands/sync.ts`).** Covered under *Agent
generation* above. Restated here because the description *is* a prompt: it is
what the dispatching model reads while choosing, and a mis-selection among
three is silent.

Prose, in descending order of how wrong it would be left alone:

| File | Tier mentions | What changes |
|---|---|---|
| `CLAUDE.md` | 27 | The tier model, the `[tiers]` example, the ranking paragraph, `TIER_NAMES`, alias grammar, agent counts (8 -> 12) |
| `README.md` | 18 | The front-door explanation of what a tier is and how many agents `init` generates |
| `docs/guide/configuration.md` | 4 | The `[tiers.<role>]` reference, including that `normal` is optional |
| `docs/HANDOFF.md` | 8 | Current state; the tier set a new session is told to assume |
| `docs/guide/limitations.md` | 2 | Wherever the two-tier split is named as a constraint |
| `CHANGELOG.md` | — | An `## [Unreleased]` entry |

`docs/roadmap.md` has no tier mentions today; check it at ship time, and update
the claude.ai Artifact it mirrors if it gains one.

**Not edited by hand:** `.claude/agents/*.md` and `.claude/skills/sonata-loop/`
are generated. They change by running `sonata sync` after the code lands, and a
stale generated agent on a developer's machine is the expected state until they
do.

**Also mine, not the repo's:** the session memory notes that name the tier set
(`sonata-default-subagent-lane`, `sonata-never-override-tier-agent-model`) need
the third tier, or they will keep teaching two.

## Compatibility

**No `schema_version` bump and no migration.** Making `normal` optional means an
existing config parses unchanged, generates the same 8 agents, and routes
identically. A user gains the third tier by re-running `sonata init`, or by
adding the list by hand.

This is deliberately smaller than the alternative considered — bumping the
schema and seeding `normal` from `complex` or from a fresh proposal. Seeding
changes behaviour on upgrade without asking, and a fresh proposal additionally
needs an AA catalog that may be absent or stale at migration time. Sonata's
migrations are in-memory and its config is user-owned; "you get the new tier
when you next ask for it" is the honest default.

## Testing

- `proposeTiers` returns three lists; `simple` is a prefix of `normal` on a
  homogeneous fixture and diverges from it on a mixed one. Both cases are
  asserted, since the prefix property is the accepted degeneracy and the
  divergence is the feature.
- The ceiling admits its own anchor at 12x, and `simple` is non-empty for every
  fixture including an all-expensive one.
- A config with no `normal` parses, syncs 8 agents, and resolves every existing
  alias; `sonata-<role>-normal` resolves to `undefined` on it.
- Round-trip: a config *with* `normal` survives `nativeTomlFor` -> `parseConfig`
  unchanged, and a no-op `sonata agents` edit writes byte-identical TOML.
- Every assertion is mutation-checked: deleting the feature must fail the test.
- A documentation check: no shipped prose describes the tier set as exactly two.
  Cheap to assert badly (a grep for "simple" matches everything), so this is a
  review-time checklist item rather than a test.

## Rejected alternatives

- **Keep two tiers, rank both by value.** Deletes the capability objective
  entirely; `complex` would lead with the weakest model. Measured above.
- **Capability floor on `simple` only.** Produces three distinct heads, but
  `normal` then leads with a model `simple` excluded as unworkable.
- **Capability floor on both cheap tiers.** Produces byte-identical lists;
  `normal` becomes `simple` with a longer tail.
- **Ceiling as a fraction (<100%) of any anchor.** Empties the tier.
- **Anchoring the ceiling to the cheapest, or to the most capable, model.** Both
  work, but the best-value model is the anchor that guarantees `simple` and
  `normal` agree at the head by construction rather than by luck.
