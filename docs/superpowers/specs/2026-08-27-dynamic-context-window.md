# Dynamic context-window resolution (follow-up)

**Status:** queued — write a plan and dispatch via sonata after the
usage-ledger plan (`docs/superpowers/plans/2026-08-27-usage-ledger.md`)
finishes, since it reuses that plan's `src/aipricing.ts` (Task 5) and
shouldn't collide with tasks still in flight there.

## Problem

`CLAUDE_CODE_MAX_CONTEXT_TOKENS` — the env var `sonata code`/`sonata route`
write alongside `ANTHROPIC_BASE_URL` — is `min(context_window)` across a
session's configured native models (`src/commands/code.ts:37`). Today
`context_window` is a value the user types into `sonata.toml` by hand for
each `[models."<key>"]` entry; nothing checks it against reality, and a
model added without one silently drops out of the `min()`.

## Data source

`GET https://ai-pricing.fyi/v1/models` (confirmed live 2026-08-27, no key
needed, `access-control-allow-origin: *`) returns, per row: `canonical_slug`,
`vendor`, `context_window`, `max_output_tokens`, plus fields sonata doesn't
need yet (`model_type`, `modality`, `capabilities`, …). 1021 rows total,
paginated via `limit`/`offset` (`limit=2000` returns everything in one page
today).

Same messiness as the pricing endpoint sonata already scrapes
(`src/aipricing.ts`): duplicate slug variants for one model (e.g.
`jamba-1-5-large` vs `jamba-1.5-large`), and `context_window`/
`max_output_tokens` can be `null` on one variant while populated on another.
Normalize with the existing `normalizeModelName` (`src/catalog.ts`) and — per
the ledger's own invariant ("0 is a real price; unknown must never be summed
or displayed as zero") — never fabricate a context window for a model the
cache doesn't resolve; omit rather than guess.

Unlike price, `context_window` is not provider-scoped in this endpoint's
schema (no `provider_slug` field on `/v1/models`, unlike `/v1/prices`) — one
canonical model has one context window regardless of which gateway serves
it, which simplifies the cache shape versus `AiPricingCache.models`'s
`model -> provider -> Rates` nesting.

## Proposed design

- Extend the existing `sonata catalog update` fetch (`src/commands/catalog.ts`,
  already fetching AA + ai-pricing prices independently) to also fetch
  `/v1/models` and cache `context_window`/`max_output_tokens` per normalized
  slug — either a new field on `AiPricingCache` or a sibling cache file next
  to `~/.config/sonata/ai-pricing.json`. Follows the same rules as the
  existing caches: fetched only on explicit `update`, cached under the user's
  home directory, never committed (ai-pricing.fyi publishes no licence, same
  treatment as the Artificial Analysis catalog).
- Precedence when computing a model's effective context window: explicit
  `context_window` in `sonata.toml` (user override) > cached ai-pricing value
  for that model's normalized slug > omitted (the model drops out of the
  `min()` the same way an unset `context_window` does today — never a
  fabricated number).
- `CLAUDE_CODE_MAX_CONTEXT_TOKENS` stays computed once, at env-build time
  (`nativeSessionEnv`/`planCode`/route env), not fetched live on the request
  path — same caching discipline as pricing.
- `sonata doctor` could warn when a configured native model has no resolvable
  context window from either source, the way it already warns on other
  catalog gaps.

## Out of scope for this note

Full task breakdown, test cases, and exact function signatures — this is a
design sketch to carry into `writing-plans` once the usage-ledger branch is
merged, not an implementation-ready spec yet.
