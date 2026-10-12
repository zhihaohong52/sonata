# Adding a harness

The adapter boundary is the extension point. A new harness means one new file,
registration in two places, and tests:

1. **`src/adapters/<name>.ts`** — export a `HarnessAdapter`. The interface is
   in [`src/adapters/types.ts`](https://github.com/zhihaohong52/sonata/blob/main/src/adapters/types.ts);
   [`opencode.ts`](https://github.com/zhihaohong52/sonata/blob/main/src/adapters/opencode.ts)
   is the smallest example,
   [`codex.ts`](https://github.com/zhihaohong52/sonata/blob/main/src/adapters/codex.ts)
   the most complete. You implement:
   - `name`, `versionCommand`, `supportedVersions`, `pathPrepend` — identity,
     and the probe sonata runs to read the installed version
   - `plan(input)` → a `LaunchPlan`: the bash `script`, whether the harness is
     `interactive`, and `effortHonoured` (required — whether the plan passes a
     pinned `<key>@<effort>` level through). Optional on the plan:
     `canWriteReport` (false when this configuration cannot write `report.md`
     at all) and `silentUntilExit` (true when nothing reaches the pane until
     the run exits)
   - `canPromptForApproval` — whether the harness can stop and ask a human
   - `promptPatterns` / `describePrompt` — how a pending approval looks
   - `approveKeys` — the tmux key sequences that answer one
   - `usage(query)` — required: the tokens a finished run spent, read from the
     harness's own store, or `unobservable` with a reason. Never guessed, never
     zero
   - optional: `health(env)` — runtime checks beyond "is it installed";
     `update` — how `sonata init` offers to bring the harness up to date;
     `fallbackReportFile` — a file the harness writes its own final message to,
     used as a report fallback before the pane
2. **[`src/adapters/index.ts`](https://github.com/zhihaohong52/sonata/blob/main/src/adapters/index.ts)** — register it.
3. **[`src/config.ts`](https://github.com/zhihaohong52/sonata/blob/main/src/config.ts)** — add the name to `KNOWN_HARNESSES`.
4. **`tests/adapters/<name>.test.ts`** — follow an existing adapter's tests.

Optionally, [`src/detect.ts`](https://github.com/zhihaohong52/sonata/blob/main/src/detect.ts)
for `sonata init` discovery. It probes opencode, pi, codex (via `codex
app-server`'s `model/list`) and reasonix; the `claude` harness is the host and
is never offered for discovery. Note the id shape — opencode, pi and reasonix
take `provider/model` ids, while codex takes a bare id.

**Probe the real binary before you write the adapter.** Every adapter bug found
so far was invisible in the documentation and obvious on the first real run:
OpenCode silently eating a positional argument, codex rejecting a flag that its
own `exec` accepts, both harnesses printing approval prompts that matched none
of the patterns written for them. If you claim a harness prints something,
capture it into `tests/fixtures/panes/` and test against that.
