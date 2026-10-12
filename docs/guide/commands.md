# Commands

Every `sonata` command, grouped by what you would reach for it to do. A
mistyped command suggests the nearest real one.

## Setting up

| Command | Purpose |
|---|---|
| `sonata init` | Set up sonata in this project (interactive). Every prompt has a flag for unattended use: `--yes`, `--providers`, `--models`, `--roles`, `--config-scope`, `--scope`, `--routing`, `--guidance`, `--credential-source`; `--repropose-tiers` re-ranks from the catalog, discarding a hand-tuned order; `--prune` removes stale generated agents |
| `sonata` / `sonata tui` | Open the configuration UI. `sonata status`, `sonata usage`, `sonata agents` and `sonata init` open it at their own screen when run in a terminal |
| `sonata agents [--list] [--json]` | Every generated tier agent, what each ranked candidate resolves to, its context window, and whether the alias carries `[1m]`. In a terminal it is also the editor: re-rank a tier without walking the whole wizard |
| `sonata sync [--prune]` | Regenerate agent files from `sonata.toml`; `--prune` removes stale generated agents |
| `sonata doctor [--json]` | Check tmux, harnesses, auth and versions, the permission hook, tier routing, model rankings, catalog coverage and freshness, and more; `--json` prints the same checks as structured output |
| `sonata reset [--global] [--yes]` | Remove sonata's configuration and generated files at one scope — the config, the generated agents, the loop skill, the CLAUDE.md block, and the routing env/hooks/allow-list. Keeps your gateway keys, the usage ledger and the caches, and shows the full plan before touching anything |
| `sonata upgrade` | Install the latest published release with `npm install -g`. A development install (`npm link`) is refused and told to `git pull && npm run build` instead. Run `sonata restart` afterwards so the router runs the new version |
| `sonata --version` (`-v`) | The running version and the directory it ran from — how you tell which install answered |

## Credentials and catalogs

| Command | Purpose |
|---|---|
| `sonata auth list\|add <gateway>\|remove <gateway>\|login <gateway>` | Manage native-path gateway keys, kept in sonata's own key store. `add` reads the key from the terminal or stdin, never argv; `login` runs the OAuth flow for `codex` and `github-copilot` |
| `sonata catalog [update]` | Show the cached catalogs' age, or refresh them: the Artificial Analysis model rankings (needs a stored `artificialanalysis` key), models.dev pricing, and the auto-route decision-model scores. `sonata init` refreshes on its own when a discovered model is missing; `sonata doctor` warns when a cache goes stale |
| `sonata litellm install\|status` | Install or report sonata's own pinned LiteLLM. `status` answering `not-required` is healthy — no gateway in this config routes through it |

## The native router

| Command | Purpose |
|---|---|
| `sonata serve [--daemon]` | Run the router (and its LiteLLM child, when a gateway needs one); `--daemon` detaches. Its web UI is at `http://localhost:4100/` by default (`[native.ports] router`) |
| `sonata restart` | Stop the router sonata recorded and start a fresh daemon. Use this rather than killing it by hand |
| `sonata route auto\|manual [--global]` | Route each session for its lifetime via hooks, keeping Remote Control. `auto` is what `sonata init` offers |
| `sonata route on\|off\|status [--global]` | Route every plain `claude` session in the project (or, with `--global`, every project) through the router |
| `sonata code` | Launch a single routed Claude Code session without writing any settings, starting the router if needed (passes `claude` arguments through). Most setups use `sonata route auto` and plain `claude` instead |
| `sonata status [--session <id>\|--all] [--global]` | Whether the router is up and on which port, then recent alias → candidate served → tokens → failed attempts decisions from the ledger |
| `sonata usage [--since 7d] [--by model\|role\|tier\|route\|effort\|gateway\|lane\|session\|project] [--session <id>] [--project <dir>] [--json]` | Tokens and cost from the ledger — native requests as the router saw them, and dispatch runs read from each harness's own store once they finish (`--by lane` splits the two). Unpriced volume is reported separately, never folded into the total |

## The dispatch lane

| Command | Purpose |
|---|---|
| `sonata dispatch (--tier <role>-<tier> \| --model <key>) [--task-file <path>] "<task>"` | Blocking harness dispatch with ranked fallback — what a tier agent runs when every native route fails |
| `sonata run --role <role> --model <key> --task-file <path> [--json]` | Launch a run in the background and print its id |
| `sonata wait <id>` | Resume a running or approved run and block until its next state — finished, needs approval, or stalled |
| `sonata approve <id> (--yes\|--no)` | Answer a pending approval |
| `sonata tail <id>` | A human view of a run's progress |
| `sonata log <id>` | Print what a run printed |
| `sonata verify <id> [--model <key>]` | Verify a completed run |
| `sonata runs [--json]` | List this project's dispatch runs, with state and whether each wrote a report |
| `sonata gc` | Kill finished tmux sessions |

Any live run can also be watched directly: `tmux attach -t sonata-<id>` (add
`-r` for read-only).
