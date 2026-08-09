# Sonata — Foreign-Model Subagents for Claude Code

**Date:** 2026-08-10
**Status:** Design approved, not yet implemented

## Problem

Claude Code's subagents are excellent but always Claude. Two things follow.

The first is cost. Bulk coding work — mechanical refactors, test scaffolding,
migrations — does not need a frontier model. Cheap high-cache models are
adequate substitutes for that tier of work, and the price difference over a
working day is large.

The second is correlated judgement. Asking Claude to review Claude's work
surfaces fewer problems than asking a different model family. Review is where
thought diversity pays, and today there is no way to get it without leaving the
session.

Both problems have the same shape: the work should stay in Claude Code, with
Claude orchestrating, and only the *model behind a subagent* should change.

## Goals

- Dispatch subagents backed by non-Claude models through the ordinary Agent
  tool, so Claude's existing selection, fan-out, and workflow machinery applies
  unchanged.
- Route by model, delivered through each model's native harness, so each
  harness keeps its own loop, tools, and sandbox.
- Show every step of a foreign run while it happens, and allow attaching to a
  live run to steer it.
- Mirror the session's permission mode onto the foreign harness so a sonata
  agent is never more permissive than the session that spawned it.

## Non-goals

- Building an agent harness. Sonata drives existing harnesses; it does not
  implement a tool loop.
- Replacing Claude for orchestration. The main thread stays Claude.
- Supporting harnesses without a scriptable non-interactive or TUI mode.

## Key decisions

Each decision below was made deliberately; the rationale is recorded because
several of them are non-obvious and will look wrong to a future reader without
it.

**Many harnesses, not one universal adapter.** OpenCode alone could reach every
target model, but harnesses differ in loop quality, sandboxing, and tuning.
Codex's sandbox and OpenAI tuning are worth having natively rather than
approximated. The cost is N adapters; the benefit is that each model runs in the
harness built for it.

**Agent-tool targets, not MCP tools.** Sonata agents must be orchestratable by
Claude Code — spawned, fanned out in parallel, chained in workflows, and read
back as reports. MCP tools do not participate in that machinery. This rules out
an MCP server as the primary interface.

**Generated role × model agent files.** Sonata cannot extend the Agent tool's
`model` enum, so it generates one `.claude/agents/*.md` per (role, model) pair
from config. These are ordinary registry entries, which means Claude's own agent
selection reasoning works over them with no special-casing. The registry grows
as roles × models, so descriptions must be sharp enough to disambiguate.

**tmux panes with capture polling.** There is no supported way to inject foreign
events into another agent's progress box — a subagent's rendered steps are its
own tool calls, and no API was found for adding to them. Full step-level
visibility therefore requires either making the steps genuinely native (which
would mean discarding the harnesses) or mirroring an external process. tmux was
chosen for mirroring because it uniquely supports live attach and mid-run
steering via `send-keys`, which turns a wasted cheap-model run into a corrected
one.

**Sonata owns the role prompts.** A role must mean the same thing across models
or cross-model comparison is meaningless, and comparison is the point of
diversity. Role prompts live in sonata and are injected as harness
instructions, composed with the repo's `CLAUDE.md`/`AGENTS.md`.

**Full permission parity, including prompt escalation.** Prompt detection only
serves `default` mode — in `acceptEdits` and `bypassPermissions` no prompt ever
renders. It is built anyway so sonata agents behave exactly like native ones in
every mode. It is the most fragile component in the system and is backstopped by
a stall timeout.

**TypeScript/Node.** Matches the Claude Code plugin ecosystem and npm
distribution. The work is process and JSON plumbing, which Node handles well.

## Architecture

Five components.

### 1. `sonata` CLI

The engine. Owns config parsing, agent-file generation, the run lifecycle, tmux
session management, and the run store under `.sonata/`.

### 2. Generated agent files

`sonata sync` reads `sonata.toml` and writes one wrapper agent per (role, model)
pair. Each wrapper is a thin Claude loop with `tools: Bash` and `model: haiku` —
cheap, because it only shells out and relays. A wrapper never parses harness
output.

### 3. Harness adapters

One per harness. Each declares:

- launch command and model flag
- permission-mode → harness-flag mapping
- prompt-detection patterns
- completion-sentinel mechanism
- tested harness version range

This is the only place harness-specific knowledge lives. Adding Pi is a new
adapter file and a config line, with no change to wrappers, roles, or the
engine.

### 4. Role prompts

`roles/*.md`, owned by sonata, composed with the repo's `CLAUDE.md`/`AGENTS.md`
and the task text into the harness's instructions. `review` and `code` ship
first; `explore` and `plan` follow (see Build order).

### 5. Permission hook

A `PreToolUse` hook writes the live `permissionMode` to
`.sonata/session-<sid>.json`. `PreToolUse` fires on every tool call, so the
value stays fresh when the mode changes mid-session. The mode is not available
as an environment variable, so this hook is the only way the engine can see it.

## Configuration

```toml
# sonata.toml
[models.deepseek-v4-flash]
harness = "opencode"
id      = "deepseek/deepseek-v4-flash"

[models.kimi-k3]
harness = "opencode"
id      = "moonshot/kimi-k3"

[models.gpt-5-6-sol]
harness = "codex"
id      = "gpt-5.6-sol"

[generate]
roles  = ["review", "code"]
models = ["deepseek-v4-flash", "kimi-k3", "gpt-5-6-sol"]

[run]
tail_window_seconds = 20
stall_timeout_seconds = 120
run_timeout_seconds = 1800
```

`sonata sync` validates that every model is offered by its declared harness and
fails at sync time rather than mid-run.

## Run lifecycle

1. **Dispatch.** Claude calls `Agent(subagent_type: "code-deepseek-v4-flash",
   prompt: …)`.

2. **Wrapper invocation.** One Bash call. The task is passed by file, not argv,
   to avoid shell-quoting damage:

   ```
   sonata run --role code --model deepseek-v4-flash --task-file <tmp> --json
   ```

3. **Launch.** The engine allocates a short run id, reads the cached permission
   mode, resolves the model to its harness, composes
   `.sonata/runs/<id>/instructions.md`, wraps the harness command so its exit
   code lands in a sentinel file, starts it with `tmux new-session -d -s
   sonata-<id>`, and returns immediately with the run id and session name.

4. **Progress.** The wrapper loops on a blocking tail:

   ```
   sonata tail <id> --since <cursor> --wait 20
   ```

   The call blocks up to `tail_window_seconds` and returns on change, so a
   three-minute run costs roughly nine Bash calls rather than a busy loop. The
   engine performs the diffing: it normalizes `capture-pane` output, strips
   redraw artifacts and spinner frames, and emits only new lines. The wrapper
   never sees a full screen repaint.

   Each tail returns one of `PROGRESS`, `PAUSED`, `DONE`, `STALLED`.

5. **Completion.** Never scraped from the TUI. The role prompt instructs the
   agent to write `.sonata/runs/<id>/report.md` as its final action; the exit
   sentinel confirms the process ended. If the process exits without a report,
   the engine falls back to the pane tail and marks the report `degraded`.

6. **Result.** The wrapper returns `report.md` as the subagent's final report.

7. **Cleanup.** `sonata gc` kills orphaned sessions and prunes old runs.

## Permission model

The engine mirrors the session's mode onto the harness:

| Claude Code mode | Foreign harness |
|---|---|
| `plan` | read-only, no writes attempted |
| `default` | approvals on, prompts escalated |
| `acceptEdits` | auto-approve edits within cwd, escalate the rest |
| `bypassPermissions` | full auto-approve |

A sonata agent is never more permissive than the session that spawned it.

## Escalation protocol

A subagent cannot prompt the user directly, so escalation cannot be inline. The
protocol relies on tmux session persistence:

1. The wrapper's tail returns `PAUSED` with the run id and the pending action.
2. The wrapper returns early with a structured block naming both.
3. The **main** thread — which can prompt — asks the user.
4. The main thread calls `sonata approve <id> --yes|--no`, implemented as
   `tmux send-keys`.
5. The main thread re-dispatches a wrapper with `sonata tail <id> --resume`.

The pane stays alive throughout, so no work is lost.

## Workspace

Sonata runs the harness in the wrapper's cwd, matching native subagent
semantics. Because the harness inherits that cwd, `isolation: "worktree"` on the
Agent call composes for free: Claude Code places the wrapper in a worktree and
the harness lands there too. This is the recommended form for parallel fan-out.

## Live attach

Every progress block carries `tmux attach -t sonata-<id>`, or `-r` for
read-only. Attaching mid-run allows correcting a model that is going off the
rails instead of paying for the rest of a wasted run.

## Data layout

```
.sonata/
  session-<sid>.json          live permission mode
  runs/<id>/
    instructions.md           composed role + repo context + task
    meta.json                 role, model, harness, mode, timings
    pane.log                  raw capture-pane history
    events.jsonl              normalized progress events
    report.md                 final report
    exit                      process exit code
```

## CLI surface

| Command | Purpose |
|---|---|
| `sonata sync` | Generate agent files from config; validate models |
| `sonata run` | Launch a run, return run id |
| `sonata tail` | Blocking progress poll; returns run state |
| `sonata approve` | Answer a pending prompt via send-keys |
| `sonata doctor` | Check tmux, harness install, auth, version drift |
| `sonata gc` | Kill orphaned sessions, prune old runs |

## Failure handling

| Failure | Handling |
|---|---|
| Harness missing or not authed | `sonata doctor`; validated at `sync` |
| Model not offered by its harness | Rejected at `sync` |
| `tmux` absent | Hard dependency, checked by `doctor` |
| Harness crashes | Non-zero exit sentinel, report marked `degraded` |
| Prompt detector misses a prompt | `STALLED` after `stall_timeout_seconds`, returns pane tail |
| Harness upgrade breaks detection | Adapter pins a tested version range; `doctor` warns on drift |
| No report written | Pane-tail fallback, flagged `degraded` |
| Runaway run | `run_timeout_seconds` exceeded, pane killed, partial report returned |
| Concurrent runs sharing cwd | Warn on overlap, suggest `isolation: "worktree"` |

`degraded` is load-bearing. A silently truncated report from a cheap model is
the failure most likely to waste downstream time, so it is always labelled.

## Testing

**Fake harness.** A scripted TUI binary that replays fixtures — normal run,
approval prompt, crash, stall, no-report. It exercises the entire engine, every
state transition, and all four tail states with no API spend and no harness
installed. This is the backbone of the test suite.

**Pane normalization goldens.** Recorded `pane.log` fixtures mapped to expected
event lines. Redraw-stripping regressions surface here.

**Generation tests.** `sonata.toml` → expected agent files.

**Hook test.** `permissionMode` capture, including a mid-session mode change.

**Live smoke tests.** One per harness, opt-in, tagged out of default CI.

## Build order

1. **Engine plus OpenCode adapter.** OpenCode is model-agnostic, so one adapter
   reaches both deepseek-v4-flash and kimi-k3 and proves the cross-model
   comparison story end to end. Roles `review` and `code`.
2. **Codex adapter.** Adds gpt-5.6-sol and exercises a genuinely different
   launch and sandbox shape, which is what validates the adapter boundary.
3. **Pi adapter.**
4. **Roles `explore` and `plan`.**

## Risks

**Prompt detection is regex against a TUI sonata does not control.** It will
break on harness upgrades. Mitigated by version pinning, `doctor` warnings, and
the stall backstop — but expect maintenance.

**Pane normalization is heuristic.** Different harnesses redraw differently, and
a normalizer tuned on OpenCode may produce noisy output for Codex. The golden
tests exist to make this visible rather than to prevent it.

**Wrapper polling costs tokens.** The blocking tail keeps this small, but a long
run still costs wrapper turns. If it proves material, the tail window is
configurable.
