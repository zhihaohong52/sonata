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

**Working, early.** The engine and the OpenCode adapter are complete and
tested; a live run goes from `sonata run` to a returned report. Codex and Pi
adapters are not written yet. See [Limitations](#limitations) before relying
on it.

## Requirements

- **Node 22+**
- **tmux** — every harness runs inside a tmux session (`brew install tmux`,
  `apt install tmux`)
- **[OpenCode](https://opencode.ai)**, authenticated with at least one provider

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

## Permission modes

Sonata mirrors your Claude Code permission mode onto the harness. A sonata
agent is never more permissive than the session that spawned it.

| Claude Code mode | opencode agent | auto-approve | interactive |
|---|---|---|---|
| `plan` | `plan` (read-only) | no | no |
| `default` | `build` | no | yes — approvals surface |
| `acceptEdits` | `build` | yes | no |
| `bypassPermissions` | `build` | yes | no |

The mode is not exposed as an environment variable, so this needs a
`PreToolUse` hook — which `sonata init` offers to install, at project or global
scope. Without it, sonata assumes `default`, which is the safe direction.

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
roles  = ["code", "review"]
models = ["deepseek-v4-flash", "kimi-k3"]

[run]
tail_window_seconds   = 20    # how long `sonata tail` blocks per call
stall_timeout_seconds = 120   # silence before a run is reported STALLED
run_timeout_seconds   = 1800
```

Roles live in `roles/*.md` and are owned by sonata rather than the harness, so
"review" means the same thing whichever model performs it — which is what makes
comparing two models' reviews meaningful.

Run `sonata sync` after editing the config.

## Limitations

Worth knowing before you depend on this:

- **OpenCode only.** Codex and Pi adapters are designed but not built.
- **Roles are `code` and `review`.** `explore` and `plan` are not implemented.
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
npm test          # 116 tests; needs tmux
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
