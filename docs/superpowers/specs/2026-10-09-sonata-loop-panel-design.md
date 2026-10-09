# sonata-loop as a mod: a live panel of the loop and its agents

Date: 2026-10-09
Status: design approved in conversation; spec awaiting review

## Purpose

While `sonata-loop` runs, the person watching cannot see what the loop is
doing. The plan lives in the orchestrator's context, and the tier agents run
inside Claude Code's loop: their transcripts are hidden, and the router knows
models and cost but not which agent a request came from. This adds a side panel
that answers two questions at a glance, in this order:

1. **Where is the loop?** Each planned task's state: coding, in review, failed
   n×, escalated, or done.
2. **What is each agent doing?** Its type, the model the router actually
   served, its current tool and target, its step count, cost, and the edits it
   has made.

Success means a loop of several tasks can be followed from the panel alone,
without opening transcripts. Every state shown is reported by the loop, a hook
or the router, never inferred.

## Decisions

| Question | Decision |
|---|---|
| What the panel leads with | Loop progress first; each task expands to its live agents |
| How loop state reaches the panel | A tool the mod registers, `sonata_loop`, called by the orchestrator |
| Packaging | The mod lives in the skill folder; `sonata init` installs the folder |
| Nested agents | Shown as a tree, using `agent.spawn`'s `parentAgentId` |
| Diffs | Shown per applied edit, on selecting an agent or task row |
| Controlling agents | Out of scope: the mod API cannot interrupt a subagent |

## Architecture

### Packaging: the skill folder becomes the plugin

Claude Code auto-loads a plugin found in a skills folder
(`~/.claude/skills/<name>`, a project's `.claude/skills/<name>`). `sonata init`
already writes `.claude/skills/sonata-loop/SKILL.md`, so the repository's
`skills/loop/` grows into a plugin and is installed whole:

```
skills/loop/
  SKILL.md                    existing; gains the sonata_loop instructions
  .claude-plugin/plugin.json  { "name": "sonata-loop", "version", "description",
                                "types": "./types/index.d.ts" }
  hooks/hooks.json            { "modules": ["./register.tsx"] }
  hooks/register.tsx          the hooks module
  types/index.d.ts            the $.state contract
  hooks/*.test.ts             claude plugin test cases
```

No marketplace, `--plugin-dir` or extra install step is needed. `package.json`
`files` already ships `skills/`.

### Data sources: one owner each

| Source | Provides | Channel |
|---|---|---|
| Orchestrator | The plan and each task's state | The `sonata_loop` tool, held in `$.state` |
| Claude Code | Per agent: type, description, parent, current tool and target, step count, end state, applied edits | `agent.spawn`, `tool.call` (by `agentId`), `turn.step`, `turn.complete` |
| sonata router | The model actually served, the tier an `-auto` alias chose, fallbacks, tokens and cost | `$.http.fetch` to the router's existing `/__sonata/api/session/<id>` |

Every hook observes and then calls `next(e)`. The mod never denies a tool call
or a spawn, so a fault in the panel cannot change what the loop does.

## The `sonata_loop` tool

Registered with `$.tool.register`. One `action` per loop step:

| action | arguments | Called by the skill |
|---|---|---|
| `plan` | `title`, `tasks: [{ id, title }]` | after the plan (step 1) |
| `start` | `taskId`, `phase: code \| fix \| review \| final` | immediately before each dispatch |
| `result` | `taskId`, `outcome: pass \| fail`, `note?` | after each review verdict |
| `escalate` | `taskId`, `to: simple \| normal \| complex` | when the twice-failed rule fires |
| `done` | `summary?` | at the end of the loop |

**Validation.** The tool refuses an unknown `taskId`, a `result` with no
`start` before it, a second `plan` before `done`, and an action it does not
know. Each refusal is a tool error naming the problem, so the orchestrator sees
it and the panel cannot drift silently from the loop.

**Derived states.** A task's displayed state comes from these calls alone:
`start(code)` gives coding, `start(fix)` fixing, `start(review|final)` in
review; `result(fail)` increments failed n×; `escalate` marks it escalated with
its tier; `result(pass)` on a review phase marks it done.

**SKILL.md change.** One section: when a tool named `sonata_loop` is
available, call it at the points in the table; when it is not, run the loop
exactly as today. No other step of the loop changes.

## Agents

### Linking agents to tasks

- A `start` sets the task as **pending dispatch**. The next top-level
  `agent.spawn` (no `parentAgentId`) whose `subagentType` is a sonata agent attaches to it,
  and the pending mark clears. "A sonata agent" is the matcher `sonata route
  auto` already uses, `^(native-)?(code|review|explore|plan)(-|$)`, which also
  covers a collapsed agent named for its role alone (`plan`).
- A spawn with a `parentAgentId` attaches to its parent's task, under its
  parent, never to a pending task.
- A top-level sonata spawn with nothing pending is listed under
  **Unplanned**. Spawns of agents other than sonata's are not shown.

### Nesting

Children render under the agent that spawned them, found through
`parentAgentId`. Two levels show in full; deeper descendants fold into
`+N more (depth 3+)` on their ancestor's line, and the fold expands when
selected. A parent's line reads `fanned out n`. A parent counts as done only
when its own `turn.complete` fires, not when its children finish.

### Live activity

- `tool.call` with an `agentId` sets that agent's current activity: the tool
  name and its main target (a file path, a pattern, a command's first word).
- `turn.step` with an `agentId` increments the step count and records the
  request's model alias and time.
- `turn.complete` for an `agentId` ends the agent: done, interrupted, or
  failed, as the event's `reason` says.

### Model and cost attribution

The router does not know Claude Code's `agentId`. The panel polls
`/__sonata/api/session/<id>` (every 3 s while any agent runs, otherwise not at
all) and matches each agent's `turn.step` (alias and time) to a route in that
session's stream.

- **One running agent on an alias:** the match is exact, so the served model,
  the chosen tier and the cost are shown.
- **Several concurrent agents on one alias:** the match is ambiguous. The
  panel shows the models that alias was served by, marked `≈`, and does not
  assign a cost to either agent.

A task's cost is the sum of its tree's attributed costs. When any part is
unattributed, the total is marked `≈` and the unattributed part is named, never
counted as zero.

## Diffs

- **Capture.** After an `Edit`, `MultiEdit` or `Write` call with an `agentId`
  succeeds (`await next(e)` reports no error), the mod builds hunks from the
  call's own arguments: `old_string`/`new_string` pairs, or the written content
  as a new file. A refused or failed call adds nothing.
- **Bounds.** Each hunk is capped at 40 lines (`… N more lines`), and each
  agent keeps its last 30 hunks.
- **Display.** Selecting an agent row (click, or focus and Enter) shows that
  agent's own hunks below the tree, grouped by file with newest last; children
  are not folded in. Selecting a task row shows every hunk of its tree.
  Selecting the row again, or another row, replaces or hides the diff. A task
  row carries a `+A −D · F files` summary.
- **Blind spot.** A `Bash` call may change files without a diff. Each agent
  that ran one shows `Bash may have changed files: not shown`. `git diff`
  cannot fill the gap because concurrent agents share one working tree.

## The panel

Opened with `$.ui.open({ id: 'sonata-loop', title: 'sonata loop' })` on the
first `plan`, and toggled by a `/sonata-loop` command.

```
sonata loop · auth-refresh            4/7 done · $1.84 · 0:42:10
────────────────────────────────────────────────────────────────
✓ 1 Parse token expiry            code-simple   → flash-1      $0.04
▶ 3 Retry queue                   code-complex → sol            6:40
    └ Agent · step 22 · fanned out 3
    ├ ▶ code-simple  "queue tests"        flash-1   Edit tests/queue.test.ts
    ├ ✓ code-simple  "backoff helper"     flash-1   $0.03
    └ ▶ explore-simple "find retry callers" ≈ flash-1  Grep
✗ 5 Cookie fallback   failed 1×   code-normal   → flash-1
⇡ 6 Migration         escalated   code-complex  → sol      waiting
· 7 Final gate                    review-auto                   —
── Unplanned ───────────────────────────────────────────────────
▶ explore-simple  "find callers of refresh()"   flash-1   0:20
── src/auth/queue.ts (code-simple "queue tests") ───────────────
- retry(fn)
+ retry(fn, { backoff })
```

**Interaction.** The pane takes focus (`ctrl+x tab` or a click), and rows are
Buttons: selecting one shows its diff, and selecting a fold expands it.
Buttons offer: active only / all agents, jump to latest hunk, and copy a hunk
or a path (`$.ui.copy`). The diff area scrolls.

**Lifecycle.** `$.state` survives a module reload. A `session.end` with
`reason: 'clear'` empties the panel. `done` keeps the final view until the
next `plan`.

## Failure handling

| Case | Shown |
|---|---|
| Router unreachable, or session not in its stream | Alias kept; model `?`; cost `unknown`; footer `router not reachable` |
| Session not routed | Agents and loop tracked; model and cost columns say `not routed` |
| Skill run without the mod | Nothing; the loop runs as today |
| A hook throws | That row shows `panel error: <message>`; the rest keeps drawing |

## Sonata-side changes

- **`sonata init`** (`src/init/apply.ts`) installs the whole `skills/loop/`
  folder instead of `SKILL.md`, overwriting only files sonata ships.
- **`sonata sync`** (`src/commands/sync.ts`) refreshes the installed folder
  the same way.
- **`sonata reset`** already removes the whole `sonata-loop` folder; unchanged.
- **`sonata doctor`** adds one line: whether the installed skill folder has
  the mod, and whether its version matches the package's.
- **Docs:** README, `docs/guide/`, and a CHANGELOG entry under Added. This
  changes what `init` installs, so it is a minor version.

## Testing

- `claude plugin test` cases for:
  - the spawn-to-task link, and Unplanned;
  - `parentAgentId` nesting and the depth fold;
  - diff capture, applied versus refused, and the hunk and line caps;
  - each `sonata_loop` validation error;
  - attribution: exact, ambiguous (`≈`), and router unreachable (`unknown`).
- `claude plugin validate` and `tsc -p` on the mod.
- vitest for the `init` and `sync` folder copy, and for the `doctor` line.
- A manual run of a short loop in a routed session, with the panel watched.

## Out of scope

- Stopping, retrying or re-tiering an agent from the panel: the mod API has
  no interrupt, and re-tiering belongs to the loop's escalation rule.
- Token-by-token diffs while a tool call is still being written.
- Diffs for changes made through `Bash`.
- A tuned desktop or mobile layout: the same elements render there, but only
  the terminal layout is designed and tested.
