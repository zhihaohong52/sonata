# A persistent config TUI

**Status:** designed
**Date:** 2026-09-18

## The decision

Bare `sonata` opens a persistent terminal UI that boots into a health check and
from there edits configuration and runs configuration actions. The web UI on
the router port keeps runs, usage and status; the TUI never reimplements them.

`sonata init` is unchanged. It remains the linear first-run wizard, and its
`--yes` twin remains what CI and scripted installs use.

## Why a second interactive surface

Sonata has accumulated six interactive or semi-interactive surfaces — `init`,
`agents`, `doctor`, `usage`, `status`, `runs` — and exactly one of them is
navigable. `init` is a one-shot linear wizard: changing one tier means walking
every screen, and `sonata agents` exists because that was intolerable for the
one thing people change most. A second one-off editor is the symptom, not the
fix.

The measured cost of having no persistent surface is already on record. A
saved `[tiers]` list could not absorb the `@effort` candidates added in
2026-09, and nothing surfaced the gap: `complex` held 6 of 13 configured models
for weeks while `normal`, seeded later from a fresh proposal, held 12. Both
were visible only by reading the TOML. A screen that shows what each tier holds
next to what the catalog would propose makes that a glance rather than an
investigation.

## What it is not

**Not an observability surface.** Runs, spend and live router state stay in the
web UI, where long tables, charts and linkable state are genuinely better. The
TUI's Actions screen links there rather than redrawing it.

**Not a replacement for `sonata init`.** The wizard is good at cold start, it
has a tested scripted twin, and absorbing it would put the `--yes` path — which
CI depends on — behind a rewrite. The TUI detects a cold config and offers to
run the wizard.

**Not a new services layer.** `src/init/` is already `discover` → `validate` →
`plan` → `apply`, with two front ends over one `InitState`. Screens call the
existing modules. A screen that appears to need a new service is a signal to
check `src/init/` first.

## Entry point

Bare `sonata` renders the TUI. Three guards:

- **TTY only.** No TTY — CI, a SessionStart hook, a pipe — prints today's help
  and exits with today's code, unchanged: **2** for a bare `sonata`, 0 for an
  explicit `--help`. (`main` returns `command ? 0 : 2`.) Without this, `sonata`
  inside a hook renders Ink into a pipe.
- **`--help` / `-h`** always prints help, TTY or not.
- **`sonata tui`** names it explicitly, so the behaviour is addressable and
  testable without depending on argv being empty.

Bare `sonata` currently prints help and exits 0, so this is a behaviour change
to a command something may already call. The TTY guard is what makes it safe;
it is a requirement, not a refinement.

### The stdin hazard

`src/tui.ts`'s `readKeys` must `ref()` stdin while it waits. Ink *unrefs* stdin
on unmount, so a paused stdin's handle is not work node knows about: with
nothing else pending the process exits 0 mid-prompt, with no error because
there is no error. That is what once made every prompt after the wizard die
instantly.

The TUI therefore owns its entire lifetime and never unmounts to hand off to a
`src/tui.ts` prompt. Every confirmation is an Ink screen.

## Boot

Step `checking` renders a spinner while running what `cmdDoctor` already
computes, then routes to **Overview**: doctor's results *as* the home screen,
each problem an openable row.

This inverts today's flow, where `doctor` names a problem and the user then
goes to find the command that fixes it. The five distinct reasons
`diagnoseRouteAuto` can give for a tiered config not being routed become five
rows that open the thing that fixes them.

## Structure

```text
src/tui-ink/
├── app.tsx          flat step machine: one `step` string, a switch per screen
├── screens/         one file per screen
└── components/      existing — RankedSelect, models-step, byok-step, …
```

A flat step machine rather than a router: it is what claude-swap uses at this
size, and it is the smallest thing that works. Screens are thin; anything
testable lives in the existing headless modules or beside them as a pure
function, so screen behaviour is provable without a TTY — the same discipline
`src/tui.ts`'s `parseKey`/`reduce`/`renderList` already follow.

## Screens, in shipping order

1. **Overview / Health** — `doctor` results, each problem actionable. First
   because it is the cheapest (the computation exists) and the most valuable (it
   is the screen that tells you what is wrong).
2. **Tiers** — `sonata agents` moved in wholesale. It is already a persistent
   editor with the correct write discipline; it becomes a screen rather than a
   command.
3. **Models** — what is configured, what each resolves to, and which models sit
   in no tier at all.
4. **Providers** — gateways, their auth kind, and what they serve.
5. **Keys** — stored credentials, add and remove.
6. **Budget** — `[budget] daily_usd`, the one config value with a direct dollar
   consequence and currently the least reachable: nothing in sonata writes it,
   so it can only be hand-edited.
7. **Actions** — `catalog update`, `sync`, `litellm install`, `route on/auto`.

Each lands independently and is useful alone. Shared state is factored out as
each screen arrives, not after: the failure to avoid is two state models that
disagree about what the config says, which is `tiersCollapse` rebuilt at three
call sites with one of them wrong, promising eight agent files where `sync`
wrote four.

## Writes

The TUI is the third writer of `sonata.toml`, and writes by **targeted block
replacement**, never a full rewrite:

```text
Tiers screen   -> replaceBlock('tiers.*')     (generalised from replaceTiersBlock)
Models screen  -> replaceBlock('models.*')
Providers      -> replaceBlock('native.gateways.*')
Budget screen  -> replaceBlock('budget')
Keys           -> credential store, never the TOML
```

Every other byte is left untouched, and the result is parsed back **before** it
is written, since a rewrite that will not load leaves no working config at all
and would surface later from an unrelated command.

Full rewrite through `nativeTomlFor` is rejected for this surface. That path
reconstructs the file from a parsed model, so a setting it does not emit is
deleted — which is exactly how a gateway was silently un-priced, flipping from
priced to unpriced between two requests 64 seconds apart, and narrowing
`[budget] daily_usd` without saying so. `sonata agents` already avoids this by
construction; a second writer carrying the hazard would double the places it
can recur.

`sonata init` keeps its full rewrite. It is the sole writer of the *whole*
file, and that stays true.

### Keys never enter the TOML

Credentials live in the store. There is deliberately no `--key` flag anywhere
in sonata, because that would put a secret in argv and shell history; the TUI
holds the same line. A key typed into a screen goes to the store and is never
serialized into a config file, a log, or an init log — which records a key as
the gateway it belongs to, never as its value.

## Actions

Each action opens a panel with streamed output and a cancel key:

```text
┌ Keys ─ add gateway: github-copilot ────┐
│  Open:  github.com/login/device        │
│  Code:  A1B2-C3D4        [c] copy      │
│  polling… 38s left of 60s              │
│  esc cancel                            │
└────────────────────────────────────────┘
```

This is the one thing a TUI does that the CLI cannot, and the reason is on
record: `sonata serve` refuses to install LiteLLM precisely because a silent
multi-minute install run from a hook is indistinguishable from a hang. The
device flows have known, differing budgets — Copilot polls 60 seconds and makes
up to three attempts with a fresh code each time; ChatGPT polls 15 minutes — so
the panel shows which one is running and how long it has.

Cancel must leave no partial state: an action either completes or is a no-op.

## Testing

- **Pure logic without a TTY.** Step transitions, row derivation and the
  block-replacement writers are pure functions tested directly, following
  `parseKey`/`reduce`/`renderList`.
- **Write round-trips through `parseConfig`.** Every screen that writes gets a
  round-trip test. Asserting on emitted text cannot catch the sibling failure
  where a key is written but bound to the wrong table.
- **A no-op edit is byte-identical.** Opening a screen and confirming it
  unchanged must not alter the file. This is the property that caught the
  bulk-accept divergence in the wizard, and it is the cheapest guard against a
  writer that silently drops what it cannot represent.
- **The TTY guard.** Bare `sonata` without a TTY prints help and exits 2;
  `sonata --help` exits 0, TTY or not. Both codes are today's, and asserting
  them is what keeps this a pure addition.

### `[budget]` is destroyed by the current writer

`src/init/` contains no non-comment reference to `budget`. `nativeTomlFor`
takes an `existingRun` to preserve `[run]` and an `existing` config to preserve
`pricing_provider` and `[price]`, and has neither a budget parameter nor an
emission path — so **a hand-added `[budget]` block is deleted by the next
`sonata init`.** It is the same bug that un-priced a gateway, still live, and
it never got the round-trip test that fix's note asks for on every config key.

Its failure is the least visible one available. A cap's only effect is a
refusal that has not happened yet, so a silently deleted cap is
indistinguishable from a working one until the spend arrives.

Preserving it is therefore a task in this plan, ahead of the screen that edits
it: a Budget screen writing a value the next `sonata init` deletes would be
worse than no screen at all.

## Open questions

- Whether Providers and Keys are one screen or two. They are edited together
  and separated only by where the value is stored, which is an implementation
  fact rather than a user-facing one.
- Whether Overview should offer to run `sonata init` for a cold config, or
  refuse and name the command. Running a full-rewrite wizard from inside a
  targeted-write surface mixes two write disciplines in one session.
