# Internals

The maintainer's design record — what `CLAUDE.md` used to carry in full. Each
page was moved out of `CLAUDE.md` verbatim when that file outgrew its size
limit; `CLAUDE.md` keeps the day-to-day rules and links here. User-facing
reference lives in [`../guide/`](../guide/README.md).

| Page | Covers |
|---|---|
| [CLI reference](cli-reference.md) | Every command in full, release/publish, the `route auto` history |
| [Architecture](architecture.md) | Design points: completion, worktree fingerprint, harness usage, tier ranking, effort levels, pricing |
| [Configuration](configuration.md) | `sonata.toml` in full |
| [Native path](native-path.md) | Router tenancy, LiteLLM, OAuth gateways, credential stores, request transforms, serve lifecycle |
| [Permission modes](permission-modes.md) | Per-harness permission-mode mapping |
| [Limitations](limitations.md) | Known limitations, router fallback and 400 handling |
| [Conventions](conventions.md) | PR, review, testing and wrapper conventions in full |
