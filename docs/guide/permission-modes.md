# Permission modes

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

## The permission hook

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
