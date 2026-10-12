# Claude models as ordinary sonata models

Date: 2026-10-12
Status: design approved in conversation; spec awaiting review

## Purpose

Sonata refuses every model key and id that begins with `claude-`. The reason
was mechanical: the router sends any request whose model starts with `claude-`
straight to `api.anthropic.com`, so a configured `claude-*` model could never
reach its own gateway. The refusal also hides Claude models that gateways
really do serve: `init` filters out 27 such ids from Copilot, OpenRouter and
others.

This change makes a Claude model an ordinary model. Any tier may rank one, from
either of two sources:

- **a gateway that serves Claude ids** (Copilot, OpenRouter, any other
  gateway), billed to that gateway's credential, exactly like any other model
  it serves;
- **the person's own Claude Code account**, using the credential the session
  already sends.

Success means a config such as this loads, routes and falls back like any
other:

```toml
[native.gateways."claude"]
provider = "anthropic"
auth = "session"

[models."opus"]
gateway = "claude"
id = "claude-opus-4-1"

[models."claude-sonnet-4.5"]
gateway = "copilot"
id = "claude-sonnet-4.5"

[tiers.code]
complex = ["opus", "kimi-k3"]
normal  = ["claude-sonnet-4.5", "flash"]
```

The ledger, `sonata usage`, `sonata status` and the loop panel all report every
request's true cost, its API list price, including work a subscription paid for.

## Decisions

| Question | Decision |
|---|---|
| Which Claude models | Both: gateway-served Claude ids and the person's own Claude Code account |
| Special treatment for Claude | None. No refusal, no flag on review tiers, no separate path |
| How the person's own account is expressed | An `anthropic` gateway with `auth = "session"`: a credential source, like `codex-oauth` |
| Where the session credential may go | `api.anthropic.com` only, enforced at parse time |
| How the person's own account is priced | Like any gateway: models.dev's `anthropic` list rates |
| How subscription work is shown | Its API list price everywhere a cost is shown, marked `sub`, never `—` or `$0` |
| Whether subscription work counts toward `[budget]` | No: `daily_usd` caps money billed per token |
| Which work is subscription work | `codex-oauth` and `copilot-oauth`, as today, plus a `session` request carrying an OAuth credential |

## What is removed

`ANTHROPIC_ROUTED_PREFIX` and `isAnthropicRoutedName` (`src/config.ts`), and
every use of them:

- the three parse-time refusals in `parseConfig`: a `[models]` key, a
  `[tiers]` candidate key, and a legacy `[native.models]` key;
- the candidate filters in `src/init/helpers.ts`, `models-step.tsx`,
  `byok-step.tsx` and `providers-step.tsx`;
- the `anthropicRouted` effort exception in `src/adapters/claude.ts`, which
  becomes "a model name the config does not define" (see *Routing*).

Every test that asserts one of these refusals is replaced by one asserting that
the same config now loads, or that `init` now offers the id.

## Config: `auth = "session"`

`NativeGatewayAuth` gains `'session'`, and `NATIVE_GATEWAY_AUTHS` lists it.

- **Valid only with `provider = "anthropic"`.** Any other provider is refused
  at parse time, naming the gateway.
- **`base_url` is pinned.** Absent, it is `https://api.anthropic.com/v1`.
  Present, it must parse as `https://api.anthropic.com` with an optional `/v1`
  path. Anything else is refused: the session's credential is Claude Code's
  own, and sending it to any other host is a leak. This is the same boundary
  `forwardDirect` documents for the stored-key case today.
- **No stored key.** A session gateway never reads the credential store. Every
  place that resolves or checks a gateway key (`sonata auth list`, `doctor`'s
  credential check, `init`'s key step, `gatewayEnv`) skips it, the way each
  already skips `codex-oauth` and `copilot-oauth`. `sonata auth add` on a
  session gateway is refused, with the reason given.
- **Transport is `direct`.** `transportFor` already sends an `anthropic`
  gateway direct, and that is unchanged. A session gateway never starts
  LiteLLM.
- **Round-trip.** `nativeTomlFor` writes `auth = "session"` back, with a test
  through `parseConfig`, because `sonata init` deletes whatever it does not
  write back.

## Routing (`src/native/router.ts`)

### Name resolution order

`routeRequest` resolves a request's model in this order:

1. an auto alias (`sonata-<role>-auto`), as today;
2. a tier alias (`sonata-<role>-<tier>`), as today;
3. **a model key the tenant's config defines, whatever its name**;
4. a name shaped like a tier alias that the config does not resolve, which
   gets the typed 400 pointing at `sonata sync`, as today;
5. otherwise, a name beginning `claude-` is forwarded to Anthropic
   byte-identical with the caller's credential: the main session's own turns.
   Anything else goes to LiteLLM, as today.

Step 3 is the change. Today the `claude-` check runs before the config is
consulted, which is exactly why a `claude-*` key could never be reached.
`isClaudeRequest` survives only as step 5's test.

**Consequence, accepted in design:** a configured key that is spelled exactly
like a model the main session uses (a key `claude-opus-4-1` on Copilot, say)
also catches the main session's own turns when the session is routed. That is
what treating the key like any other key means. The docs say so in one line.

### `@effort` on a configured key

The split of `<key>@<effort>` in `routeRequest` skips names beginning
`claude-`. It changes to skip only names that are not configured keys, so a
configured Claude key takes a level exactly like any other key. A Claude model
an Artificial Analysis catalog scores is subject to the same rule as any scored
model: a bare scored key in `[tiers]` is refused at load.

The direct transport already declines to add `reasoning_effort` to a request
bound for an Anthropic-native gateway, which has no such field. That is
unchanged, and the adapter reports the level as unhonoured, as it does for any
direct `anthropic` gateway today.

### Forwarding with the session's credential

`forwardDirect` gains a session mode. On a `session` gateway it:

- keeps the caller's `authorization` and `x-api-key` headers rather than
  replacing them with a stored key;
- rewrites only the body's `model` to the candidate's `id`, as every
  candidate dispatch already does, and otherwise leaves the body byte-identical
  (no `flattenSystemBlocks`, `cache_control` and `redacted_thinking` intact);
- sends the request to the pinned base URL.

A request that reaches a session candidate with no credential gets Anthropic's
own 401, which is a failed candidate like any other: the router cools it down
and tries the next ranked candidate. If every candidate fails, the usual 529
names the `sonata dispatch` fallback.

### Which credential paid

On every `session` request the router classifies the caller's credential.
Only the classification is recorded, never the credential:

- `authorization: Bearer sk-ant-oat…` is a Claude subscription (OAuth): **covered**;
- `x-api-key`, or any other bearer token, is billed per token: **priced**.

The classification travels with the ledger row: the price `source` is `covered`
or `priced`. `codex-oauth` and `copilot-oauth` keep today's rule (`relabelCovered`),
always covered.

## Pricing and display

### The price itself

Every request is valued at its models.dev API list rate, whichever credential
paid. `MODELSDEV_PROVIDER_FOR_GATEWAY` consults `auth` before the gateway's
name, as it does today, and `session` maps to `anthropic`. `init` gives a new
session gateway `pricing_provider = "anthropic"`, as it does for every gateway
it writes. A model with no models.dev rate stays unpriced, never `$0`.

### `[budget]`

Unchanged: `spentTodayUsd` skips covered rows, so `daily_usd` caps money billed
per token. A day of subscription work never trips it.

### `sonata usage`

The main cost cell of a bucket whose work was entirely covered reads `—` today.
It shows the bucket's list value instead, marked `sub` (`$0.42 sub`). A mixed
bucket's cell shows the billed amount, and the existing covered column beside it
carries the subscription value. The covered column and totals keep their meaning.

### `sonata status` and the router's session API

`RouteLine` (`src/commands/status.ts`), which is also what
`/__sonata/api/session/<id>` returns to the panel, gains `isCovered?: true`,
present only when the row's price source is `covered`. `priceUsd` keeps carrying the
list value, as it already does for covered rows.

`sonata status` prints a covered route's cost as `$0.42 sub`, and its totals
line splits billed money from subscription value:
`$1.10 billed · $0.42 sub`.

### The loop panel

- `RouteLine` in `skills/loop/types/index.d.ts` gains `isCovered?: true`,
  and `fetchOnce`'s route-shape filter accepts it only as `true` or absent.
- `attribute` returns `isCovered: true` when any of an agent's routes was
  covered; `taskCost` returns the same per task.
- **Agent and task rows** show the list cost, then ` sub` in the `inactive`
  colour when any part was covered. The board keeps its one accent.
- **The header facts** read `$1.10 + $0.42 sub` when both kinds are present,
  `$0.42 sub` when only covered work is.
- **The detail section** of a selected row breaks a mixed cost down: billed
  and subscription value on one line.
- `≈` (shared alias, no cost assigned) and unknown cost are unchanged: an
  ambiguous or unpriced agent still shows no cost at all.

## `sonata init`

- The provider step gains **"Claude (this Claude Code account)"**, which
  writes `[native.gateways."claude"]` with `provider = "anthropic"`,
  `auth = "session"` and `pricing_provider = "anthropic"`. It asks for no key.
- Its model candidates are the `anthropic` provider's models in the models.dev
  cache. A session gateway has no key to query `/models` with, so the models
  step's live refresh skips it, the way it skips the OAuth gateways.
- Gateway-served Claude ids appear in the models step like any other id. An id
  needs no renaming: a key may now begin `claude-`.

## Docs

The `claude-` rule is removed from, and the session gateway added to:
`docs/internals/configuration.md`, `docs/internals/native-path.md`,
`docs/guide/native-path.md`, `docs/internals/limitations.md`, and the
*Rules that bite* list in `CLAUDE.md`. The guide states the main-session
consequence of step 3 in one line. `CHANGELOG.md` records it under
`[Unreleased]`. It is a **minor** release (`0.15.x` → `0.16.0`): it changes how
sonata routes, what config it accepts, and how cost is shown.

## Testing

- **Config:** each removed refusal becomes a load test. `auth = "session"` is
  refused with a non-anthropic provider and with a non-Anthropic `base_url`.
  It gets its default `base_url`, and it round-trips through `nativeTomlFor`
  and `parseConfig`.
- **Router:**
  - a configured `claude-*` key routes to its gateway;
  - an unconfigured `claude-*` name still passes through byte-identical;
  - a tier candidate on a session gateway keeps the caller's credential, with
    only `model` rewritten;
  - a 401 from a session candidate falls through to the next candidate;
  - an OAuth bearer records `covered`, and an `x-api-key` records `priced`;
  - the credential never appears in a log line or a ledger row;
  - `claude-key@low` splits when configured.
- **Pricing and display:**
  - `spentTodayUsd` ignores covered session rows;
  - `sonata usage`'s cell renders `$x sub` and `$a + $b sub`;
  - `sonata status` renders `$x sub` and the split totals;
  - the panel's `board.test.ts` renders `sub` on an agent row, a task row and
    the header;
  - `fetchOnce` keeps `isCovered`.
- **`init`:** the Claude provider writes the session gateway with no key
  prompt; Claude ids from Copilot are offered; the live refresh skips the
  session gateway.

## Out of scope

- A per-role guard or flag on Claude models in review tiers. It was decided
  against: Claude is treated like any other model.
- Querying Anthropic's `/models` with the session credential.
- Effort levels for Claude beyond what any direct `anthropic` gateway gets
  today.

## Sequencing

The panel half depends on PR #86 (the loop panel). This branch is cut from
`feat/loop-panel` and is rebased onto `main` once #86 merges; it opens as its
own PR after that.
