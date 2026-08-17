# Investigating two DeepSeek harnesses as sonata adapters

Date: 2026-08-17
Status: investigation only — no code written, nothing added to `KNOWN_HARNESSES`

Two candidates were raised:

- `esengine/DeepSeek-Reasonix` — "Reasonix", a terminal coding agent
- `deepseek-ai/deepseek-harness` — "dsh", an agent harness framework

**Verdict: Reasonix is a strong adapter candidate and the best fit sonata has seen after
codex. dsh is not one yet — defer and watch.**

Everything below is derived from published docs, source trees and the npm registry.
**No binary was probed.** The repository's own rule ("Probe the real binary before writing
an adapter") is therefore *not* satisfied, and the last section says what to run. The
install was attempted and denied by the permission classifier; see "What is still unknown".

---

## Reasonix

| | |
|---|---|
| Repo | `esengine/DeepSeek-Reasonix`, MIT, 34.6k stars, pushed 2026-08-17 |
| Default branch | `main-v2` — a **Go** rewrite (Go 1.25+) |
| npm | `reasonix@1.26.0` (`latest`) |
| Legacy line | `dsnix@0.53.1` — the TypeScript 0.x line, in maintenance |

The `main` branch README describes the old TypeScript agent and says active development
moved to the Go rewrite on `main-v2`. `reasonix@1.26.0` is almost certainly that Go line
(the 0.x TS line appears to live on as `dsnix`), but **that mapping is inferred from
version numbers, not verified.** It is the first thing to check on a real machine, because
every flag below comes from `main-v2/docs/CLI.md`.

### Why it fits sonata

Reasonix has, in one binary, the three things sonata's adapter interface wants and which
no current harness supplies together:

1. **A real headless one-shot mode with structured output**

   ```
   reasonix run "task" [--auto|-y]
   reasonix run --output-format [text|json|stream-json] "task"
   reasonix -p "prompt"                       # final answer only
   ```

   `stream-json` is a genuine event stream. opencode's `--format json` is broken upstream,
   which is why sonata diffs the tmux pane; Reasonix would not need that workaround. (The
   tmux/pane design still stands — see "ACP" below.)

2. **Permission modes that map almost 1:1 onto Claude Code's**

   `reasonix --permission-mode MODE`, with modes: `manual`/`ask`, `auto`, `acceptEdits`,
   `dontAsk`, `plan`, `bypassPermissions`. Plus `--allowed-tools "Bash(go test ./...)"`,
   a workspace sandbox, and per-turn checkpoints.

3. **Interactive approval cards** — allow once / allow for session / always allow / deny.

   This means `canPromptForApproval: true`. Reasonix would be **the second harness after
   codex able to honour `default` mode for write-capable roles**, instead of refusing it
   the way opencode and pi do. That is the single biggest reason to take this one.

### Proposed mode mapping (to be confirmed against a real binary)

| Claude Code mode | Reasonix |
|---|---|
| `plan` | `--permission-mode plan` (or `run` with plan) — read-only, likely `canWriteReport: false` |
| `default` | interactive TUI, approval cards, `--permission-mode ask` |
| `acceptEdits` | `run --auto` with `--permission-mode acceptEdits` |
| `bypassPermissions` | `--permission-mode bypassPermissions` / `--yolo` |

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
| 1. `promptPatterns` / `describePrompt` / `approveKeys` | **Unknown.** Needs captured panes; must not be written from docs |
| 1. `health()` | Plausible: `reasonix doctor` exists, with `doctor sessions --json` |
| 2. `src/adapters/index.ts` | Mechanical |
| 3. `KNOWN_HARNESSES` + `parseConfig` id shape | **Undecided.** Depends on whether `--model NAME` takes a bare id (codex-shaped) or a provider-qualified ref (opencode/pi-shaped) |
| 4. `tests/adapters/reasonix.test.ts` | Follows codex's, once fixtures exist |

**Model discovery (`sonata init`).** No model-listing subcommand appears in `docs/CLI.md`.
If none exists, Reasonix is **codex-shaped for `detect.ts`**: no automatic catalogue,
entries hand-written into `sonata.toml`, carried through by `init` as unmanaged. Worth one
probe (`reasonix model --help`, `reasonix config`) before accepting that.

Reasonix v2 is multi-provider ("DeepSeek ships as a preset; any OpenAI-compatible endpoint
is a config entry"), unlike the 0.x line whose stated non-goal was multi-provider support.
So it is a harness dimension, not just one more model — the same reason pi and opencode
both exist in `KNOWN_HARNESSES` and why the key is `<harness>-<provider>-<model>`.

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

## What is still unknown, and how to find out

Installing the binaries was attempted and **denied by the permission classifier**, so no
probe was run. That gap is the reason nothing above should be turned into an adapter yet:
this repository's convention is that every adapter bug found so far was invisible in
documentation and obvious on the first real run, and that a captured fixture beats a
plausible regex.

To unblock, run in-session (the `!` prefix runs it here so the output lands in the
conversation):

```
! npm i -g reasonix
! reasonix --version && reasonix doctor
```

Then the probe list, in priority order:

1. **Is `reasonix@1.26.0` the Go v2 line?** If `--permission-mode` and `--output-format`
   are unrecognised, every flag in this note is wrong and the whole assessment restarts.
2. **Does `reasonix run` write anything to a file, or is it stdout-only?** Sonata reads
   completion from an exit sentinel plus a report file; if Reasonix writes a final-message
   file, that becomes `fallbackReportFile`.
3. **Can the interactive TUI be seeded with task text**, codex-style? Required for `default`
   mode to work at all — without it, `default` must be refused like opencode's.
4. **Does plan mode block writing `report.md`?** That decides `canWriteReport`. Probe it
   the way pi/opencode were probed: ask a plan-mode run to write exactly one file and see
   whether the file appears.
5. **Is there a model catalogue command?** Decides whether `detect.ts` can discover models
   or whether entries are hand-written like codex's.
6. **Capture real pane output** for an approval card into `tests/fixtures/panes/`, and the
   real key sequences that answer it. `promptPatterns`, `describePrompt` and `approveKeys`
   must come from that capture, never from these docs.

Only after 1–6 does writing `src/adapters/reasonix.ts` make sense.
