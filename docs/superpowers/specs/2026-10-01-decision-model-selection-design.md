# Auto-route: any decision URL, best available model

**Status:** designed, not implemented.
**Date:** 2026-10-01
**Ships in:** 0.15.1 (maintainer's call; the repo's rule would read it as a minor).
**Amends:** `2026-09-30-jev-auto-route-design.md`. That spec's classifier,
policy, decision store and records are unchanged; this replaces how the
decision endpoint and model are chosen.

## The decision

`[auto_route]` takes one `base_url`. Sonata asks that URL which decision
models it serves, scores each against **JevBench**, and uses the best one —
highest capability score, with cost only breaking a tie. Unscored models are
never chosen over scored ones. Pinning a `model` skips the selection.

```toml
[auto_route]
classifier = "jev"
base_url = "https://openrouter.ai/api"   # any URL; default "https://api.typesafe.ai"
# model = "typesafe/jev-1.13"            # optional pin; skips selection
min_confidence = 0.5
```

The unreleased `provider` key (commit `8941b6f`) is removed: `base_url`
subsumes it.

## Why

Decision models are no longer one vendor's product. OpenRouter lists eight
(`/api/v1/models?output_modalities=decisions`, measured 2026-10-01): Jev,
kev, tev1, solar-decide, span-01 and free tiers. Open models run locally
behind `jev-compatible-server`, which speaks Jev's own API. The user's goal
is to point sonata at one URL and have it use the best model there, so model
choice must follow evidence rather than a hardcoded id.

JevBench (Benchmark Heaven) is the ranking source: independent of the model
makers, part of its 1,624 decisions sealed, and scored for calibration as
well as accuracy. DecisionBench was considered and rejected as the source:
its maintainer also makes its top models, and the two benchmarks disagree
sharply on exactly those (`bosun-v3.1-0.6b`: DecisionBench #2 at 81%,
JevBench #73 of 106).

## Endpoint and key

- Decisions go to `<base_url>/v1/systemone`. Verified 2026-10-01: TypeSafe
  (`https://api.typesafe.ai`), OpenRouter (`https://openrouter.ai/api` —
  answers 401 there without a key, 404 on an unknown path) and
  `jev-compatible-server` (`http://localhost:8000`) all serve that path with
  the same request and response.
- `base_url` is any `http`/`https` URL; a trailing `/` is ignored. Absent
  means `https://api.typesafe.ai`, so a 0.15.0 config behaves unchanged.
- The key is chosen by host: `openrouter.ai` → the `openrouter` gateway's key
  (sonata's store, then opencode's, as the gateway resolves it);
  `api.typesafe.ai` → `sonata auth add typesafe`; any other host → the key
  stored as `sonata auth add auto-route` if there is one, else no
  `Authorization` header (a local server needs none). Keys are read per call
  and never logged.

## Discovering models

- `GET <base_url>/v1/models`, two accepted shapes:
  - TypeSafe: `{ "models": [ … ] }`; each entry's `id` (or `name`) is a model.
  - OpenRouter: `{ "data": [ … ] }`; only entries whose
    `architecture.output_modalities` includes `"decisions"` count, and each
    carries `pricing.prompt` (USD per input token).
- Anything else — a 404, an error, an unrecognised shape, a timeout (3 s) —
  means "no list": the URL's default is used (below). `jev-compatible-server`
  has no list endpoint and serves the one model it was started with.
- Lists are cached in memory per URL for one hour; a failed fetch is retried
  on the next decision after 5 minutes, not every request.

## Ranking data

- `sonata catalog update` additionally fetches
  `https://benchmarkheaven.com/api/jevbench/<revision>` and caches, per
  system: its key, display name, **capability** (the mean of its
  intelligence and calibration scores) and its estimated USD per 1,000
  decisions. Cache: `~/.config/sonata/decision-catalog.json`, with the
  benchmark revision and fetch time.
- The revision is pinned (`v1.5.4`) in `JEVBENCH_URL`: the site publishes no
  latest-revision index (its root serves an older v1 document), so a new
  revision is adopted by changing the constant. The published `source_sha256`
  is recorded for traceability.
- JevBench data is not committed to the repository; tests use a hand-built
  fixture, as for the AA catalog.
- `sonata doctor` reports the decision catalog's age and revision beside the
  AA catalog's, and says when it is absent.

## Matching ids to scores

Exact match only, after normalising both sides — never a guess (the AA
rule): lower-case; drop a leading `vendor/` and a leading `~`; drop a
`:variant` suffix (`:free`); treat a version written with or without a
trailing `.0` as equal (`jev-1.13` ≡ `jev-1.13.0`). A JevBench system is
matched by its `key`, then by the last path segment of its `repo`. An alias
such as `~typesafe/jev-latest` matches nothing, so the pinned release it
points at is the one that gets ranked.

## Choosing the model

1. `model` set → use it. No discovery, no ranking.
2. Otherwise rank the URL's listed decision models by capability, highest
   first. On an exact tie the lower listed price wins (free lowest; unlisted
   price after listed).
3. Unscored models rank after every scored one, in listed order — an unknown
   score is not a good score.
4. No list, or nothing scored → the URL's default: no `model` field for
   TypeSafe and other hosts (the server's default), `~typesafe/jev-latest`
   for `openrouter.ai`, which requires a model.

On OpenRouter on 2026-10-01 this picks `typesafe/jev-1.13` (capability 80.0;
`kev-4b` is the only other scored model there).

## Cost

Per decision, in USD: the response's `usage.cost` when present (OpenRouter
reports it); otherwise **$0** when the URL's host is loopback (`localhost`,
`127.0.0.0/8`, `::1`) — a local model is free, not unpriced; otherwise
unpriced. Recorded as `autoRoute.costUsd` and summed by `sonata usage`
beside, never into, the priced total, as already built.

## Visibility

- The ledger already records the answering model (`autoRoute.classifierModel`).
- `sonata doctor`, when `[auto_route]` is set: the URL, the key it needs and
  whether one is stored, the chosen model with its score, and the runner-up —
  or why nothing was ranked. Doctor may make the one `GET /v1/models` call
  (a list is free); it never makes a decision call.

## Configuration rules

- `parseConfig` refuses unknown keys, a `base_url` that is not an absolute
  `http(s)` URL, and an empty `model`; `provider` is no longer accepted.
- `nativeTomlFor` writes `base_url` and `model` back only when set, so a
  0.15.0 file round-trips unchanged.

## Testing

No network in the suite. Fixtures: a TypeSafe-shaped list, an
OpenRouter-shaped list (decision and non-decision entries), a small
hand-built JevBench JSON. Cases: endpoint and key per host; both list
shapes; a failed list falls back to the default; matching (prefix, `:free`,
`.0`, alias unmatched, no fuzzy match); selection (highest capability,
price tie-break, unscored after scored, nothing scored → default, pinned
`model` skips all of it); loopback cost $0, reported cost used, otherwise
unpriced; config refusal and round trip; doctor output.

## Out of scope

- DecisionBench as a second source; a quality-versus-price margin; falling
  back from one URL to another; ranking aliases; asking a model's own
  self-reported quality.

## Open questions

- Real `usage` and latency from OpenRouter's decision endpoint are unmeasured
  until the account has credit.
- Whether JevBench keeps its JSON URL stable across revisions.

## Setup TUI step (added 2026-10-01)

Auto-routing could only be configured by hand, and its key only with
`sonata auth add` in a terminal. Setup (`sonata init`, or the shell's
**Setup**) gains an **Auto-route** step, after the tier rankings and before
the summary.

1. **"Auto-route subagent tiers?"** — a choice: **Off**, **TypeSafe**
   (`https://api.typesafe.ai`), **OpenRouter** (`https://openrouter.ai/api`),
   **Custom URL…**. Opens on the saved `base_url` (or Off when there is no
   `[auto_route]`). Left goes back to the last tier screen.
2. **Custom URL…** → a text field for the URL, validated as an absolute
   `http(s)` URL — the same rule as `parseConfig`.
3. **Key** — a masked field ("stored in sonata's key store, not shown
   again"), the same component provider keys use:
   - TypeSafe → shown when no `typesafe` key is stored; required.
   - OpenRouter → shown only when the `openrouter` gateway resolves no key
     (a provider key added in this run counts); required.
   - Custom URL → shown when the host is not loopback and no `auto-route`
     key is stored; **optional** — an empty submission means no key.
4. **No model screen.** The best model is chosen automatically at decision
   time (the selection above); pinning one stays a hand edit of `model`.
   The summary says which URL and that selection is automatic.

**State and writes.** `InitState` gains `autoRoute?: { baseUrl: string } |
null` (`null` = turned off this run; absent = untouched) and
`decisionKey?: { gateway: 'typesafe' | 'openrouter' | 'auto-route'; key:
string }` — kept apart from `byokKeys`, which the provider pipeline reads as
gateways to build. `plan()` writes `[auto_route]` from the state: absent →
the saved table unchanged; `null` → no table; set → `classifier = "jev"`,
the chosen `base_url`, the saved `model` only when the URL is unchanged, the
saved `min_confidence` or 0.5. The decision key joins `keysToStore` and is
written after the confirm gate, like provider keys — a cancelled wizard
leaves nothing. The guidance block's auto-route flag follows the same state.
The scripted (`--yes`) path is unchanged: it keeps whatever `[auto_route]`
the file has.

**Keys screen.** When `[auto_route]` is set, the shell's read-only Keys
screen adds one row for the decision key (`auto-route → <host>`) with its
source, or "no key" when one is required and missing.

**Tests.** The step's state transitions (each choice; custom URL validation;
key shown/skipped per host and stored key; optional empty key for custom);
`plan()` writing each case (absent, null, set, model kept only for the same
URL) and round-tripping through `parseConfig`; the decision key in
`keysToStore` only after confirm; the Keys-screen row.
