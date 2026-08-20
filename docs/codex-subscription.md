# Using a ChatGPT (Codex) subscription with sonata

Verified end to end on 2026-08-20 against codex-cli 0.147.0, LiteLLM 1.82.3,
a ChatGPT Plus account, and `gpt-5.6-luna`.

A `codex login` credential is **ChatGPT OAuth**, not an OpenAI API key. That
distinction decides everything below, and getting it wrong produces errors that
look like a missing key when nothing is missing.

## The credential

`~/.codex/auth.json` holds:

```
auth_mode: chatgpt
OPENAI_API_KEY: None
tokens.{access_token, refresh_token, id_token, account_id}
```

The access token is a JWT with `aud: ["https://api.openai.com/v1"]` and a
`chatgpt_plan_type` claim. The audience is misleading — see below.

## What the token can and cannot reach

Probed directly with curl:

| Endpoint | Result |
| --- | --- |
| `GET api.openai.com/v1/models` | 403 `Missing scopes: api.model.read` |
| `POST api.openai.com/v1/chat/completions` | **429 `insufficient_quota`** |
| `POST api.openai.com/v1/responses` | 403 `Missing scopes: api.responses.write` |
| `POST chatgpt.com/backend-api/codex/responses` | **200, streams normally** |

The 429 is the informative one: the token **authenticated and passed scope
checks**, then hit billing. A ChatGPT subscription is not API credit. The
metered `api.openai.com` API is a separate, separately-billed product.

**Therefore `base_url = "https://api.openai.com/v1"` can never work for a
ChatGPT-OAuth credential**, no matter how the key is plumbed. The correct base
is `https://chatgpt.com/backend-api/codex`, the Responses wire API, and
**streaming is mandatory** — a non-streamed request returns
`{"detail":"Stream must be set to true"}`.

The backend also validates entitlement per model: `gpt-5.6-luna` is accepted,
while `gpt-5.3-codex-spark` returns *"not supported when using Codex with a
ChatGPT account."*

## Route 1 — the codex harness (simplest, works today)

Runs the real `codex` CLI, which already speaks all of the above.

```toml
[models."gpt-5.6-luna"]
harness = "codex"
id = "gpt-5.6-luna"

[generate.roles]
code = ["gpt-5.6-luna"]
```

`sonata sync`, then dispatch. Verified: `codex exec -m 'gpt-5.6-luna' -s
workspace-write` completed a real repository task, exit 0.

Note `sonata doctor` will report `key source: codex: no key`. That refers to the
**native** gateway and is irrelevant here — the harness uses codex CLI's own
auth. Note also that `config.models` is resolved before `config.native.models`
(`src/commands/run.ts:106` vs `:111`), so adding a `[models]` entry reroutes an
existing agent without regenerating it or restarting Claude Code.

## Route 2 — the native path (foreign model inside Claude Code's own loop)

LiteLLM ships a first-class `chatgpt` provider that handles this correctly:
`CHATGPT_API_BASE` is already `https://chatgpt.com/backend-api/codex`, its
`CHATGPT_CLIENT_ID` is the same OAuth app codex uses, it forces `stream:true`
and `store:false`, sends `ChatGPT-Account-Id`, and **refreshes the token
automatically** (`_refresh_tokens`, expiry check with skew).

Working LiteLLM config — note there is **no `api_base` and no `api_key`**; the
provider supplies both:

```yaml
model_list:
  - model_name: gpt-5.6-luna
    litellm_params:
      model: chatgpt/gpt-5.6-luna
    model_info:
      mode: responses          # REQUIRED — see below
```

Credentials come from `$CHATGPT_TOKEN_DIR/auth.json` (default
`~/.config/litellm/chatgpt/`), in a **flattened** form — codex nests these under
`tokens`:

```json
{"access_token":"…","refresh_token":"…","id_token":"…",
 "expires_at":<jwt exp>,"account_id":"…"}
```

Verified: an Anthropic `/v1/messages` request with `"stream": true` streamed
`NATIVE-STREAM-OK` back through LiteLLM from the subscription.

### `mode: responses` is required

Without it LiteLLM takes the chat-completions path and POSTs to the bare
`backend-api/codex/` URL, which serves the ChatGPT **web app**. The reply is a
Cloudflare "Enable JavaScript and cookies to continue" HTML page, which surfaces
as an opaque `ChatgptException`. This is a configuration error, not bot
detection — identical requests via curl and httpx both succeed.

### Non-streaming calls fail — harmless for Claude Code

With `mode: responses`, a **non-streaming** request fails:

```
ChatgptException - Unknown items in responses API response: []
```

Root cause is upstream and not in the chatgpt provider: the Codex backend sends
`response.completed` with `output: []` and delivers items in preceding
`response.output_item.done` events, which LiteLLM's Responses→ChatCompletions
bridge never accumulates
(`completion_extras/litellm_responses_transformation/transformation.py:540`).

**Streaming clients bypass that bridge entirely**, building content from
`response.output_text.delta`. Claude Code always streams, so this never fires in
normal use. What does break: non-streaming callers — health checks, token
counting, `stream:false` probes.

Upstream: [BerriAI/litellm#25429](https://github.com/BerriAI/litellm/issues/25429),
open since 2026-04-09, fix PR
[#31332](https://github.com/BerriAI/litellm/pull/31332) still unmerged. No
stable release contains it. Reproduced on 1.82.3 here.

## How sonata implements Route 2

Configure it by marking the gateway — nothing else is needed:

```toml
[native.gateways."codex"]
auth = "codex-oauth"

[native.models."gpt-5.6-luna"]
gateway = "codex"
id = "gpt-5.6-luna"
context_window = 128000
```

`base_url` is refused here: a config naming the metered API would describe a
gateway that can never authenticate. `sonata init` writes this form by itself
when `codex login` used a ChatGPT account.

What each piece does:

- **`src/config.ts`** parses `auth`, defaulting to `api-key` so existing configs
  are unaffected, and supplies `CODEX_OAUTH_BASE_URL` for codex-oauth.
- **`src/native/litellm.ts`** emits `model: chatgpt/<id>` with
  `model_info.mode: responses` and **no** `api_base`/`api_key` — passing either
  would override the provider and break it.
- **`src/native/codex-auth.ts`** flattens `~/.codex/auth.json` into the record
  LiteLLM reads, deriving `expires_at` from the JWT.
- **`src/commands/serve.ts`** writes that record 0600 into its own temp
  directory and sets `CHATGPT_TOKEN_DIR`, then removes it on stop.
- **`src/commands/doctor.ts`** reports the credential as a subscription rather
  than telling the user to add a key that would be ignored.

Verified end to end: an Anthropic `/v1/messages` streaming request to
`sonata serve`'s router returned `"text": "OK"` from `gpt-5.6-luna`.

### The credential must not outlive serve

`serve` runs until killed, so its signal handlers *are* its normal exit path.
Without them `stop()` never runs and the temp directory survives — carrying the
generated master key and, for a codex-oauth gateway, the ChatGPT credential. One
such token was found in the system temp directory during development. `cli.ts`
now stops the handle on SIGINT/SIGTERM/SIGHUP, and `run.ts` retains the handle
it used to discard for auto-started serves.

## opencode's OAuth logins

opencode stores two OAuth credentials beside its API keys, and neither is a
bearer key:

| Entry | Value | What it actually is |
| --- | --- | --- |
| `openai` | JWT, `client_id: app_EMoamEEZ73f0CkXaXp7hrann` | The **same** ChatGPT subscription credential codex holds — same OAuth app. As an `api_key` it 429s. |
| `github-copilot` | opaque `gho_…` | A GitHub OAuth token. Must be exchanged at `api.github.com/copilot_internal/v2/token` for a short-lived Copilot key. |

`opencodeKeys()` is therefore **right** to skip them — it resolves API keys, and
these are not API keys. The bug was that they were then invisible, so `doctor`
reported "no key" for a gateway whose credential was sitting on disk. They are
now read by dedicated readers instead:

- `readOpencodeChatGptOAuth` flattens the `openai` entry into the same record
  `readCodexOAuth` produces, **after checking `client_id`** — another OpenAI
  OAuth grant would fail confusingly inside LiteLLM's chatgpt provider.
- `readChatGptOAuth` prefers codex and falls back to opencode, so
  `auth = "codex-oauth"` works for a machine that only has opencode.
- `readCopilotToken` reads the `github-copilot` entry for the
  `copilot-oauth` gateway kind.

### `auth = "copilot-oauth"`

```toml
[native.gateways."copilot"]
auth = "copilot-oauth"
```

Emits `model: github_copilot/<id>` with no `api_base`/`api_key` and **no** mode
override — Copilot speaks chat-completions, so the Responses bridge that
codex-oauth needs does not apply. `serve` writes the GitHub token to
`access-token` in its temp directory and sets `GITHUB_COPILOT_TOKEN_DIR`;
LiteLLM performs the exchange and caches the Copilot key itself.

**opencode's token usually cannot be used.** Measured on a real machine: the
stored `gho_` token carries scope **`read:user` only** — both the `access` and
`refresh` fields are the same token — so GitHub answers the exchange with

```
403 Forbidden — https://api.github.com/copilot_internal/v2/token
```

LiteLLM then drops the deployment and carries on, and the next request fails as
`no healthy deployments for this model`, naming neither the token nor the scope.
So sonata checks the scope before offering Copilot at all: `init` prints a line
and omits its models, and `doctor` fails the check with the reason. The check
asks GitHub (scopes are not in the opaque token) and **fails closed**, so an
offline machine simply does not offer Copilot rather than offering it wrongly.

To actually use `copilot-oauth`, the token must carry the `copilot` scope —
LiteLLM's own device-code login produces one, writing it to its token
directory.

**Known collision:** Copilot serves Claude models, but the router sends any
`claude-`-prefixed model to Anthropic, so `parseConfig` refuses such an id.
5 of the 8 Copilot models on this machine are Claude. `init` filters every
candidate the router cannot reach — otherwise it would write a config that
`parseConfig` then refuses to load. 27 such candidates were being offered
across `vendorx`, `anthropic` and `github-copilot`.

**opencode writes `expires: 0`** on the Copilot entry, meaning "does not
expire". Read literally that reports a working token as expired since 1970.

**LiteLLM's output is now inherited** by `serve`. A per-model startup failure
appears only there; discarding it is what made the 403 above surface as an
unrelated-looking "no healthy deployments".
