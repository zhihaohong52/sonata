# sonata

**Foreign-model subagents for Claude Code.**

[![ci](https://github.com/zhihaohong52/sonata/actions/workflows/ci.yml/badge.svg)](https://github.com/zhihaohong52/sonata/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)

Claude Code's subagents are excellent, but they are always Claude. Sonata lets
you dispatch a subagent backed by a different model — running in that model's
own harness — through the ordinary Agent tool. Same interface, same working
directory, same report contract. Different brain.

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

**Working, early.** The engine and the OpenCode, Codex, Pi and Reasonix adapters are
complete and tested, each verified end to end against a real model.

Not yet published to npm — install from source (below). Read
[Limitations](#limitations) and [Security](#security) before depending on it.

## Requirements

- **Node 22+**
- **tmux** — every harness runs inside a tmux session (`brew install tmux`,
  `apt install tmux`)
- **LiteLLM (optional, native path only)** — install with `pip install 'litellm[proxy]'`
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
  - **Claude Code** — the `claude` harness adapter (native path; see
    [Native path](#native-path))

## Install

Sonata is not on npm yet. Install from source:

```bash
git clone https://github.com/zhihaohong52/sonata.git
cd sonata
npm install
npm run build
npm link          # puts `sonata` on your PATH
```

Once it is published, this becomes `npm install -g @zhihaohong52/sonata`.

Then, in the repository where you want to use it:

```bash
sonata init
```

`sonata init` detects your environment, reports anything broken with the command
that fixes it, and asks which providers, models and roles you want.

The same model id is often served by several providers, and they are different
choices — different routing, different billing. So you pick a provider first:

```
  ███████╗ ██████╗ ███╗   ██╗ █████╗ ████████╗ █████╗
  ██╔════╝██╔═══██╗████╗  ██║██╔══██╗╚══██╔══╝██╔══██╗
  ███████╗██║   ██║██╔██╗ ██║███████║   ██║   ███████║
  ╚════██║██║   ██║██║╚██╗██║██╔══██║   ██║   ██╔══██║
  ███████║╚██████╔╝██║ ╚████║██║  ██║   ██║   ██║  ██║
  ╚══════╝ ╚═════╝ ╚═╝  ╚═══╝╚═╝  ╚═╝   ╚═╝   ╚═╝  ╚═╝

  foreign-model subagents for Claude Code

  ✓ tmux 3.7b
  ✓ opencode 1.18.16 · 496 models
  · pi not installed

  Providers

  filter: █

  ❯ ◉ opencode · openai        · 13 models
    ○ opencode · opencode-go   · 18 models
    ○ opencode · openrouter    · 341 models
    ○ pi · opencode-go         · 12 models

  9 of 9 · space toggle · type to filter · enter confirm · esc cancel
```

then the models within them. Long lists scroll and filter as you type, because
one provider alone can offer several hundred:

```
  Models to enable

  filter: gpt█

  ❯ ◉ openai/gpt-5.6-sol      · GPT-5.6 Sol
    ○ openai/gpt-5.6-luna     · GPT-5.6 Luna

  2 of 13 · space toggle · type to filter · enter confirm · esc cancel
```

Finally it asks whether the config applies to this project or the whole
machine, writes `sonata.toml`, generates one agent per role × model, and offers
to install the permission hook. Project scope writes `./sonata.toml` and
`./.claude/agents/`; machine scope writes `~/.config/sonata/sonata.toml` and
`~/.claude/agents/`, where Claude Code offers the agents in every repository.

Claude Code picks up the new agents automatically; no restart is needed.

Every prompt has a flag, so it also works unattended:

```bash
sonata init --yes --providers opencode/openai --models opencode-openai-gpt-5.6-sol --roles code,review --scope project
```

### BYOK (bring your own key)

Sonata does not need a harness. `sonata init` lists ~30 well-known providers
alongside anything your harnesses discovered; pick one, enter its API key, and
choose from the models it reports.

The key is stored in sonata's own key store — never in `sonata.toml`, never in
an agent file, and never on the command line. It is written only after you
confirm the summary, so cancelling the wizard stores nothing.

Unattended, with the key stored first so it stays out of argv and shell history:

```bash
sonata auth add deepseek
sonata init --yes --providers byok/deepseek --models deepseek-deepseek-v4-flash --roles code
```

BYOK models use the [native path](#native-path), so they run inside Claude
Code's own loop, tools and permission modes.

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

Hand-written entries survive `sonata init` - the wizard carries through any
model whose harness it does not manage, and adds it to `generate.models`.

Then run `sonata sync` to regenerate the agent files; Claude Code picks them up automatically.

## Using it

The generated agents are ordinary registry entries, so Claude selects them the
same way it selects any other subagent. Ask for one by name, or describe work
that suits it:

> "Use code-deepseek-v4-flash to convert these callbacks to async/await."

> "Get review-kimi-k3 to look at the auth refactor."

They compose with everything Claude Code already does — parallel fan-out,
workflows, and `isolation: "worktree"` (the harness inherits the wrapper's
working directory, so worktree isolation works with no extra configuration).

## How it works

```
Claude Code
    │  Agent(subagent_type: "code-deepseek-v4-flash")
    ▼
wrapper agent  (MCP-only — relays, never reasons)
    │  mcp__sonata__dispatch / wait / approve
    ▼
sonata CLI
    │  composes role prompt + CLAUDE.md + task
    │  launches harness in a detached tmux session
    ▼
opencode → deepseek-v4-flash
```

The wrapper holds `mcp__sonata__dispatch`, `mcp__sonata__wait` and
`mcp__sonata__approve`, and no Bash. It never parses harness output; it calls
the MCP tools and relays. All harness-specific knowledge lives in one adapter
file. Bash access was tested and silently ignored by Claude Code, so
`tools: Bash(sonata:*)` is not a supported alternative.

`dispatch` launches a run and blocks until it finishes, needs approval, stalls,
or reaches its blocking window. `wait` resumes a run after approval or when a
previous call returned `RUNNING`. The MCP surface deliberately has no polling
tool; `sonata tail` remains available as a human/debugging CLI command.

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

## Native path

The harness path above runs the foreign model's *own* loop in OpenCode, Codex,
Pi, or Reasonix. The native path instead runs foreign models inside Claude
Code's own loop, tools, and permission modes, through a local routing proxy:

- `sonata serve` — runs the router and a managed LiteLLM child
- `sonata code` — launches a Claude Code session routed through the proxy
  (`ANTHROPIC_BASE_URL` points at the local router); auto-starts
  `sonata serve --daemon` if the router is down
- `sonata auth` — manages per-gateway keys that the router forwards to LiteLLM;
  keys live in the store and are never logged or put in a conversation

The `claude` harness adapter completes the picture: it dispatches a
foreign-on-Claude-loop session through the existing MCP path, running headless
`claude -p` with no TUI. Native dispatches assume `sonata serve` is already up.

Two consequences worth knowing. First, `ANTHROPIC_BASE_URL` is process-wide and
`isFirstPartyAnthropicBaseUrl` gates Remote Control, so sessions launched by
`sonata code` lose Remote Control while routed through the local proxy. Second,
model keys and ids beginning with `claude-` are refused at parse time, because
the router sends that prefix to Anthropic.

## Permission modes

Sonata mirrors your Claude Code permission mode onto the harness. A sonata
agent is never more permissive than the session that spawned it — where a
harness cannot honour a mode, sonata refuses the run rather than downgrading it
quietly.

**OpenCode:**

| Claude Code mode | agent | auto-approve |
|---|---|---|
| `plan` | `plan` (read-only) | no |
| `default` | refused for write-capable roles — see below | — |
| `acceptEdits` | `build` | yes |
| `bypassPermissions` | `build` | yes |

`opencode run` has no approval UI at all. Probed against opencode 1.18: with
permissions unset it runs commands unasked, and with `permission = { bash =
"ask" }` it does not ask either — it auto-rejects:

```
! permission requested: bash (rm file.txt); auto-rejecting
```

So `default` — "ask me first" — cannot be honoured. Rather than run an opencode
agent ungated while claiming otherwise, sonata refuses to launch a
write-capable role in `default` mode and says so. Read-only roles still run,
having nothing to ask about. To use opencode for edits, dispatch in
`acceptEdits` or `bypassPermissions`, or use a codex model, whose TUI does
prompt.

**Pi** has the strictest enforcement of the three, and the least negotiable
limits. Its docs say it "intentionally does not include built-in MCP,
sub-agents, permission popups, plan mode, to-dos, or background bash", and it
has no sandbox — so like opencode it cannot honour `default`, and refuses:

| Claude Code mode | tools |
|---|---|
| `plan` | `--tools read,grep,find,ls` |
| `default` | refused for write-capable roles |
| `acceptEdits` | all built-in tools |
| `bypassPermissions` | all built-in tools |

Unlike opencode's agent selection, pi's `--tools` allowlist is real: asked to
create a file with the write tool withheld, the model reports having no write
tool and no file appears. Note the consequence — a read-only pi run cannot
write `report.md` either, so sonata takes its terminal output as the report and
does **not** mark it degraded. A read-only run that crashes or times out is
still flagged.

Pi has no sandbox, so it draws no distinction between `acceptEdits` and
`bypassPermissions`. If you need isolation, run it in a container.

**Codex** maps onto its sandbox policy directly, and can be approved:

| Claude Code mode | invocation | sandbox |
|---|---|---|
| `plan` | `codex exec` | `read-only` |
| `default` | interactive TUI, `approval_policy=on-request` | `workspace-write` |
| `acceptEdits` | `codex exec` | `workspace-write` |
| `bypassPermissions` | `codex exec` | `danger-full-access` |

`codex exec` cannot raise an approval prompt, so `default` mode uses the
interactive TUI — otherwise a sonata agent could write without ever asking,
which would be more permissive than the session that spawned it. Sonata never
passes `--dangerously-bypass-approvals-and-sandbox`. Its stdout stays attached
to tmux: piping it through `tee` makes codex print `Error: stdout is not a
terminal` and exit 0. After `report.md` lands, sonata clears the TUI composer
and sends Ctrl-D so the run writes its exit sentinel rather than stalling.

On first entry to a directory, the codex TUI blocks on a directory-trust
question before any work starts. Sonata surfaces it as a `PAUSED` prompt, and
`sonata doctor` warns when the project has not been trusted yet, so a
`default`-mode run does not stall on it unexpectedly.

Codex also writes its final message to a file (`-o`), so sonata has a
harness-guaranteed report and degrades to pane text far less often.

**Reasonix** has real approval cards, so like codex it can honour `default`:

| Claude Code mode | invocation | asks |
|---|---|---|
| `plan` | `reasonix run --permission-mode dontAsk` | no — denies instead |
| `default` | interactive TUI, `--permission-mode ask` | yes |
| `acceptEdits` | `reasonix run --permission-mode acceptEdits` | no |
| `bypassPermissions` | `reasonix run --permission-mode bypassPermissions` | no |

Reasonix has a `plan` mode of its own, but `reasonix run` refuses it outright —
"--permission-mode plan requires an interactive session", exit 2 — so read-only
work uses `dontAsk`, which denies without prompting. That enforcement is real
and covers the shell too: asked to read one file and write another, the model
read it fine and was refused both the write tool and a `printf … > file`
fallback. As with pi, a read-only run therefore cannot write `report.md`, so
sonata takes its terminal output as the report and does **not** mark it
degraded.

Sonata never passes `-y`/`--auto`. That flag aliases reasonix's *own* `auto`
mode, which is wider than Claude Code's — it skips risk prompts for operations
like `git push`. Since Claude's `auto` maps to `acceptEdits`, reaching for the
similarly named flag would silently widen permissions.

Two quirks worth knowing. Reasonix loads the working directory's `.mcp.json` on
top of its own config, so a dispatched model inherits whatever MCP servers your
project defines — including sonata itself, if you have it configured there;
`sonata doctor` warns when it sees one. And on a machine that has never
answered it, the very first `reasonix` invocation blocks on a telemetry consent
question before the agent starts at all, which looks exactly like a model that
never said anything — `sonata doctor` reports that as a blocker, and
`reasonix config telemetry off` clears it.

### The permission hook

The mode is not exposed as an environment variable, so this needs a
`PreToolUse` hook — which `sonata init` offers to install, at project or global
scope. Without it, sonata assumes `default`. For codex that is simply the
cautious choice; for opencode and pi it means dispatches refuse, so
`sonata doctor` reports a missing hook as a blocker rather than letting it
surface on first use.

**`auto` mode.** Claude Code's current default mode is `auto`: it runs tool
calls its classifier judges lower-risk without prompting, and blocks the rest.
Sonata maps it to `acceptEdits`, which is the closest thing it can actually
enforce on another harness — work proceeds without prompting, as it does in the
parent session. The residual gap is worth stating plainly: the foreign harness
has no such classifier, so it will run things auto mode would have blocked.
Dispatch in `plan` mode, or to a read-only role, when that matters.

The hook does nothing in projects that have no `sonata.toml`, so a global
install will not litter unrelated repositories.

## Commands

| Command | Purpose |
|---|---|
| `sonata init` | Set up sonata in this project (interactive); `--prune` removes stale generated agents |
| `sonata doctor` | Check tmux, harnesses, auth and versions |
| `sonata sync` | Regenerate agent files from `sonata.toml`; `--prune` removes stale generated agents |
| `sonata run` | Launch a run, print its id |
| `sonata tail` | Human/debugging view of a run; not part of the MCP dispatch path |
| `sonata approve` | Answer a pending approval |
| `sonata mcp` | Run the Sonata MCP server |
| `sonata log <id>` | Print a run's whole transcript |
| `sonata verify <id> [--model <key>]` | Verify a completed run |
| `sonata auth` | Manage native-path gateway keys (`list`, `add <gateway>`, `remove <gateway>`) |
| `sonata serve` | Run the native router and its managed LiteLLM child (`--daemon` detaches) |
| `sonata restart` | Kill whatever sonata router currently holds the port (a stale daemon, or one MCP-hosted inside `sonata mcp`) and start a fresh daemon |
| `sonata code` | Launch a Claude Code session routed through the local proxy (passes `claude` args through) |
| `sonata gc` | Kill finished tmux sessions |

## Configuration

```toml
# sonata.toml
[models."opencode-openrouter-kimi-k3"]
harness = "opencode"      # opencode | codex | pi | reasonix
id = "openrouter/kimi-k3"      # provider/model for opencode, pi, reasonix; bare for codex

[generate.roles]
code    = ["opencode-openrouter-kimi-k3"]
review  = ["opencode-openrouter-grok-4.5", "opencode-openai-gpt-5.6-sol"]
explore = ["opencode-opencode-go-deepseek-v4-flash"]
plan    = ["opencode-openai-gpt-5.6-terra"]

[run]
tail_window_seconds   = 20     # how long `sonata tail` blocks per call
stall_timeout_seconds = 120    # silence before a run is reported STALLED
run_timeout_seconds   = 1800   # hard cap; the run is killed at this point
dispatch_window_seconds = 1500 # blocking window; must stay under MCP's 30-minute stdio idle limit
```

### Where sonata.toml lives

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
[Permission modes](#permission-modes).

Each role chooses its own models through `[generate.roles]`; the old flat
`roles`/`models` pair is no longer accepted. `sonata init` rewrites an old
config to the per-role format.

Run `sonata sync` after editing the config; Claude Code picks up the generated agents automatically. Reconnect the sonata MCP server with `/mcp` only when sonata's MCP tool surface changes.

## Troubleshooting

Start with `sonata doctor` — it checks tmux, each configured harness, its
version and auth, and the permission hook.

| Symptom | Cause |
|---|---|
| Agents don't appear in Claude Code | Run `sonata sync`; Claude Code picks up regenerated agents automatically. |
| `sonata: command not found` | The generated agents call `sonata` on your PATH. Run `npm link` in the clone (or install globally once published). |
| Dispatch fails: "cannot ask for approval" | You are in `default` mode with opencode or pi, which cannot prompt. Switch to `acceptEdits`, use a codex or reasonix model, or dispatch a read-only role. |
| Dispatch fails immediately after upgrading | Generated agents still name the removed `run`/`tail` tools. Run `sonata sync`; Claude Code picks up the regenerated agents automatically. |
| Every opencode/pi dispatch refuses | The permission hook is not installed, so sonata assumes `default`. Run `sonata init` and choose a hook scope. |
| A codex run sits in `PAUSED` at startup | Codex has not been trusted in this directory. Run `codex` there once and answer "Yes, continue". |
| A run reports `degraded` | The harness exited without writing a report; the text you get is scraped pane output. Treat it as untrustworthy. |
| A run never finishes | It is capped by `run_timeout_seconds`. Attach with `tmux attach -t sonata-<id>` to watch it. |
| `sonata serve --daemon` times out with "the daemon did not answer" | Something already holds the router port — often a stale daemon, or a router still living inside a `sonata mcp` process from an earlier native dispatch. Run `sonata restart` instead; it kills the recorded occupant first. |

## Security

Sonata launches other coding agents on your machine. They run **as you**, with
your files and your credentials.

- **Read the permission tables above before dispatching write-capable roles.**
  Only codex offers a real sandbox. Pi has none, and opencode's is advisory.
- **Sonata never bypasses a harness's own safety flags.** It does not pass
  `--dangerously-bypass-approvals-and-sandbox` to codex.
- **Credentials stay with the harness.** Sonata reads harness config to report
  health; it does not copy, forward or log API keys. Keys live wherever the
  harness put them (e.g. `~/.config/opencode/opencode.json`).
- **Prompt injection is a real risk.** A foreign model reading a hostile
  repository can be steered, and it has no classifier between it and your
  files. For untrusted code, dispatch read-only roles or run in a container.

Please report security issues privately, through the repository's
[Security tab](https://github.com/zhihaohong52/sonata/security), rather than in
a public issue.

## Limitations

Worth knowing before you depend on this:

- **`sonata init` discovers models for all three harnesses.** Codex has no
  `models` subcommand, so its catalogue comes from `codex app-server`'s
  `model/list` (JSON-RPC over stdio), with a real response captured in
  `tests/fixtures/codex/model-list.json`.
- **Not published to npm yet**, so installation is from source.
- **Prompt detection is regex against TUIs sonata does not control.** Codex's
  patterns are written from captured real output in `tests/fixtures/panes/`,
  but they will still break when codex changes its interface. The `STALLED`
  timeout is the backstop. OpenCode and Pi cannot prompt at all, so there is
  nothing to detect.
- **Codex through a proxy needs that proxy up.** If `~/.codex/config.toml` sets
  `openai_base_url`, `sonata doctor` checks the endpoint is listening — a dead
  proxy otherwise wastes minutes in retries before failing.
- **`opencode run --format json` is broken upstream** (v1.18.15 produces no
  output and never exits), so progress comes from pane text rather than a
  structured event stream. Pi's `--mode json` does work; the adapter keeps a
  seam for adopting it.
- **No streaming granularity guarantees.** Progress is whatever the harness
  prints.
- **ChatGPT's Codex endpoint occasionally returns an empty completion under
  concurrent load** instead of a 429, which LiteLLM surfaces as a 500. The
  router recognizes this specific case and re-emits it as 529 (overloaded) so
  Claude Code retries automatically instead of treating it as a hard failure.

## Development

```bash
npm install
npm test          # 596 tests; needs tmux
npm run typecheck
npm run build
```

The test suite runs against a **fake harness** — a scripted binary replaying a
normal run, a crash, a real captured approval prompt, a hang that the watchdog
must kill, a clean exit with no report, and a harness-written report — so the
whole engine is covered with no API spend and no harness installed.

Design notes and the implementation plan, including the defects found by
running it, are in [`docs/superpowers/`](docs/superpowers/). What using sonata
to implement sonata taught about sizing and verifying dispatched work is in
[`docs/dispatching-work-through-sonata.md`](docs/dispatching-work-through-sonata.md).

## Adding a harness

The adapter boundary is the extension point. A new harness means one new file
plus two lines of registration:

1. **`src/adapters/<name>.ts`** — export a `HarnessAdapter`. The interface is
   in `src/adapters/types.ts`; `opencode.ts` is the smallest example, `codex.ts`
   the most complete. You implement:
   - `plan(input)` → the bash script to run, and whether it can be approved
   - `canPromptForApproval` — whether the harness can stop and ask a human
   - `promptPatterns` / `describePrompt` — how a pending approval looks
   - `health(env)` — optional runtime checks beyond "is it installed"
2. **`src/adapters/index.ts`** — register it.
3. **`src/config.ts`** — add the name to `KNOWN_HARNESSES`.
4. **`tests/adapters/<name>.test.ts`** — follow an existing adapter's tests.

Optionally, `src/detect.ts` for `sonata init` discovery — currently OpenCode,
Pi and Reasonix; codex has no provider dimension, so its entries are added by
hand (and survive the wizard).

**Probe the real binary before you write the adapter.** Every adapter bug found
so far was invisible in the documentation and obvious on the first real run:
OpenCode silently eating a positional argument, codex rejecting a flag that its
own `exec` accepts, both harnesses printing approval prompts that matched none
of the patterns written for them. If you claim a harness prints something,
capture it into `tests/fixtures/panes/` and test against that.

## Contributing

Issues and pull requests are welcome.

- Run `npm test` and `npm run typecheck` before opening a PR; CI runs both on
  Linux with tmux installed.
- Add tests for behaviour you change. The suite needs no API keys.
- Prefer evidence to inference: if a change depends on how a harness behaves,
  say how you verified it. A captured fixture beats a plausible regex.
- Keep harness-specific knowledge inside its adapter.

## License

MIT — see [LICENSE](LICENSE).
