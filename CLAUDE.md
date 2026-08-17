# CLAUDE.md

This file provides guidance to AI assistants when working with this repository. For a human-readable overview, see `@README.md`. Design notes and the implementation plan (including defects found by running it) live in `docs/superpowers/`; lessons about dispatching work through sonata are in `docs/dispatching-work-through-sonata.md`.

## Project Overview

**Sonata** — foreign-model subagents for Claude Code. It lets you dispatch a subagent backed by a different model (OpenCode, Codex, or Pi), running in that model's own harness, through the ordinary Agent tool. Same interface, same working directory, same report contract — different brain. Motivations: cost (cheap high-cache models for mechanical work) and diversity of judgement (a different model family reviews Claude's work).

The wrapper agent (MCP-only, relays rather than reasons) calls `sonata run` → gets a run id, then polls with `sonata tail`. Sonata composes the role prompt + CLAUDE.md + task, launches the harness in a detached tmux session, and reads completion from an exit sentinel + report file (never scraped from the terminal). Runs that die without writing a report are marked `degraded` so results are never falsely trusted.

**Status:** Working, early. Engine and the OpenCode/Codex/Pi adapters are complete and tested end-to-end against real models. Not yet published to npm — install from source (`npm link`).

## Requirements

- Node 22+
- tmux (every harness runs inside a tmux session) — `brew install tmux`
- macOS or Linux (Windows unsupported; WSL untested)
- At least one harness authenticated: OpenCode, Codex CLI (`codex login`), or Pi

## Commands

```bash
npm install        # install dependencies
npm run build      # tsc → dist/
npm run typecheck  # tsc --noEmit
npm test           # vitest run (432 tests; needs tmux — runs against a fake harness)
npm run dev        # tsx src/cli.ts

npm link           # puts `sonata` on your PATH (until published to npm)
```

The CLI (after `npm link`):
- `sonata init` — set up sonata (interactive wizard; asks the config scope, then providers, models, roles and per-role models. Left goes back a screen, skipping any answered by a flag; writes the config, generates one agent per role × model, offers the permission hook). Unattended flags: `--yes`, `--providers`, `--models`, `--roles`, `--config-scope project|global`, `--scope project|global|skip`, `--prune`
- `sonata doctor` — check tmux, harnesses, auth, versions, permission hook
- `sonata sync` — regenerate agent files from `sonata.toml` (run after editing config, then restart Claude Code); supports `--prune`
- `sonata run` — launch a run, print its id
- `sonata tail` — poll a run for progress (PROGRESS | PAUSED | DONE | STALLED)
- `sonata approve` — answer a pending approval
- `sonata mcp` — run the Sonata MCP server
- `sonata log <id>` — print a run's whole transcript; the after-the-fact companion to `tmux attach`
- `sonata verify <id> [--model <key>]` — verify a completed run
- `sonata gc` — kill finished tmux sessions

## Architecture

```
Claude Code
    │  Agent(subagent_type: "code-deepseek-v4-flash")
    ▼
wrapper agent  (MCP-only; relays, never reasons)
    │  mcp__sonata__run / tail / approve
    ▼
sonata CLI
    │  composes role prompt + CLAUDE.md + task
    │  launches harness in a detached tmux session
    ▼
opencode → deepseek-v4-flash   (or codex, or pi)
```

Key design points:
- **The three wrapper tools must be allow-listed**, which `sonata init` now does and `sonata doctor` checks. In Claude Code's `auto` mode an un-allow-listed tool is judged per call and the decisions are not stable: on 2026-08-12 a wrapper had `run` allowed and `tail` allowed twice then denied twice mid-run ("Blocked by classifier"), so a foreign model kept writing to the repository with nothing able to observe it. `run` executes code and is the one the classifier tends to permit, which makes the failure silent by construction.
- **The wrapper holds `mcp__sonata__run`, `mcp__sonata__tail` and `mcp__sonata__approve`, and no Bash.** This is deliberate: an agent with Bash performed 102 file reads and zero dispatches on 2026-08-12. `tools: Bash(sonata:*)` was tested and is silently ignored, so it is not a cheaper alternative and should not be re-proposed.
- **The wrapper never parses harness output.** It calls the MCP tools and relays. All harness-specific knowledge lives in one adapter file.
- **Completion is read from an exit sentinel and a report file**, never scraped from the terminal. If a harness dies without a report, sonata returns the captured pane and marks the result `degraded`.
- **Progress comes from diffing the tmux pane.** You can attach to any live run: `tmux attach -t sonata-<id>` (`-r` read-only) — so you can correct a cheap model mid-run.
- **`run_timeout_seconds` is a hard cap** enforced by a watchdog inside the launched shell (not by `sonata tail`); on expiry the whole process group is killed and the run is reported `DONE`, `degraded`, report beginning `[timed out: …]`.

### Source layout

```
src/
├── cli.ts                CLI entry point; arg parsing, then delegates to src/commands/* and src/mcp/*
├── commands/             command implementations (approve, doctor, gc, init, log, run, sync, tail, verify)
├── mcp/                  stdio JSON-RPC MCP server — protocol.ts (handshake + captured fixtures), server.ts (`runMcpStdio`), tools.ts (run/tail/approve tools)
├── config.ts             config resolution (project → machine), sonata.toml parsing, KNOWN_HARNESSES, isReadOnlyRole
├── detect.ts             harness catalogues (`opencode models`, `pi --list-models`) → ModelRef, provider grouping
├── normalize.ts          config/model normalization
├── roles.ts              role prompt composition
├── settings.ts           permission-hook scope settings
├── store.ts              run state storage
├── tmux.ts               tmux session lifecycle (detached sessions, pane diffing)
├── tui.ts                Minimal zero-dependency TUI primitives — pure parseKey/reduce/renderList so list behaviour is testable without a TTY
├── watchdog.ts           run timeout enforcement
├── mode.ts               permission-mode mapping (plan/default/acceptEdits/bypassPermissions/auto)
├── types.ts              shared types
└── adapters/
    ├── types.ts          HarnessAdapter interface (plan, canPromptForApproval, promptPatterns, describePrompt, health)
    ├── index.ts          adapter registration
    ├── opencode.ts       smallest example adapter
    ├── codex.ts          most complete adapter
    └── pi.ts             pi adapter

tests/                   vitest suite against a fake harness + captured fixtures in tests/fixtures/panes/
roles/                   role definitions (code, review, explore, plan) — owned by sonata, not the harness
hooks/                   capture-mode.mjs + hooks.json — the PreToolUse permission hook
docs/                    dispatching-work-through-sonata.md + superpowers/ (plans + specs)
```

### Adding a harness

The adapter boundary is the extension point — one new file plus registration:
1. `src/adapters/<name>.ts` — export a `HarnessAdapter` (interface in `src/adapters/types.ts`; implement `plan`, `canPromptForApproval`, `promptPatterns`/`describePrompt`, optional `health`)
2. `src/adapters/index.ts` — register it
3. `src/config.ts` — add the name to `KNOWN_HARNESSES`
4. `tests/adapters/<name>.test.ts` — follow an existing adapter's tests

**Probe the real binary before writing an adapter** — every adapter bug found so far was invisible in documentation and obvious on the first real run. If you claim a harness prints something, capture it into `tests/fixtures/panes/` and test against that.

## Permission modes

Sonata mirrors the Claude Code permission mode onto the harness; a sonata agent is never more permissive than the session that spawned it. Where a harness cannot honour a mode, sonata refuses the run rather than downgrading quietly.

- **OpenCode** (`opencode run` has no approval UI — it either proceeds unasked or auto-rejects): `plan` → plan agent, no approve; `default` → **refused** for write-capable roles; `acceptEdits`/`bypassPermissions` → build agent, auto-approve.
- **Pi** (no sandbox, `--tools` allowlist is real): `plan` → `--tools read,grep,find,ls`; `default` → refused for write-capable roles; `acceptEdits`/`bypassPermissions` → all built-in tools.

**A read-only run cannot write `report.md`** on either opencode or pi, so sonata takes terminal output as the report and does NOT mark such a run degraded (`LaunchPlan.canWriteReport`). Pi's allowlist removes the write tool; opencode's `plan` agent is *instructed* not to modify files and declines — weaker enforcement, identical reporting consequence. Probed directly: a run asked only to write one file wrote nothing and reported "blocked by policy, not by error".
- **Codex** (real sandbox, TUI prompts): `plan` → `codex exec` read-only; `default` → interactive TUI with `approval_policy=on-request` workspace-write; `acceptEdits` → `codex exec` workspace-write; `bypassPermissions` → `codex exec` danger-full-access. Sonata never passes `--dangerously-bypass-approvals-and-sandbox`.

The permission mode is not exposed as an env var, so this needs a **PreToolUse hook** (`hooks/capture-mode.mjs`), which `sonata init` offers to install at project or global scope. Without it sonata assumes `default` — for opencode/pi that means dispatches refuse, so `sonata doctor` reports a missing hook as a blocker.

**Where the mode is stored mirrors config resolution.** A project with its own `sonata.toml` or `.sonata/` gets `<cwd>/.sonata/session-<id>.json`; a project relying only on `~/.config/sonata/sonata.toml` gets `~/.config/sonata/session-<id>.json`; a directory with neither is left alone. That second case matters — the hook is installed globally and fires on every Bash call, so writing into the repo would scatter `.sonata/` directories across the machine. `readPermissionMode` reads the same two locations in the same order.

**`auto` mode** (Claude Code's current default) maps to `acceptEdits`. Residual gap: the foreign harness has no classifier, so it will run things auto mode would have blocked. Dispatch in `plan` mode, or to a read-only role, when that matters.

## Configuration

Sonata resolves exactly one config, in this order (`configPath` in `src/config.ts`):

1. `./sonata.toml` — the current repository, wins outright
2. `~/.config/sonata/sonata.toml` — the machine

A project config **replaces** the machine one; they are never merged, so it is always possible to say which file produced a run. `sonata doctor` prints the resolved path.

```toml
# sonata.toml
[models."opencode-openrouter-deepseek-v4-flash"]
harness = "opencode"                # opencode | codex | pi
id = "openrouter/deepseek-v4-flash"     # provider/model for opencode and pi; a bare id for codex

[generate.roles]
code    = ["opencode-openrouter-kimi-k3"]
review  = ["opencode-openrouter-grok-4.5", "opencode-openai-gpt-5.6-sol"]
explore = ["opencode-opencode-go-deepseek-v4-flash"]
plan    = ["opencode-openai-gpt-5.6-terra"]

[run]
tail_window_seconds   = 20     # how long `sonata tail` blocks per call
stall_timeout_seconds = 120    # silence before a run is reported STALLED
run_timeout_seconds   = 1800   # hard cap; the run is killed at this point
```

- **Keys are always quoted.** An unquoted `[models.grok-4.5]` nests as `models → "grok-4" → "5"` and silently stops describing the model it names. Every key and value is written through `tomlKey`, which also escapes control characters.
- **The key is `<harness>-<provider>-<model>`, slashes flattened to dashes**, and doubles as the agent filename (`code-<key>.md`). The harness segment is load-bearing: pi and opencode can serve the identical ref. Flattening is *not* injective (`opencode/go-x` and `opencode-go/x` collide), so `init` checks the keys it is about to write.
- **Ids are provider-qualified for opencode and pi**, bare for codex; `parseConfig` enforces this per harness. Picker rows are labelled `<harness>/<provider>/<model>` (`refLabel`), because opencode and pi can serve the identical `provider/model` — labelling by ref alone printed two identical rows that also shared a selection value.
- **Each role chooses its own models** through `[generate.roles]`; the old flat `roles`/`models` pair is no longer accepted. `sonata init` rewrites an old config to the per-role format.
- Four roles ship: `code`, `review`, `explore`, `plan`. The last three are read-only, enforced by the harness (read-only sandbox on codex, tool allowlist on pi, read-only agent on opencode).
- `sonata init` discovers OpenCode and Pi models. Codex has no provider dimension and is added by hand; hand-written entries survive `sonata init`, which carries through any model whose harness it does not manage.
- Run `sonata sync` after editing the config, and restart Claude Code so it picks up the generated agents.

## Security

Sonata launches other coding agents on your machine — they run **as you**, with your files and credentials. Only codex offers a real sandbox; pi has none, and opencode's is advisory. Sonata never bypasses a harness's own safety flags; credentials stay with the harness (sonata reads harness config for health reporting but does not copy/forward/log API keys). Prompt injection is a real risk with foreign models — for untrusted code, dispatch read-only roles or run in a container.

## Known Limitations

- `sonata init` discovers models for all three harnesses. Codex has no `models` subcommand, so its catalogue comes from `codex app-server`'s `model/list` (JSON-RPC over stdio); the schema is generated by `codex app-server generate-json-schema` and a real response is captured in `tests/fixtures/codex/model-list.json`.
- **opencode's `event` table grows without bound** — 6.5 GB across 140k rows on the development machine, which is what produced `database is locked` under three concurrent dispatches. Sonata cannot prune another harness's store. Three concurrent runs against opencode 1.18.16 completed cleanly, so this is load- and size-dependent rather than a fixed limit; a run that dies without producing output is now reported `degraded` rather than silently succeeding.
- Not published to npm yet — install from source.
- Prompt detection is regex against TUIs sonata does not control; `STALLED` timeout is the backstop. Codex prompt patterns are written from captured real output in `tests/fixtures/panes/`.
- Codex through a proxy needs that proxy up (`sonata doctor` checks the endpoint).
- `opencode run --format json` is broken upstream (v1.18.15 produces no output, never exits), so progress comes from pane text rather than a structured event stream. Pi's `--mode json` works; the adapter keeps a seam for adopting it.
- No streaming granularity guarantees — progress is whatever the harness prints.
- **The harness conversation cannot be streamed into Claude Code.** A subagent receives text only as tool results, and its parent receives only its final message, so no push channel exists to stream into. `sonata tail` is already a long-poll (it returns the instant a line appears, and only blocks for `tail_window_seconds` when the harness is silent); `tmux attach -r -t sonata-<id>` is the live view, and `sonata run` now prints that command.

## Conventions

- **Harness-specific knowledge stays inside its adapter** — never in the CLI or the wrapper.
- **Evidence over inference** for harness behaviour: a captured fixture in `tests/fixtures/panes/` beats a plausible regex.
- **Tests need no API keys** — the suite runs against a fake harness (scripted binary replaying a normal run, a crash, a captured approval prompt, a hang the watchdog kills, a clean exit with no report, and a harness-written report).
- Run `npm test` and `npm run typecheck` before opening a PR; CI runs both on Linux with tmux installed.
- Escape control characters and keys everywhere they are written (TOML escaping) — see the duplicate-TOML-table and control-char fixes in git history.
- **`sonata` on PATH runs `dist/`, not `src/`.** After changing anything under `src/`, `npm run build` or the global command keeps the old behaviour. Two bugs in this repo's history were "fixed" but still reproducing for exactly this reason.
- The wrapper agent relays; it must never reason about or parse harness output.
