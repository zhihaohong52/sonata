# Native path

The harness path runs the foreign model's *own* loop in OpenCode, Codex,
Pi, or Reasonix. The native path instead runs foreign models inside Claude
Code's own loop, tools, and permission modes, through a local routing proxy.

**The usual setup is `sonata route auto` once per project** (`sonata init`
offers it), then launching plain `claude` exactly as before. Each session
routes itself at start, the router comes up on its own, and Remote Control
keeps working. `sonata code` is for a one-off routed session somewhere you
have not set routing up.

- `sonata serve` — runs the router, and a managed LiteLLM child when any
  configured model needs one. Anthropic-native gateways go straight through
  the router and start none. The child comes up with `serve` when the config
  already needs it, and otherwise lazily, on the first request that does.
- `sonata route auto` — routes every plain `claude` session in the project
  *and* keeps Remote Control. Instead
  of leaving the routing env in the file, a SessionStart hook writes it just
  after the session launches and a SessionEnd hook removes it again, so each
  session launches from a clean file. Claude Code decides Remote Control once,
  at launch, from `ANTHROPIC_BASE_URL`; it re-reads the settings `env` on every
  request. Auto mode lives in that gap. Concurrent sessions are counted, so one
  ending never cuts another's routing. `sonata route manual` removes the pair.
  A session that dies without running its SessionEnd hook leaves routing on —
  the next launch loses Remote Control once; `sonata route off` resets it.
- `sonata route on` — routes every plain `claude` session by leaving
  `ANTHROPIC_BASE_URL` in `.claude/settings.local.json`, with a SessionStart
  hook that keeps the router up, so editor integrations, `.mcp.json` entries
  and shell aliases all go through the proxy too. Every routed session loses
  Remote Control until `sonata route off`; `sonata route status` reports which
  mode is on. Prefer `auto` unless something launches sessions in a way its
  hooks cannot reach.
- `sonata code` — launches a single routed Claude Code session
  (`ANTHROPIC_BASE_URL` points at the local router), starting the router in
  the background if it is down. No settings are written; that session loses
  Remote Control.
- `sonata auth` — manages per-gateway keys that the router forwards to LiteLLM;
  keys live in the store and are never logged or put in a conversation
- `sonata auth login <gateway>` — starts LiteLLM's device login for an OAuth gateway

The `claude` harness adapter completes the picture: it dispatches a
foreign-on-Claude-loop session through `sonata dispatch`, running headless
`claude -p` with no TUI. Native dispatches assume `sonata serve` is already up.

Two consequences worth knowing. First, `ANTHROPIC_BASE_URL` is process-wide and
`isFirstPartyAnthropicBaseUrl` gates Remote Control, so a session *launched*
routed — by `sonata code`, or under `sonata route on` — loses Remote Control.
`route auto` avoids that by routing only after launch.

Second, behind a gateway Claude Code cannot verify that a model really has the
1M window it claims natively, so it budgets those models — Sonnet 5, the Fable
models, Opus 4.7+ — at 200K instead. The window silently shrinks by 80%; the
only clue is a number in `/context`. An id carrying an explicit `[1m]` is
immune, because there is nothing left to verify: `"model": "opus[1m]"` keeps
its full window where a bare `opus` does not. `sonata doctor` prints the fix
when it applies.

### Your own Claude Code account

A tier can rank Claude models served by your own Claude Code account:

    [native.gateways."claude"]
    provider = "anthropic"
    auth = "session"

    [models."opus"]
    gateway = "claude"
    id = "claude-opus-4-1"

The router forwards the session's own credential, and only to
`api.anthropic.com` — any other `base_url` is refused. Usage is priced at
Anthropic's list rates; work your Claude subscription paid for is shown as
`$x sub` and never counts toward `[budget]`. A key named exactly like a model
your main session uses (`claude-opus-4-1`) also catches that session's own
turns when it is routed.

**OpenCode Zen and Go.** The two are separate endpoints on one opencode.ai
account: Zen (pay as you go) is `https://opencode.ai/zen/v1`, Go (the
subscription) is `https://opencode.ai/zen/go/v1`. Both route a conversation by
an `x-opencode-session` header and refuse a request without one (400
`MissingSessionID`). Since 0.13.1 the router sends it — a stable id per
conversation — and LiteLLM forwards it only to models on an `opencode.ai`
gateway; no other client `x-*` header reaches them. Earlier versions sent none,
so no native request to an opencode.ai gateway could succeed.

See also: [Codex subscription auth](codex-subscription.md), for how the
`codex-oauth` gateway type authenticates against a ChatGPT subscription rather
than a metered API key.

## The loop panel

The `sonata-loop` skill folder `sonata init` installs is also a Claude Code mod,
which Claude Code loads from the skills folder by itself. While a loop runs it
shows a side panel (toggle it with `/sonata-loop panel`; any other
arguments start a loop as before):

- **Tasks** from the loop's plan, one line each, with a state stroke: `━━`
  active, `── done`, `· · queued`, and `─ ─` for a condition (`failed 1x`,
  an escalation). The orchestrator reports these through the panel's
  `sonata_loop` tool; nothing is inferred.
- **Agents** under their task, one line each: role and tier, the model the
  router served, tokens, elapsed time and state. A running agent adds one line
  with its current tool, step count and how long ago its last step was; one
  silent for 90 s reads `─ ─ stalled`.
- **Model and cost** come from the router. `≈` means two agents on one alias
  ran at once and the router cannot say whose request was whose, so neither is
  given a cost. A dash or `cost unknown` means unpriced or unattributable,
  never `$0`.
- **Tokens** come from Claude Code itself, so they show even when the router
  cannot be read.
- **Detail**: select a row (click, or focus the pane with `ctrl+x tab` and
  press enter) to open, beneath it, its token breakdown (input, output, cache
  read, cache write) and the edits it applied. A task's detail covers its whole
  agent tree. Only applied `Edit` and `Write` calls are diffed; when `Bash` ran
  too, the detail says so.

The panel reads the router at `http://127.0.0.1:4100` by default. With a
different `[native.ports] router`, set the mod's `router_url` option. When the
router is not reachable the footer says so and the panel keeps showing what it
last reported, with its age.

The panel can also be installed as a plugin from this repo's marketplace:

```
claude plugin marketplace add zhihaohong52/sonata
claude plugin install sonata-loop@sonata
```

Claude Code loads one plugin per name, and the installed plugin wins over any
skills-folder copy, so once it is present `sonata init` and `sonata sync` write
only the skill text and remove the panel files from their copies. Update it
with `claude plugin update sonata-loop@sonata`; `sonata doctor` says when its
version is behind the package's.
