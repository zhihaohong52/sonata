# What sonata can and cannot borrow from a native subagent

Date: 2026-08-18
Status: measured; the wiring it recommends is implemented

Sonata's ambition has always been to feel like a native Claude Code subagent —
same interface, same working directory, same report contract, different brain —
including being able to watch the foreign model work, turn by turn, in the
terminal.

Everything below was measured against Claude Code 2.1.233, protocol
2025-11-25. None of it is inferred.

## The one channel an MCP server has

Claude Code sends `params._meta.progressToken` on `tools/call`, and a
`notifications/progress` referencing that token renders in the user's terminal.
They are protocol messages, not tool results, so they cost no tokens and enter
no model's context — which is exactly why they can show the user a running
harness and exactly why they can never feed the orchestrator.

That is the whole channel. There is no other push surface.

## Three measurements

1. **A subagent's tool call never renders progress.** Two dispatches were run
   with an identical ticker, one from the main thread and one through a wrapper
   subagent, labelled `DIRECT` and `WRAPPER`. Only `DIRECT` ticks appeared.

2. **A main-thread call renders progress only while it blocks.** Claude Code
   moves a main-conversation MCP call to a background task after 120 seconds.
   On a 4-second ticker, ticks stopped at exactly 30.

3. **`/tasks` shows status, not progress.** A backgrounded run displays
   `sonata/dispatch · <id> · working` and nothing else, so the messages do not
   reappear elsewhere.

## What follows

| | async | live turns |
|---|---|---|
| native subagent | yes | yes |
| sonata via wrapper agent | yes | no |
| sonata direct, under 120s | no | yes |
| sonata direct, backgrounded | yes | no |

**Sonata cannot have both.** A native subagent does, because Claude Code renders
subagent activity through its own internal channel, which is not available to an
MCP server. This is an upstream constraint, not a sonata design flaw: if Claude
Code ever renders progress for backgrounded calls, sonata inherits the full
experience with no change.

`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` is the dial between the two rows. Setting
it to `0` or a large value in a project's `.claude/settings.json` keeps a call
blocking, and therefore streaming, for the whole run. It is deliberately **not**
recommended: holding the session for an eight-minute dispatch is a worse trade
than losing the stream, and the setting applies to every MCP server in the
project rather than to sonata alone.

## Decisions

**Keep backgrounding.** Default behaviour, no config changes shipped.

**Emit progress anyway.** `cmdTail` already computes the new pane lines each
poll; emitting them as progress notifications is small, costs nothing, and gives
real streaming for runs under two minutes — a decent share of them. It is also
positioned to become the full experience for free if the upstream limit lifts.

**Drop the wrapper agent.** It streams nothing, costs a model turn per dispatch,
and is the only component that can corrupt the task text — a 3K spec once
arrived as a one-line summary. Dispatching directly from the main thread
preserves the task byte for byte because the caller writes the argument itself.
This also removes the need for a `task_file` parameter, which existed only to
route around the paraphrasing.

**`tmux attach` remains the real live view.** For anything past two minutes it is
the answer, and on its merits it beats the native experience: the actual
terminal, complete rather than summarised, and interactive — drop `-r` and steer
a cheap model mid-run.

## What would change this

A single upstream change: Claude Code rendering `notifications/progress` for
backgrounded calls, or exposing subagent tool-call progress. Worth re-probing
after a Claude Code upgrade; the three measurements above are each about ten
minutes to redo.
