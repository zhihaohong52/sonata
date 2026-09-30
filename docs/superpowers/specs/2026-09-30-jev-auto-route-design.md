# Auto-routed tiers: Jev chooses simple, normal or complex

**Status:** designed, not implemented.
**Date:** 2026-09-30
**Ships in:** the next minor (it adds a config key and changes routing).

## The decision

Add a `<role>-auto` agent per role (alias `sonata-<role>-auto`). On the first
request of a conversation for that alias, sonata's router asks TypeSafe's
System One model **Jev** one Choice question — which of this role's tiers
(`simple` / `normal` / `complex`) the task needs — and then routes the whole
conversation exactly as if the caller had picked that tier. The explicit
`-simple` / `-normal` / `-complex` agents stay.

The feature is **opt-in** (`[auto_route]` in `sonata.toml`), **fail-open**
(any failure → the fallback tier, never an error), and **decided once per
conversation** (never re-decided mid-conversation).

## Why

Tier *selection* is sonata's weakest routing decision. Over 30 days of one
machine's ledger, `complex` took 74% of tiered requests and 80% of priced
spend, because the dispatching model picks a tier from a description, and a
model unsure of itself picks upward (`docs/internals/architecture.md`). The
wording fix in the generated descriptions was the first lever; CLAUDE.md names
the next one as structural — resolving an unsuffixed alias automatically.
A purpose-built classifier is that structural fix.

[jev-router](https://github.com/gargpratyush/jev-router) (MIT) shows the
pattern working for Claude Code's own model choice: one Jev call per fresh
turn, fail-open, pinned for the tool loop. Sonata applies it to the choice it
already struggles with — the subagent tier — and keeps its own ranking,
fallback and pricing downstream of the decision.

## Scope

**In:** subagent tiers, per role; Jev as the only classifier; the router as
the only place the decision is made.

**Out:** routing the main Claude Code session between Claude models (that is
jev-router's own product); choosing exact models (Jev picks a *tier*, sonata's
ranked candidates pick the model); a local-model classifier (the classifier
sits behind a small interface so one can be added later); confidence
thresholds per tier; the three complexity Score questions jev-router also
asks.

## Configuration

```toml
[auto_route]
classifier = "jev"      # the only accepted value; an absent section = off
min_confidence = 0.5    # below this, the fallback tier is used
```

- `parseConfig` refuses an unknown `classifier`, an unknown key in
  `[auto_route]`, and a `min_confidence` that is not a number in `[0, 1]`. A
  switch that silently does nothing reads exactly like one that works.
- Absent `min_confidence` means `0.5`.
- `nativeTomlFor` writes `[auto_route]` back out, with a round-trip test
  through `parseConfig` (the "init deletes what it does not write back" rule).
- `[auto_route]` is read per tenant (the project's own config), so projects
  opt in independently. The TypeSafe key is machine-wide: `sonata auth add
  typesafe`, stored like the Artificial Analysis key, never in argv, never
  logged, sent only in the `Authorization` header.

## Agents

With `[auto_route]` set, `sonata sync` generates one `<role>-auto` agent per
role whose tiers are **not** collapsed (`tiersCollapse`): a collapsed role has
nothing to choose. Its frontmatter model is `sonata-<role>-auto` (with `[1m]`
when every tier of the role qualifies for extended context, the same rule the
tier agents follow). Its description states that sonata chooses the tier and
that the explicit tier agents remain for when the caller knows better.

- The routing matcher `^(native-)?(code|review|explore|plan)(-|$)` already
  matches `code-auto`; a test pins that.
- `resolveTierAlias` does **not** learn `-auto`. The auto branch runs before
  it and hands it an explicit alias, so every existing caller keeps its
  current contract.
- The managed CLAUDE.md guidance block, when `[auto_route]` is set, makes
  `-auto` the default and keeps the tier agents as the manual override.
  Without `[auto_route]` the block is unchanged.
- `sonata agents` lists `-auto` agents and marks them as auto-routed; they
  have no ranking of their own to edit.

## The Jev call

**When.** Only when the requested model is `sonata-<role>-auto` and no
decision is stored for the request's `conversationKey` (the hash of the first
message, tenant and alias that already keeps a conversation on one
candidate). Later turns and tool-loop continuations make no call.

**Endpoint.** `POST https://api.typesafe.ai/v1/systemone` with
`Authorization: Bearer <key>`, called with `fetch` — no SDK dependency. The
request is the SDK's wire shape: `state` plus one `choice` question.

**State.**

```json
{ "role": "code", "task": "<cleaned first user message>" }
```

Cleaning, before anything leaves the machine:

1. Take the first `user` message only.
2. Keep text blocks only — no images, tool results, system prompt or tool
   definitions.
3. Remove every `<system-reminder>…</system-reminder>` span; that is where
   Claude Code injects CLAUDE.md, memory and other context.
4. Trim, and cap at 8,000 characters, keeping the start.

An empty result (nothing but reminders) is not sent; it takes the fallback
with outcome `failed`.

**Question.** One Choice named `tier`, whose options are the tiers the role
actually has, in order. Each option's criteria reuse the wording of the
generated agent descriptions, so Jev and a dispatching model judge by the
same definitions:

| Option | What | Not for |
|---|---|---|
| `simple` | Specified closely enough that the change could be written without asking a question; typically one or two files and no interface change. A large mechanical change is simple. | Work that needs a design decision or reading around to fit in. |
| `normal` | You know what to change but not exactly how; needs reading the surrounding code; may touch several files; "done" is not in question. | Open design choices, or an ambiguous definition of done. |
| `complex` | Needs a design decision affecting other components, or is ambiguous about what "done" means, so the first job is deciding what to build. A three-line change that decides an interface is complex. | Routine work with a clear implementation, however large. |

The instruction is: pick the cheapest tier that can complete the task in one
pass without being re-run at a higher tier; size is not difficulty.

**Answer.** Per TypeSafe's Choice docs: `choice` is the highest-probability
option, `probabilities` sum to 1, and `confidence` (0–1) summarises how
concentrated the distribution is (0 for an even split). The response's
top-level `model` (e.g. `jev-1.13.0`) is the classifier's version.

**Timeouts.** 1.5 s per attempt, one retry, 3 s overall deadline (jev-router
measured ~300 ms warm, ~1 s cold).

## Policy

```
confidence ≥ min_confidence and choice is an offered tier  → choice   (accepted)
confidence <  min_confidence                               → fallback (low-confidence)
choice not an offered tier / malformed body                → fallback (invalid)
no key, network error, non-2xx, timeout, empty task        → fallback (failed)
```

The **fallback tier** is `normal`, or the next tier up when the role has no
`normal` (`complex`). It is the tier callers are already told to default to,
so an unsure or unavailable Jev never does worse than today. A failure is
logged once per conversation with its reason and never with the task text.

The decision becomes an explicit alias (`simple` → `sonata-code-simple`) and
continues through the existing tier path unchanged: ranked candidates,
cooldowns, conversation stickiness, `avoid_gateways`, `[budget]`, and the 529
exhaustion message naming `sonata dispatch --tier code-simple`.

## Decision store

A map from `conversationKey` to the decision, bounded like the sticky map
(`STICKY_MAX_CONVERSATIONS`, `STICKY_TTL_MS`: 1,000 conversations, 2 h, oldest
touched evicted first). Concurrent first requests for the same key share one
in-flight call. If a decision is evicted mid-conversation, the next turn asks
again with the same first message, which almost always gives the same tier;
if it changes, `stripForeignThinking` already keeps the transcript valid, at
the cost of one prompt-cache rebuild.

## Classifier interface

```ts
interface TierClassifier {
  classify(input: { role: string; task: string; tiers: TierName[] },
           signal: AbortSignal): Promise<ClassifierAnswer>;
}
```

Jev is the only implementation. Policy, store, cleaning and ledger recording
live outside it, so a second classifier needs none of them rewritten.

## Records

**Ledger.** Every row of an auto-routed conversation carries the resolved
`tier` (so `sonata usage --by tier` keeps its meaning) and `route: "auto"`;
rows reached through an explicit tier alias carry `route: "manual"`. The row
of the request that made the decision also carries:

```json
"autoRoute": {
  "classifier": "jev", "classifierModel": "jev-1.13.0",
  "choice": "simple", "confidence": 0.81,
  "probabilities": { "simple": 0.88, "normal": 0.12, "complex": 0.0 },
  "outcome": "accepted", "ms": 312,
  "tokens": { "input": 318, "output": 34 }
}
```

Raw values are stored as received, so any later rule (a different threshold,
a per-tier bar, a target share) can be computed from history without calling
Jev again. The ledger's row validation allow-lists `route` and `autoRoute`;
a round-trip test proves such a row survives `readRows`, since an unexpected
value makes the reader drop the row silently.

**`sonata usage --by route`** groups auto against manual (requests, spend,
tier split). A summary line counts decision outcomes, so the gate's firing
rate is visible.

**Jev's own cost is not priced.** Sonata knows no TypeSafe rate, so
classifier token volume is reported beside the priced total and never folded
in as zero. `[budget] daily_usd` therefore does not bound classifier calls;
the docs say so.

## `sonata doctor`

- `[auto_route]` set, no TypeSafe key → **warn** naming `sonata auth add
  typesafe` (routing still works; it always falls back).
- `[auto_route]` set, `-auto` agents missing → names `sonata sync`.
- No live call: a probe spends tokens.

## Privacy

When enabled, the cleaned first message of every auto-routed subagent task
is sent to TypeSafe. Nothing else is: no system prompt, no tool results, no
later turns, no file contents beyond what the task text itself quotes.
`docs/guide/security.md` and the guide's configuration page state this, and
`[auto_route]` is off unless written.

## Testing

No network in the suite.

- **Cleaning:** reminders removed, non-text blocks dropped, cap applied,
  empty task not sent.
- **Question:** only the role's tiers offered, in order; wording pinned.
- **Policy:** each row of the policy table produces its tier and outcome;
  a role without `normal` falls back to `complex`.
- **Router, against a fake Jev server:** an auto alias reaches the chosen
  tier's candidates; a second turn makes no call; concurrent first requests
  make one; a hanging Jev falls back within the deadline; a 529 names the
  resolved tier; the key is sent only as a bearer header.
- **Config:** accepted and refused forms; round trip through `nativeTomlFor`.
- **Agents:** `-auto` generated only when enabled and only for non-collapsed
  roles; the routing matcher matches `code-auto`; guidance block wording.
- **Ledger:** an `autoRoute` row round-trips through `readRows`;
  `--by route` groups correctly.
- **Live (once a key exists):** capture one real response as a fixture,
  replacing the docs-shaped one, and run one real auto-routed dispatch,
  checking its ledger row.

## Open questions

- Real latency and a real response for sonata-shaped tasks are unmeasured
  until a key is available; the fixture and the 3 s deadline are provisional
  until then.
- TypeSafe pricing is not known to sonata; the per-call cost is reported as
  token volume only.
