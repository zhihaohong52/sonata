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

Each role chooses its own ranked model list, per tier, through `[tiers.<role>]`.
`simple` and `complex` are required; `normal` is optional. An absent `normal`
list is valid and preserves the previous behavior, while a present-but-empty
list is refused at parse time. The older flat `[generate.roles]`/`[generate.native]` pair is
migrated automatically the next time you run `sonata init` (a config still in
that shape parses fine in the meantime — `sonata doctor` just points at
`init` to migrate it).

A tier candidate may pin a reasoning-effort level: `"gpt-5.6-luna@xhigh"`.
The level is one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`,
`max`, and it belongs to the *slot*, not the model — the same model may sit
in `simple` at `high` and in `complex` at `max`. `sonata init` ranks every
level Artificial Analysis has scored for a model as its own row, because for
the current generation the level is often the larger lever: GPT-5.6 Luna at
`max` out-scores GPT-5.6 Terra at every level below `max`, at an eighth of
the cost per task.

**A bare candidate whose model the catalog scores at several levels is
refused when the config loads.** Ranked bare, it is scored at the model's
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
resolves to, whether every candidate clears 1M (which is what decides the
`[1m]` suffix, and it has to hold for *whichever* model answers, not the best
one), and whether a key still names a model at all.

Run it in a terminal and it is also the editor — `enter` re-ranks one list
through the same picker `sonata init` uses, `w` writes and regenerates the
agent files. `--list` prints without the editor, `--json` emits the same rows
for a script.

**The `--json` shape changed when effort levels landed.** A row's `key` now
holds the whole candidate, `@effort` included (`acme-big@high`), rather than a
bare key into `[models]`, and a sibling `effort` field carries the level on its
own. A script that fed `key` straight back into a `[models]` lookup needs to
split it — `key` is the candidate, not the model.

It is the only writer of `sonata.toml` besides `sonata init`, and it replaces
the `[tiers]` tables alone: every other byte of your config, including
hand-written `[price]` blocks and `pricing_provider`, is left exactly where it
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
