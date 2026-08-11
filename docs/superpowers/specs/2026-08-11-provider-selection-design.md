# Provider Selection for OpenCode and Pi

**Date:** 2026-08-11
**Status:** Design approved, not yet implemented

## Problem

OpenCode and pi both address a model as `provider/model`, and the same model id
is commonly served by several providers. On the development machine
`deepseek-v4-flash` arrives from `opencode-go`, from `openrouter`, and from
`openrouter` (as `openrouter/deepseek/deepseek-v4-flash`). Sonata has no
concept of a provider, which causes four defects.

**Sonata dispatches to a provider the user never chose.** The opencode adapter
hardcodes the prefix:

```ts
const flags = ['run', `--agent ${agent}`, `-m opencode/${input.modelId}`, ...];
```

Every run goes to provider `opencode` whatever the user selected.

**That dispatch is not merely wrong, it is dead.** Provider `opencode` serves
only free models (`big-pickle`, `*-free`). None of the seven models in the
development machine's `sonata.toml` exist under it:

```
MISSING  opencode/deepseek-v4-flash-0731
MISSING  opencode/deepseek-v4-pro
MISSING  opencode/gpt-5.6-luna
MISSING  opencode/gpt-5.6-sol
MISSING  opencode/gpt-5.6-terra
MISSING  opencode/grok-4.5
MISSING  opencode/kimi-k3
```

OpenCode-backed dispatch therefore does not work at all for a user whose models
come from anywhere but the free tier.

**Detection sees a fraction of what is installed.** `parseOpenCodeModels` reads
the `provider` block of `~/.config/opencode/opencode.json`, which declares only
*custom* providers. Built-in providers the user has authenticated against never
appear — 31 models visible out of 496.

**Pi is not discovered at all.** The wizard is opencode-only; the README tells
users to hand-write pi and codex entries. Pi's adapter already passes
`modelId` through untouched and documents that `--model` takes a combined
`provider/id`, so pi's gap is selection, not dispatch.

## Goals

- Select a provider explicitly, and enable the same model id from more than one
  provider independently.
- Do this for pi as well as opencode, in one flow.
- Reach every model each harness can actually run.
- Dispatch to the provider the user chose.

## Non-goals

- Provider selection for codex. Codex takes a bare model id and has no provider
  dimension. Codex entries stay hand-written.
- Ranking, recommending, or pricing providers. Sonata lists what each harness
  reports and the user chooses.
- Credential management. Authentication stays `opencode auth login` and
  `pi auth check --provider <name>`.

## Key decisions

### Each harness reports its own catalogue

**OpenCode:** `opencode models` prints one `provider/model` ref per line —
exactly the string `-m` accepts, confirmed against `opencode run --help`:

```
-m, --model    model to use in the format of provider/model
```

It reports 496 refs across 10 providers where config parsing found 31. Cost is
a ~2.5s subprocess in `init` and `doctor`, replacing a file read.

**Pi:** `pi --list-models` prints a whitespace-aligned table whose first row is
a `provider model context max-out thinking images` header. Provider and model
are separate columns and are joined with `/` to form the ref. `piHealth`
already runs this command with a 5s timeout; detection reuses that one call
rather than shelling out twice.

`opencode.json` is still read, but only to enrich the picker with display names
(`· Claude Haiku 4.5`). Neither CLI emits names, and losing every hint would be
a visible regression.

A ref splits on the **first** `/` only. `openrouter/deepseek/deepseek-v4-flash`
is provider `openrouter`, model `deepseek/deepseek-v4-flash`; the model id
itself may contain slashes and must not be re-split.

Every count in this document is one snapshot from the development machine on
2026-08-11. The catalogues are served, not static — two `opencode models` runs
minutes apart disagreed on one free model — so counts are illustrative and
nothing may depend on them.

### OpenCode filters by auth; pi does not

OpenCode's picker offers providers present in
`~/.local/share/opencode/auth.json`, plus `opencode`, whose models are free and
need no auth entry. On the development machine that is nine providers and 495
refs, excluding only `agnes`, which is neither authenticated nor free.

Pi needs no such filter: `pi --list-models` lists only usable models. That is
exactly what `piHealth` relies on when it treats an empty list as "no usable
model provider". Applying an auth filter to pi would be inventing a concept pi
does not have.

### One provider list spanning both harnesses

Providers are picked from a single list whose rows are `harness · provider`,
then models are picked from the refs those rows cover. A provider name can
appear under both harnesses — `opencode-go` is reachable through opencode and
through pi — and these are genuinely different choices, so they are two rows.

This keeps the flow two steps deep. A harness-first step would add a keystroke
and buy nothing, because the harness is already visible on every row.

### The config key is harness-qualified

A model's key in `sonata.toml` is also its agent filename
(`.claude/agents/code-<key>.md`), so it cannot contain `/`. The key is the
harness, then the ref with slashes flattened to dashes:

```toml
[models."opencode-openrouter-deepseek-v4-flash"]
harness = "opencode"
id = "openrouter/deepseek-v4-flash"

[models."pi-opencode-go-deepseek-v4-flash"]
harness = "pi"
id = "opencode-go/deepseek-v4-flash"

[models."opencode-openrouter-deepseek-deepseek-v4-flash"]
harness = "opencode"
id = "openrouter/deepseek/deepseek-v4-flash"
```

`id` holds the ref verbatim and reaches `-m` / `--model` unchanged.

The harness segment is not decoration. Pi and opencode can serve the *identical*
ref: the opencode catalogue contains `opencode-go/deepseek-v4-flash`, and the pi
adapter's own test dispatches `opencode-go/deepseek-v4-flash`. Without the
harness in the key those two selections collide.

Flattening is still **not** injective within a harness, because provider names
contain dashes too: `opencode/go-x` and `opencode-go/x` both yield
`opencode-go-x`. No pair in the current 496 refs collides, but the catalogue is
served and the shape is reachable, so it cannot be assumed away. `init` checks
for duplicate keys before writing and refuses with both names. The check is
over what is about to be written, not the catalogue: two colliding refs the
user did not both select are harmless.

"What is about to be written" includes the carried-forward entries, not just
the selection. Hand-written keys share the namespace and are user-authored, so
they can be anything — the README's own example is `pi-deepseek`, already
squatting on the `pi-` prefix the wizard now generates. A carried key equal to
a generated one would otherwise let one silently overwrite the other.

Keys are quoted. An unquoted `[models.grok-4.5]` nests as `models → "grok-4" →
"5"`, a bug this repo has already been bitten by.

### Bare ids are rejected per harness, not globally

An existing `id = "kimi-k3"` on an opencode model would become `-m kimi-k3`,
which is not a valid ref. `parseConfig` rejects a slash-less id when the
harness is `opencode` or `pi`, and names the fix.

The rule is harness-aware because codex is the opposite case: codex ids are
bare (`gpt-5.6-sol`) and a slash would be wrong there. Validating globally
would break every codex entry.

Auto-prefixing `opencode/` was rejected: it is precisely the behaviour that
silently sent every model to the wrong provider, and it would fail later and
more confusingly than failing here.

### `init` stops destroying hand-written entries

`cmdInit` currently writes `writeFileSync(configPath, tomlFor(...))` — a
wholesale overwrite. Any codex entry, which the README instructs users to add
by hand, is destroyed by re-running the wizard. This is a pre-existing bug, but
this change makes it urgent: codex remains the hand-written harness after pi
moves into the wizard, so the wizard is now the *only* thing that can delete it.

`init` reads the existing config and carries forward every model whose harness
it does not manage, appending its own selections. `generate.models` becomes the
union of the two, so a hand-written codex agent survives a re-run.

### Pre-ticking matches on `(harness, id)`, not on the key

`existingModels` currently regexes `[models.<key>]` out of the file. That
cannot survive a key-scheme change, and it answers the wrong question: what a
user already enabled is a *ref*, not a name.

Pre-ticking instead parses the config and matches each entry's
`(harness, id)` against the catalogue. This makes hand-written pi entries —
`[models.pi-deepseek]` with `id = "opencode-go/deepseek-v4-flash"` — pre-tick
correctly despite an unrecognisable key, because they record the full ref and
so state exactly what was meant. Only opencode's bare ids fail to match, and
only because they genuinely do not say which provider was intended.

### The list widget gains a viewport and a filter

`renderList` draws every choice and redraws by moving the cursor up
`ESC[<n>A`. A 31-item list already nearly fills a terminal; openrouter's 341
would overflow the screen and corrupt the redraw. Long lists are not an edge
case of this feature, they are its normal state.

The multiselect gains a window around the cursor with overflow counts, and a
filter line that narrows the list as the user types. The window is
`min(15, process.stdout.rows - 8)` rows, the subtraction covering the title,
filter, counts, hint, and their blank lines; it floors at 3 so a short terminal
still renders something navigable.

This forces one behaviour change: letters must mean text, so `j`/`k` stop
navigating in multiselect lists and navigation is `↑↓` only. `select` — hook
scope, confirm — keeps `j`/`k` and gets no filter, because those lists are
three items long and typing has nothing to narrow.

## Components

**`ModelRef`** (`src/detect.ts`) — `{ harness, provider, id, ref }`, the single
currency both catalogues normalise into.

**`parseOpenCodeRefs(stdout): ModelRef[]`** — splits each line on the first
`/`. Ignores blanks. Pure.

**`parsePiRefs(stdout): ModelRef[]`** — splits each row on whitespace, skips the
`provider model …` header, requires at least two columns, joins columns one and
two with `/`. Pure, and shares its header rule with `countModelRows`, which
should be expressed in terms of it rather than duplicating the regex.

**`offerableProviders(refs, authed): ProviderSummary[]`** — groups by
`(harness, provider)`, applies the auth filter to opencode rows only, returns
name and count sorted. Pure.

**`configKeyFor(ref): string`** — `<harness>-<ref with / → ->`. Pure.

**`duplicateKeys(entries): [string, string][]`** — collisions across everything
about to be written, selection and carried-forward alike. Pure.

**`preTicked(existing, refs): Set<string>`** — matches configured entries to
catalogue refs on `(harness, id)`, replacing the `[models.<key>]` regex. Pure.

**`viewport(state, total, height)`** (`src/tui.ts`) — visible slice and
overflow counts for the current cursor. Pure.

**`filterChoices(choices, query)`** (`src/tui.ts`) — case-insensitive substring
match on the label. Pure.

**`mergeConfig(existing, managed)`** (`src/commands/init.ts`) — carries forward
unmanaged-harness entries and unions `generate.models`. Pure.

**Detection** — shells out to `opencode models` and `pi --list-models`, then
composes the above. The subprocesses are the only impure part and are already
injected via `DetectEnv` in tests.

**`cmdInit`** — provider multiselect, then a model multiselect scoped to the
chosen providers.

**opencode adapter** — `-m ${input.modelId}`.

## Data flow

```
opencode models ──▶ parseOpenCodeRefs ──┐
pi --list-models ──▶ parsePiRefs ───────┤
auth.json ──▶ parseAuthedProviders ─────┤
                                        ▼
                              offerableProviders
                                        │
                            provider multiselect  (harness · provider)
                                        │
                       refs filtered to chosen providers
                                        ▼
                              model multiselect
                                        │
                    configKeyFor + duplicateKeys check
                                        ▼
             mergeConfig(existing codex entries, managed) ──▶ sonata.toml
                                        │
                        run: modelCfg.id ──▶ -m / --model <ref>
```

## Interface changes

`Detection` in `init.ts` is `{ tmux, oc }` — one named harness field. It
becomes a list of harness statuses so pi is not bolted on as a second special
case and codex can follow later without another reshape. `defaultDetector` and
the test doubles move with it.

## Error handling

- A harness binary absent → that harness contributes no providers, silently.
  Absence is not an error; a machine with only opencode is normal.
- Both catalogues empty → an `error` Problem. Distinct from today's "opencode
  has no models configured", which would now be wrong.
- `opencode models` or `pi --list-models` fails → an `error` Problem carrying
  the stderr, with that harness's auth command as the fix. `init` already
  refuses to continue past a blocking problem.
- `pi --list-models` exceeding its 5s timeout → treated as absent, with a
  `warn` Problem. Doctor must never hang, which is why the timeout exists.
- Bare id on an opencode or pi model in an existing config → `parseConfig`
  throws naming the model and the fix.
- Two entries about to be written sharing a key — two selected refs that
  flatten alike, or a carried-forward hand-written key equal to a generated
  one → `init` refuses before writing, naming both, so no file is half-written
  and no agent is silently overwritten by its twin.
- Filter matching nothing → the list renders empty with `0 of N`; `enter`
  confirms whatever was already checked rather than nothing.

## Migration

`sonata.toml` files written before this change hold bare ids and stop parsing.
This is deliberate — they are already dispatching to a provider that does not
serve those models. `sonata init` rewrites them, and existing agent files
become stale, which `staleAgents` already reports for manual deletion.

The first `init` after upgrading pre-ticks no *opencode* models. Matching is on
`(harness, id)`, and an old bare `kimi-k3` names no provider, so there is no
catalogue ref it can honestly claim to be. This is expected rather than a
regression: the entry never recorded what was meant.

Hand-written pi entries do pre-tick. `[models.pi-deepseek]` with
`id = "opencode-go/deepseek-v4-flash"` carries a complete ref, so it matches
the catalogue and comes back ticked despite a key the wizard would never
generate — it is then rewritten under the generated key. Nothing a user
configured deliberately is dropped without being shown to them first.

The README's pi section is rewritten to point at the wizard; its codex section
stays, and gains a note that codex entries now survive `sonata init`.

Test fixtures carrying bare ids on `harness = "opencode"` —
`tests/e2e.test.ts`, `tests/commands/run.test.ts`, and others using
`[models.fake]` — will fail the new validation and need refs. That is the
validation working, but it is a known edit, not a surprise to discover
mid-implementation.

## Risks

**The pi table format is unverified.** Pi is not installed on the development
machine, so the only evidence for `--list-models` output is a fixture in
`tests/adapters/pi.test.ts` written from memory, not captured from a real run.
`parsePiRefs` must therefore be defensive — skip rows with fewer than two
columns rather than mis-parsing them — and the plan must include capturing real
output on a machine with pi before the parser is trusted. If the real format
turns out to be delimited differently, only `parsePiRefs` changes.

## Testing

Pure functions carry the load, matching how `tui.ts` is already tested:

- `parseOpenCodeRefs` — first-slash split, nested openrouter ids, blank lines,
  empty input.
- `parsePiRefs` — header skipped, rows joined with `/`, short rows ignored,
  header-only input yields nothing.
- `offerableProviders` — auth filter applies to opencode and not to pi, free
  tier included, unauthed excluded, same provider under two harnesses stays two
  entries, counts correct.
- `configKeyFor` — harness prefix, flattening, a nested openrouter ref.
- `duplicateKeys` — `opencode/go-x` and `opencode-go/x` selected together are
  rejected naming both; either alone writes normally; the same ref under two
  harnesses does *not* collide; a carried-forward hand-written key equal to a
  generated one is rejected too.
- `preTicked` — a hand-written pi entry pre-ticks from its ref despite an
  unrecognisable key; a bare opencode id pre-ticks nothing; a ref no longer in
  the catalogue pre-ticks nothing.
- `viewport` — cursor at top, bottom, middle; list shorter than the window;
  overflow counts.
- `filterChoices` + the reducer — typing narrows, backspace widens, checked
  state survives a filter change (a model checked, then filtered away, stays
  checked).
- `mergeConfig` — a hand-written codex entry survives a wizard re-run and stays
  in `generate.models`.
- `parseConfig` — rejects a bare id on opencode and on pi, accepts a bare codex
  id, accepts a ref.
- opencode adapter — `-m` receives the ref verbatim, with no `opencode/` prefix.
- `cmdInit` non-interactive — a dotted, harness-qualified model round-trips to
  `sonata.toml` and back.

The interactive path stays covered the way `readKeys` is: fake streams, no TTY.

## Open questions

None blocking. Two noted for later:

- Whether `doctor` should verify that every configured `id` still appears in
  its harness's catalogue, catching a provider that lost its auth. Cheap, since
  both lists are already fetched.
- Whether the filter should match the display name as well as the ref.
