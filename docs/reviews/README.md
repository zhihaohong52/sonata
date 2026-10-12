# Architecture reviews

Point-in-time reviews of the codebase's module boundaries and responsibility
splits — independent of any single feature's design doc (see
[`docs/superpowers/`](../superpowers/) for those). Kept permanently, same
reasoning as the design history.

| Date | Review |
|---|---|
| 2026-08-18 | [Architectural review](2026-08-18-architecture-review.md) — CLI boundary, config, detection, normalization, role composition, permission/settings policy, run persistence, tmux/watchdog, adapters, MCP boundary |
| 2026-09-27 | [Full audit of 0.13.1](2026-09-27-full-audit.md) — six read-only `review-*` tier agents auditing the native router, pricing/ledger/budget, config and init, the dispatch lane and adapters, routing hooks and the serve lifecycle, and credentials/catalog; the top findings fixed in 0.14.0, the rest recorded as the backlog |
