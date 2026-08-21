# CLAUDE.md

This file provides guidance to AI assistants when working with this repository. For a human-readable overview, see `@README.md`. Design notes and the implementation plan (including defects found by running it) live in `docs/superpowers/`; lessons about dispatching work through sonata are in `docs/dispatching-work-through-sonata.md`.

## Project Overview

**Sonata** — foreign-model subagents for Claude Code. It lets you dispatch a subagent backed by a different model (OpenCode, Codex, Pi, or Reasonix), running in that model's own harness, through the ordinary Agent tool. Same interface, same working directory, same report contract — different brain. Motivations: cost (cheap high-cache models for mechanical work) and diversity of judgement (a different model family reviews Claude's work).

The wrapper agent (MCP-only, relays rather than reasons) calls the `dispatch` tool, which launches a run and blocks until it is worth reporting; it uses `wait` to resume a `RUNNING` or approved run. Sonata composes the role prompt + CLAUDE.md + task, launches the harness in a detached tmux session, and reads completion from an exit sentinel + report file (never scraped from the terminal). Runs that die without writing a report are marked `degraded` so results are never falsely trusted.

**Status:** Working, early. Engine and the OpenCode/Codex/Pi/Reasonix adapters are complete and tested end-to-end against real models. Not yet published to npm — install from source (`npm link`).

## Requirements

- Node 22+
- tmux (every harness runs inside a tmux session) — `brew install tmux`
- macOS or Linux (Windows unsupported; WSL untested)
- At least one harness authenticated: OpenCode, Codex CLI (`codex login`), Pi, Reasonix (`reasonix setup`), or Claude Code
- LiteLLM for the native path (`pip install 'litellm[proxy]'`)

## Commands

```bash
npm install        # install dependencies
npm run build      # tsc → dist/
npm run typecheck  # tsc --noEmit
npm test           # vitest run (596 tests; needs tmux — runs against a fake harness)
npm run dev        # tsx src/cli.ts

npm link           # puts `sonata` on your PATH (until published to npm)
```

The CLI (after `npm link`):
- `sonata init` — set up sonata (interactive wizard; asks the config scope, then providers, models, roles and per-role models. Left goes back a screen, skipping any answered by a flag; writes the config, generates one agent per role × model, offers the permission hook). Unattended flags: `--yes`, `--providers`, `--models`, `--roles`, `--config-scope project|global`, `--scope project|global|skip`, `--prune`
- `sonata doctor` — check tmux, harnesses, auth, versions, permission hook
- `sonata sync` — regenerate agent files from `sonata.toml`; Claude Code picks them up automatically. Supports `--prune`
- `sonata run` — launch a run, print its id
- `sonata tail` — human/debugging view of a run (PROGRESS | PAUSED | DONE | STALLED); the MCP dispatch path uses `dispatch`/`wait`
- `sonata approve` — answer a pending approval
- `sonata mcp` — run the Sonata MCP server
- `sonata log <id>` — print a run's whole transcript; the after-the-fact companion to `tmux attach`
- `sonata verify <id> [--model <key>]` — verify a completed run
- `sonata auth` — manage native-path gateway keys (`list`, `add <gateway>`, `remove <gateway>`; keys live in the store, never logged)
- `sonata serve` — run the native router and its managed LiteLLM child. `--daemon` re-execs the CLI detached, **waits until the router answers**, then prints the pid, port and log path; a detached child that failed would otherwise report success and leave no server. Its output goes to `~/.config/sonata/logs/serve-<timestamp>.log`, since a detached process has nowhere else to say why it stopped
- `sonata restart` — kills whatever sonata router currently holds the configured port (a stale daemon, or one MCP-hosted inside a `sonata mcp` process) using only a pid `cmdServe` itself recorded, then starts a fresh daemon. Plain `sonata serve --daemon` cannot recover from this case: it just times out against `EADDRINUSE` with "the daemon did not answer", which reads as a startup failure rather than "something else already has it". See `stopServe`/`cmdRestart` in Configuration below.
- `sonata code` — launch a Claude Code session routed through the local proxy (passes `claude` args through); auto-starts `sonata serve --daemon` when the router is down
- `sonata gc` — kill finished tmux sessions

## Architecture

```
Claude Code
    │  Agent(subagent_type: "code-deepseek-v4-flash")
    ▼
wrapper agent  (MCP-only; relays, never reasons)
    │  mcp__sonata__dispatch / wait / approve
    ▼
sonata CLI
    │  composes role prompt + CLAUDE.md + task
    │  launches harness in a detached tmux session
    ▼
opencode → deepseek-v4-flash   (or codex, pi, or reasonix)
```

Key design points:
- **The three wrapper tools must be allow-listed**, which `sonata init` now does and `sonata doctor` checks. In Claude Code's `auto` mode an un-allow-listed tool is judged per call and the decisions are not stable: on 2026-08-12 a wrapper had `run` allowed and `tail` allowed twice then denied twice mid-run ("Blocked by classifier"), so a foreign model kept writing to the repository with nothing able to observe it. `run` executes code and is the one the classifier tends to permit, which makes the failure silent by construction. Today those wrapper tools are `dispatch`, `wait`, and `approve`.
- **The wrapper holds `mcp__sonata__dispatch`, `mcp__sonata__wait` and `mcp__sonata__approve`, and no Bash.** The polling tools were removed from the MCP surface so the wrapper cannot spend one model turn per progress poll; `dispatch` blocks until a reportable state and `wait` resumes when needed. This is deliberate: an agent with Bash performed 102 file reads and zero dispatches on 2026-08-12. `tools: Bash(sonata:*)` was tested and is silently ignored, so it is not a cheaper alternative and should not be re-proposed.
- **The wrapper never parses harness output.** It calls the MCP tools and relays. All harness-specific knowledge lives in one adapter file.
- **Completion is read from an exit sentinel and a report file**, never scraped from the terminal. If a harness dies without a report, sonata returns the captured pane and marks the result `degraded`.
- **Progress comes from diffing the tmux pane.** You can attach to any live run: `tmux attach -t sonata-<id>` (`-r` read-only) — so you can correct a cheap model mid-run.
- **`run_timeout_seconds` is a hard cap** enforced by a watchdog inside the launched shell (not by the MCP wait loop); on expiry the whole process group is killed and the run is reported `DONE`, `degraded`, report beginning `[timed out: …]`.
- **`sonata init`'s interactive TUI is an Ink app** (`src/tui-ink/`), not the hand-rolled prompt functions. The pure list primitives in `src/tui.ts` (`parseKey`/`reduce`/`renderList`) and the `select`/`confirm`/`runList` prompts are retained for the non-Ink interactive prompts that remain — init's hook-scope and confirm steps, and `cli.ts`'s `confirm` — and are intentionally not deleted.

### Source layout

```
src/
├── cli.ts                CLI entry point; arg parsing, then delegates to src/commands/* and src/mcp/*
├── commands/             command implementations (approve, auth, code, doctor, gc, init, log, run, serve, sync, tail, verify, wait)
├── mcp/                  stdio JSON-RPC MCP server — protocol.ts (handshake + captured fixtures), server.ts (`runMcpStdio`), tools.ts (dispatch/wait/approve tools)
├── config.ts             config resolution (project → machine), sonata.toml parsing, KNOWN_HARNESSES, isReadOnlyRole
├── detect.ts             harness catalogues (`opencode models`, `pi --list-models`, reasonix doctor) → ModelRef, provider grouping; WELL_KNOWN_PROVIDER_URLS
├── normalize.ts          config/model normalization
├── roles.ts              role prompt composition
├── settings.ts           permission-hook scope settings
├── store.ts              run state storage
├── tmux.ts               tmux session lifecycle (detached sessions, pane diffing)
├── tui.ts                Minimal zero-dependency TUI primitives — pure parseKey/reduce/renderList so list behaviour is testable without a TTY; retained for the non-Ink prompts (init's hook scope, prune confirm)
├── watchdog.ts           run timeout enforcement
├── mode.ts               permission-mode mapping (plan/default/acceptEdits/bypassPermissions/auto)
├── native/               native path — credentials.ts (gateway keys), litellm.ts (managed LiteLLM child config), router.ts (local routing proxy), models.ts (BYOK /models discovery)
├── types.ts              shared types
└── adapters/
    ├── types.ts          HarnessAdapter interface (plan, canPromptForApproval, promptPatterns, describePrompt, health)
    ├── index.ts          adapter registration
    ├── opencode.ts       smallest example adapter
    ├── codex.ts          most complete adapter
    ├── pi.ts             pi adapter
    ├── reasonix.ts       reasonix adapter — the only harness whose TUI sonata seeds itself
    └── claude.ts         claude harness adapter — headless `claude -p`, no TUI; native runs assume `sonata serve` is up

tests/                   vitest suite against a fake harness + captured fixtures in tests/fixtures/panes/
roles/                   role definitions (code, review, explore, plan) — owned by sonata, not the harness
hooks/                   capture-mode.mjs + hooks.json — the PreToolUse permission hook
docs/                    dispatching-work-through-sonata.md + reviews/ (architecture review) + superpowers/ (plans + specs)
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
- **Codex** (real sandbox, TUI prompts): `plan` → `codex exec` read-only; `default` → interactive TUI with `approval_policy=on-request` workspace-write; `acceptEdits` → `codex exec` workspace-write; `bypassPermissions` → `codex exec` danger-full-access. The TUI stdout stays attached to tmux: piping it through `tee` makes codex print `Error: stdout is not a terminal` and exit 0. A report watcher clears its composer and sends Ctrl-D once `report.md` lands. Sonata never passes `--dangerously-bypass-approvals-and-sandbox`.
- **Reasonix** (real approval cards, so `default` is honoured): `plan` and every read-only role → `run --permission-mode dontAsk`; `default` → interactive TUI with `--permission-mode ask`; `acceptEdits` and `bypassPermissions` → `run` with the same-named mode.
  - `--permission-mode plan` is **refused by `reasonix run`** ("requires an interactive session", exit 2), so read-only work uses `dontAsk` instead. That is real enforcement, probed: a run asked to read one file and write another read it fine and was refused both the write tool and the shell fallback. It cannot write `report.md` either, so `canWriteReport` is false.
  - **Never use `-y`/`--auto`.** It aliases reasonix's own `auto`, which is wider than Claude Code's — it skips risk prompts for things like `git push`. Claude's `auto` maps to `acceptEdits`, so always pass `--permission-mode` explicitly.
  - Reasonix loads the working directory's `.mcp.json` on top of its own config. In this repository that hands a dispatched model sonata's own dispatch/wait/approve tools, so it can dispatch further runs. `sonata doctor` warns when a `.mcp.json` is present.
- **Claude Code** (`claude -p` is headless and has no TUI): `plan`, `default`, `acceptEdits`, and `bypassPermissions` map directly to Claude Code's corresponding permission modes. Read-only roles use Claude's restricted tool set; native runs assume `sonata serve` is already up so the session is routed to the foreign model.

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
harness = "opencode"                # opencode | codex | pi | reasonix | claude
id = "openrouter/deepseek-v4-flash"     # provider/model for opencode, pi and reasonix; a bare id for codex

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

- **Keys are always quoted.** An unquoted `[models.grok-4.5]` nests as `models → "grok-4" → "5"` and silently stops describing the model it names. Every key and value is written through `tomlKey`, which also escapes control characters. This includes `credential_source` on `[native.gateways]`: its values are `sonata`, `codex`, and `opencode`; when absent, today's credential resolution is unchanged. `parseConfig` refuses `credential_source = "codex"` with `auth = "api-key"` because a Codex subscription is not a bearer API key and the metered endpoint authenticates before failing on quota — see `docs/codex-subscription.md`.
- **The key is `<harness>-<provider>-<model>`, slashes flattened to dashes**, and doubles as the agent filename (`code-<key>.md`). The harness segment is load-bearing: pi and opencode can serve the identical ref. Flattening is *not* injective (`opencode/go-x` and `opencode-go/x` collide), so `init` checks the keys it is about to write.
- **Ids are provider-qualified for opencode, pi and reasonix**, bare for codex; `parseConfig` enforces this per harness. Picker rows are labelled `<harness>/<provider>/<model>` (`refLabel`), because opencode and pi can serve the identical `provider/model` — labelling by ref alone printed two identical rows that also shared a selection value.
- **Each role chooses its own models** through `[generate.roles]`; the old flat `roles`/`models` pair is no longer accepted. `sonata init` rewrites an old config to the per-role format.
- Four roles ship: `code`, `review`, `explore`, `plan`. The last three are read-only, enforced by the harness (read-only sandbox on codex, tool allowlist on pi, read-only agent on opencode, `dontAsk` on reasonix).
- `sonata init` discovers OpenCode, Pi and Reasonix models (reasonix's catalogue and its per-provider auth state both come from `reasonix doctor --json`). Codex has no provider dimension and is added by hand; hand-written entries survive `sonata init`, which carries through any model whose harness it does not manage.
- **BYOK: a provider can be named directly, with no harness installed.** `init`
  offers ~30 well-known providers from `WELL_KNOWN_PROVIDER_URLS` as a `byok`
  pseudo-harness, alongside the existing `config` one — both bypass the harness
  filter in `providersForHarnesses`, which is what makes the zero-harness case
  work. A provider a harness already covers gets no BYOK row, so it is never
  offered twice. Having no harness is a **warning**, not the blocking error it
  used to be; that downgrade is where the zero-harness claim actually lives.
  - Models come from `GET <base_url>/models` (`src/native/models.ts`), which
    returns a `FetchModelsResult`, not a bare list. **Only 401/403 map to
    `unauthorized`** — that is the one failure whose fix is a different key, so
    it gets its own screen offering a re-prompt. 404, 429, non-JSON and a
    payload with no `data` array stay on the manual-ids path: a provider with no
    `/models` endpoint has nothing wrong with its key, and re-prompting there
    misdiagnoses in the opposite direction from the bug the split exists to fix.
    Fetched ids run through `isAnthropicRoutedName` for the same reason harness
    candidates do.
  - **The rejection screen must keep a way past itself.** Some providers 403 a
    key that is fine for inference, so "keep it and type ids by hand" sits
    beside "re-enter the key"; forcing the retry would trap that user in a loop.
    The retry carries an `attempt` counter because retyping the *same* key
    changes no effect dependency — and a retry usually is the same key, typed
    again by someone who believes they mistyped it.
  - **Keys are written once, after the confirm gate.** They live in
    `InitState.byokKeys` in memory only — `runInitTui` renders in-process and
    serializes nothing — so a cancelled wizard leaves no credential behind.
    There is deliberately **no `--key` flag**: it would put a credential in argv
    and shell history. The scripted path requires `sonata auth add <gateway>`
    first and refuses by name if the key is missing.
  - `byokCandidateKey` is exported and shared rather than inlined: the wizard
    puts the key into `nativeKeys` and `cmdInit` looks the candidate up by it,
    so two copies of the formula is how the two stop agreeing.
- **A prompt must `ref()` stdin while it waits** (`src/tui.ts`, `readKeys`). A
  paused stdin's handle is *unreferenced*, so waiting on a keystroke is not work
  node knows about: with nothing else pending the process exits, code 0,
  mid-prompt. Nothing paused stdin before the Ink wizard existed; Ink pauses it
  on unmount, so **every prompt after the wizard died the instant it was
  drawn** — prompt on screen, shell back, exit 0, nothing written. That was
  "sonata init never saves the config", and it left no error because there was
  no error. `unref()` on the way out, or the last prompt hangs instead.
- **`sonata init` writes a log** (`src/commands/init-log.ts`) to
  `~/.config/sonata/logs/init-<timestamp>.log`, newest ten kept. The wizard owns
  the screen — Ink repaints and the list prompts use the alternate buffer, which
  is discarded on exit — so a run that dies mid-wizard otherwise leaves a
  restored shell and no trace. Every printed line is teed there, along with the
  resolved selections and any error. Keys are recorded as the gateway they
  belong to, never as their value. `cli.ts` prints the directory when a run
  fails or cancels. Logging never throws: an unwritable home degrades to
  `nullInitLog` rather than failing the command it was meant to explain.
- Run `sonata sync` after editing the config; Claude Code picks up the generated agents automatically. Reconnect the sonata MCP server with `/mcp` only when sonata's MCP tool surface changes.

## Security

Sonata launches other coding agents on your machine — they run **as you**, with your files and credentials. Codex and reasonix both offer a real sandbox (reasonix reports its own `write_roots`, which follow `--dir`); pi has none, and opencode's is advisory. Sonata never bypasses a harness's own safety flags; credentials stay with the harness (sonata reads harness config for health reporting but does not copy/forward/log API keys). Prompt injection is a real risk with foreign models — for untrusted code, dispatch read-only roles or run in a container.
The native router transits the session credential locally and unmodified; native keys flow store → environment → LiteLLM only.

## Known Limitations

- `sonata init` discovers models for all three harnesses. Codex has no `models` subcommand, so its catalogue comes from `codex app-server`'s `model/list` (JSON-RPC over stdio); the schema is generated by `codex app-server generate-json-schema` and a real response is captured in `tests/fixtures/codex/model-list.json`.
- **opencode's `event` table grows without bound** — 6.5 GB across 140k rows on the development machine, which is what produced `database is locked` under three concurrent dispatches. Sonata cannot prune another harness's store. Three concurrent runs against opencode 1.18.16 completed cleanly, so this is load- and size-dependent rather than a fixed limit; a run that dies without producing output is now reported `degraded` rather than silently succeeding.
- Not published to npm yet — install from source.
- Prompt detection is regex against TUIs sonata does not control; `STALLED` timeout is the backstop. Codex prompt patterns are written from captured real output in `tests/fixtures/panes/`.
- Codex through a proxy needs that proxy up (`sonata doctor` checks the endpoint).
- `opencode run --format json` is broken upstream (v1.18.15 produces no output, never exits), so progress comes from pane text rather than a structured event stream. Pi's `--mode json` works; the adapter keeps a seam for adopting it.
- **An interactive run has to be told to stop.** Reasonix's TUI is a chat session: it does not exit when the task is
  done, so nothing writes the exit sentinel and a finished run sits at PROGRESS until the stall timeout, then gets
  killed and reported degraded with its report sitting right there. The adapter's watcher waits for `report.md` and
  then sends Ctrl-D, retrying until the sentinel appears. Ctrl-D, never the documented `exit` + Enter: typing blind
  races the TUI, and a run that typed `exit` landed the letters in an open approval card and the Enter picked
  whatever row was highlighted.
- **A prompt stays in the pane after it is answered, so it can be re-reported.** Prompt detection reads the current
  pane, and answering does not erase the block that matched. Under the one-call loop this is visible: a live
  reasonix dispatch on 2026-08-18 returned PAUSED for a prompt that had already been approved, so `approve` sent
  its `1` when no selection list was open and the digit landed in the composer as text. Two consequences —
  wasted approve/wait round trips, and a composer that is no longer empty.
- **Ctrl-D does not quit a reasonix TUI whose composer is not empty**, which is how the above turns a finished run
  into a STALLED one: the report was written, the quit watcher sent Ctrl-D, nothing happened, and no exit sentinel
  was ever produced. Clearing the line before quitting would fix the second half; the first half needs prompt
  detection to know what it has already answered.
- No streaming granularity guarantees — progress is whatever the harness prints.
- **`default` mode is verified live on codex and reasonix** (2026-08-18). A codex dispatch surfaced its
  directory-trust prompt as `PAUSED`, took `approve`, did the work and reached `DONE` un-degraded — the first
  time codex `default` has ever run. A reasonix dispatch went from 9 calls with duplicated prompts ending
  `STALLED`, to 5 calls, no duplicates, `DONE` with its report.
- **MCP progress notifications DO reach the user's terminal, and cost nothing.** Probed 2026-08-18 against Claude
  Code 2.1.233 (protocol 2025-11-25): a `tools/call` arrives with `params._meta.progressToken`, and a
  `notifications/progress` referencing that token is rendered while the call blocks. They are protocol messages,
  not tool results, so they never enter any model's context — which is exactly why they cannot feed the
  orchestrator, and exactly why they are free. Wired up: `dispatch` and `wait` emit one notification per line.
- **The progress display keeps the head of one message, not a history.** Measured 2026-08-19 against Claude Code
  2.1.233, in the subagent view: a notification carrying several lines is **flattened** — the newlines are not
  rendered — and then **clipped head-first** at roughly two wrapped rows. Sending a rolling window of recent
  output was tried and is measured *worse* than one line: the newest line sits at the window's end, so it is
  exactly what the clip removes (a screenshot showed four old commands and the live one cut to `$ nod…`). Hence
  one line per notification. Live history has no channel here; it belongs in the transcript.
- **`notifications/message` renders nothing.** Probed 2026-08-19 in the subagent view, with `logging: {}`
  declared in the initialize response first — a compliant client may discard log notifications from a server that
  never declared the capability, so emitting without declaring would have made silence unreadable. Declared and
  emitted per line, still only the latest progress line appeared. **The tool result is the only channel into
  conversation history**, which is what makes `transcript: true` the whole-run answer and a chunked `wait` the
  only possible interleaved one.
- **The harness conversation cannot be *pushed* into Claude Code turn by turn.** A subagent receives text only as tool results, and its parent receives only its final message, so no push channel exists to stream into. Two channels carry the conversation anyway: the progress window above shows it live, and `dispatch`/`wait` accept `transcript: true`, which returns the run's whole recorded transcript — `sonata log`'s content — beside the report, budgeted so the report can never be pushed out of the result. It is opt-in because a transcript is far larger than a report and lands in the wrapper's context. Outside Claude Code, `tmux attach -r -t sonata-<id>` is the live view and `sonata log <id>` the after-the-fact one; `sonata tail` remains a human/debugging CLI command.

## Native path

The native path runs foreign models inside Claude Code's own loop, tools, and permission modes through a local routing proxy. The harness path instead runs the foreign model's own loop in OpenCode, Codex, Pi, or Reasonix.

Its `[native]` config surface describes foreign `models`, `gateways`, and their `ports`; `[generate.native]` assigns native model keys to roles. `sonata serve` runs the router and managed LiteLLM child, while `sonata code` launches a Claude Code session routed through it. LiteLLM is an external prerequisite, like tmux: install it with `pip install 'litellm[proxy]'`.

Sonata implements no OAuth itself; it drives LiteLLM's own authenticator as a subprocess, so no token passes through sonata's process memory. A login needs neither the codex CLI nor a prior `codex login`: LiteLLM's authenticator is a self-contained HTTP client, and the Codex OAuth app id is compiled into it. The login script calls `get_access_token()`, never `_login()` — only the former persists the token, while `_login()` starts a second device flow against an empty directory.

For Copilot, `api-key.json`, written by `get_api_key()`, proves entitlement. A bare `ghu_` token proves nothing: LiteLLM's Copilot credential is a GitHub App token with no OAuth scopes, while opencode's stored `gho_` token has only `read:user` and cannot be exchanged for a Copilot key. These are different credential kinds and remain distinct sources. Copilot's device flow polls for 60 seconds; ChatGPT's polls for 15 minutes. Copilot retries three times, with a fresh code each time.

The `sonata` credential source points LiteLLM's token directory at `~/.config/sonata/credentials/<gateway>/`, so refreshes persist across runs. The old temp-directory approach silently discarded every refresh; Copilot's `api-key.json` is short-lived and re-exchanged in place, so persistence is load-bearing. Never pass `api_base` for Copilot: `get_api_base()` reads `endpoints.api` from `api-key.json`, and business tenants have different endpoints.

There are two deliverables: (A) `sonata serve`/`sonata code` for a complete local routing path, and (B) the `claude` harness adapter for dispatching foreign-on-Claude-loop through the existing MCP path.

**A gateway declares how it authenticates.** `auth = "api-key"` (the default, so existing configs are unaffected) sends a stored bearer to `base_url`. `auth = "codex-oauth"` uses the ChatGPT subscription credential written by `codex login`, and takes **no** `base_url` — parsing refuses one, because that credential is refused by the metered `api.openai.com` with `insufficient_quota` *after* passing auth and scopes, and reaches only `https://chatgpt.com/backend-api/codex`. A subscription is not API credit; a config naming the metered URL authenticates and then 429s, which reads as a missing key. LiteLLM's `chatgpt` provider handles that endpoint, the Responses wire API, the mandatory streaming, and token refresh, so sonata emits `model: chatgpt/<id>` with `model_info.mode: responses` and **no** `api_base`/`api_key` — passing either overrides the provider and breaks it. Without `mode: responses` LiteLLM POSTs to the bare `backend-api/codex/` URL and gets a Cloudflare HTML page. Non-streaming calls hit an open upstream bug (BerriAI/litellm#25429) that streaming clients — Claude Code included — never reach. Full detail in `docs/codex-subscription.md`.

**`auth = "copilot-oauth"`** uses opencode's GitHub Copilot login and emits `model: github_copilot/<id>` — no `mode` override, because Copilot speaks chat-completions. `serve` writes the `gho_` token to `access-token` and sets `GITHUB_COPILOT_TOKEN_DIR`; LiteLLM exchanges it for a Copilot key. **That exchange usually fails**: opencode's token carries scope `read:user` only, so GitHub answers `copilot_internal/v2/token` with 403, LiteLLM drops the deployment, and the request fails as "no healthy deployments" naming neither cause. So `init` and `doctor` check the `copilot` scope first (asking GitHub, failing closed) and refuse to offer models the credential cannot serve.

**`init` must never offer a model the router cannot reach.** Copilot, anexto and anthropic all serve Claude models, and the router sends `claude-` upstream, so `parseConfig` refuses those ids — 27 such candidates were being offered, and selecting one wrote a config that then failed to load. `isAnthropicRoutedName` is the single definition, used by both the parser and the candidate filter.

**The router port's occupant is usually sonata.** An MCP dispatch to a native
model starts a router *inside* the `sonata mcp` process, and that router lives
as long as the MCP server does — until Claude Code restarts, not until the
dispatch ends. So `serve` after any native dispatch hits `EADDRINUSE`, and its
old message called that "a non-sonata listener", sending the user to hunt a
foreign program that did not exist (a day-old `sonata mcp` was found holding
4100 and answering its own health endpoint). `occupiedPortMessage` asks the
health endpoint first, which costs one request and makes the message true.

**`sonata restart` clears that occupant instead of just naming it.** `cmdServe`
now records `process.pid` as `routerPid` in `serve-state.json` once the router
successfully binds — true whether that process is a foreground/daemon `sonata
serve` or an in-process router started inside `sonata mcp` (both call `cmdServe`
the same way; `src/commands/run.ts` is the second call site). `stopServe` reads
that file, kills only the pids sonata itself recorded (never a pid found by
scanning the OS — the same discipline as the pre-existing litellm-orphan kill),
and polls the health endpoint until the port actually frees before returning.
`cmdRestart` runs that then `startServeDaemon`. If the port answers as a sonata
router but the state file has no matching pid (a different sonata install, or
state left by an older version), `stopServe` refuses rather than guessing —
same principle as `occupiedPortMessage`. Killing an MCP-hosted router's pid
ends the `sonata mcp` process it lives in, dropping that session's MCP
connection until Claude Code reconnects; `restart` makes that trade explicitly
instead of leaving a stale router unreachable forever.

**The router logs which upstream served each request** — `POST /v1/messages
model=gpt-5.6-terra -> litellm`. `serve` never passed a `log` before, so that
line had never produced output, and LiteLLM's access log records the path and
status but not the model. That left "did this native agent really run on the
foreign model, or fall back to Claude?" answerable only by inference. It is now
evidence: a `claude-`-prefixed model logs `-> anthropic` and never reaches
LiteLLM at all, so a foreign-model line in `serve`'s log is proof of routing.

**Claude Code's `system` array must be flattened for codex.** Claude Code always
sends `system` as an array of text blocks. LiteLLM turns a *string* system prompt
into a `developer` message the Codex backend accepts, but leaves block arrays as
role `system` — and that backend answers `{"detail":"System messages are not
allowed"}`, a 400 naming neither the field nor the shape, so it reads as a model
or auth problem. Probed directly: a string system prompt streams fine, the
identical text as a one-element array 400s, an empty array is accepted.
`flattenSystemBlocks` (`src/native/router.ts`) joins the blocks with blank lines
on the **litellm path only** — an Anthropic request stays byte-identical, since
Anthropic understands its own shape. `cache_control` is dropped with the block
wrapper, costing prompt caching on this path; the alternative is a request that
cannot be sent. A non-text block (an image) has no string form, so the body is
passed through unchanged rather than silently losing content. Verified live: the
model obeys the flattened prompt, not just accepts it.

**ChatGPT's Codex endpoint returns `output: []` under concurrent load, which LiteLLM surfaces as a 500.** When 8+ native agents dispatched simultaneously hit the same `codex-oauth` gateway, the upstream accepts the requests (no 429) but returns empty completions. LiteLLM's Responses API transformation (`transformation.py`) raises `ValueError: Unknown items in responses API response: []` and the proxy emits 500. The router (`src/native/router.ts`) catches 500 responses from LiteLLM whose body contains that string and re-emits them as 529 (overloaded) — Claude Code treats 529 as a retriable backpressure signal rather than a hard fault, so the turn is retried automatically. The match is string-level because the body is LiteLLM's rendered exception, not a structured field. LiteLLM 1.97.0 added an SSE recovery attempt for this case but still raises when recovery fails, so the router catch is still needed.

**`serve` inherits LiteLLM's stdio.** A per-model startup failure appears only in LiteLLM's own output; discarding it is what turned a plain 403 into an unrelated-looking "no healthy deployments for this model".

**opencode's OAuth entries are not API keys.** `opencodeKeys()` resolves `type: api` entries only, which is correct — but the `type: oauth` ones (`openai`, `github-copilot`) were then invisible, so doctor reported "no key" for a credential sitting on disk. opencode's `openai` entry is the *same* ChatGPT credential codex holds (identical `client_id`), so `readChatGptOAuth` prefers codex and falls back to opencode; the `client_id` is checked, because another OpenAI grant would fail confusingly inside LiteLLM. opencode writes `expires: 0` on the Copilot entry to mean "never expires".

**`serve` must clean up on signals.** It runs until killed, so its signal handlers *are* its normal exit path; without them the run's temp directory survives, carrying the generated master key and, for a codex-oauth gateway, the ChatGPT credential. One such token was found in the system temp directory. `ServeDeps.tempDir` exists so tests never write into the real temp directory — two 0600 files carrying a test fixture's gateway URL were found there after a suite run.

Remote Control is the trade-off: `ANTHROPIC_BASE_URL` is process-wide, and `isFirstPartyAnthropicBaseUrl` gates Remote Control. Sessions launched by `sonata code` therefore lose Remote Control while routed through the local proxy.

The `claude-` prefix is load-bearing because the router sends that prefix to Anthropic. Native model keys and ids beginning with `claude-` are refused at parse time. Credentials flow only store → memory → LiteLLM environment; keys are never logged or put in a Claude conversation. The user starts `sonata serve`: the classifier correctly blocks launching an auth-forwarding proxy from inside a session.

The `claude` harness adapter is the simplest adapter: it runs headless `claude -p`, has no TUI, and maps permission modes directly. For native dispatches it assumes `sonata serve` is already running.

## Conventions

- **Harness-specific knowledge stays inside its adapter** — never in the CLI or the wrapper.
- **Evidence over inference** for harness behaviour: a captured fixture in `tests/fixtures/panes/` beats a plausible regex.
- **Tests need no API keys** — the suite runs against a fake harness (scripted binary replaying a normal run, a crash, a captured approval prompt, a hang the watchdog kills, a clean exit with no report, and a harness-written report).
- Run `npm test` and `npm run typecheck` before opening a PR; CI runs both on Linux with tmux installed.
- Escape control characters and keys everywhere they are written (TOML escaping) — see the duplicate-TOML-table and control-char fixes in git history.
- **`sonata` on PATH runs `dist/`, not `src/`.** After changing anything under `src/`, `npm run build` or the global command keeps the old behaviour. Two bugs in this repo's history were "fixed" but still reproducing for exactly this reason.
- **The launch wrapper must `fg` the harness, and must not redirect that `fg`.** `set -m` gives the harness its own
  process group so the watchdog can kill the tree, but that group is then not the terminal's foreground group, so any
  harness reading the terminal takes SIGTTIN and stops dead — pane frozen, process in state `T`, no exit sentinel,
  killed at the run timeout. `fg %1 >/dev/null 2>&1` runs, reports success, and leaves the job stopped anyway;
  only the unredirected `fg %1` actually hands over. Both verified against the same wrapper.
- The wrapper agent relays; it must never reason about or parse harness output.
