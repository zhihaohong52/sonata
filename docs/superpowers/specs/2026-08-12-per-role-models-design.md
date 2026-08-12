# Per-Role Model Selection

**Date:** 2026-08-12
**Status:** Design approved, not yet implemented

## Problem

`sonata sync` generates the cartesian product of two lists:

```toml
[generate]
roles  = ["review", "code", "explore", "plan"]
models = ["a", "b", "c"]
```

```ts
for (const role of config.generate.roles)
  for (const model of config.generate.models)
```

Every role therefore gets every model, which is rarely what anyone wants. The
roles differ in what they need:

- `explore` reads a codebase and answers questions — the cheapest adequate
  model is the right one, and a frontier model is waste.
- `review` exists for diversity of judgement, so it wants a *different family*
  from the one that wrote the code, and often several at once.
- `code` wants whichever model actually does the mechanical work well.
- `plan` wants the strongest model available, and only one.

Today those preferences cannot be expressed. The development machine's config
has 10 models and 4 roles, producing 40 agent files where perhaps 8 are
wanted. The surplus is not merely untidy: every agent is offered to Claude for
selection, so a bad match is one wrong pick away, and stale agents have already
caused three separate failures this week.

## Goals

- Choose which models each role is generated for.
- Keep the common case — the same models everywhere — a single keystroke.
- Make the config say plainly what will be generated, with one way to say it.

## Non-goals

- Per-role *roles*. The four shipped roles are fixed; this is about which
  models each one uses.
- Per-role run settings (timeouts, tail window). `[run]` stays global.
- Per-role harness selection. A model already names its harness in `[models]`.

## Key decisions

### `[generate.roles]` is a table, and the flat form is removed

```toml
[generate.roles]
code    = ["opencode-openai-gpt-5.6-sol"]
review  = ["opencode-openrouter-grok-4.5", "opencode-openrouter-kimi-k3"]
explore = ["opencode-opencode-go-deepseek-v4-flash"]
plan    = []
```

The flat `roles = [...]` / `models = [...]` pair is no longer accepted. Keeping
both forms was considered and rejected: two ways to express one thing means
answering "which models does review use" requires knowing a precedence rule,
and this week has already shown what a misread config costs.

The break is real and total. Every `sonata.toml` in existence stops parsing
until rewritten, including the project config, the machine config, the README
examples and the suite's fixtures.

An omitted role and a role set to `[]` both generate nothing. That is two ways
to say one thing, accepted deliberately: requiring all four keys would be
noisier without catching anything, since `KNOWN_ROLES` validation already
rejects a typo'd role name.

### The old form is detected by type, not guessed

TOML cannot express both `roles = [...]` and `[generate.roles]` in one file, so
the two forms are distinguishable exactly:

```ts
if (Array.isArray(raw.generate?.roles)) → old form
if (raw.generate?.models !== undefined) → old form
```

Either produces an error naming the fix. There is no heuristic and no
best-effort read. A config that cannot be understood must fail loudly rather
than be interpreted approximately — the `[models.gpt-5.6-luna]` nesting bug
began as a config that parsed into something nobody intended.

### The wizard asks once, and loops only on request

After models and roles are chosen, `init` asks:

```
  Use the same models for every role?

  ❯ Yes · 4 roles × 3 models = 12 agents
    No  · choose per role
```

**Yes** writes every chosen model under every chosen role — today's behaviour,
one keystroke. **No** walks the roles in order, each a multiselect over the
models already chosen, pre-ticked with all of them:

```
  Models for: review

  filter: █

  ❯ ◉ openrouter/grok-4.5
    ◉ openrouter/kimi-k3
    ○ openai/gpt-5.6-sol

  3 of 3 · space toggle · type to filter · enter confirm · esc cancel
```

The per-role lists reuse the existing multiselect, viewport and filter, so
there is no new widget. A matrix screen was rejected for that reason: a second
widget to build, test and window, for a screen most runs would skip.

### Command-line flags keep the shorthand meaning

`--roles code,review --models a,b` continues to mean "each of these roles gets
each of these models", and `init` writes the table form. Per-role selection is
interactive-only. Adding a `--role-models code=a,b;review=c` flag was
considered and deferred: it is a new parsing surface for a case nobody has
asked for, and the shorthand covers scripted and CI use.

## Components

**`SonataConfig.generate`** (`src/config.ts`) — becomes
`{ roles: Record<string, string[]> }`. The `models` field is removed; the union
of every role's models is derived where a flat list is needed.

**`parseConfig`** — rejects the old form by type; validates each role against
`KNOWN_ROLES` and every referenced model against `[models]`, as it does now.

**`generatedAgents(config): { role: string; model: string }[]`**
(`src/config.ts`) — the flattened set of agents the config asks for. One
function, so `sync`, `init`'s summary and `staleAgents`' expected set cannot
disagree about what should exist. This is new: today the same nested loop is
written out in `sync` and again as `expected` in `init`.

**`cmdSync`** — iterates `generatedAgents` rather than a nested loop.

**`tomlFor`** (`src/commands/init.ts`) — writes `[generate.roles]`, each value
a quoted-key-escaped array, using the existing `tomlKey`.

**`cmdInit`** — the same-models question and the per-role loop; the summary
line reports the agent count from `generatedAgents`.

## Data flow

```
init: providers → models → roles → same for every role?
                                    │
                          ┌─────────┴─────────┐
                        Yes                   No
                          │                    │
              every role gets      per-role multiselect,
              every model          pre-ticked with all
                          └─────────┬─────────┘
                                    ▼
                        [generate.roles] table
                                    │
                    parseConfig ─▶ generatedAgents ─┬─▶ cmdSync (writes agents)
                                                     ├─▶ init summary (count)
                                                     └─▶ staleAgents (expected)
```

## Error handling

- **Old flat form present** → throw naming both the offending key and the fix:
  re-run `sonata init`, or rewrite as `[generate.roles]`. The message shows the
  new shape, since a user hitting this has a working config they need to
  translate.
- **Unknown role key** → the existing `KNOWN_ROLES` error, unchanged.
- **A role referencing an undefined model** → the existing
  `generate.models references unknown model` error, reworded to name the role
  as well, since the model list is no longer global.
- **Every role empty, or `[generate.roles]` absent** → `init` refuses with
  "nothing to generate", matching how it already refuses an empty model
  selection. `sync` writes zero agents and says so rather than failing.
- **A model chosen for no role** → not an error. It stays defined in
  `[models]` and can be dispatched by `sonata run --model`; only agent
  generation is affected.

## Migration

Breaking, with no compatibility path — chosen deliberately over supporting both
forms.

`sonata init` rewrites a config to the new shape, which is the migration. Until
then every command that loads the config fails with the message above.

Updated in the same change: `README.md`, `CLAUDE.md`, and the flat-form
fixtures in `tests/config.test.ts`, `tests/e2e.test.ts`,
`tests/commands/run.test.ts` and `tests/commands/sync.test.ts`.

The machine config at `~/.config/sonata/sonata.toml` and the development
repository's own `sonata.toml` are rewritten by hand or by re-running `init`
once this lands.

## Interaction with the dispatch-integrity work

The two specs are independent but both touch `cmdSync` and `doctor`. Whichever
lands second adapts to the first; neither depends on the other. If
dispatch-integrity lands first, its "every generated agent maps to a defined
model" check consumes `generatedAgents` instead of recomputing the product.

## Testing

- `parseConfig` — accepts the table form; rejects `roles` as an array naming
  the fix; rejects a present `models` key; rejects an unknown role key; rejects
  a role referencing an undefined model, naming the role.
- `parseConfig` — a role with `[]` parses and contributes no agents; an omitted
  role behaves identically.
- `generatedAgents` — returns one entry per role × its own models; empty for an
  all-empty table; two roles with different model sets produce exactly those.
- `cmdSync` — writes exactly the files `generatedAgents` names, and no others.
- `tomlFor` — round-trips a per-role table through `parseConfig` unchanged,
  including a model key containing a dot.
- `cmdInit` non-interactive — `--roles a,b --models x,y` writes a table where
  both roles list both models.
- `cmdInit` — a config where `review` has one model and `code` has two
  round-trips, and the reported agent count is three.

Tests inject `cwd` and `home` as temp directories, as the suite already does.

## Risks

**The break is total and offers nothing in return to a user who liked the flat
form.** A config that worked yesterday fails today, and the only remedy is
re-running `init` or hand-editing. This was chosen over a compatibility path;
it should be stated in the release notes rather than discovered.

**`generatedAgents` becomes the single definition of what should exist.** That
is the point — three copies of the product currently exist — but a bug in it now
misreports stale agents as well as generating the wrong ones.

## Open questions

None blocking. One noted: whether a `--role-models` flag is wanted for scripted
per-role configs. Deferred until someone needs it; the shorthand covers CI.
