# Add Provider / Import From Harnesses — Wizard Redesign

**Status:** approved design, ready for implementation plan.

## Problem

`sonata init`'s wizard currently has two separate steps for getting a provider
configured:

- Step 2 ("Providers"): a flat multi-select of every provider any installed
  harness knows about, regardless of whether a usable credential exists for
  it.
- Step 3 (the credential-source screen): run once per selected gateway,
  showing a flat list of rows mixing "log in with sonata", "import from
  codex", "import from opencode", and "enter an API key" with no structure
  between them.

This conflates two different user intents — "I already logged into a harness,
just use that" versus "let me configure a provider directly" — into one flat
list, and the default selection (`'sonata'`, i.e. run an OAuth login) doesn't
obviously read as "the deliberate direct-setup path" versus "import" being
buried as sibling rows.

There is also no way to configure a provider that isn't already known to
sonata (not in `WELL_KNOWN_PROVIDER_URLS`, not in any installed harness's
model catalogue) — every OpenAI-chat-completions-compatible or
Anthropic-Messages-compatible endpoint that isn't already catalogued is
unreachable from the wizard.

## Goal

Replace steps 2 and 3 with a single new step presenting an explicit top-level
choice — **Import from other harnesses** vs **Add provider** — modeled on
opencode's own `/connect` onboarding: bulk-import what's already
authenticated, or add any provider one at a time, including a fully custom
one (name, base URL, wire format, then a credential).

## Non-goals

- Editing or removing a provider once configured within the same wizard run
  (matches today's behavior — not currently supported either).
- Any wire format beyond OpenAI-chat-completions-compatible and
  Anthropic-Messages-compatible.
- OAuth for anything other than `codex`/`github-copilot` — sonata has no
  generic OAuth mechanism, only LiteLLM's two built-in authenticators
  (`docs/dispatching-work-through-sonata.md` and `CLAUDE.md`'s Native path
  section cover why this is a hard limit, not a scoping choice).
- Custom auth schemes beyond a single bearer API key, or per-model overrides.
- Changing anything past this step (role assignment, per-role model
  selection) — those steps consume the same `InitState` shape they do today.

## Design

### A. Top-level menu (replaces steps 2 and 3)

Shown once harness selection (step 1) completes:

```
┌─ Set up providers ──────────────────────┐
│ > Import from other harnesses           │
│   Add provider                          │
│   Continue                              │  ← only once ≥1 provider configured
└──────────────────────────────────────────┘
```

- **Import from other harnesses** is omitted from the menu entirely if no
  installed harness has an actual detected credential (mirrors today's
  "skipped when it would be an empty list" logic for the zero-harness BYOK
  case).
- **Continue** is omitted until at least one provider has a
  `credentialSources` entry, exactly like today's implicit requirement that
  you configure something before the wizard can proceed.
- Both "Import…" and "Add provider" return to this same menu when they
  finish, so a user can freely mix one bulk import with one or more
  individually-added providers in a single `init` run.

### B. Import from other harnesses (bulk)

A multi-select, structurally identical to today's step-2 `MultiSelect`, but
**filtered to providers with an actual detected credential** — a real codex
login (`readChatGptOAuth`/`readCodexOAuth`) or a real opencode auth-store
entry (`readChatGptOAuth`/`readCopilotToken` via the opencode path) — not
merely "this harness's model catalogue lists this provider." This is the
existing `credentialRowsFor`'s `have[name] !== null` check, applied as a
filter over providers rather than as per-gateway rows.

Selecting providers here sets `credentialSources[gateway]` to `'codex'` or
`'opencode'` directly (whichever harness the credential came from — if both
have a credential for the same provider, prefer `'codex'`, matching
`readChatGptOAuth`'s existing default precedence when no source is named) and
returns to the top-level menu. No further per-provider screen — the whole
point of bulk import is that there's nothing left to ask.

### C. Add provider (one at a time)

```
Add provider
┌─ Provider ───────────────────────────────┐
│ [type to filter]                          │
│ > openai                                  │
│   anthropic                               │
│   codex          (device login available) │
│   github-copilot (device login available) │
│   openrouter                              │
│   ... (merged: harness-known + well-known)│
│   Add a custom provider…                  │
└────────────────────────────────────────────┘
```

The list merges `providersForHarnesses(data.providers, state.harnesses)` and
`data.byokProviders` (today's well-known-provider catalogue), deduped by
name, **excluding any provider already configured** in this run (already has
a `credentialSources` entry) so the same gateway can't be added twice.
Filterable by typed text, same interaction pattern as the existing
`MultiSelect`/`Choice` components.

**Picking a known provider** goes to a credential-method choice:

- `codex` and `github-copilot` — the only two providers with a real OAuth
  device flow (LiteLLM's built-in authenticators; no harness installation
  required, per the existing Native-path documentation) — offer both **Enter
  an API key** and **Run OAuth login**.
- Every other provider offers **Enter an API key** only.

This choice screen is exactly today's `credentialRowsFor`'s `'sonata'` (login)
and `'sonata-key'` (key entry) rows, unchanged — only the `'codex'`/`'opencode'`
import rows move out to step B above.

- **Run OAuth login** → today's `LoginScreen`, unchanged.
- **Enter an API key** → today's `ByokStep` (key entry → `/models` fetch →
  manual-id fallback on 404/429/non-JSON), unchanged, given `{ name, url }`
  for the chosen provider.

**Picking "Add a custom provider…"** prompts for:

1. **Name** — validated non-empty and unique (case-insensitively) against
   every provider already offered or already configured in this run, same
   validation style as the existing key-flattening collision check `init`
   already performs.
2. **Base URL** — validated non-empty, must parse as an absolute URL.
3. **Wire format** — a two-item `Choice`: `OpenAI-compatible` (default,
   pre-selected) / `Anthropic-compatible`.

...then falls into the same **Enter an API key → `ByokStep`** path as any
other provider — a hand-typed endpoint has no known OAuth flow, so "Run OAuth
login" is never offered for a custom provider. The chosen wire format is held
in a new `InitState.customWireFormats?: Record<string, 'anthropic'>` map
(only populated on the non-default choice, mirroring how `credentialSources`
only records deviations from default elsewhere) and consumed at TOML-write
time (see below).

### D. Config schema: `wire_format`

New optional field on `[native.gateways.*]`, meaningful only for
`auth = "api-key"`:

```toml
[native.gateways.my-custom-anthropic-provider]
auth = "api-key"
base_url = "https://example.com/v1"
wire_format = "anthropic"   # new; omitted = "openai" (today's only behavior)
```

- `NativeGatewayConfig` (`src/config.ts`) gets
  `wireFormat?: 'openai' | 'anthropic'`. Absent or `"openai"` is byte-for-byte
  today's behavior — **no effect on any existing config file.**
- `parseConfig` refuses `wire_format` on a non-`api-key` gateway (OAuth
  gateways already have a wire format implied by `auth` — `codex-oauth` is
  always `chatgpt/*` + `mode: responses`, `copilot-oauth` is always
  `github_copilot/*`), mirroring the existing parse-time refusal of
  `codex`+`api-key`.
- `litellmConfig` (`src/native/litellm.ts`) gets one new branch:
  `wireFormat === 'anthropic'` emits `anthropic/<id>` as the LiteLLM
  `custom_llm_provider` against the gateway's `api_base`/`api_key` — LiteLLM
  already supports arbitrary Anthropic-Messages-compatible endpoints this way,
  sonata simply doesn't expose the option today. The `openai` branch is
  unchanged from current behavior.
- The wizard only ever writes `wire_format` for a custom provider that chose
  `Anthropic-compatible`; every known/well-known provider is unaffected and
  never sets it.

### E. Data flow (state shapes, no new downstream steps)

- `InitState` gains `customProviders?: { name: string; url: string }[]`
  (session-only list of hand-typed custom providers, unioned with
  `data.byokProviders` wherever the provider list is rendered) and
  `customWireFormats?: Record<string, 'anthropic'>` (see above).
- Everything past provider+credential configuration — role assignment,
  per-role model selection, final TOML emission — consumes
  `credentialSources`, `nativeKeys`, `byokKeys` exactly as it does today.
  `ByokStep`'s existing `onSubmit` → `byokCandidateKey(provider, id)` path is
  unchanged and is reused verbatim for both known-provider and
  custom-provider API-key entry.
- `ProviderSummary`/`ProviderOption`'s existing `harness: '... | config |
  byok'` tag is reused for custom providers too (tagged `'byok'`) — no new
  pseudo-harness value needed, since a custom provider behaves identically to
  today's BYOK flow once its `{ name, url }` exists, wire format aside.

### F. Testing

- `credentialRowsFor`'s import-filter logic, extracted into a
  provider-level filter function, gets direct unit tests for: both harnesses
  present, only one present, neither present (menu item omitted), and the
  codex-preferred-over-opencode tie-break when both have a credential for the
  same provider.
- The custom-provider name/URL/wire-format entry screen gets tests for: empty
  name, name colliding with an existing/known provider (case-insensitive),
  empty URL, non-absolute URL, and the resulting `InitState` shape after
  submission.
- `parseConfig` gets tests for: `wire_format = "anthropic"` on an
  `api-key` gateway (accepted), `wire_format` on any OAuth-auth gateway
  (refused, matching the existing refusal message style), and an absent
  `wire_format` still defaulting to today's behavior (regression guard).
- `litellmConfig` gets a test asserting the new `anthropic/<id>` branch's
  exact emitted shape, alongside the existing `openai/<id>` case to guard
  against the default branch regressing.
- End-to-end `cmdInit` tests (scripted path, following the existing
  `--credential-source` test patterns) covering: bulk import selecting a
  codex-backed provider, Add provider with OAuth login for `codex`, Add
  provider with API-key entry for a known provider, and Add provider with a
  full custom provider (name + URL + anthropic wire format + API key),
  asserting the written TOML in each case.

## Open questions resolved during brainstorming

- **Does step 2 survive?** No — replaced entirely by the new menu (user
  confirmed).
- **Does "Import from other harnesses" bulk-select or go one at a time?**
  Bulk-selects everything detected (user confirmed).
- **Can both paths be mixed in one run?** Yes, via the loop-back-to-menu
  structure with a `Continue` exit (user confirmed).
- **What's in the Add-provider catalog?** Harness-known + well-known BYOK,
  merged, plus a custom-provider escape hatch with name/URL/wire-format entry
  (user confirmed).
