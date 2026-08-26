# Usage and route ledger: measuring what sonata actually did

**Date:** 2026-08-27
**Status:** Approved design, pre-implementation
**Release:** next minor (0.3.0)

## Summary

Cost is the first reason the README gives for using sonata, and sonata cannot
currently measure it. `grep -n "usage\|input_tokens\|output_tokens"
src/native/router.ts` returns nothing: every native request and response
transits `routeRequest`, and the usage block is discarded. The honest answer to
"did this native agent run on the foreign model, or fall back to Claude?" is
still `grep '\-> litellm' ~/.config/sonata/logs/serve-*.log`.

This design adds one append-only ledger written by the router, and three
commands that read it: `sonata usage` (tokens and cost), `sonata status` (live
router state and recent routing decisions), and `sonata runs` (dispatch runs,
over the `listRuns()` that today has only the garbage collector as a consumer).

Scope is roadmap items 01, 02 and 03. Item 04 (budget guardrails) is a
consumer of this ledger and is deliberately deferred: a cap should be built on
numbers that have been looked at for a while first. Item 05 (daemon identity)
shares no code with this and gets its own spec.

## Decisions (from brainstorming, 2026-08-27)

Each of these replaced an assumption that a probe disproved. The probes are
recorded in §8.

1. **Tokens come from the SSE stream tail, not from LiteLLM headers.** LiteLLM
   does emit `x-litellm-response-cost-*` with no database configured, but
   headers are flushed before the body, so on a streaming request no output
   token exists yet and the cost is structurally `0`. Every Claude Code request
   streams.
2. **Cost is computed by sonata from token counts.** Follows from 1.
3. **ai-pricing.fyi is the scraped price source**, cached locally, refreshed
   only on explicit `sonata catalog update`.
4. **A scraped price applies only where the gateway declares which public
   provider it is.** One model carries an 8× price spread across serving
   providers; absent a declaration the answer is `unpriced`, not a guess.
5. **Per-model and per-gateway rate overrides, with optional UTC time
   windows**, because ai-pricing.fyi does not model peak/off-peak pricing and
   silently stores whichever side of a discount its scraper caught.
6. **Requests are attributed per session** via the `x-claude-code-session-id`
   header, which Claude Code sends on every request.
7. **One append-only JSONL log, three views** — rather than separate route and
   usage logs, or SQLite.
8. **Anthropic-bound requests are recorded too**, because without a Claude
   baseline the cost comparison the tool exists to make has nothing to compare
   against.

## 1. The ledger record

One line per completed request, appended by the router to
`~/.config/sonata/usage/YYYY-MM-DD.jsonl`. Global rather than per-project,
because the router is a daemon shared across every project; per-project
reporting comes from a session → project map (§4).

```jsonc
{
  "ts": "2026-08-27T04:12:07.881Z", "ms": 4820,
  "session": "8cc4f5bb-…",
  "alias": "sonata-code-simple",
  "role": "code", "tier": "simple",
  "key": "gpt-5.6-luna",
  "gateway": "codex", "upstream": "litellm",
  "litellm_model": "chatgpt/gpt-5.6-luna", "call_id": "9fbe78c5-…",
  "status": 200,
  "complete": true,
  "tokens": { "input": 1632, "output": 11, "cache_read": 0, "cache_creation": 0 },
  "price": { "total_usd": 0.0021, "source": "ai-pricing", "observed_at": "2026-08-26T15:31:30Z" },
  "attempts": [{ "key": "anexto-gemini-3.7-flash", "status": 403 }],
  "litellm": { "fallbacks": 0, "retries": 0 }
}
```

| Field | Source |
| --- | --- |
| `session` | `x-claude-code-session-id` request header; absent for non-Claude-Code clients |
| `alias`, `role`, `tier` | the requested model; role/tier parsed when it is a `sonata-<role>-<tier>` alias |
| `key`, `gateway`, `attempts` | the router's own tier resolution (`routeTierRequest`) |
| `litellm_model`, `call_id` | `x-litellm-model-name`, `x-litellm-call-id` |
| `litellm.fallbacks/retries` | `x-litellm-attempted-fallbacks`, `x-litellm-attempted-retries` |
| `tokens` | SSE `message_start` (input, cache) merged with the final `message_delta` (output) |
| `price` | §3 |

**Never recorded:** prompt or response text, `metadata.user_id`'s
`account_uuid` or `device_id`. The session id alone is what attribution needs,
and it is already the least identifying of the three.

`price.source` is one of `model` (§3 step 1), `gateway` (step 2),
`ai-pricing` (step 3) or `none` (step 4). The two config steps are
distinguished rather than collapsed to `config`, so a surprising figure can be
traced to the exact table that produced it.

`complete: false` marks a row whose stream ended without a final usage frame —
a client disconnect, or an upstream dying mid-stream. Such a row is written
anyway. Dropping it would make the ledger under-count precisely when things go
wrong, which is the same failure the `degraded` run state exists to prevent.

**A request that no candidate served is still a row.** When every native
candidate fails, `routeTierRequest` returns 529; that row records `status:
529`, the full `attempts` list, and zero tokens. These are the rows that
explain a tier which has quietly stopped working, so they are the last thing
that should be filtered out at write time.

## 2. Capture: teeing the stream

`responseBody()` (`src/native/router.ts`) currently yields upstream chunks
straight through to the client. It gains a wrapper that yields each chunk
**unchanged and immediately** while feeding a side parser.

```ts
async function* observe(body, onChunk, onEnd) {
  try {
    for await (const chunk of body) {
      try { onChunk(chunk); } catch { /* accounting never breaks routing */ }
      yield chunk;
    }
  } finally {
    try { onEnd(); } catch { /* nor does writing the row */ }
  }
}
```

Constraints, each of which is a way this goes wrong silently:

- **Accounting must never break routing.** Every observer call is individually
  guarded. A parser bug costs a ledger row, never a response.
- **The row is written from `finally`**, so a client disconnect (generator
  `return`) or an upstream error still produces one. See `complete` above.
- **No buffering.** Chunks are yielded before the parser runs, so the tee
  cannot add latency or hold backpressure.
- **SSE frames split across chunk boundaries.** `message_delta` can straddle a
  chunk, so the parser holds a line buffer, bounded (64 KiB) and dropped past
  the cap rather than growing on a pathological stream.
- **Usage arrives in two frames.** `message_start` carries input and cache
  counts, the final `message_delta` carries output. The row merges them rather
  than trusting either alone.
- **Non-streaming responses** take usage from the JSON body instead; the body
  is already a `Buffer` on that path.

Writes are serialised in-process (the router is a single process holding the
port) and appended, so concurrent requests cannot interleave partial lines.

**Rotation is part of this design, not a follow-up.** Daily files with a
retention window (default 30 days, pruned on `serve` start). "opencode's
`event` table grows without bound — 6.5 GB across 140k rows" is already a
documented limitation caused by another tool doing this carelessly; sonata
does not get to repeat it in its own store.

## 3. Pricing

Resolution order, evaluated at **request start**, first match wins:

1. `[models."<key>".price]`
2. `[native.gateways."<g>".price]`
3. ai-pricing.fyi cache — only when the gateway declares `pricing_provider`,
   matched `normalizeModelName(id)` → `canonical_slug`
4. `unpriced`

```toml
[models."anexto-deepseek-v4-flash-0731".price]      # USD per 1M tokens
input = 0.44
cached_input = 0.014
output = 1.32

[[models."anexto-deepseek-v4-flash-0731".price.windows]]
from = "16:30"                                      # UTC, always
to   = "00:30"
input = 0.11
output = 0.33

[native.gateways."google"]
pricing_provider = "google"                          # opts step 3 in
```

Rules:

- **UTC only.** Provider discount windows are published in UTC; local time
  would shift them twice a year under DST.
- **Windows may cross midnight.** `16:30 → 00:30` wraps, so membership is not
  `from <= t < to`. This is the likeliest bug in the feature; §7 tests both
  boundaries and the wrap.
- **Overlapping windows resolve by declaration order**, so behaviour does not
  depend on table iteration.
- **`0` is a price; `unpriced` is not.** A free gateway sums as zero. An
  unknown rate must never sum as zero — that is how a total silently
  under-reports. They are distinct states, and `sonata usage` reports unpriced
  volume separately from the priced total.
- **Priced at request start** even when a stream crosses a window boundary.
  Deterministic and explainable; apportioning tokens across a boundary is not
  knowable.
- **Never auto-fetch.** The cache refreshes only on explicit
  `sonata catalog update`. A tool whose premise is not phoning home does not
  make background HTTP calls. `sonata usage` prints the cache's age instead.
- **ai-pricing.fyi data is cached locally and never committed.** The site
  states no licence, so it gets the same treatment as the Artificial Analysis
  catalog.

Because every row stores the rate used and when it was observed, and tokens
are recorded unconditionally, a cache that caught the wrong side of a discount
can be re-priced later.

## 4. Session → project map

The router sees a session id but not a working directory. `cmdRouteSession`
already runs at SessionStart and knows both, so it records
`{ session, cwd, started }` into `~/.config/sonata/sessions.json`. `sonata
usage --by project` joins on it. A session with no entry (a session routed
some other way) reports as `unknown` rather than being dropped.

This is a **separate file from `route-sessions.json`**, which is a live
refcount that shrinks as sessions end. The map is append-mostly history: a
ledger row from last week still needs its project resolved after the session
is long gone. It is pruned on the same retention window as the ledger (§2), so
the two cannot drift into a state where rows exist with no map to join.

## 5. Commands

### `sonata usage`

```
$ sonata usage --since 7d
                        requests   input      output    cost
gpt-5.6-luna                  412   1.9M        61k     —  (subscription)
anexto-deepseek-v4-flash      308   1.4M        44k     $0.68
claude-sonnet-5                91   0.4M        12k     $1.94
                                                        ─────
                                          priced total   $2.62
                                        unpriced         720 requests · 3.3M in · 105k out
prices: ai-pricing.fyi cache 2d old · 2 models from config
```

Flags: `--since <dur>`, `--by model|role|tier|gateway|session|project`,
`--session <id>`, `--json`. Defaults to 7 days grouped by model, with the
Claude rows included, because the comparison is the point.

### `sonata status`

```
$ sonata status
router   :4100  up 4h12m  litellm ok  config ~/.config/sonata/sonata.toml
cooling  anexto-gemini-3.7-flash (403, 41s left)

recent routes
  sonata-explore-simple  anexto-gemini-3.7-flash 403 → gpt-5.6-luna 200   1.6k/11
  sonata-code-simple     anexto-deepseek-v4-flash 200                     8.2k/302
```

Promotes the `-> litellm` log line into a product surface, and surfaces
cooldowns, which are currently invisible and are why a tier can silently stop
using its first-ranked model.

Note the neighbour: `sonata route status` already exists and answers a
different question — whether *settings* route this project's sessions. `sonata
status` answers what the *router* is doing. The names are close enough that
each should point at the other in its output.

The CLI cannot know which session invoked it —
the session id arrives on a request header, not in the shell environment — so
`status` defaults to the most recent session in the ledger and takes
`--session <id>` or `--all`.

### `sonata runs`

```
$ sonata runs
id      state  role     model                    started        report
a3f1    DONE   code     kimi-k3                  12m ago        yes
9c02    DONE!  review   gpt-5.6-sol              1h ago         degraded
```

One command over existing store primitives. Per-project, since the run store
is. `sonata log <id>` currently requires knowing an id with no way to find one.

## 6. Two honesty constraints

Both are structural, not presentational.

**`sonata usage` measures the native path only.** A `sonata dispatch` run
executes in the foreign CLI's own process and never transits the router, so
its tokens are unobservable to sonata. The output states this rather than
presenting a partial figure as a total. It is also why `runs` sits beside
`usage` rather than inside it: two lanes, one measurable.

**Unpriced volume is never folded into the priced total.** Reported beside it,
in tokens and request count.

## 7. Testing

- **Stream tee:** chunk-boundary splits of `message_delta`; a stream that ends
  with no usage frame (`complete: false`); an observer that throws (response
  unaffected); client disconnect mid-stream still writing a row; assertion
  that chunks are yielded before the parser runs.
- **Pricing:** window wrap across midnight, both boundaries inclusive/
  exclusive, overlapping windows resolving by declaration order, `0` vs
  `unpriced` in totals, missing `pricing_provider` yielding `unpriced`.
- **Ledger:** concurrent appends producing whole lines; rotation and retention
  pruning; a corrupt line skipped rather than failing a whole report.
- **Commands:** aggregation by each `--by` dimension against a fixture ledger;
  `--json` shape; unknown-project sessions surfacing as `unknown`.
- Fixtures: a captured SSE stream (real, from the probes in §8) and a synthetic
  ai-pricing.fyi response, per the repo's evidence-over-inference convention.
  No API keys, per the existing suite's constraint.

## 8. Probe record

Run 2026-08-26/27 against the live router and a real Claude Code session.

- LiteLLM 1.98.0 returns `x-litellm-response-cost-input: 0.0`,
  `-output: 0` on a streaming `/v1/messages` request with no database
  configured, alongside `x-litellm-model-group`, `-model-name`, `-call-id`,
  `-attempted-fallbacks`, `-attempted-retries`.
- The final `message_delta` of the same request carried
  `{"input_tokens": 1632, "output_tokens": 11}`.
- A real Claude Code request carries `x-claude-code-session-id`, and
  `metadata.user_id` as a JSON string containing `device_id`, `account_uuid`
  and `session_id`.
- ai-pricing.fyi: public JSON, no auth, 60 req/60 s on `/v1/prices/*`, rows
  carrying `input_token` / `cached_input_token` / `output_token` in USD per 1M.
  Covers 9 of this machine's 10 configured models (`glm-5.3` absent).
  `deepseek/deepseek-v4-flash` cached-input ranges 0.0035 → 0.028 across five
  serving providers.
- ai-pricing.fyi models service tiers (`tier_key`: batch/flex/priority/
  standard), batch, region and context bands — **not** time of day. DeepSeek
  has one price per metric with `tier_key: null`, so its published off-peak
  discount is unrepresented.

## 9. Out of scope

- **Item 04, budget guardrails.** A consumer of this ledger; worth building
  once the numbers have been watched for a while.
- **Item 05, daemon identity.** Separate spec, no shared code.
- **Harness-path token accounting.** Not observable, see §6.
- **Automatic price fetching.** See §3.
- **A cost figure for subscription gateways.** `codex-oauth` has no per-token
  price; those rows are `unpriced` by construction, not by omission.
