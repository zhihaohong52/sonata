# LiteLLM: which dialect, and when sonata needs it at all

Three questions that turned out to be one.

**Roadmap item 09** asks sonata to own its LiteLLM dependency: the native path
is the default and does not work until the user runs `pip install
'litellm[proxy]'` by hand — the first wall a stranger hits after
`npm install -g`.

**A question raised 2026-09-01:** Claude Code speaks Anthropic, sonata speaks
Anthropic, and several providers now serve a native Anthropic Messages
endpoint. What is LiteLLM translating?

**And its follow-up:** what about an aggregator serving a mixture of models,
some with Anthropic support and some without?

Answering them also produced a claim that did not survive checking, retracted
in Finding 3 — the record of what was withdrawn is kept, because a spec that
quietly drops a wrong finding teaches nothing.

Supersedes `2026-09-01-managed-litellm-design.md`, whose decisions are carried
forward unchanged.

## What was measured

All probed live on 2026-09-01. Nothing below is inferred.

| # | probe | result |
|---|---|---|
| 1 | OpenRouter `/v1/messages`, native model id `deepseek/deepseek-v4-flash` | `200` |
| 2 | Two-turn tool round-trip: assistant's own blocks echoed back + `tool_result` | `200` |
| 3 | `system` as a block array carrying `cache_control` | accepted as-is |
| 4 | Streaming | full Anthropic SSE set (`message_start`, `content_block_*`, `message_delta`, `message_stop`) |
| 5 | sonata's own `createUsageCollector` over that stream | `{"tokens":{"input":85,"output":17,…},"complete":true}` |
| 6 | **Gemini** via OpenRouter `/v1/messages`, tool call | `200`, blocks `redacted_thinking + tool_use` |
| 7 | **Gemini**, echo `redacted_thinking` back + `tool_result` | `200` |
| 8 | `openai/gemini-3.7-flash` → `generativelanguage.googleapis.com/v1beta`, plain "Say OK", **scratch instance** | `404` — unexplained; contradicted by 34 successful ledger rows on the same config (see Finding 3) |
| 9 | `gemini/gemini-3.7-flash` → same key | `429` quota — i.e. routed and authenticated |

Probe 5 decides the architecture: the ledger needs no changes. Probes 6–7
answer the aggregator question. Probe 9 shows the native prefix routes and authenticates. Probe 8 is an
unresolved observation, not a defect — see Finding 3.

## Finding 1 — an Anthropic-native upstream needs no LiteLLM

sonata receives Anthropic on `/v1/messages`, already knows each gateway's
`base_url`, and already holds its key. When the upstream also speaks
Anthropic, LiteLLM is a pass-through whose only contribution is the
translation layer — and nearly every defect this project has fought lives in
that layer: Gemini's dropped `thought_signature`, Codex rejecting
`role: system`, `map_system_message_pt` raising on block arrays
(BerriAI/litellm#32904), and `flattenSystemBlocks` — a workaround whose cost
is prompt caching (probe 3 shows an Anthropic-native upstream keeps
`cache_control` that the current path discards on every tier request).

## Finding 2 — an aggregator normalises per-model dialects behind one wire

The follow-up question was whether a gateway-level dialect can be right for an
aggregator serving many vendors. Empirically yes, and better than expected:
**Gemini** over OpenRouter's Anthropic endpoint returned its reasoning state
as `redacted_thinking` — Anthropic's block for opaque data the client echoes
back verbatim — and the round-trip succeeded (probes 6–7).

The aggregator carries vendor-specific state through Anthropic's block model,
which OpenAI's shape has nowhere to put. So the dialect is a property of the
**gateway**, not of each model behind it: that is what an aggregator is for.

**This creates a hard rule.** `redacted_thinking` is only useful if it comes
back byte-identical, so **sonata must never rewrite assistant content blocks.**
True today — `flattenSystemBlocks` touches only `system` — but now a rule
rather than an accident, and a test.

## Finding 3 — the native prefix is better, but nothing is broken today

**Retracted claim.** An earlier revision of this document asserted that
`openai/` against Google's `/v1beta` is a live defect, on the strength of
probe 8 returning 404. That claim does not survive checking and is withdrawn.

The ledger is real traffic through the real path, and it disagrees:

| evidence | result |
|---|---|
| the config `serve` actually generates vs. the probe's | byte-identical |
| `gemini-3.7-flash` present in Google's `/v1beta/models` | yes |
| ledger rows for `openai/gemini-*` | **34 successful**, most recent 57,877 input tokens |
| `google-gemini-2.5-flash` failures in tier attempts | **429 quota**, never 404 |

The probe's 404 is unexplained. The most likely cause is that the key
hand-extracted for the scratch instance differs from the one
`SONATA_KEY_GOOGLE` resolves, and Google answers 404 for a model a key's
project cannot reach. It is recorded here as an unresolved observation, not
as a defect.

**The design decision stands on its own merits.** Emitting `gemini/<id>` for a
Google gateway is better than `openai/<id>` because it speaks the vendor's
native API instead of a compatibility shim, which is where vendor-specific
state (Gemini's `thought_signature`) has nowhere to live. Probe 9 confirms
that prefix routes and authenticates. That is an argument from architecture,
not from an outage — and this section previously dressed it up as the latter.

## The model: a gateway declares its provider

`wire_format: 'anthropic' | 'openai'` is too narrow — the real axis is **which
LiteLLM provider**, and LiteLLM has one per vendor. Generalised to `provider`,
matching LiteLLM's own `custom_llm_provider` vocabulary:

```toml
[native.gateways."google"]
base_url = "https://generativelanguage.googleapis.com/v1beta"
provider = "gemini"          # -> litellm_params.model = gemini/<id>

[native.gateways."openrouter"]
base_url = "https://openrouter.ai/api/v1"
provider = "anthropic"       # -> direct transport, no LiteLLM
```

**Transport is derived, never configured separately:**

| gateway | transport | emitted |
|---|---|---|
| `provider = "anthropic"`, `auth = "api-key"` | **direct** | — (no LiteLLM) |
| any other `provider`, `auth = "api-key"` | litellm | `<provider>/<id>` |
| `auth = "codex-oauth"` | litellm | `chatgpt/<id>` + `mode: responses` |
| `auth = "copilot-oauth"` | litellm | `github_copilot/<id>` |
| model id starts `claude-` | anthropic | unchanged |

Deriving rather than adding a `transport` key is deliberate: two keys that can
disagree is the shape of the item-14 scope bug, where a writer and a cleaner
defaulted differently and ids leaked forever.

### The provider table carries the prefix

`WELL_KNOWN_PROVIDER_URLS` becomes `{ url, provider }` per entry, so a known
vendor gets its native prefix without the user knowing any of this. `openai` is
the fallback for genuinely unknown custom endpoints — a default for the
unknown, not for known vendors. **Changing Google's dialect is then a table
entry** (a better prefix, not a repair — see Finding 3), and the same table gains Anthropic-capable rows (`openrouter` → `anthropic`), each
added only after its endpoint is probed: the table doubles as the name→URL
lookup, where a wrong entry is worse than a missing one.

### Migration

`wire_format` ships in configs today. `provider` supersedes it;
`wire_format = "anthropic"` maps to `provider = "anthropic"` and `"openai"` to
`"openai"`, handled in `migrateLegacyConfig` beside the existing
`[generate.roles]` migration. `parseConfig` keeps refusing it on OAuth
gateways, since those providers are fixed by their auth.

## Direct transport

`forwardDirect(body, gateway, deps)` beside `forwardToLitellm`. The body is
passed through **unmodified** — no `flattenSystemBlocks`, only the model id
substituted.

### Auth is a third header mode

| path | credential |
|---|---|
| direct-to-Anthropic | the session's own, untouched |
| litellm | caller's stripped, LiteLLM master key injected |
| **direct-to-gateway (new)** | caller's stripped, **that gateway's** key injected |

Stripping the incoming `authorization`/`x-api-key` before injecting is the
security boundary, not hygiene: forwarding a session credential to a
third-party gateway is a credential leak. `auth_header` defaults to
`Authorization: Bearer`, which every probed endpoint accepted.

Tier ranking, cooldowns, item-13 fingerprinting, the 529 exhaustion message
and usage recording are upstream-agnostic and reused unchanged.

## LiteLLM becomes conditional

```
litellmRequired(config) = any model reachable from [tiers] whose gateway
                          resolves to the litellm transport
```

When false, `serve` starts **no LiteLLM child** — no spawn, no crash-loop
watcher, no port — and no venv, no Python. A user whose gateways are all
Anthropic-native runs sonata on Node and tmux alone. That is a better answer
to "let strangers in" than managing the dependency is.

## The managed venv, for gateways that still need one

Carried forward unchanged, now reached only when `litellmRequired` is true.

```
~/.config/sonata/litellm/              the venv
~/.config/sonata/litellm/bin/litellm   what serve spawns
~/.config/sonata/litellm/.sonata-pin   the version sonata installed
```

**Pinned exactly**, starting at **1.98.0** — the version every LiteLLM
behaviour in `CLAUDE.md` was measured against. Shipping the newest release
would ship one against which none of those findings has been re-verified.

**`uv` when present, `python3 -m venv` otherwise.** uv installs in seconds and
can fetch a conforming interpreter, the only thing that rescues an
out-of-range `python3`. Two paths is a real risk; the mitigation is structural
— one `Installer` interface, two implementations, **one test suite**,
subprocess as a seam. A test passing for only one implementation is not done.

**Python range has a ceiling:** LiteLLM declares `<3.15,>=3.10`. A "3.10 or
newer" check passes 3.15 and fails later at the resolver.

**Status is a value:**

```ts
type LitellmStatus =
  | { state: 'not-required' }                                   // no gateway needs it
  | { state: 'ok'; version: string; path: string }
  | { state: 'stale'; installed: string; expected: string; path: string }
  | { state: 'missing' }
  | { state: 'broken'; reason: string }
  | { state: 'no-python'; pythonVersion?: string };              // uv absent; uv would fix it
```

`not-required` is the point: `doctor` says "no gateway needs LiteLLM" rather
than "not installed", which reads as a fault.

**Install is atomic** — build in a temp directory, move into place on success
only, so a failure leaves `missing` (repairable) not `broken` (invites
debugging a half-built environment). **`init` installs, `doctor` repairs,
`serve` never installs**: `ensure-serve.mjs` runs it headless from a
SessionStart hook, where a silent multi-minute install is indistinguishable
from a hang.

## Testing

- `providerFor(gateway)` and `transportFor(gateway)` across all five rows.
- `litellmRequired`: true when any tier model needs it; **false** for a config
  mixing Anthropic-native gateways with a `claude-` model.
- `serve` starts no LiteLLM child when not required — asserted on the spawn
  seam, not by absence of error.
- Direct transport: headers carry the gateway key and **not** the caller's;
  body reaches the upstream byte-identical including `cache_control`.
- **Assistant content blocks round-trip byte-identical** — a `redacted_thinking`
  block in, the same bytes out.
- Usage recording over the captured real Anthropic SSE stream from probe 4.
- `migrateLegacyConfig`: `wire_format` → `provider`, both values.
- The `google` gateway emits `gemini/<id>`, not `openai/<id>` — a change of
  dialect, not a bug fix; nothing is broken today.
- Venv: installer selection, the range including a 3.15 rejection, `status()`
  for each of six states, both installers against the same assertions, and
  atomicity.

Live, outside CI: one real dispatch through a direct-transport gateway, and
one real install on a machine without `uv`.

## Out of scope

- **Automatic LiteLLM upgrades.** `status()` reports `stale`; acting is the
  user's call.
- **Vendoring or replacing LiteLLM.** The roadmap's wording is deliberate.
- **Installing Python.** uv may fetch one as a side effect; sonata never does.
- **Making `flattenSystemBlocks` conditional on Codex.** It stays for the
  LiteLLM transport, where it is still required. Narrowing it needs its own
  probe and is not assumed here.
- **Per-model dialect overrides.** The aggregator absorbs per-model variation
  (finding 2), and item 13's cooldown catches whatever still cannot serve the
  shape. Adding a per-model override before a case demands it would be the
  second disagreeing key this design exists to avoid.
