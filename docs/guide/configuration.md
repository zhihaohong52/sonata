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
complex = ["kimi-k3", "flash"]

[run]
tail_window_seconds   = 20     # how long `sonata tail` blocks per call
stall_timeout_seconds = 120    # silence before a run is reported STALLED
run_timeout_seconds   = 1800   # hard cap; the run is killed at this point
```

A `[models."<key>"]` entry can carry `gateway`/`id` (native), `harness`/`harness_id`
(dispatch fallback), or both — one model, two routes. `sonata init` writes this
shape for you; see [Using it](../../README.md#using-it) for how the generated agents use it.

## Where sonata.toml lives

Sonata looks for a config in two places, in order:

1. `./sonata.toml` — the current repository
2. `~/.config/sonata/sonata.toml` — the machine

A project config wins outright; it is not merged with the machine one. So a
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

Each role chooses its own ranked model list, per difficulty tier, through
`[tiers.<role>]`; the older flat `[generate.roles]`/`[generate.native]` pair is
migrated automatically the next time you run `sonata init` (a config still in
that shape parses fine in the meantime — `sonata doctor` just points at
`init` to migrate it).

Run `sonata sync` after editing the config; Claude Code picks up the
generated agents automatically.
