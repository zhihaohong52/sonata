# Configuration

```toml
# sonata.toml
[models."flash"]
gateway = "acme"                    # native route: this key resolves through the router
id = "deepseek-v4-flash-0731"

[models."kimi-k3"]
harness = "opencode"                # harness route: sonata dispatch --tier/--model falls back to this
id = "openrouter/kimi-k3"

[native.gateways."acme"]
base_url = "https://gateway.acme.example/v1"

[tiers.code]
simple  = ["flash", "kimi-k3"]       # tried in this order; a cooling-down candidate is skipped
normal  = ["flash", "kimi-k3"]       # optional; absent is valid, empty is refused
complex = ["kimi-k3", "flash"]

[run]
tail_window_seconds     = 20     # how long `sonata tail` blocks per call
stall_timeout_seconds   = 120    # silence before a run is reported STALLED
run_timeout_seconds     = 1800   # hard cap; the run is killed at this point
dispatch_window_seconds = 1500   # how long `sonata wait` blocks before giving up
```

A `[models."<key>"]` entry can carry `gateway`/`id` (native), `harness`/`harness_id`
(dispatch fallback), or both — one model, two routes. `sonata init` writes this
shape for you; see [Using it](getting-started.md#using-it) for how the generated agents use it.

A native model that answers `Function tools with reasoning_effort are not supported
… use /v1/responses` (seen from `gpt-6.1-sol` and `gpt-6-astra` on an
OpenAI-compatible gateway) needs `api = "responses"` on its entry. That sends it
to the gateway's `/responses` endpoint instead of `/chat/completions`. It only
applies to an `api-key` gateway reached through LiteLLM, and is refused anywhere
else. `sonata init` keeps the line when it rewrites the file, and adds it itself
for a model models.dev says is served only there (OpenCode Go's GPT models, for
one); `sonata doctor` names any such model that lacks it.

`api = "google"` does the same for a model served only on Google's own
protocol — OpenCode Go's Gemini models. OpenCode Go serves that protocol only at
`https://opencode.ai/inference/go/v1`, not the older `…/zen/go/v1`; `sonata
init` now writes the first, and `sonata doctor` tells you if a gateway needs
switching.

## Where sonata.toml lives

Sonata looks for a config in three places, in order, and uses exactly one:

1. `./sonata.toml` — the current repository
2. `sonata.toml` in a linked git worktree's main checkout, when the worktree
   has none of its own
3. `~/.config/sonata/sonata.toml` — the machine

A project config wins outright; it is never merged with the machine one. So a
repository with its own `sonata.toml` sees only that file, and adding one
repo-specific model means copying the machine entries alongside it.

`sonata init` asks which you want, and writes the agents to match — project
agents into `./.claude/agents/`, machine agents into `~/.claude/agents/`, where
Claude Code offers them in every repository. Use `--config-scope project|global`
to skip the prompt.

`sonata doctor` prints the config path it actually used.

Roles live in `roles/*.md` and are owned by sonata rather than the harness, so
"review" means the same thing whichever model performs it — which is what makes
comparing two models' reviews meaningful.

Four roles ship: `code`, `review`, `explore` and `plan`. The last three are
**read-only**, enforced by the harness rather than by the prompt alone — a
read-only sandbox on codex, a tool allowlist on pi, a read-only agent on
opencode. The strength of that guarantee differs per harness; see
[Permission modes](permission-modes.md).

Each role chooses its own ranked model list, per tier, through `[tiers.<role>]`.
`simple` and `complex` are required; `normal` is optional. An absent `normal`
list is valid: no `<role>-normal` agent is generated, and a `sonata-<role>-normal`
alias resolves to nothing. A present-but-empty list is refused at parse time.
The older flat `[generate.roles]`/`[generate.native]` pair is
migrated automatically the next time you run `sonata init` (a config still in
that shape parses fine in the meantime — `sonata doctor` just points at
`init` to migrate it).

A tier candidate may pin a reasoning-effort level: `"gpt-5.6-luna@xhigh"`.
The level is one of `default`, `none`, `minimal`, `low`, `medium`, `high`,
`xhigh`, `max`. `default` means run the model as it ships — no
`reasoning_effort` is sent at all. The level belongs to the *slot*, not the
model — the same model may sit in `simple` at `high` and in `complex` at
`max`. `sonata init` ranks every
level Artificial Analysis has scored for a model as its own row, because for
the current generation the level is often the larger lever: GPT-5.6 Luna at
`max` out-scores GPT-5.6 Terra at every level below `max`, at an eighth of
the cost per task.

**A bare candidate whose model the catalog holds at any effort level is
refused when the config loads** — a family of one counts, because its single
row is still a level to pin. Ranked bare, it is scored at the model's
default row (usually its highest level) and dispatched with no level at all,
so what the ranking promised and what runs are different models. The error
names the candidate, its levels and its default; `sonata init` re-ranks
every tier with levels. With no catalog cache the check cannot run, and
`sonata doctor` says so.

**What a pinned level actually does.** A native tier agent's requests carry
`reasoning_effort` at that level, recorded on each ledger row — `sonata usage
--by effort` breaks spend down by it. A `sonata dispatch` run passes it to the
harness: `-c model_reasoning_effort` on codex, `--variant` on opencode,
`--thinking` on pi (where `none` becomes pi's own `off`), and in the model name
for the claude harness, which routes back through sonata's router. `sonata
dispatch --model <key>@<effort>` takes the same grammar as a tier candidate,
and refuses an unknown level rather than dropping it.

Where sonata has no way to set a level — reasonix today, because it was not
installed on the machine the others were probed on — the run goes ahead at the
harness default and its report opens with `[effort xhigh not honoured: sonata
has no effort control for reasonix]`. That is a note, not a failure: the report
is still trusted, and the run is not marked degraded. Effort is a preference,
unlike a permission mode, which sonata refuses rather than quietly downgrades.

One limit worth stating: sonata can see that it sent the level, not that the
model applied it. A gateway without an effort control drops the field silently,
and `opencode run` accepts a `--variant` a model does not publish without
complaining. The evidence a level did anything is cost per task moving with it
in `sonata usage`.

Run `sonata sync` after editing the config; Claude Code picks up the
generated agents automatically.

## Auto-routed tiers

Opt in per project by adding:

```toml
[auto_route]
classifier = "jev"
min_confidence = 0.5
```

`classifier` must be `"jev"`; `min_confidence` is optional and must be between 0 and 1 (the default is `0.5`).

Jev is asked wherever `base_url` points — any http(s) URL speaking its API:

- TypeSafe directly (the default, `https://api.typesafe.ai`). Store the key with `sonata auth add typesafe`.
- OpenRouter (`base_url = "https://openrouter.ai/api"`), using the key your `openrouter` gateway already uses (`sonata auth add openrouter`, or one opencode holds). No TypeSafe account is needed.
- A self-hosted `jev-compatible-server`, e.g. `base_url = "http://localhost:8000"`. A local server usually needs no key; any other host takes one stored with `sonata auth add auto-route` when there is one.

The key follows the host and is only ever sent to it: the OpenRouter key goes to `openrouter.ai`, the TypeSafe key to `api.typesafe.ai`. The key is read when each classification is made and is never logged.

```toml
[auto_route]
classifier = "jev"
base_url = "https://openrouter.ai/api"
# model = "typesafe/jev-1.13"            # optional pin; skips selection
min_confidence = 0.5
```

Unless `model` pins one, sonata lists the decision models the URL serves (cached an hour per URL) and takes the one with the highest JevBench capability score — an exact tie goes to the cheaper listed price, and a model JevBench does not score never beats one it does. With nothing scored, it uses `~typesafe/jev-latest` on `openrouter.ai`, `jev-latest` on `api.typesafe.ai`, and sends no `model` field to any other host (the server's default). `model` skips that choice: pin a Jev release with `model = "typesafe/jev-1.13"`, or name any other decision model the URL serves. Run `sonata catalog update` to cache the JevBench scores; `sonata doctor` shows the URL, the key it needs, and the model chosen.

When enabled, `sonata sync` generates a `<role>-auto` agent for each role whose tiers differ. Jev chooses among that role's available `simple`, `normal` and `complex` tiers once per conversation; the selected tier then follows the same ranked native routing path as its explicit tier agent. If the key is missing, the request fails, the task is empty, Jev returns an invalid or low-confidence answer, or the deadline is exceeded, sonata falls back to `normal`, or `complex` when `normal` is unavailable. Use the explicit tier agents when you already know the right tier.

Classifier calls are not charged against `[budget] daily_usd`. `sonata usage --by route` separates auto-routed requests from manual tier requests and reports classifier token volume beside the priced total. Where the response reports a cost (OpenRouter's does), `sonata usage` sums it and shows it apart from the priced total; a decision asked on a loopback URL (`localhost`, `127.0.0.0/8`, `::1`) is recorded as free ($0) even when its response reports no cost, and only a non-loopback decision whose response reports no cost stays unpriced.

## Seeing and changing a ranking

`sonata agents` prints every generated tier agent, what each of its ranked
candidates resolves to, that model's context window, and whether the agent's
alias carries `[1m]`:

```text
code-simple
    1. flash                        acme/deepseek-v4-flash-0731  128K
    2. kimi-k3                      opencode/openrouter/kimi-k3  window unknown  harness only
```

Three things there are invisible in the file itself: what a key actually
resolves to, whether every native candidate clears 1M (which is what decides
the `[1m]` suffix, and it has to hold for *whichever* model answers, not the
best one), and whether a key still names a model at all.

Run it in a terminal and it is also the editor — `enter` re-ranks one list
through the same picker `sonata init` uses, `w` writes and regenerates the
agent files. `--list` prints without the editor, `--json` emits the same rows
for a script.

**A saved ranking is never re-ranked for you.** Upgrading sonata, or
refreshing the catalog, changes what `sonata init` would propose but leaves
your saved order alone. On the ranking board, `r` replaces that list with the
order the catalog suggests now; it is written only when you confirm with
`enter` and `w`, and `←` discards it. `sonata init --repropose-tiers` does the
same for every list at once.

**The `--json` shape changed when effort levels landed.** A row's `key` now
holds the whole candidate, `@effort` included (`acme-big@high`), rather than a
bare key into `[models]`, and a sibling `effort` field carries the level on its
own. A script that fed `key` straight back into a `[models]` lookup needs to
split it — `key` is the candidate, not the model.

It is the only writer of `sonata.toml` besides `sonata init`, and it replaces
the `[tiers]` tables alone: every other byte of your config, including
hand-written `price` entries and `pricing_provider`, is left exactly where it
was. It refuses to write at all if the file changed while the editor was open,
rather than reverting a tier you edited elsewhere.

## Starting over

`sonata reset` removes what `sonata init` wrote at one scope — the config, the
generated agents, the loop skill, the managed `CLAUDE.md` block, and the
routing env, lifecycle hooks, permission hook and tool allow-list from the
settings files. Add `--global` for the machine scope, `--yes` to skip the
confirmation.

It removes **only what sonata wrote**: an agent file you wrote by hand survives,
`permissions.allow` keeps every entry that is not sonata's, and `CLAUDE.md`
loses what is between the sonata markers and nothing else. It **keeps** what is
expensive to recreate — your gateway keys, the usage ledger, the ranking and
pricing caches, and the `.sonata/` run store — and prints that list, so a
reset never silently costs you your credentials or spend history. The full plan
is shown, path by path, before anything is touched.

## Config keys

The whole grammar `sonata.toml` parses. Top-level keys must sit above every
`[table]` header — a bare key after one belongs to that table.

**Top level**

- `schema_version` — integer stamp; the current value is `2` and a newer one
  is refused. Older files are migrated in memory on every load; nothing is
  written back.
- `avoid_gateways` — list of gateway names whose models rank last in every
  tier. Demotion, never exclusion: they stay as last-resort candidates. An
  unknown name is refused, so a typo cannot read as an unused setting.
- `gateway_order` — list of gateway names that breaks ranking *ties* only; a
  gateway left out is neutral. An unknown or repeated name is refused.

**`[budget]`**

- `daily_usd` — positive number of US dollars. It counts priced spend only
  (unpriced volume is reported beside it, never folded in as zero), including
  a `sonata dispatch` run once that run finishes. Both the router and
  `sonata dispatch` refuse at the cap — but a dispatch run cannot be stopped
  midway, so one run can carry spend past it. Subscription-covered work — a
  `codex-oauth`, `copilot-oauth` or Claude `session` gateway, or any gateway
  on a flat-rate plan (see `billing` below) — shows as `$x sub` and never
  counts. A non-positive or non-numeric value is refused
  at parse time; remove the table to run without a cap.

**`[native.ports]`**

- `router` — port for `sonata serve`'s router (default `4100`).
- `litellm` — port for the managed LiteLLM child (default `4000`).

**`[native.gateways."<name>"]`**

- `base_url` — the endpoint (required on an `api-key` gateway). An OAuth
  gateway cannot point it anywhere but the URL its credential reaches —
  naming the metered OpenAI API on a `codex-oauth` gateway is refused (see
  [Codex subscription auth](codex-subscription.md)); an `auth = "session"`
  gateway accepts only `https://api.anthropic.com`.
- `auth` — `api-key` (default), `codex-oauth`, `copilot-oauth`, or `session`.
- `provider` — one of `openai`, `anthropic`, `gemini`, `deepseek`, `mistral`,
  `groq`, `openrouter`, selecting the wire dialect LiteLLM speaks.
  `wire_format = "openai"|"anthropic"` is the older spelling; `provider` wins
  when both are set. Neither may be set on an OAuth gateway, whose dialect is
  fixed by its auth.
- `credential_source` — `sonata`, `codex`, or `opencode`: which login the
  gateway reads. `codex` is refused with `api-key` and with `copilot-oauth`,
  and `session` cannot set it. See
  [Codex subscription auth](codex-subscription.md#which-login-a-gateway-reads).
- `billing` — `subscription` or `metered`, on an `api-key` gateway only:
  whether it is a flat-rate plan. Subscription work is valued at list but
  never billed per token, so it is reported as covered and left out of
  `[budget]`. Unset, the endpoint decides — see
  [Subscription plans](native-path.md#subscription-plans) — so set it only for
  a plan that shares its pay-as-you-go endpoint (MiniMax, Synthetic, Chutes,
  NanoGPT, Ollama Cloud, Cerebras Code), or to correct sonata. An OAuth or
  `session` gateway cannot set it.
- `price` — rates as below.
- `pricing_provider` — name(s) of the models.dev provider(s) whose rates
  price this gateway's models, instead of hand-written ones. For a plan
  endpoint, `sonata init` proposes the plan's pay-as-you-go sibling (`zai`
  for the GLM Coding Plan), because models.dev lists plans at $0.

**`[models."<key>"]`**

- `gateway` — the native route's gateway name; or `harness` — the dispatch
  route's harness (`opencode`, `codex`, `pi`, `reasonix`, `claude`); or both.
- `id` — the upstream model id for `gateway`, the harness-side ref for
  `harness` alone.
- `harness_id` — optional harness-side id when the two differ. Unset, codex
  takes `id` bare, opencode/pi/reasonix take `<gateway>/<id>`, and `claude`
  takes the config key.
- `api = "responses"` — send to the gateway's `/responses` endpoint instead
  of `/chat/completions`; `api = "google"` — send over Google's
  `generateContent` protocol at the gateway's base URL. Only on an `api-key`
  gateway reached through LiteLLM; refused anywhere else.
- `context_window` — tokens, for the native route (default `128000`).
- `price` — rates as below.

**`price`** (on a model or a gateway) is USD per 1,000,000 tokens: `input`,
`cached_input`, `cache_write`, `output`, each optional; a rate of `0` is a
real price (a free tier). `windows` is an optional array of tables with
`from` and `to` as UTC `HH:MM` plus the same rate keys; evaluated in order,
the first match wins. A window whose `from` equals its `to` is refused.
