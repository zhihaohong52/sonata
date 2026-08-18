# One-call dispatch

Date: 2026-08-18
Status: design, approved in chat — not yet implemented

## Problem

Dispatching through sonata costs one wrapper turn per poll. The wrapper calls
`run`, gets an id, then calls `tail` over and over until the run finishes. Every
one of those calls is a full assistant turn that re-sends the wrapper's whole
conversation, so the cost of a dispatch grows with the *length of the run*
rather than with the size of its result.

Two things make it worse than the design intended.

**The MCP `tail` does not long-poll.** `src/mcp/tools.ts` calls `cmdTail` with
`waitSeconds: 0`, so it returns after a single poll — frequently with
`lines: []`. The long-poll that `CLAUDE.md` describes ("returns the instant a
line appears, and only blocks for `tail_window_seconds`") is real in the CLI and
switched off over MCP. The wrapper therefore spins as fast as the model can emit
turns.

**Every poll returns pane text.** `TailResult.lines` lands in the wrapper's
context on each call, whether or not anyone will read it. Nothing does: the
wrapper's own prompt already tells it not to repeat the lines back.

The result the orchestrator actually needs is the final report. Everything
before it is a cost with no reader.

## Goal

A dispatch that never pauses costs **one tool call and one result**. A dispatch
that pauses costs one call per approval, which is irreducible — a human has to
decide.

Live progress does not disappear; it moves to where it was always better served,
`tmux attach -r -t sonata-<id>` and `sonata log <id>`.

## Design

### Tool surface

Three tools replace four. `run` and `tail` leave the MCP surface entirely.

| tool | behaviour |
|---|---|
| `dispatch(role, model, task)` | launch, then block. Returns on `DONE`, `PAUSED`, `STALLED` or `RUNNING`. |
| `wait(id)` | the same blocking loop for a run already launched. How the wrapper resumes after an approval. |
| `approve(id, answer)` | unchanged. |

`sonata tail` remains a CLI command. Removing the tool from the MCP surface —
rather than leaving it and asking the wrapper not to use it — is deliberate: the
expensive path should not exist, rather than be one model decision away.

### The blocking loop

`dispatch` and `wait` share one loop, and it reuses `cmdTail` rather than
growing a second state machine:

```
loop:
  result = cmdTail({ cwd, id, waitSeconds: <remaining window> })
  if result.state !== 'PROGRESS'  → return result
  if window exhausted             → return { state: 'RUNNING', id }
```

Pane diffing, `events.jsonl` and the cursor keep advancing exactly as now, so
`sonata log` is unaffected. The only change is that intermediate `PROGRESS`
results stop being returned to the model.

`dispatch` is `cmdRun` followed by that loop. `wait` is the loop alone.

`wait` is idempotent on a finished run: the exit sentinel is already there, so
`cmdTail` returns `DONE` with the report on the first iteration. A wrapper that
calls `wait` once too often gets the report again rather than an error, which
matters because the retry path exists precisely for calls that may have been
dropped mid-block.

### Why the window cap exists

Claude Code aborts an MCP tool call that produces no response and no progress
notification for an idle window — **30 minutes for stdio servers**. The
wall-clock limit is not the constraint (`MCP_TOOL_TIMEOUT` defaults to about 28
hours, and stdio has no per-request timer); the idle window is.

Silence is already handled: sonata's own `stall_timeout_seconds` is 120s, so a
quiet run returns `STALLED` long before MCP's window. The exposed case is the
opposite one — a *productive* run that works for 40 minutes returns nothing to
the client for 40 minutes and gets aborted.

So the loop caps its own block at a new `run.dispatch_window_seconds` (default
1500 — 25 minutes, comfortably inside the window) and returns `RUNNING` with the
id. The wrapper calls `wait(id)` again: one extra call per 25 minutes, against
one per model turn today.

MCP progress notifications would also hold the call open, but they require the
client to supply a `progressToken` and that has not been verified for Claude
Code. If it does supply one they are free insurance worth adding; nothing in
this design depends on it.

### Report truncation

Claude Code warns above 10k tokens of MCP output and caps at 25k
(`MAX_MCP_OUTPUT_TOKENS`). Separately, a result over the persist-to-disk
threshold is written to a file and replaced in the conversation by a file
reference — so an oversized report is not silently clipped, but it does stop
being the wrapper's final message, which is what the orchestrator reads.

Two measures, in order:

1. **Declare the ceiling.** `_meta["anthropic/maxResultSizeChars"]` on the
   `tools/list` entry raises that tool's threshold, up to a hard ceiling of
   500,000 characters. Set it to 200,000 so ordinary reports — including a
   degraded one carrying pane text — arrive whole and inline.
2. **Truncate above our own ceiling anyway.** Keep the head, append

   ```
   [truncated: full transcript at `sonata log <id>`]
   ```

   Nothing sensible reads a 200k-character report into a conversation, and the
   notice keeps the pointer to the full text in view.

### A dropped call loses nothing

All run state lives in the run directory and the tmux session, not in the
blocked call. If the client times out, or the user interrupts, the foreign model
keeps working and `wait(id)` picks it up where it left off. This falls out of the
design rather than needing code, and it is the reason to prefer
blocking-with-resume over one unbounded block.

## Migration

Three places name the tools, and all three must move together:

1. **`src/settings.ts`** — `SONATA_TOOLS` becomes `dispatch`, `wait`, `approve`.
2. **`src/commands/sync.ts`** — `agentMarkdown`'s frontmatter `tools:` line and
   its whole Procedure section. The procedure collapses: launch, then act on one
   of four states, with no polling instruction at all.
3. **`src/commands/doctor.ts`** — the allow-list check follows `SONATA_TOOLS`.

**Agent files already on disk are the sharp edge.** They instruct the wrapper to
call `run` and then poll `tail`. After this change those tools are gone, so a
stale agent fails partway through a dispatch — with a foreign model already
running. `sonata doctor` must therefore report an agent file or allow-list entry
naming `run`/`tail` as a **blocker**, not a warning, and name `sonata sync` as
the fix.

Users need `sonata sync` and a Claude Code restart. That is already the
documented ritual after a config change.

### Naming

`dispatch`/`wait` rather than reusing `run`. Reusing the name would spare the
allow-list churn, but a stale agent calling a tool that is *gone* fails loudly,
where one calling `run` and silently receiving different semantics is the worse
failure — and this repository has been bitten by the silent half before.

## Testing

The fake harness already scripts every case, so the e2e work is mostly reuse.

Unit:
- the loop continues on `PROGRESS` and returns on each of `DONE`, `PAUSED`,
  `STALLED`
- the window cap returns `RUNNING` with the id
- truncation fires at the threshold and names `sonata log`
- `TOOL_DEFS` exposes exactly `dispatch`, `wait`, `approve`

End to end against the fake harness:
- normal run → one `dispatch` → `DONE` with the report and its provenance line
- crash → `DONE`, `degraded`
- the captured approval prompt → `PAUSED` → `approve` → `wait` → `DONE`
- the hang → `STALLED`

Updated: allow-list tests, doctor tests, `agentMarkdown` snapshot.

Live: one real reasonix dispatch, as with the adapter — the suite runs against a
fake harness, and this repository's rule is that the real binary decides.

## Also in scope

`cmdTail`'s `waitSeconds: 0` at `src/mcp/tools.ts:89` becomes moot for the
wrapper once `tail` is not an MCP tool, but it is a real defect and a one-line
fix. The CLI's `sonata tail` should get the long-poll `CLAUDE.md` already claims
it has.

## Out of scope

- Streaming the harness conversation into Claude Code. Still impossible for the
  documented reason: a subagent receives text only as tool results and its parent
  receives only its final message, so there is no push channel.
- Changing the report contract, provenance line, or degraded semantics.
- Any adapter change.
