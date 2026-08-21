# Credential sources: choose, import, or log in

**Status:** design, awaiting review
**Date:** 2026-08-21

Today `sonata init` decides where every gateway's credential comes from by
sniffing files, and never tells the user it did. This design makes that an
explicit choice, records it in `sonata.toml` so it survives, and adds a login
path for subscription providers that have no API key — without sonata
implementing an OAuth flow.

## The problem

Three defects, one cause.

**The choice is invisible.** `oauthProvidersFor` (`src/commands/init.ts:201-232`)
reads `~/.codex/auth.json`, then opencode's `auth.json`, and marks a gateway
`codex-oauth` or `copilot-oauth` based on what happens to be on disk.
`resolveKeys` (`src/native/credentials.ts:64-79`) does the same for API keys with
a fixed precedence: sonata's store, then opencode, first match wins. A user with
both a personal key and an opencode login cannot express which one they meant,
and is never shown which one was taken.

**The decision does not persist.** There is no field in `sonata.toml` recording
where a gateway's credential came from. Re-running `init` re-sniffs, so the
answer can silently change when a harness is installed or logged out.

**A subscription needs a harness installed.** `serve` throws when no ChatGPT
credential is found (`src/commands/serve.ts:230-236`) and tells the user to run
`codex login`. So the zero-harness story that BYOK established for API keys stops
at subscriptions, which is where the models people actually want live.

There is also a live bug adjacent to all of this: `serve` writes the ChatGPT
credential into `join(tempDir, 'chatgpt')` (`serve.ts:238-240`) and the Copilot
token into `join(tempDir, 'copilot')` (`serve.ts:255-257`). LiteLLM refreshes
tokens **into those files**, and that directory is deleted when serve stops, so
every refresh sonata's own child performs is thrown away.

## What already exists (probed, 2026-08-21)

The central finding: **sonata does not need to implement OAuth.** LiteLLM 1.82.3
— the version this project pins — already ships device-code login for both
providers.

| Fact | Evidence |
| --- | --- |
| ChatGPT device login exists | `litellm/llms/chatgpt/authenticator.py:151` `_login_device_code()` |
| It uses the Codex OAuth app | `CHATGPT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"`, `common_utils.py:20` |
| It reads/refreshes/logs in from one entry point | `Authenticator().get_access_token()`, `authenticator.py:44-71` |
| It writes the token itself | `CHATGPT_TOKEN_DIR`, default `~/.config/litellm/chatgpt`, `authenticator.py:33-38` |
| It prints the code to stdout, flushed | `authenticator.py:162-168` |
| Copilot device login exists | `github_copilot/authenticator.py:341` `_login()` |
| It uses a Copilot GitHub App | `GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98"`, `authenticator.py:21` |
| That app is live and issues device codes | `POST github.com/login/device/code` returned `user_code`, `expires_in: 899`, `interval: 5` |
| **Its token really can exchange for a Copilot key** | Authorized login 2026-08-22: `ghu_` token, `x-oauth-scopes` empty, `copilot_internal/v2/token` returned a 419-char key, `sku: copilot_for_business_seat_quota` |
| Poll windows differ sharply | ChatGPT `DEVICE_CODE_TIMEOUT_SECONDS = 15*60`; Copilot `max_attempts = 12` × 5 s = **60 s**, then 3 retries each issuing a new code |
| The interpreter is discoverable | `head -1 $(command -v litellm)` names it; both authenticators import from it |
| **Login needs no codex install and no prior codex login** | Probed 2026-08-22: with `PATH=/usr/bin:/bin` (so `shutil.which("codex")` is `None`) and an empty `CHATGPT_TOKEN_DIR`, `_request_device_code()` returned a live `user_code`. `authenticator.py` contains no `subprocess`, no `shutil.which`, and no reference to the codex binary or to `~/.codex/auth.json`. |

Three consequences shape everything below.

**A user who has never installed codex can still sign in.** This is the case the
feature exists for, so it is stated as its own consequence rather than left to be
inferred. LiteLLM's authenticator is a self-contained HTTP client against
`auth.openai.com`; the Codex CLI's OAuth app id is a string constant compiled
into LiteLLM, not something read from a codex installation. `get_access_token()`
reads the auth file, finds nothing (`_read_auth_file() -> None`), and falls
through to `_login_device_code()` at `authenticator.py:71`. Nothing on that path
touches codex.

The distinction that matters: **codex is one possible credential *source*, never
a prerequisite for the `sonata` source.** Picking `credentialSource: 'codex'`
imports an existing `~/.codex/auth.json` and does require codex; picking
`credentialSource: 'sonata'` runs the device flow and requires only a ChatGPT
account and a browser. Today's code offers only the first, and `serve` throws
when that file is absent (`serve.ts:230-236`) — which is precisely why "I never
installed codex" and "I have codex but never used its OAuth login" are both dead
ends right now. The wizard must therefore offer `sonata` **unconditionally**, and
gate only the `codex`/`opencode` import rows on the corresponding credential file
actually existing.

**Sonata never has to hold the token.** LiteLLM's authenticator writes the
credential into a directory sonata chooses. Sonata sets an environment variable
and reads back only existence and expiry. For OAuth gateways this retires the
entire "credential copied into a temp directory" hazard that `serve`'s signal
handlers exist to contain.

**Login is a subprocess, not a protocol.** Driving it means spawning the
interpreter that owns `litellm` with the token directory set, streaming its
stdout, and waiting for exit.

## Architecture: credential sources

A gateway's credential has exactly one **source**, named in config:

- `sonata` — sonata's own store. For `api-key`, that is `keys.json`. For an
  OAuth gateway, a token minted by a sonata-driven login, living under
  `~/.config/sonata/credentials/<gateway>/`.
- `codex` — read through to `~/.codex/auth.json`.
- `opencode` — read through to `~/.local/share/opencode/auth.json`.

**Imported credentials are never copied into sonata's store.** The harness that
owns the credential keeps refreshing it, and it remains the single durable copy.
Storing our own would produce a snapshot that goes stale the moment codex
refreshes, and would make sonata responsible for refreshing a credential it did
not mint.

This is a claim about *ownership*, not about bytes at rest: `serve` still
materializes a reshaped 0600 copy in its temp directory for the read-through
sources, because LiteLLM's on-disk format differs from codex's and that
reshaping is exactly what `src/native/codex-auth.ts` exists for. That copy is
ephemeral and is destroyed with the temp directory on exit.

This generalizes `resolveKeys`'s existing `SOURCES` list from an implicit
precedence into a named, recorded choice. `resolveKeys` keeps its current
behaviour as the fallback when no source is recorded, so existing configs are
unaffected.

## Config schema

`NativeGatewayConfig` (`src/config.ts:73`) gains one optional field:

```toml
[native.gateways.codex]
auth = "codex-oauth"
credential_source = "sonata"      # sonata | codex | opencode

[native.gateways.openrouter]
base_url = "https://openrouter.ai/api/v1"
credential_source = "sonata"
```

```ts
export type CredentialSource = 'sonata' | 'codex' | 'opencode';
export const CREDENTIAL_SOURCES: readonly CredentialSource[] =
  ['sonata', 'codex', 'opencode'];

export interface NativeGatewayConfig {
  baseUrl: string;
  auth: NativeGatewayAuth;
  credentialSource?: CredentialSource;
}
```

Parsing rules, enforced in `parseConfig` beside the existing `auth` validation
(`config.ts:175-205`):

- Absent means "resolve as today". Every config written before this change keeps
  working, and `sonata init` is not required to migrate anything.
- An unknown value is refused by name, listing the valid ones — the same
  treatment `auth` already gets at `config.ts:179-183`.
- `credential_source = "codex"` is refused on a gateway whose `auth` is
  `api-key`: codex holds a subscription, not a bearer key, and handing that token
  to a metered endpoint produces a 429 that reads as a missing key. This is the
  documented failure in `docs/codex-subscription.md` and the parser is where it
  should die.
- `credential_source = "opencode"` is allowed for both, because opencode holds
  API keys *and* OAuth entries.

## Login mechanism

One module, `src/native/oauth-login.ts`, with a single job: run LiteLLM's
authenticator to completion and report what happened.

```ts
export interface LoginProgress {
  /** A line LiteLLM printed — includes the verification URL and user code. */
  line(text: string): void;
}

export interface LoginResult {
  ok: boolean;
  /** Present when the flow failed, safe to display — never token material. */
  problem?: string;
}

export function credentialDir(home: string, gateway: string): string;

export async function loginGateway(opts: {
  home: string;
  gateway: string;
  auth: NativeGatewayAuth;      // codex-oauth | copilot-oauth
  progress: LoginProgress;
  signal?: AbortSignal;
  /** Injected in tests; defaults to resolving litellm's shebang. */
  interpreter?: string;
}): Promise<LoginResult>;
```

Mechanics:

1. Resolve the interpreter by reading the first line of `command -v litellm` and
   stripping `#!`. If `litellm` is absent, fail with the same install guidance
   `doctor` already gives — LiteLLM is a prerequisite, like tmux.
2. `mkdirSync(credentialDir(home, gateway), { recursive: true, mode: 0o700 })`.
3. Spawn the interpreter with `-c` running
   `Authenticator().get_access_token()` for the matching provider, with
   `CHATGPT_TOKEN_DIR` or `GITHUB_COPILOT_TOKEN_DIR` set to that directory and
   **no other parent environment forwarded except `PATH`**, matching how `serve`
   already builds `childEnv` (`serve.ts:222`).
4. Stream stdout line by line into `progress.line`. LiteLLM's own text includes
   "Device codes are a common phishing target. Never share this code."
   **Relay that line verbatim; do not reformat it away.**

   **The printed block is the only source of the verification URL.** Probed
   2026-08-22: ChatGPT's device-code response carries exactly
   `device_auth_id`, `user_code`, `interval` — no `verification_uri`, no
   `expires_in` (`authenticator.py:195-207`). The URL is the constant
   `CHATGPT_DEVICE_VERIFY_URL = "https://auth.openai.com/codex/device"`,
   interpolated into a fixed four-line print at `authenticator.py:162-168`. So
   sonata cannot read a URL field out of a structured response and must not
   invent one: it relays those printed lines. Do not re-derive the URL in
   sonata's own code — a second copy of the constant is one LiteLLM upgrade away
   from pointing users at the wrong page.
5. Resolve when the child exits. Success is the child exiting 0 *and* the
   credential file existing — an exit code alone is not evidence, the same
   discipline the run engine applies to report files.

The flow is cancellable: `signal` kills the child, because a ChatGPT login blocks
for up to fifteen minutes and a user who changed their mind must not be stuck.
(Copilot blocks for 60 seconds per attempt — see the Copilot section below; the
two providers differ by a factor of fifteen and the UI must not assume either.)

**Entry point, per provider:** ChatGPT `Authenticator().get_access_token()`;
Copilot `Authenticator().get_access_token()` followed by `get_api_key()`. Copilot
needs both because the device login and the Copilot exchange are separate calls,
and only the second proves the credential is usable. Never call `_login()` — it
does not persist.

**Cooldown is real and must be surfaced.** `DEVICE_CODE_COOLDOWN_SECONDS` is 300
(`authenticator.py:27`). An abandoned login followed by a retry inside five
minutes makes LiteLLM *wait* rather than issue a fresh code, which reads as a
hang. When `_wait_for_access_token` is the path taken, sonata says so.

**Copilot retries internally, up to three times.** `get_access_token` loops over
`_login()` three times before raising (`github_copilot/authenticator.py:64-79`),
so one failed attempt can print three successive codes. The UI renders the most
recent code rather than accumulating them, or a user reads a stale one and the
poll never completes.

## Command surface

`sonata auth` gains `login <gateway>` and keeps its existing `list`/`add`/`remove`.
The wizard calls the same `loginGateway`; there is one implementation and two
entry points. A command is required regardless of the wizard, because tokens
expire and re-authenticating months later must not mean re-running `init`.

`sonata auth list` reports source and health per gateway, carrying no secret
material — it is `keyReport` extended with OAuth expiry from `codexAuthReport`.

## TUI changes

One new screen, between the provider picker (step 2) and the models step, shown
**once per selected provider that has more than one available source**. A
provider with exactly one possible source is not asked about; the wizard should
not manufacture a decision.

```
Credential for openai
> Log in with ChatGPT            device code, no API key needed
  Import from codex              ~/.codex/auth.json · expires in 6d
  Import from opencode           ~/.local/share/opencode/auth.json
  Enter an API key               metered api.openai.com billing
```

Rows are built from what actually exists: `readCodexOAuth`, `readOpencodeChatGptOAuth`,
`readCopilotToken` and `resolveKeys` already answer "is there one, and is it
healthy". An unhealthy credential is listed with its problem rather than hidden,
because "codex has one but it expired" is the answer to a question the user is
about to ask.

**Only the import rows are conditional.** "Log in" and "Enter an API key" are
always offered, because neither depends on another tool being installed — a
machine with no codex, no opencode and no harness at all still shows both. The
"more than one available source" rule above is therefore about hiding *import*
rows that would lead nowhere, never about hiding login. A provider whose only
row is "Log in" still shows this screen when its auth is OAuth, since consenting
to a browser login is itself the decision being asked about.

Choosing "Log in" pushes a sub-screen that renders `progress.line` output live,
with the URL and code prominent, and Escape to cancel. On success the wizard
records `credentialSource: 'sonata'` and continues.

This replaces `oauthProvidersFor`'s silent sniffing at the point of *choice*.
The function survives as the thing that computes **defaults** — what to
pre-select — because the existing rationale at `init.ts:192-200` still holds:
opencode's `openai` provider may hold a subscription on one machine and a key on
another, and only reading the credential can tell.

Existing wizard invariants that must not regress:

- Keys and tokens stay out of `InitState` serialization. `byokKeys` is in-memory
  only (`types.ts:20`); a login writes through LiteLLM to disk and puts nothing
  in wizard state.
- Back must work. The new screen participates in the existing `Math.max(0, step - 1)`
  walk and the per-provider cursor pattern `ByokStep` already uses.
- Nothing is persisted before the confirm gate, matching `init.ts:790-795`. A
  completed OAuth login is the deliberate exception — it happened at a real
  identity provider and cannot be un-done by cancelling the wizard, so the
  summary screen states that the login already landed.

## serve changes

For an OAuth gateway, `serve` stops copying:

```
credentialSource = 'sonata'    → point the env var at credentialDir(home, gateway)
credentialSource = 'codex'     → flatten ~/.codex/auth.json into tempDir, as today
credentialSource = 'opencode'  → flatten opencode's entry into tempDir, as today
absent                         → today's behaviour (readChatGptOAuth precedence)
```

The `sonata` case sets `CHATGPT_TOKEN_DIR` / `GITHUB_COPILOT_TOKEN_DIR` directly
to the persistent directory. No copy is made, no temp file is written, and
**LiteLLM's refresh persists** — which is the adjacent bug fixed as a
consequence, not as a separate change.

The read-through cases keep writing a 0600 temp file because the on-disk formats
differ and the reshaping is what `codex-auth.ts` exists for. Those refreshes are
still discarded, which is correct: codex CLI owns that credential and refreshes
its own copy.

`serve`'s refusal when no credential exists (`serve.ts:230-236`) gains the
remedy that now exists: `run \`sonata auth login <gateway>\``.

## doctor changes

`doctor` reports the recorded source per gateway and whether that source actually
has a usable credential — a config naming `codex` on a machine where codex was
uninstalled is a blocker with a named fix, not a confusing downstream 401. The
existing Copilot scope check (`init.ts:496-502`) keeps failing closed and gains
the same remedy line.

## Scripted path

`--yes` cannot perform a device login: it blocks on a human visiting a URL. The
scripted path therefore refuses by name, exactly as it already does for a missing
BYOK key (`init.ts:678-686`):

```
sonata init: gateway "codex" needs a credential. Log in first: sonata auth login codex
```

`--credential-source <gateway>=<source>` is added so a scripted run can *record*
a choice whose credential already exists. There is deliberately no flag that
performs a login, for the same reason there is no `--key`: credentials must not
be reachable from argv.

## Security

- No token material passes through sonata's process on the `sonata` source path.
  LiteLLM writes it; sonata reads existence and expiry only.
- `~/.config/sonata/credentials/` is created `0700`, matching the `0600`
  discipline `writeSonataKey` already applies to `keys.json`.
- The login child inherits `PATH` and the token-directory variable, nothing else.
- Device codes are phishing-sensitive. LiteLLM's warning line is relayed verbatim
  and sonata adds no UI that would make a code look routine.
- Nothing is logged: the init log records the gateway a credential belongs to,
  never its value (`init-log.ts:12-14`), and that rule extends to tokens.
- Driving OAuth means sonata triggers a flow that identifies as the Codex CLI to
  OpenAI. This is not new — it is what LiteLLM's `chatgpt` provider already does
  on every native codex request today — but making it user-initiated from
  sonata's own UI is a more visible position, and `docs/codex-subscription.md`
  should say so plainly.

## Testing

The suite runs with no API keys and no network, so:

- `loginGateway` takes an injected `interpreter`, and tests point it at a fake
  script that prints a canned device-code block and writes a fake credential
  file. Captured from real LiteLLM output, per the fixtures convention.
- Cases: success; child exits non-zero; child exits 0 but writes no credential
  (must fail, not silently succeed); cancellation via `signal`; `litellm` absent.
- `parseConfig` cases: each valid source round-trips; unknown source refused by
  name; `codex` + `api-key` refused; absent field preserves today's resolution.
- `serve` cases: `sonata` source sets the env var to the persistent directory and
  writes no temp credential; each read-through source still writes 0600; the
  refusal message names `sonata auth login`.
- Wizard cases: the source screen is skipped when only one source exists; back
  works from it; a recorded source lands in the emitted TOML.

## Validation gate before building the Copilot half — PASSED 2026-08-22

**Settled by an authorized device login.** The Copilot half is unblocked; build
it. What was inference is now measurement:

| Check | Result |
| --- | --- |
| Device login completes | `ghu_…`, 40 chars |
| Scopes GitHub granted | `x-oauth-scopes: ''` — **empty** |
| `copilot_internal/v2/token` exchange | **succeeded**, key 419 chars |
| Entitlement | `sku: copilot_for_business_seat_quota`, `chat_enabled: true` |
| Endpoints returned | `api: https://api.business.githubcopilot.com` (+ exp, proxy, telemetry) |

**The empty scope string is the whole explanation.** LiteLLM's token is `ghu_`, a
GitHub *App* user-to-server token, and it carries no OAuth scopes at all — its
entitlement comes from the app installation. opencode's is `gho_` with
`read:user`, an OAuth-App token whose scope cannot authorize the exchange. So the
two credentials are not the same kind of thing, and "opencode has a GitHub token"
never implied "Copilot will work". Sonata must keep treating them as distinct
sources rather than interchangeable GitHub tokens.

Three consequences for implementation, each learned from this run:

- **Call `get_access_token()`, never `_login()`.** Only the former writes
  `access-token`. Calling `_login()` returns a valid token and persists nothing,
  so the next call starts a *second* device flow against an empty directory —
  observed exactly once here, costing a wasted authorization.
- **Never hardcode `api.githubcopilot.com`.** This account resolved to a
  business tenant. `get_api_base()` (`authenticator.py:135-150`) reads
  `endpoints.api` out of `api-key.json`, so the right behaviour is to let LiteLLM
  resolve it and to pass no `api_base` — the same rule the codex gateway already
  follows for a different reason.
- **`api-key.json` is short-lived and refreshed in place.** `get_api_key()`
  compares `expires_at` against now and re-exchanges when stale
  (`authenticator.py:93-114`). That makes the persistent credential directory
  load-bearing rather than a tidiness preference: under today's temp directory
  the exchange is redone from scratch every `serve`, and any failure to re-obtain
  it surfaces as "no healthy deployments".

**The 60-second window is the real UX risk, not entitlement.** Copilot polls
`max_attempts = 12` × 5 s = **60 seconds** (`authenticator.py:285`), where ChatGPT
allows `DEVICE_CODE_TIMEOUT_SECONDS = 15 * 60`. On expiry `get_access_token()`
retries `_login()` three times (`authenticator.py:64-76`), and **each retry issues
a brand-new code**, so a user still reading the first one authorizes a code that
is no longer being polled. This timed out on the first live attempt here.

The login screen must therefore, for Copilot specifically: show the URL and code
the instant they are printed; render a visible countdown of the 60 seconds;
and when a new code supersedes an old one, **replace** it and say so, never
accumulate codes. A pre-flight line — open the page first, then start — belongs
in the screen, because the minute begins at code issuance, not at the user's
first glance.

## Out of scope

- Anthropic subscription credentials. The router sends every `claude-` model to
  Anthropic and `parseConfig` refuses such ids; nothing here changes that.
- Implementing any OAuth protocol in sonata.
- Migrating existing configs. The field is optional and absence means today's
  behaviour.
- Refreshing credentials sonata did not mint.
