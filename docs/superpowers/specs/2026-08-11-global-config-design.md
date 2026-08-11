# A Machine-Level sonata.toml

**Date:** 2026-08-11
**Status:** Design approved, not yet implemented

## Problem

`loadConfig` reads `join(cwd, 'sonata.toml')` and throws if it is absent. There
is no other place it looks. So sonata must be configured once per repository,
and a machine-level setup is impossible.

That would be a mild inconvenience on its own. What makes it a defect is that
**agents are already machine-level while config is not**, and `sonata init`
silently produces that split.

Running `sonata init` in `$HOME` writes:

- `~/sonata.toml` — which `loadConfig` finds only when the cwd is exactly `~`
- `~/.claude/agents/` — which Claude Code treats as global, so the agents are
  offered in *every* repository

The result observed on the development machine: 32 agents visible everywhere,
naming models no reachable config defines. Dispatching one from another repo
fails at config load with `No sonata.toml found`. Nothing warned that the setup
could not work, because from `init`'s point of view it succeeded — it wrote a
config and 32 agent files, and the agents genuinely did appear.

The failure is at least loud rather than silent: the run dies before a harness
starts, so no work is done against the wrong model.

## Goals

- Configure sonata once for the machine and have every repository use it.
- Keep a per-repository config authoritative where one exists.
- Make `init` incapable of producing the split above.
- Say which config file is in effect, since there is now more than one place to
  look.

## Non-goals

- Merging configs. A local file replaces the global one entirely; see the key
  decision below.
- Searching upward from the cwd through parent directories. Two fixed locations
  are predictable; a search makes "which config am I getting" depend on where
  you happen to be standing.
- Moving the user's files without being asked. `doctor` reports; the user acts.
- Changing where `.sonata/runs/` lives. Runs stay beside the repository they
  operate on, which is correct regardless of where config came from.

## Key decisions

### Two fixed locations, project first

```
loadConfig(cwd, home):
  1. <cwd>/sonata.toml                    — if present, wins
  2. <home>/.config/sonata/sonata.toml    — machine-level
  3. neither → throw, naming both paths
```

`~/.config/sonata/` follows the XDG convention and matches what sonata already
does elsewhere: `detect.ts` reads `~/.config/opencode/opencode.json`. A dotfile
at `~/.sonata.toml` was considered and rejected only for consistency with that
existing read.

### A local config replaces the global one entirely

The alternative — global `[models]`, local `[generate]` — is more useful: a
repository could add one model without restating the other eight. It was
rejected because "which models are in effect here" would then require reading
two files and knowing the merge rule.

The cost is real and should be stated plainly: a repository with any local
`sonata.toml` sees *only* that file. Adding one repo-specific model means
copying the global entries alongside it.

### `init` chooses a scope, and both files follow it

`init` gains a TUI select, mirroring the permission-hook prompt it already
shows:

```
  Where should this config apply

  ❯ This project only    ./sonata.toml + ./.claude/agents/
    All projects         ~/.config/sonata/sonata.toml + ~/.claude/agents/
```

The scope governs **both** the config path and the agents directory. This is
the whole point: the two cannot drift apart, which is the defect that motivated
the change.

The unattended flag is `--config-scope project|global`. `--scope` already means
the permission hook. Two similarly-named flags is a real wart, accepted because
renaming `--scope` would break anything already scripted against it, and
overloading one flag for two unrelated scopes would be worse than both.

`init` run with no local config and a global one present pre-ticks from the
global config, since that is what the machine currently uses.

### `doctor` names the file it used

Today it reports `ok sonata.toml: 10 models`. With two possible sources that is
no longer enough to debug with, so it reports the resolved path.

It also warns when `~/sonata.toml` exists, because nothing reads it and it
looks exactly like configuration. The warning carries the `mv` command. Sonata
does not move it: a file in `$HOME` that sonata did not deliberately place
there is the user's to move.

## Components

**`configPath(cwd, home): string | null`** (`src/config.ts`) — the resolution
rule above, returning the path that will be used, or null. Pure apart from two
`existsSync` calls; exported so `doctor` can report it without loading.

**`loadConfig(cwd, home)`** — resolves via `configPath`, throws naming both
candidate paths when neither exists.

**`agentsDirFor(scope, cwd, home): string`** (`src/commands/init.ts`) —
`<cwd>/.claude/agents` or `<home>/.claude/agents`. Mirrors `settingsPath` in
`settings.ts`, which already does exactly this for the hook.

**`configPathFor(scope, cwd, home): string`** — the write-side counterpart of
`configPath`. Kept separate because reading resolves a precedence chain while
writing picks one location.

**`cmdInit`** — a scope select before the summary; `configPathFor` and
`agentsDirFor` replace the two hardcoded `join(opts.cwd, …)` paths.

**`cmdSync`** — gains `home` so it resolves the same way `loadConfig` does,
and its `agentsDir` comes from the resolved scope rather than always `cwd`.

**`cmdDoctor`** — reports the resolved path; warns on a stray `~/sonata.toml`.

## Data flow

```
                     ┌─ <cwd>/sonata.toml ──────────────┐
configPath(cwd,home) ┤                                  ├─▶ loadConfig
                     └─ <home>/.config/sonata/…  ───────┘         │
                                                                  ▼
                                                    run / tail / sync / doctor

init --config-scope ─┬─ project → ./sonata.toml    + ./.claude/agents/
                     └─ global  → ~/.config/sonata/ + ~/.claude/agents/
```

## Error handling

- Neither config exists → throw naming both paths, so the message says where it
  looked rather than only where it failed.
- `~/.config/sonata/` does not exist when writing a global config → created
  with `recursive: true`, as `cmdSync` already does for the agents directory.
- A stray `~/sonata.toml` → a `warn` Problem from `doctor`, never an error. It
  breaks nothing; it merely misleads.
- An unparseable global config, with no local one → the existing parse error,
  now prefixed with the resolved path. `init` must still be able to repair it,
  so `preTickedRefs` and `carriedEntries` keep degrading to empty rather than
  throwing.
- `--config-scope` given an unknown value → refuse, listing the two valid ones,
  matching how `--scope` is already validated in `cli.ts`.

## Migration

Nothing breaks. A repository with a local `sonata.toml` resolves exactly as it
does today; the global location is only consulted when there is no local file.

The development machine's `~/sonata.toml` is moved to
`~/.config/sonata/sonata.toml` by hand once this lands. Moving it before then
would remove the one case that currently works — `cd ~ && sonata …` — in
exchange for nothing.

## Testing

The resolution rule is pure enough to test directly, using temp directories for
`cwd` and `home` as the existing `cmdInit` tests already do:

- `configPath` — local only; global only; both (local wins); neither (null).
- `loadConfig` — the error names both candidate paths.
- `configPathFor` / `agentsDirFor` — project and global for each.
- `cmdInit --config-scope global` — writes the config under `home`, the agents
  under `home`, and nothing under `cwd`.
- `cmdInit --config-scope project` — unchanged from today's behaviour.
- `cmdInit` with a global config and no local one pre-ticks from the global.
- `cmdSync` — regenerates against a global config when no local one exists.
- `cmdDoctor` — reports the resolved path; warns on a stray `~/sonata.toml`;
  does not warn when it is absent.
- `cli` — `--config-scope` parses, and an unknown value is refused.

No test may read the real `$HOME`; every one injects `home`, as the current
suite already does.

## Open questions

None blocking. One noted for later: if per-repo configs that *extend* the
global set prove to be what people actually want, the merge rejected above
becomes worth revisiting. That would be a change to the resolution rule only,
not to the scope machinery.
