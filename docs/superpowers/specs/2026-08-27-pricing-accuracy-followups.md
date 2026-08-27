# Pricing accuracy follow-ups (queued)

**Status:** queued — write a plan and dispatch via sonata as its own piece of
work, following the usual brainstorm/spec/plan flow. Not blocking the 0.3.0
release (`docs/superpowers/specs/2026-08-27-usage-ledger-design.md`, shipped
in PR #3) or the queued
[dynamic-context-window follow-up](2026-08-27-dynamic-context-window.md),
which this is unrelated to besides sharing the "queued, dispatch later"
pattern.

Three gaps surfaced 2026-08-27 while checking whether sonata's pricing
correctly handles DeepSeek's peak/off-peak scheme.

## 1. `genai-prices` as a pricing source

`pydantic/genai-prices` (https://github.com/pydantic/genai-prices) explicitly
supports "variable daily prices" and names DeepSeek's off-peak pricing as a
supported case — something `ai-pricing.fyi` (sonata's current scraped source,
`src/aipricing.ts`) does not model at all (confirmed during the original
usage-ledger design: its `tier_key` field covers batch/flex/priority/standard
service tiers, never time-of-day).

- No live API yet ("Coming soon..." per its README as of this check) — data
  ships as a downloadable static JSON (`prices/new_data/v2/data.json`, plus a
  `data_slim.json`) and Python/JS packages. This is the same shape sonata
  already handles for the Artificial Analysis catalog and `ai-pricing.fyi`:
  fetch-and-cache under the user's home directory on an explicit
  `sonata catalog update`, never live-queried per request, never committed to
  the repo (same licence-caution treatment as the existing two sources).
- Proposed integration: a third source in `resolvePrice`'s fallback chain
  (`src/pricing.ts`) — model price → gateway price → scraped (today:
  `ai-pricing.fyi`; could become genai-prices, or both, resolved by whichever
  actually has a rate for the model+provider) → none. Needs its own
  normalization function paralleling `normalizeAiPricingRows`, and its own
  cache file/gateway declaration (`pricingProvider` may need a second field,
  or a value distinguishing which scraped source to use, if both sources are
  kept). If both sources have a rate for the same model+provider, genai-prices may be
  preferred over `ai-pricing.fyi` because it is the source intended to model
  time-of-day pricing, but this cannot be an unconditional precedence rule.
  Before trusting its output as authoritative, the follow-up plan must verify
  and, if necessary, normalize genai-prices' constraint evaluation for the
  specific date/time/weekday combinations sonata cares about. At minimum, add
  boundary tests proving that DeepSeek peak rates do **not** apply before the
  2026-08-16 change and do **not** apply on Saturday/Sunday. This is a
  prerequisite check for the implementation plan, not a blocker on writing
  this queued design sketch. Both caches should follow the existing
  `ai-pricing.fyi` policy: no auto-fetch and refresh only on an explicit
  `sonata catalog update`. `LedgerPrice.source` (`src/ledger.ts`) will also
  need a `'genai-prices'` union variant so `sonata usage` can record which
  scraped source supplied each price, rather than only that a scraped source
  did.
- Before implementing: check whether genai-prices' data schema actually
  encodes DeepSeek's *current* (post Aug-16-2026) peak-surcharge scheme or
  still reflects the older off-peak-discount shape — the pricing landscape
  moved under this research (see §3).

## 2. `PriceWindow` needs a day-of-week dimension

DeepSeek changed its scheme on 2026-08-16: previously a flat off-peak
discount window (16:30–00:30 UTC, every day), now a **peak surcharge**
scoped to **01:00–04:00 and 06:00–10:00 UTC, Monday–Friday only** — 2× the
base rate during those hours, base rate everywhere else including all of
Saturday/Sunday.

Sonata's current `PriceWindow` (`src/config.ts`) has only `from`/`to` as UTC
`HH:MM` — no way to say "only on weekdays." A naive config entry for the new
DeepSeek scheme would incorrectly apply the surcharge on weekends too.

Proposed fix: add an optional `days` field to `PriceWindow` (e.g.
`days: string[]` — `["mon","tue","wed","thu","fri"]` — or ISO weekday
numbers 1–7), defaulting to "every day" when absent so existing configs are
unaffected. `inWindow` (`src/pricing.ts`) needs the day-of-week check added
alongside its existing UTC-midnight-wrap time check. Existing
midnight-wrap/UTC/priced-at-start invariants from the original design stay
unchanged — this is additive.

## 3. Cache-creation tokens are billed at the plain input rate

`src/pricing.ts`'s `costOf`:
```ts
cacheCreation * (rates.input ?? 0)
```
There is no distinct cache-creation rate — cache writes are billed as if
they were plain input tokens. Real providers (Anthropic included) typically
charge a *premium* for writing to cache (commonly 1.25×–2× the base input
rate depending on TTL) and a *discount* for reading it — `cachedInput`
already models the read discount correctly, but the write premium is
missing entirely, so a cache-write-heavy workload is under-reported.

Proposed fix: add a `cacheCreation` field to `Rates` (`src/config.ts`,
parallel to `cachedInput`), defaulting to the `input` rate when absent (so
existing configs with no explicit cache-creation rate keep today's
behavior — no silent regression). The new field must be carried through all of
the relevant paths: the `Rates` interface itself; `parseRates` in
`src/config.ts`, which must parse the TOML `cache_creation` field;
`hasRates` in `src/pricing.ts` must count it when checking whether any rate is
configured; and both the flat/default branch and the window-override branch
of `ratesFor` in `src/pricing.ts` must copy it into the `Rates` they construct.
Then wire the effective rate into `costOf`, preserving the fallback to `input`
when `cacheCreation` is absent. This also needs to update the already-shipped
`RATE_KEYS` allowlist in `src/aipricing.ts`'s `modelsAreValid`: it currently
accepts only `input`, `cachedInput`, and `output`, so a scraped record
containing `cacheCreation` would otherwise be rejected as invalid immediately.
Tests should cover flat rates, window overrides, cache-creation-only rates (so
`hasRates` does not wrongly treat them as empty), and fallback to `input` when
`cacheCreation` is absent. Smaller, self-contained fix — doesn't depend on
§1/§2 and could ship alone.

## DeepSeek's real current scheme, for reference

Effective 2026-08-16T16:00:00Z (confirmed via DeepSeek's own pricing docs
and their announcement): peak surcharge 01:00–04:00 and 06:00–10:00 UTC,
Monday–Friday, at 2× the base rate; all other hours (including weekends) at
base rate. deepseek-v4-flash base: $0.22/1M input (cache miss), $0.007/1M
(cache hit), $0.66/1M output. deepseek-v4-pro base: $0.66/1M input, $1.98/1M
output. The 16:30–00:30 UTC window baked into sonata's own test fixtures
(`tests/commands/serve-ledger.test.ts` and others) reflects the *old*
V3/R1-era scheme and is stale — those are just fixtures exercising the
mechanism, not live config, so this isn't urgent to fix, but worth knowing
if anyone reads them as a real-world reference.
