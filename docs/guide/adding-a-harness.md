# Adding a harness

The adapter boundary is the extension point. A new harness means one new file
plus two lines of registration:

1. **`src/adapters/<name>.ts`** — export a `HarnessAdapter`. The interface is
   in `src/adapters/types.ts`; `opencode.ts` is the smallest example, `codex.ts`
   the most complete. You implement:
   - `plan(input)` → the bash script to run, and whether it can be approved
   - `canPromptForApproval` — whether the harness can stop and ask a human
   - `promptPatterns` / `describePrompt` — how a pending approval looks
   - `health(env)` — optional runtime checks beyond "is it installed"
2. **`src/adapters/index.ts`** — register it.
3. **`src/config.ts`** — add the name to `KNOWN_HARNESSES`.
4. **`tests/adapters/<name>.test.ts`** — follow an existing adapter's tests.

Optionally, `src/detect.ts` for `sonata init` discovery — currently OpenCode,
Pi and Reasonix; codex has no provider dimension, so its entries are added by
hand (and survive the wizard).

**Probe the real binary before you write the adapter.** Every adapter bug found
so far was invisible in the documentation and obvious on the first real run:
OpenCode silently eating a positional argument, codex rejecting a flag that its
own `exec` accepts, both harnesses printing approval prompts that matched none
of the patterns written for them. If you claim a harness prints something,
capture it into `tests/fixtures/panes/` and test against that.
