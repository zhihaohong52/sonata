# Investigating two DeepSeek harnesses as sonata adapters

Date: 2026-08-17
Status: investigation only — no code written, nothing added to `KNOWN_HARNESSES`

Two candidates were raised:

- `esengine/DeepSeek-Reasonix` — "Reasonix", a terminal coding agent
- `deepseek-ai/deepseek-harness` — "dsh", an agent harness framework

**Verdict: Reasonix is a strong adapter candidate and the best fit sonata has seen after
codex. dsh is not one yet — defer and watch.**

The Reasonix section was **probed against the real binary** (`reasonix v1.26.0`,
`git_commit cf5ac0b3584e`, built 2026-08-17, `darwin/arm64`, Go 1.26.6), installed with
`npm i -g reasonix`. Findings marked **probed** are captured output; everything else is
doc-derived. The probe machine has no `DEEPSEEK_API_KEY`, so no model turn was ever
executed — that limit is what the final section is about. The dsh section is doc- and
source-derived only.

---

## Reasonix

| | |
|---|---|
| Repo | `esengine/DeepSeek-Reasonix`, MIT, 34.6k stars, pushed 2026-08-17 |
| Default branch | `main-v2` — a **Go** rewrite (Go 1.25+) |
| npm | `reasonix@1.26.0` (`latest`) |
| Legacy line | `dsnix@0.53.1` — the TypeScript 0.x line, in maintenance |

**Probed: `reasonix@1.26.0` is the Go v2 line.** `reasonix version --json` reports
`go1.26.6`, and `reasonix --help` self-describes as "a config- and plugin-driven coding
agent (multi-model)". The `main`-branch TypeScript 0.x line, whose stated non-goal was
multi-provider support, is a different product; the npm package is the one you want.

### Why it fits sonata

Reasonix has, in one binary, the three things sonata's adapter interface wants and which
no current harness supplies together:

1. **A real headless one-shot mode with structured output** (probed)

   `reasonix run --help` gives, among others: `--dir` (project root — config, sandbox and
   file tools all resolve from it, which is exactly sonata's `cwd`), `--model`,
   `--permission-mode`, `--allowed-tools`, `--add-dir`, `--max-steps`,
   `--output-format text|json|stream-json`, `--events-jsonl`, `--effort`, and
   `--metrics PATH` / `--trajectory PATH` which write JSON to a path sonata chooses.

   `stream-json`/`--events-jsonl` is a genuine event stream. opencode's `--format json` is
   broken upstream, which is why sonata diffs the tmux pane; Reasonix would not need that
   workaround. (The tmux/pane design still stands — see "ACP" below.)

2. **Permission modes that map almost 1:1 onto Claude Code's** (probed)

   `--permission-mode manual|ask|auto|acceptEdits|dontAsk|plan|bypassPermissions`,
   default `ask`. Plus `--allowed-tools`, a real sandbox (`doctor` reports
   `sandbox.bash: "enforce"` with explicit `write_roots`), and per-turn checkpoints.

3. **Interactive approval cards** — allow once / allow for session / always allow / deny.

   This means `canPromptForApproval: true`. Reasonix would be **the second harness after
   codex able to honour `default` mode for write-capable roles**, instead of refusing it
   the way opencode and pi do. That is the single biggest reason to take this one.

### Mode mapping

**Probed, and it corrects the obvious guess: `plan` is refused headlessly.**

```
$ reasonix run --permission-mode plan "say hello"
error: --permission-mode plan requires an interactive session      # exit 2
```

Every other mode is accepted by `run` (all reached the API call and failed on the missing
key with exit 1). Exit codes match the documented contract — `2` for argument errors, `1`
for state errors — which is a clean signal for the launch script's sentinel.

| Claude Code mode | Reasonix | Notes |
|---|---|---|
| `plan` | **interactive TUI** with `--permission-mode plan`, task seeded via send-keys | `run` refuses it; sonata is already tmux-based so this costs nothing |
| `default` | interactive TUI, `--permission-mode ask`, approval cards | the mode opencode and pi have to refuse |
| `acceptEdits` | `run --permission-mode acceptEdits` | headless |
| `bypassPermissions` | `run --permission-mode bypassPermissions` | headless; `-y/--auto` is an alias for `auto`, **not** for this |

**Trap confirmed at the flag level:** `-y, --auto` is documented in `--help` as "alias for
`--permission-mode auto`". Since Claude Code's `auto` maps to `acceptEdits` in `mode.ts`,
an adapter that reaches for the similarly-named `-y` would silently widen permissions.
Pass `--permission-mode acceptEdits` explicitly and never use `-y`.

**Seeding the TUI works** (probed). Launched in tmux, the interactive session ignores
positional task text — the composer comes up empty — but `tmux send-keys` types into it
normally, which is the codex-shaped approach the adapter already knows. The status line
also renders the active mode, so pane-diffing can verify the mode actually took:

```
◆ reasonix  · deepseek-v4-flash
  Context is kept across turns. Type 'exit' or Ctrl-D to quit.
  ! provider "deepseek-flash": missing env DEEPSEEK_API_KEY
 ❯ hello from sonata probe
   Plan  · ready · Shift+Tab ask/auto/plan · Ctrl+Y YOLO      MODEL deepseek-v4-flash   EFFORT auto
```

**First-run gotcha:** on a fresh machine the very first invocation blocks on a telemetry
consent prompt (`Allow anonymous CLI usage statistics? [Y/n]:`) — before any TUI. An
unattended dispatch would hang there forever. `sonata doctor` should require the choice to
have been made (`reasonix config telemetry off|on` writes `cli_metrics` to
`~/.reasonix/config.toml`); it was set to `off` on this machine during the probe.

**Trap: Reasonix's `auto` is not Claude Code's `auto`.** Reasonix `auto` auto-approves
ordinary permissions broadly, including skipping risk prompts for things like `git push`.
Sonata's `mode.ts` maps Claude's `auto` → `acceptEdits`; the adapter must map that onto
Reasonix's `acceptEdits`, **not** onto Reasonix's `auto`. Same word, more permissive
meaning. This is exactly the kind of silent widening sonata refuses to do.

Documented headless posture is fail-closed: `reasonix run` under the default Ask posture
"fails closed for writer fallback and explicit ask rules instead of adding prompts or
silently approving them". `--auto`/`-y` opens ordinary writer approval. Good — a run that
cannot get approval will fail visibly rather than hang, and `STALLED` remains the backstop.

### Against CLAUDE.md's "Adding a harness" checklist

| Step | Status |
|---|---|
| 1. `src/adapters/reasonix.ts` — `plan()` | Flags known; **`plan()` script unverifiable without a probe** (see below) |
| 1. `canPromptForApproval` | `true` (docs: approval cards) |
| 1. `promptPatterns` / `describePrompt` / `approveKeys` | **Still unknown.** Needs a captured approval card, which needs an API key |
| 1. `health()` | **Solved** — `reasonix doctor --json`, see below |
| 2. `src/adapters/index.ts` | Mechanical |
| 3. `KNOWN_HARNESSES` + `parseConfig` id shape | **Bare id, codex-shaped** — see below |
| 4. `tests/adapters/reasonix.test.ts` | Follows codex's, once fixtures exist |

### `reasonix doctor --json` solves discovery and health at once (probed)

This is better than expected. There is no `models` subcommand, but `doctor --json` emits
the provider catalogue *and* the auth state in one call:

```json
{ "version": "v1.26.0",
  "config": { "user_path": "~/.reasonix/config.toml", "default_model": "deepseek-flash" },
  "providers": [
    { "name": "deepseek-flash", "kind": "anthropic", "base_url_host": "api.deepseek.com",
      "model": "deepseek-v4-flash", "models": ["deepseek-v4-flash"],
      "api_key_env": "DEEPSEEK_API_KEY", "key_present": false,
      "is_default": true, "context_window": 1000000 } ],
  "sandbox": { "bash": "enforce", "network": true, "write_roots": ["/tmp"], "available": true },
  "permission": { "mode": "ask", "allow_rules": 0, "ask_rules": 0, "deny_rules": 0 },
  "warnings": [ ... ] }
```

- **`detect.ts`**: `providers[].name` is the catalogue. `sonata init` can offer real rows.
- **`health()`**: `key_present: false` is exactly the auth check `sonata doctor` wants, per
  provider, and it never exposes the key itself. `warnings[]` comes free.
- **Id shape**: `--model` is documented in `--help` as taking a *provider name* — the key
  of a `[providers]` entry in `reasonix.toml`, not a `provider/model` ref. So Reasonix ids
  are **bare, like codex's**, and `parseConfig` should enforce that. Note the consequence:
  a Reasonix id is only meaningful against that machine's `reasonix.toml`, so two machines
  can disagree about what `deepseek-flash` means. Worth a line in the config docs.

Reasonix v2 is multi-provider (any OpenAI-compatible endpoint is a config entry), unlike
the 0.x line whose stated non-goal was multi-provider support. So it is a harness
dimension, not just one more model — the same reason pi and opencode both exist in
`KNOWN_HARNESSES` and why the key is `<harness>-<provider>-<model>`.

### Hazard: Reasonix auto-loads the project's `.mcp.json` (probed)

Run in `/tmp`, `doctor` lists no plugins. Run inside this repository, it lists:

```
plugins
  sonata           stdio    node
```

Nothing in `~/.reasonix/config.toml` registers it — the `[[plugins]]` block there is
entirely commented out. Reasonix picked it up from `./.mcp.json` in the working directory.

**A Reasonix run dispatched by sonata into this repo would therefore be handed
`mcp__sonata__run`, `tail` and `approve`, and could dispatch further sonata runs.** That
is unbounded recursion started by a foreign model, and it is invisible unless you go
looking: sonata's own hazard model assumes the harness has file and shell tools, not
sonata's control plane.

This is not hypothetical for any repo that ships a `.mcp.json`, and it is not specific to
sonata's server — any project-local MCP server is loaded the same way. The adapter needs a
decision before it ships. Options, cheapest first:

- Have `plan()` point Reasonix at a config without project plugin discovery, if a flag or
  config key exists to disable it (unprobed — check `reasonix mcp` and `docs/SPEC.md`).
- Refuse to launch when the resolved plugin set contains sonata's own server, the way
  sonata already refuses modes a harness cannot honour rather than downgrading quietly.
- At minimum, have `sonata doctor` report it as a blocker.

Note the sandbox is cwd-scoped in the right way — `write_roots` was `/tmp` under
`--dir /tmp` and this repository when run here — so the file-tool boundary is sound. It is
the tool *set*, not the write boundary, that leaks.

Auth failure is fast and legible, which makes `degraded` classification easy:

```
$ reasonix run --permission-mode acceptEdits "say hello"
error: provider "deepseek-flash": missing env DEEPSEEK_API_KEY     # exit 1
```

---

## dsh (deepseek-harness)

| | |
|---|---|
| Repo | `deepseek-ai/deepseek-harness`, MIT, 141.7k stars, pushed 2026-08-13 |
| Default branch | `master`, TypeScript, pnpm monorepo (~50 packages) |
| npm | `@deepseek-ai/dsh@0.1.0-rc.6` |
| Self-description | "developer preview", compatibility-breaking changes expected |

dsh is a *framework* — "everything is a plugin", built on Cordis, with `packages/` for
sandbox, guard, subagent, mcp, acp, web, terminal. Its headline entry point is a web UI:
`npx @deepseek-ai/dsh web` on `127.0.0.1:3080`.

### Why it is not a candidate yet

- **The headless command is not in the shipped launcher.** A design note dated 2026-08-08
  specifies `dsh run [--profile <name>] [--patch <path>...] <task...>` — one fresh session,
  final assistant text on stdout, exit code mapped to task completion. But
  `apps/cli/src/args.ts` on `master` parses only `web`, `plugin`, `--profile`, `--patch`,
  `--dump-config`, `--dump-default-config`, `-V`, `-h`. **There is no `run` subcommand in
  the launcher's parser.** Headless work is reachable only as `dsh --profile headless
  "job"`, and the note itself says a profile lacking `headless-runner` fails validation.
- **No per-run model selection.** Models are not a CLI flag; they come out of Cordis
  profile composition (bundle layers → profile patches → home patches → CLI overlays).
  Sonata's whole config model is `[models."<key>"] harness/id` → one launch command. Against
  dsh, an adapter would have to *generate a profile directory per model* and keep it in
  sync. That is a large, unstable surface for a `0.1.0-rc` project.
- **Approval semantics headlessly are undocumented.** By sonata's own rule that would force
  `default` mode to be refused for write-capable roles — the opencode/pi posture — which
  removes the main thing that makes a new adapter worth having.
- **Version risk.** `0.1.0-rc.6` plus an explicit breaking-changes warning means adapter
  churn, against a project whose CLI surface changed nine days ago.

### When to revisit

When `dsh run` (or an equivalent) is in the shipped launcher's arg parser, a model can be
chosen per invocation without authoring a profile, and the version leaves `rc`.

---

## ACP — a note, not a proposal

Both projects speak the Agent Client Protocol: Reasonix has `docs/ACP.md`, dsh has
`packages/acp`. In principle a structured protocol beats diffing a tmux pane for progress.

This changes nothing today. Sonata's stated constraint is that **the harness conversation
cannot be streamed into Claude Code** — a subagent receives text only as tool results, so
there is no push channel to stream into. A better progress source would improve `sonata
tail`'s fidelity, not remove the long-poll. Worth recording; not worth building for.

---

## What is still unknown

The flag surface, mode mapping, discovery, health and TUI seeding are all now settled
against the real binary. What is **not** settled is everything that requires the model to
actually take a turn, because the probe machine has no `DEEPSEEK_API_KEY` (or a configured
OpenAI-compatible provider). Nothing below can be written from documentation —
this repository's rule is that a captured fixture beats a plausible regex, and every
adapter bug found so far was invisible in docs and obvious on the first real run.

With a key present, three things remain:

1. **Capture a real approval card** into `tests/fixtures/panes/`, and the real key
   sequences that answer it. `promptPatterns`, `describePrompt` and `approveKeys` come from
   that capture. The status line advertises `Shift+Tab ask/auto/plan` and `Ctrl+Y YOLO`,
   so the card's own accelerators still have to be read off a real prompt — and note
   codex's lesson that a trailing Enter can fall through to the composer.
2. **Does plan mode block writing `report.md`?** That decides `canWriteReport`. Probe it
   the way pi and opencode were probed: ask a plan-mode run to write exactly one file and
   see whether the file appears.
3. **Does `run` write the final message anywhere on disk**, or is it stdout-only? If there
   is a session file holding the final assistant text, that becomes `fallbackReportFile`.
   `--metrics PATH` and `--trajectory PATH` are already sonata-controlled output paths and
   may make the whole question moot.

Only after 1–3 does writing `src/adapters/reasonix.ts` make sense.

Aside, useful later: `reasonix subagent <list|create|edit|delete|try|run>` is a
first-class subagent system, and `reasonix acp` serves the Agent Client Protocol over
stdio. Neither changes the adapter, but both are worth knowing before designing one.
