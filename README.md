# sonata

**Foreign-model subagents for Claude Code.**

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
  └ Bash: sonata tail a1f3e2 --wait 20
     → read  src/parser.ts
     → edit  src/parser.ts  +31 −12
     → bash  pytest -q → 47 passed
  done — "Refactored the parser. Tests pass."
```

## Status

**Working, early.** The engine and the OpenCode, Codex and Pi adapters are
complete and tested, each verified end to end against a real model. See
[Limitations](#limitations) before relying on it.

## Requirements

- **Node 22+**
- **tmux** — every harness runs inside a tmux session (`brew install tmux`,
  `apt install tmux`)
- At least one harness, authenticated:
  - **[OpenCode](https://opencode.ai)** — any provider it supports
  - **[Codex CLI](https://github.com/openai/codex)** — `codex login`
  - **[Pi](https://github.com/earendil-works/pi-mono)** — any provider it
    supports; model ids take the `provider/id` form

## Install

```bash
npm install -g @zhihaohong52/sonata
```

Then, in the repository where you want to use it:

```bash
sonata init
```

`sonata init` detects your environment, reports anything broken with the command
that fixes it, and asks which models and roles you want:

```
  sonata init

  ✓ tmux 3.7b
  ✓ opencode 1.18.15 · 8 models · 1 authed provider(s)

  Models to enable

    ◉ deepseek-v4-flash  · DeepSeek V4 Flash
  ❯ ○ kimi-k3  · Kimi K3
    ○ glm-5.2  · GLM 5.2

  space toggle · enter confirm · esc cancel
```

It writes `sonata.toml`, generates one agent per role × model into
`.claude/agents/`, and offers to install the permission hook.

**Restart Claude Code** so it picks up the new agents.

Every prompt has a flag, so it also works unattended:

```bash
sonata init --yes --models deepseek-v4-flash,kimi-k3 --roles code,review --scope project
```

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
wrapper agent  (haiku, Bash only — relays, never reasons)
    │  sonata run …          →  run id, returns immediately
    │  sonata tail <id>      →  PROGRESS | PAUSED | DONE | STALLED
    ▼
sonata CLI
    │  composes role prompt + CLAUDE.md + task
    │  launches harness in a detached tmux session
    ▼
opencode → deepseek-v4-flash
```

The wrapper never parses harness output. It calls the CLI and relays. All
harness-specific knowledge lives in one adapter file, so adding a harness
touches nothing else.

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
passes `--dangerously-bypass-approvals-and-sandbox`.

On first entry to a directory, the codex TUI blocks on a directory-trust
question before any work starts. Sonata surfaces it as a `PAUSED` prompt, and
`sonata doctor` warns when the project has not been trusted yet, so a
`default`-mode run does not stall on it unexpectedly.

Prompt detection for codex is written from captured TUI output, kept in
`tests/fixtures/panes/`, rather than from guesses about what it prints.

Codex also writes its final message to a file (`-o`), so sonata has a
harness-guaranteed report and degrades to pane text far less often.

The mode is not exposed as an environment variable, so this needs a
`PreToolUse` hook — which `sonata init` offers to install, at project or global
scope. Without it, sonata assumes `default`. For codex that is simply the
cautious choice; for opencode it means dispatches refuse, so `sonata doctor`
reports a missing hook as a blocker rather than letting it surface on first use.

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
| `sonata init` | Set up sonata in this project (interactive) |
| `sonata doctor` | Check tmux, harnesses, auth and versions |
| `sonata sync` | Regenerate agent files from `sonata.toml` |
| `sonata run` | Launch a run, print its id |
| `sonata tail` | Poll a run for progress |
| `sonata approve` | Answer a pending approval |
| `sonata gc` | Kill finished tmux sessions |

## Configuration

```toml
# sonata.toml
[models.deepseek-v4-flash]
harness = "opencode"
id = "deepseek-v4-flash"

[generate]
roles  = ["code", "review", "explore", "plan"]
models = ["deepseek-v4-flash", "kimi-k3"]

[run]
tail_window_seconds   = 20    # how long `sonata tail` blocks per call
stall_timeout_seconds = 120   # silence before a run is reported STALLED
run_timeout_seconds   = 1800   # hard cap; the run is killed at this point
```

Roles live in `roles/*.md` and are owned by sonata rather than the harness, so
"review" means the same thing whichever model performs it — which is what makes
comparing two models' reviews meaningful.

Four roles ship: `code`, `review`, `explore` and `plan`. The last three are
**read-only** — sonata forces a read-only sandbox for them regardless of your
permission mode, so a review can never quietly edit your repository.

Run `sonata sync` after editing the config.

## Limitations

Worth knowing before you depend on this:

- **No Pi adapter.** OpenCode and Codex are supported; Pi is designed but not built.
- **Codex through a proxy needs that proxy up.** If `~/.codex/config.toml` sets
  `openai_base_url`, `sonata doctor` checks the endpoint is listening — a dead
  proxy otherwise wastes minutes in retries before failing.
- **Prompt detection is regex against a TUI sonata does not control.** It is
  tested against a scripted fake harness, not against real opencode output, and
  it will break when harnesses change their interface. The `STALLED` timeout is
  the backstop.
- **`opencode run --format json` is broken upstream** (v1.18.15 produces no
  output and never exits), so progress comes from pane text rather than a
  structured event stream. The adapter keeps a seam for adopting it later.
- **No streaming granularity guarantees.** Progress is whatever the harness
  prints.

## Development

```bash
npm install
npm test          # 205 tests; needs tmux
npm run typecheck
npm run build
```

The test suite runs against a **fake harness** — a scripted binary replaying
normal, crash, stall, approval-prompt and missing-report scenarios — so the
whole engine is covered with no API spend and no harness installed.

Design notes and the implementation plan, including the defects found by
running it, are in [`docs/superpowers/`](docs/superpowers/).

## License

MIT — see [LICENSE](LICENSE).
