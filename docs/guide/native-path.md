# Native path

The harness path runs the foreign model's *own* loop in OpenCode, Codex,
Pi, or Reasonix. The native path instead runs foreign models inside Claude
Code's own loop, tools, and permission modes, through a local routing proxy:

- `sonata serve` — runs the router and a managed LiteLLM child
- `sonata code` — launches a single Claude Code session routed through the proxy
  (`ANTHROPIC_BASE_URL` points at the local router); auto-starts
  `sonata serve --daemon` if the router is down
- `sonata route on` — routes *every* plain `claude` session launched in the
  project, not just ones started by `sonata code`: it writes the same
  `ANTHROPIC_BASE_URL` env into `.claude/settings.local.json` and installs a
  SessionStart hook that keeps the router up, so editor integrations, `.mcp.json`
  entries and shell aliases all go through the proxy too. `sonata route off`
  undoes it; `sonata route status` reports whether routing is on. The same
  Remote Control trade-off as `sonata code` applies, project-wide: every routed
  session loses Remote Control until you `sonata route off`.
- `sonata route auto` — routes every session *and* keeps Remote Control. Instead
  of leaving the routing env in the file, a SessionStart hook writes it just
  after the session launches and a SessionEnd hook removes it again, so each
  session launches from a clean file. Claude Code decides Remote Control once,
  at launch, from `ANTHROPIC_BASE_URL`; it re-reads the settings `env` on every
  request. Auto mode lives in that gap. Concurrent sessions are counted, so one
  ending never cuts another's routing. `sonata route manual` removes the pair.
  A session that dies without running its SessionEnd hook leaves routing on —
  the next launch loses Remote Control once; `sonata route off` resets it.
- `sonata auth` — manages per-gateway keys that the router forwards to LiteLLM;
  keys live in the store and are never logged or put in a conversation
- `sonata auth login <gateway>` — starts LiteLLM's device login for an OAuth gateway

The `claude` harness adapter completes the picture: it dispatches a
foreign-on-Claude-loop session through `sonata dispatch`, running headless
`claude -p` with no TUI. Native dispatches assume `sonata serve` is already up.

Two consequences worth knowing. First, `ANTHROPIC_BASE_URL` is process-wide and
`isFirstPartyAnthropicBaseUrl` gates Remote Control, so sessions launched by
`sonata code` lose Remote Control while routed through the local proxy. Second,
model keys and ids beginning with `claude-` are refused at parse time, because
the router sends that prefix to Anthropic.

See also: [Codex subscription auth](codex-subscription.md), for how the
`codex-oauth` gateway type authenticates against a ChatGPT subscription rather
than a metered API key.
