# sonata

**Foreign-model subagents for Claude Code.**

[![ci](https://github.com/zhihaohong52/sonata/actions/workflows/ci.yml/badge.svg)](https://github.com/zhihaohong52/sonata/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/tag/zhihaohong52/sonata?label=release&sort=semver)](CHANGELOG.md)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)

Claude Code's subagents are excellent, but they are always Claude. Sonata lets
you dispatch a subagent backed by a different model, through the ordinary
Agent tool — same interface, same working directory, same report contract.
Different brain.

Two ways to run it:

- **Native** — the foreign model runs *inside Claude Code's own loop*: its
  tools, its permission modes, no separate TUI. A local routing proxy
  (`sonata serve`) makes this possible; see the [Native path guide](docs/guide/native-path.md).
  This is the default: `sonata init` generates one tier agent per role, each
  backed by a ranked list of models the router tries in order.
- **Harness** — the foreign model runs in *its own* CLI (OpenCode, Codex, Pi,
  Reasonix), launched in a detached tmux session and driven through
  `sonata dispatch`. No proxy required — this is the fallback lane: when
  every native route for a tier has failed, the router says so and names the
  `sonata dispatch --tier <role>-<tier>` command, which the agent runs itself.

Two reasons you might want that:

- **Cost.** Mechanical work — bulk refactors, test scaffolding, migrations —
  does not need a frontier model. A cheap high-cache model is an adequate
  substitute, and the difference over a working day is large.
- **Diversity of judgement.** Asking Claude to review Claude's work surfaces
  fewer problems than asking a different model family. Review is where a second
  opinion actually pays.

```
● code-deepseek-v4-flash (running)
  └ sonata: tail a1f3e2
     → read  src/parser.ts
     → edit  src/parser.ts  +31 −12
     → bash  pytest -q → 47 passed
  done — "Refactored the parser. Tests pass."
```

## Status

**Working, early.** The engine and the OpenCode, Codex, Pi and Reasonix
harness adapters are complete and tested, each verified end to end against a
real model. The native path (`sonata serve`/`sonata code`/`sonata restart`
and the `claude` harness adapter) is also complete and verified live —
routing, permission modes, and the router's Codex-overload handling have all
been confirmed against real dispatches.

Read [Limitations](docs/guide/limitations.md) and
[Security](docs/guide/security.md) before depending on it.

## Requirements

- **Node 22+**
- **tmux** — every harness runs inside a tmux session (`brew install tmux`,
  `apt install tmux`)
- **LiteLLM — managed, and only when a gateway needs it.** Sonata installs its
  own pinned copy into `~/.config/sonata/litellm` (`sonata litellm install`,
  offered by `sonata init`), so `pip install` by hand is no longer a step. A
  gateway that speaks the Anthropic Messages API natively is reached directly
  with no LiteLLM in the path at all — such a config needs no Python whatsoever.
  When one *is* needed, `uv` (fastest, and can fetch a conforming interpreter)
  or a `python3` in `>=3.10,<3.15` is required.
- **macOS or Linux.** Sonata launches bash scripts inside tmux and manages
  process groups directly; Windows is not supported. WSL should work but is
  untested.
- **A provider.** Either an API key for one of ~30 well-known providers (see
  [BYOK](#byok-bring-your-own-key) — no harness needed), or at least one of the
  harnesses below, authenticated:
  - **[OpenCode](https://opencode.ai)** — any provider it supports
  - **[Codex CLI](https://github.com/openai/codex)** — `codex login`
  - **[Pi](https://github.com/earendil-works/pi-mono)** — any provider it
    supports; model ids take the `provider/id` form
  - **[Reasonix](https://github.com/esengine/DeepSeek-Reasonix)** — `reasonix setup`;
    any OpenAI-compatible endpoint is a config entry, and model ids take the
    `provider/id` form
  - **Claude Code** — the `claude` harness adapter (native path; see the
    [Native path guide](docs/guide/native-path.md))

## Install

```bash
npm install -g @zhihaohong52/sonata
```

### From source

For working on sonata itself, or to run a change that has not been released:

```bash
git clone https://github.com/zhihaohong52/sonata.git
cd sonata
npm install
npm run build
npm link          # puts `sonata` on your PATH
```

`sonata` on your PATH runs `dist/`, not `src/` — after changing anything under
`src/`, run `npm run build` or the command keeps its old behaviour.

Then, in the repository where you want to use it:

```bash
sonata init
```

`sonata init` detects your environment, reports anything broken with the command
that fixes it, and asks which providers, models and roles you want.

Provider setup is a menu, modeled on opencode's own `/connect`: bulk-import
everything you're already logged into elsewhere, or add providers one at a
time — including one sonata has never heard of.

```
  ███████╗ ██████╗ ███╗   ██╗ █████╗ ████████╗ █████╗
  ██╔════╝██╔═══██╗████╗  ██║██╔══██╗╚══██╔══╝██╔══██╗
  ███████╗██║   ██║██╔██╗ ██║███████║   ██║   ███████║
  ╚════██║██║   ██║██║╚██╗██║██╔══██║   ██║   ██╔══██║
  ███████║╚██████╔╝██║ ╚████║██║  ██║   ██║   ██║  ██║
  ╚══════╝ ╚═════╝ ╚═╝  ╚═══╝╚═╝  ╚═╝   ╚═╝   ╚═╝  ╚═╝

  foreign-model subagents for Claude Code

  ✓ tmux 3.7b
  ✓ opencode 1.18.19 · 520 models
  ✓ codex codex-cli 0.149.0 · 6 models

  Set up providers
  ❯ Import from other harnesses
    Add provider

  ↑↓ choose · enter confirm · ← back · esc cancel
```

**Import from other harnesses** bulk-selects providers your installed
harnesses are already authenticated for — nothing to type, nothing to
re-enter. It lists every provider with a detected credential (an OAuth grant
or a plain API key sitting in another harness's own store), whether or not
it is already configured, and pre-checks the ones that are — so the same
screen doubles as a toggle: unchecking an already-imported provider removes
it, along with its models and any role assignments that used them:

```
  Import from other harnesses

  filter: █

  ❯ ◉ codex     · expires in 8d
    ○ openai    · expires in 8d

  2 of 2 · space toggle · type to filter · enter confirm · esc cancel
```

**Add provider** searches the merged catalogue of every provider a harness
knows about plus ~30 well-known BYOK providers — or lets you type in one
sonata has never seen:

```
  Add provider

  filter: █

  ❯ acme                · opencode
    anthropic           · opencode
    codex               · codex
    deepseek            · byok
    ⋮
    Add a custom provider…

  38 of 38 · ↑↓ choose · type to filter · enter confirm · ← back · esc cancel
```

Picking a known provider offers **Run OAuth login** (for `codex` and
`github-copilot`, the two providers sonata can authenticate on its own — see
the [Native path guide](docs/guide/native-path.md)) or **Enter an API key**.
Picking a harness-catalogued provider then shows its models to select from:

```
  Models to enable

  filter: gpt█

  ❯ ◉ openai/gpt-5.6-sol      · GPT-5.6 Sol
    ○ openai/gpt-5.6-luna     · GPT-5.6 Luna

  2 of 13 · space toggle · type to filter · enter confirm · esc cancel
```

Then it asks you to rank your selected models into `simple`/`complex` tiers per
role — pre-sorted by a cached Artificial Analysis catalog (`sonata catalog
update`, with a free key from [artificialanalysis.ai](https://artificialanalysis.ai))
when one exists, or built-in defaults otherwise. `complex` is ordered by raw
capability and `simple` by capability **per task-dollar**, so demanding work
goes to the strongest model you picked and grunt work to the one that returns
the most per dollar rather than merely the cheapest. Set `avoid_gateways` in
`sonata.toml` to rank a particular gateway's models last without dropping them
as fallbacks. It then asks whether the config
applies to this project or the whole machine, writes `sonata.toml`, generates
one agent per role × tier, offers to install the permission hook, installs the
`sonata-loop` skill, and offers to run `sonata route auto` so the generated
agents have a router to reach. Project scope writes `./sonata.toml` and
`./.claude/agents/`; machine scope writes `~/.config/sonata/sonata.toml` and
`~/.claude/agents/`, where Claude Code offers the agents in every repository.

Claude Code picks up the new agents automatically; no restart is needed.

Every prompt has a flag, so it also works unattended:

```bash
sonata init --yes --providers opencode/openai --models opencode-openai-gpt-5.6-sol --roles code,review --scope project
```

### BYOK (bring your own key)

Sonata does not need a harness. **Add provider** lists ~30 well-known
providers alongside anything your harnesses discovered; pick one, enter its
API key, and choose from the models it reports. A provider not on that
list — an internal proxy, a self-hosted endpoint — doesn't need to be:
**Add a custom provider…**, at the bottom of that same search list, asks for
a name, a base URL, and whether it speaks OpenAI's or Anthropic's wire
format, then drops into the same key-entry flow.

The key is stored in sonata's own key store — never in `sonata.toml`, never in
an agent file, and never on the command line. It is written only after you
confirm the summary, so cancelling the wizard stores nothing.

Unattended, with the key stored first so it stays out of argv and shell history:

```bash
sonata auth add deepseek
sonata init --yes --providers byok/deepseek --models deepseek-deepseek-v4-flash --roles code
```

BYOK models use the [native path](docs/guide/native-path.md), so they run
inside Claude Code's own loop, tools and permission modes.

Two things worth knowing before you pick a provider:

- **Model discovery is a convention, not a guarantee.** Sonata asks the provider
  for `GET <base_url>/models`, which every provider in its list implements. If
  yours does not answer — offline, or a different shape — the wizard asks you to
  type the model ids instead, saying which of those happened. That is a
  fallback, not an error.
- **A rejected key gets its own screen.** If the provider answers 401 or 403,
  sonata says so and offers to take a different key. It also offers to keep the
  one you gave and type ids by hand, because some providers refuse to list
  models for a key that works perfectly well for inference.
- **`claude-*` models are not offered.** The router forwards that prefix to
  Anthropic, so a `claude-` id cannot be served through a gateway. Aggregators
  such as OpenRouter list plenty of them; sonata filters them out rather than
  writing a config it would then refuse to load.

### Adding Codex models

**The wizard discovers OpenCode, Pi and Reasonix models** by provider then by
model, and **Codex through `codex app-server`'s `model/list`** (JSON-RPC over
stdio — codex has no provider dimension and takes a bare model id). Hand-written
codex entries survive `sonata init`, so a bare-id model can also be added by
hand:

```toml
[models."gpt-5-6-sol"]
harness = "codex"
id = "gpt-5.6-sol"
```

Hand-written entries survive `sonata init` — the wizard carries through any
model whose harness it does not manage.

Then run `sonata sync` to regenerate the agent files; Claude Code picks them up automatically.

## Using it

The generated agents are ordinary registry entries, so Claude selects them the
same way it selects any other subagent. Ask for one by name, or describe work
that suits it:

> "Use code-simple to convert these callbacks to async/await."

> "Get review-complex to look at the auth refactor."

Judging `simple` vs `complex` is a call you make per task — mechanical,
well-specified, single-file work is `simple`; cross-cutting, ambiguous, or
design-sensitive work is `complex`. When unsure, use `-complex`. The
`sonata-loop` skill `sonata init` installs (`skills/loop/SKILL.md`) drives
this across a whole feature: plan, route each task to a tier, gate behind
review, escalate a task to `complex` after two failed reviews at `simple`.

They compose with everything Claude Code already does — parallel fan-out,
workflows, and `isolation: "worktree"`.

## How it works

`sonata init` generates one agent per role × difficulty tier — `code-simple`,
`code-complex`, `review-simple`, and so on. Each agent's frontmatter names a
router alias (`model: sonata-code-simple`), not a specific model:

```
Claude Code
    │  Agent(subagent_type: "code-simple")
    ▼
sonata-code-simple  (native — runs in Claude Code's own loop)
    │  model: sonata-code-simple
    ▼
router  (sonata serve)
    │  resolves the alias against [tiers.code].simple, tries each
    │  candidate in rank order, skips one in cooldown after a failure
    ▼
litellm → flash-1   (or the next-ranked model, on failure)
```

The router is the only place ranking lives — the agent just sends its alias
and gets an answer from whichever model actually worked. If every native
candidate for a tier fails, the router returns 529 naming the fallback:
`sonata dispatch --tier code-simple`, which the agent runs itself to reach a
model through its own harness (OpenCode, Codex, Pi, or Reasonix) instead:

```
sonata dispatch --tier code-simple "<task>"
    │  resolves the tier's harness-routed candidates, in rank order
    ▼
sonata CLI
    │  composes role prompt + CLAUDE.md + task
    │  launches harness in a detached tmux session, waits for it
    ▼
opencode → deepseek-v4-flash   (next candidate on a degraded/empty finish)
```

`sonata dispatch` blocks until the run finishes, needs approval, or stalls,
trying the next ranked candidate on a thrown launch, a degraded finish, or an
empty report; `sonata wait`/`sonata approve` resume or unblock a specific run
by id. `sonata tail` remains available as a human/debugging view of any run.

Completion is read from an exit sentinel and a report file, never scraped from
the terminal. If a harness dies without writing a report, sonata returns the
captured pane and marks the result `degraded` — so you always know when a
result is untrustworthy.

Progress comes from diffing the tmux pane. You can attach to any live run:

```bash
tmux attach -t sonata-<id>     # -r for read-only
```

Attaching means you can correct a cheap model that is going off the rails
instead of paying for the rest of a wasted run.

`run_timeout_seconds` is a hard cap, enforced by a watchdog inside the launched
shell rather than by `sonata tail` — a runaway run with nobody watching is
exactly the case that needs bounding. On expiry the whole process group is
killed and the run is reported `DONE`, `degraded`, with a report beginning
`[timed out: …]`.

## Commands

| Command | Purpose |
|---|---|
| `sonata init` | Set up sonata in this project (interactive); `--prune` removes stale generated agents |
| `sonata doctor` | Check tmux, harnesses, auth and versions |
| `sonata sync` | Regenerate agent files from `sonata.toml`; `--prune` removes stale generated agents |
| `sonata run` | Launch a run, print its id |
| `sonata dispatch (--tier <role>-<tier> \| --model <key>)` | Blocking harness dispatch with ranked fallback — the fallback lane a tier agent reaches for when every native route fails |
| `sonata tail` | Human/debugging view of a run |
| `sonata approve` | Answer a pending approval |
| `sonata log <id>` | Print a run's whole transcript |
| `sonata verify <id> [--model <key>]` | Verify a completed run |
| `sonata auth` | Manage native-path gateway keys (`list`, `add <gateway>`, `remove <gateway>`, `login <gateway>`) |
| `sonata catalog [update]` | Show the cached Artificial Analysis catalog's age, or refresh it (needs a stored `artificialanalysis` key). `sonata doctor` warns when it goes stale |
| `sonata serve` | Run the native router and its managed LiteLLM child (`--daemon` detaches) |
| `sonata restart` | Kill whatever sonata router currently holds the port and start a fresh daemon |
| `sonata code` | Launch a Claude Code session routed through the local proxy (passes `claude` args through) |
| `sonata route on\|off\|status [--global]` | Route every plain `claude` session in the project (or, with `--global`, every project) through the proxy via settings.local.json/settings.json |
| `sonata route auto\|manual [--global]` | Route each session for its lifetime via SessionStart/SessionEnd hooks, keeping Remote Control |
| `sonata usage [--since 7d] [--by model\|role\|tier\|gateway\|session\|project] [--session <id>] [--json]` | Tokens and cost from the router's ledger (**native path only** — `sonata dispatch` runs never transit the router and are unobservable); unpriced volume is reported separately, never folded into the total |
| `sonata status [--session <id>\|--all]` | Whether the router is up and on which port, then the recent alias → candidate served → tokens → failed attempts decisions from the ledger; reachability and routing state live in `sonata route status` |
| `sonata runs [--json]` | List this project's dispatch runs |
| `sonata gc` | Kill finished tmux sessions |

## Documentation

The essentials are above. Deep-dive reference lives in
[`docs/guide/`](docs/guide/):

| Guide | Covers |
|---|---|
| [Native path](docs/guide/native-path.md) | Running foreign models inside Claude Code's own loop through the local routing proxy |
| [Codex subscription auth](docs/guide/codex-subscription.md) | Authenticating the `codex-oauth` gateway against a ChatGPT subscription |
| [Permission modes](docs/guide/permission-modes.md) | How each harness honours Claude Code's permission modes |
| [Configuration](docs/guide/configuration.md) | The `sonata.toml` schema, resolution order, and roles/tiers |
| [Troubleshooting](docs/guide/troubleshooting.md) | Symptom → cause table |
| [Security](docs/guide/security.md) | What sonata does and doesn't protect against |
| [Limitations](docs/guide/limitations.md) | Known gaps worth knowing before depending on this |
| [Adding a harness](docs/guide/adding-a-harness.md) | The adapter extension point |

Where this is headed: [Roadmap to 1.0](docs/roadmap.md).

Design history — every feature's spec and implementation plan, kept as a
permanent record — is indexed in [`docs/superpowers/`](docs/superpowers/).
Architecture reviews are in [`docs/reviews/`](docs/reviews/). What using
sonata to implement sonata taught about sizing and verifying dispatched work
is in [`docs/dispatching-work-through-sonata.md`](docs/dispatching-work-through-sonata.md).

## Development

```bash
npm install
npm test          # 1177 tests; needs tmux
npm run typecheck
npm run build
```

The test suite runs against a **fake harness** — a scripted binary replaying a
normal run, a crash, a real captured approval prompt, a hang that the watchdog
must kill, a clean exit with no report, and a harness-written report — so the
whole engine is covered with no API spend and no harness installed.

See [Adding a harness](docs/guide/adding-a-harness.md) for the extension
point, and [Documentation](#documentation) above for the design-history index.

## Contributing

Issues and pull requests are welcome.

- Run `npm test` and `npm run typecheck` before opening a PR; CI runs both on
  Linux with tmux installed.
- Add tests for behaviour you change. The suite needs no API keys.
- Prefer evidence to inference: if a change depends on how a harness behaves,
  say how you verified it. A captured fixture beats a plausible regex.
- Keep harness-specific knowledge inside its adapter.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release notes.

## License

MIT — see [LICENSE](LICENSE).
