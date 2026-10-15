# Security

Sonata launches other coding agents on your machine. They run **as you**, with
your files and your credentials.

- **Read the [permission tables](permission-modes.md) before dispatching write-capable roles.**
  Codex and reasonix offer a real sandbox (reasonix reports its own
  `write_roots`, which follow `--dir`). Pi has none, and opencode's is
  advisory.
- **Sonata never bypasses a harness's own safety flags.** It does not pass
  `--dangerously-bypass-approvals-and-sandbox` to codex.
- **Harness credentials stay with the harness.** Sonata reads harness config to
  report health; it does not copy, forward or log API keys. Keys live wherever
  the harness put them — opencode keeps them in `auth.json` and the
  `credential` table of `opencode.db`, for example. Sonata's own gateway keys
  (`sonata auth add`, written by `sonata init`) are separate: they live in
  sonata's key store and flow store → environment → LiteLLM on the native
  path, and never into `sonata.toml`, agent files or argv.
- **An `auth = "session"` gateway forwards your Claude Code session
  credential.** It is passed unmodified, and only ever to `api.anthropic.com` —
  a key is only ever sent to the host it belongs to.
- **A stored key is only ever sent to a host bound to its gateway name.**
  Keys are looked up by gateway name, but the `base_url` they would be sent
  to comes from a config — including a cloned repo's project config pointing
  the name at an attacker's host. A host is bound when it is the provider's
  own endpoint, you confirmed it with `sonata auth trust <gateway> <host>`,
  or it is the machine config's own URL for that name. `sonata init` binds
  the URLs you typed in its own run; `sonata auth add` binds nothing, because
  the URL it reads comes from a config a repo can carry. Anything else gets no
  key: `sonata serve` withholds it from that tenant and answers a named 502
  that names the config setting the URL and the exact trust command, and
  `sonata doctor` fails the gateway the same way, for every project it routes.
  If you did not choose a URL, remove it from that config rather than trusting
  it. Bindings live in a 0600 file beside the key store; hostnames (with a
  non-default port) compare exactly, never suffix-matched, and https only.
  The first run after an upgrade binds, once, the hosts of the configs already
  in use that have a key; `sonata auth untrust <gateway> <host>` removes any of
  them, and `sonata auth trust-list` shows them.
- **Auto-routing sends a limited task excerpt to whatever `base_url` names.** When `[auto_route]` is set, the first message of each `-auto` subagent task is sent to that URL — TypeSafe at `api.typesafe.ai` by default, OpenRouter at `openrouter.ai/api`, or a `jev-compatible-server` you run yourself — after `<system-reminder>` blocks are removed and the text is capped at 8,000 characters. Nothing else is sent: no system prompt, tool results or later turns. The key follows the host, and a key is only ever sent to the host it belongs to: the `openrouter` key goes to `openrouter.ai` and nowhere else. A custom host gets the decision only once you trust it (`sonata auth trust auto-route <host>`, or give the URL in `sonata init`); until then the decision is skipped, the task text is not sent, and the tier falls back. The feature is off unless `[auto_route]` is written.

- **Prompt injection is a real risk.** A foreign model reading a hostile
  repository can be steered, and it has no classifier between it and your
  files. For untrusted code, dispatch read-only roles or run in a container.

Please report security issues privately, following
[SECURITY.md](https://github.com/zhihaohong52/sonata/blob/main/SECURITY.md),
rather than in a public issue.
