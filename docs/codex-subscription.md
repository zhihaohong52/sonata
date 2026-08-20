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

## What sonata still needs for Route 2

1. **A gateway auth kind.** A codex-OAuth gateway must emit
   `model: chatgpt/<id>` plus `model_info.mode: responses`, and must omit
   `api_base`/`api_key` — not the current `openai/<id>` + `api_base` +
   `os.environ/SONATA_KEY_*` shape.
2. **Write the flattened auth file** and point `CHATGPT_TOKEN_DIR` at it when
   spawning LiteLLM.
3. **Fix the well-known URL table.** `sonata init` maps `codex` →
   `https://api.openai.com/v1`, which is only correct for API-key auth and
   silently produces a gateway that can never authenticate.
4. **Teach `opencodeKeys()` to read OAuth entries.** It reads only
   `credential.key ?? credential.apiKey`, so every `type: oauth` entry in
   opencode's `auth.json` (`openai`, `github-copilot`) is invisible and reported
   as "no key" when a usable credential is present.
