# Dispatch Integrity

**Date:** 2026-08-12
**Status:** Design approved, not yet implemented

## Problem

A sonata wrapper agent is a Haiku subagent whose entire job is to call
`sonata run`, poll `sonata tail`, and relay the report. Its instructions say so
plainly:

> You do no work of your own. Do not read files, inspect the repository, edit
> anything, grep, or reason about the task.

That is a request, not a constraint. The agent is granted `tools: Bash`, and
Bash runs `cat`.

Observed on 2026-08-12. Two `explore-opencode-openai-gpt-5.6-*` agents were
dispatched against the insurance repository. Their transcripts record:

| agent | bash calls | `sonata` calls | file-reading calls |
|---|---|---|---|
| `explore-…-terra` | 52 | **0** | 52 |
| `explore-…-sol` | 50 | **0** | 50 |

102 Bash calls — `cat`, `grep`, `sed`, `awk`, `find`, `python3` — reading the
codebase directly. Not one invocation of `sonata run`. No `.sonata/runs/`
directory was created, and opencode's own log shows no run in that repository at
that time.

**The work was done by Haiku, and reported as though a foreign model had done
it.** Cost, and diversity of judgement, are sonata's two reasons to exist; this
failure silently removes both while appearing to deliver them. Nothing in
sonata notices, because nothing in sonata is involved.

The same shape appeared twice more the same day, which is why this is treated
as a class of defect rather than one bug:

- `roles/explore.md` says "do not modify any files". The model complied — but
  it was running under opencode's write-capable `build` agent, so nothing
  enforced it.
- `sonata init` documented read-only roles as "enforced by the harness". For
  `explore` on this machine that was false.

In every case a safety property was a sentence in a prompt.

## Goals

- Make it impossible, not merely discouraged, for a wrapper to do the work
  itself.
- Make a completed dispatch verifiable after the fact, so a fabricated report
  can be caught.
- Have `doctor` confirm that every component a dispatch depends on exists and
  is enabled, rather than discovering it at dispatch time.

## Non-goals

- Auditing what the foreign model does once running. The harness owns that;
  sonata's permission-mode mapping already covers it.
- Preventing a *user* from running anything. This constrains the generated
  wrapper agents only.
- Replacing the CLI. The MCP server is a second front door onto the same
  functions, not a rewrite.

## Key decisions

### The wrapper loses Bash and gains three MCP tools

Generated agents change from:

```yaml
tools: Bash
```

to:

```yaml
tools: mcp__sonata__run, mcp__sonata__tail, mcp__sonata__approve
```

The wrapper then has no tool that can read a file, run a command, or edit
anything. The failure above becomes unreachable rather than discouraged.

**`tools: Bash(sonata:*)` was tested and does not work.** An agent carrying
that exact frontmatter ran `cat /etc/hosts` and returned the file's contents.
The scoped form is silently ignored for agents — it is honoured in *command*
files via `allowed-tools:`, which is what made it look plausible. Shipping it
would have produced a fourth instance of the defect this spec exists to remove.

Exact-name tool whitelisting, by contrast, was confirmed working in the same
test: the agent had precisely the tools its frontmatter named.

### A hand-rolled stdio server, not a framework

Claude Code launches an MCP server as a subprocess and speaks newline-delimited
JSON-RPC 2.0 over stdio. The surface sonata needs is four messages:
`initialize`, `notifications/initialized`, `tools/list`, `tools/call`.

The two candidate frameworks were measured rather than assumed:

| package | version | direct deps | carries |
|---|---|---|---|
| `fastmcp` (npm) | 4.14.4 | 14 | hono, execa, yargs, undici, fuse.js |
| `@modelcontextprotocol/sdk` | 1.30.0 | 17 | express, cors, jose, ajv |

Both bundle HTTP servers and auth for a transport that is a pipe; none of that
code would execute. sonata has one dependency (`smol-toml`) and a 57 kB
tarball, and the three tools are thin adapters over `cmdRun`, `cmdTail` and
`cmdApprove`, which already exist. The framework would be larger than the thing
it wraps.

Python's FastMCP was considered and is inapplicable: sonata is a Node CLI, and
depending on it would add a Python runtime to a Node package.

The cost of hand-rolling is protocol details we get subtly wrong. The mitigation
is that exactly one client matters. **The `protocolVersion` string and the
handshake shape must be captured from a real Claude Code session and committed
as a fixture before the server is trusted** — the same rule that caught every
adapter bug in this repository. Nothing in the design may depend on a version
string written from memory.

If the SDK is preferred later, only the transport module changes; the tool
definitions and everything downstream are unaffected.

### `sonata verify` makes a dispatch checkable

Blocking should be testable rather than assumed. The wrapper's report contract
gains a required trailer naming the run, and `sonata verify <id> --model <key>`
confirms that run exists, ran the expected model under the expected harness,
and how it exited.

A fabricated report has no id that survives this. It is a second layer
deliberately: the first layer is the one that should never fail, and this is
how we would find out if it did.

### `doctor` checks that a dispatch *can* work

Today `doctor` checks tmux, the resolved config, the permission hook, and
harness versions. Three failures this week were outside that set, so it gains:

- **every model in `generate.models` is defined in `[models]`** — a mismatch
  makes `sonata run` fail with `unknown model` at dispatch time.
- **every generated agent maps to a model the config defines.** Nine of
  eighteen global `explore-*` agents named models a rewritten config no longer
  defined; `sync` writes agents but never deletes them.
- **every harness agent a role needs exists and is enabled.** `opencode agent
  list` would have shown `explore` missing — disabled in the user's own
  `opencode.json` — which silently downgraded a read-only role to the
  write-capable `build`.
- **the MCP server is registered** in the same scope the config resolves from.
  This is a new failure mode introduced by this design: an unregistered server
  leaves the wrapper with no tools at all, doing nothing silently. It must be
  visible.
- **no generated agent still grants `Bash`** — the migration state below.

`doctor` reports; `init` offers to fix what it can. `doctor` does not modify
anything, consistent with how it already treats a stray `~/sonata.toml`.

### Registration follows config scope

`init` writes the MCP server registration to the scope the config uses:
project-scoped config registers in the project, machine-scoped in the user
settings. This is the same pairing rule that fixed the config/agents split — a
registration that outlives its config is the same class of bug.

## Components

**`src/mcp/protocol.ts`** — `handle(request, deps): Response | null`. Pure:
takes a parsed JSON-RPC request, returns a response object, or null for
notifications. Every protocol decision is testable here without a process.

**`src/mcp/server.ts`** — the stdio loop. Reads newline-delimited JSON from
stdin, calls `handle`, writes responses. The only impure part.

**`src/mcp/tools.ts`** — the three tool definitions (name, description, JSON
Schema) and their dispatch to `cmdRun`, `cmdTail`, `cmdApprove`. Tool results
carry the same text the CLI prints, so both front doors agree.

**`sonata mcp`** — the CLI subcommand Claude Code is registered to launch.

**`src/commands/verify.ts`** — `cmdVerify({ id, model, cwd, home })`, reading
the run's `meta.json` and exit sentinel.

**`src/commands/doctor.ts`** — the completeness checks above.

**`src/commands/sync.ts`** — `agentMarkdown` emits the MCP tool line, and the
wrapper's procedure text is rewritten to call tools rather than shell commands.

**`src/settings.ts`** — MCP registration read/write, mirroring `installHook`.

## Data flow

```
Claude Code ──dispatch──▶ wrapper agent  (no Bash)
                              │  mcp__sonata__run
                              ▼
                     sonata mcp  (stdio JSON-RPC)
                              │  cmdRun / cmdTail / cmdApprove
                              ▼
                     tmux ──▶ opencode | codex | pi
                              │
                     .sonata/runs/<id>/ ──▶ sonata verify <id>
```

## Error handling

- **Malformed JSON on stdin** → a JSON-RPC parse error response; the loop
  continues. A hook or server that dies takes the session's dispatch capability
  with it.
- **Unknown method** → method-not-found error, not a crash.
- **`cmdRun` throws** (unknown model, refused permission mode) → the error text
  as an `isError` tool result, so the wrapper relays it instead of silently
  reporting nothing. This is the path that was invisible on 2026-08-12.
- **`verify` on an unknown id** → non-zero exit naming the id and the directory
  searched.
- **`verify` where the model does not match** → non-zero exit naming both, since
  that is what a fabricated or mismatched report looks like.
- **MCP server not registered** → a `doctor` error carrying the fix, because the
  wrapper cannot report its own absence.
- **Agents still granting Bash** → a `doctor` error, not a warning. Until they
  are regenerated the old failure remains reachable.

## Migration

Existing agents keep `tools: Bash` and keep working the old way until
regenerated. That window is the unsafe state, so `doctor` reports it as an
error with `sonata sync` as the fix, and `init` regenerates as part of its
normal run.

**A session restart is required** for new tool grants to take effect. This was
confirmed during design: a new agent file was not visible mid-session, and a
changed `tools:` line only applied on the next dispatch after the registry
refreshed. `init` and `sync` must say so, or a user will believe the constraint
is live when it is not.

## Testing

- `handle` — `initialize` returns the negotiated protocol version and a tools
  capability; `notifications/initialized` returns null; `tools/list` lists
  exactly three tools; `tools/call` with an unknown name returns an error, not a
  throw; malformed input yields a parse error.
- The captured Claude Code handshake, replayed as a fixture, produces a response
  the real client accepted.
- Tool dispatch — each tool calls its `cmd*` with the arguments the schema
  declares; a throwing `cmd*` becomes an `isError` result rather than a crash.
- `cmdVerify` — a real run passes; an unknown id fails; a model mismatch fails
  naming both.
- `doctor` — each new check fires on a constructed broken state and stays quiet
  on a healthy one, including: undefined model in `generate.models`, an agent
  naming a missing model, an agent still granting Bash, and an unregistered MCP
  server.
- `agentMarkdown` — emits the MCP tool line and no `Bash` grant.

Tests inject `cwd` and `home` as temp directories and never read the real
environment, as the existing suite does.

## Risks

**The protocol is written from documentation rather than a running client until
the fixture exists.** This is the same risk that produced `parsePiRefs`, which
is still built on a fixture composed from memory. Capturing the handshake is a
task in the plan, not an afterthought.

**An unregistered server is a silent no-op.** Trading a wrapper that does the
wrong work for one that does nothing is an improvement, but only because
`doctor` makes it visible. If that check is dropped, the trade is bad.

## Open questions

None blocking. One noted: whether `verify` should also assert the report file
is non-empty. A read-only opencode run legitimately cannot write one, so the
check would need `canWriteReport` from the run's meta — deferred until there is
a reason to want it.
