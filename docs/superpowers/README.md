# Design history

Every feature in sonata went through a design doc (spec) before an
implementation plan, following the [superpowers](https://github.com/obra/superpowers)
brainstorming → spec → plan workflow. This is the permanent record: kept in
full, never pruned or archived. The growth rate here is linear with feature
count, not exponential, so it stays a manageable size the way a project's
merged-PR history does — the value of a full audit trail outweighs the cost
of a longer index. Lessons about dispatching implementation work through
sonata itself are in
[`docs/dispatching-work-through-sonata.md`](../dispatching-work-through-sonata.md).

Chronological, oldest first. A spec with no plan listed alongside it is
either queued (not yet implemented — noted below) or was an investigation/spike
that didn't lead to a standalone implementation plan.

| Date | Feature | Spec | Plan |
|---|---|---|---|
| 2026-08-10 | Sonata's original design | [spec](specs/2026-08-10-sonata-design.md) | [plan](plans/2026-08-10-sonata-m1.md) |
| 2026-08-11 | Machine-level `sonata.toml` | [spec](specs/2026-08-11-global-config-design.md) | [plan](plans/2026-08-11-global-config.md) |
| 2026-08-11 | Provider selection for OpenCode and Pi | [spec](specs/2026-08-11-provider-selection-design.md) | [plan](plans/2026-08-11-provider-selection.md) |
| 2026-08-12 | Dispatch integrity | [spec](specs/2026-08-12-dispatch-integrity-design.md) | [plan](plans/2026-08-12-per-role-models-and-dispatch-integrity.md) |
| 2026-08-12 | Per-role model selection | [spec](specs/2026-08-12-per-role-models-design.md) | [plan](plans/2026-08-12-per-role-models-and-dispatch-integrity.md) |
| 2026-08-17 | Investigating two DeepSeek harnesses as adapters | [spec](specs/2026-08-17-deepseek-harnesses-investigation.md) | — investigation, no separate plan |
| 2026-08-18 | One-call dispatch | [spec](specs/2026-08-18-one-call-dispatch-design.md) | [plan](plans/2026-08-18-one-call-dispatch.md) |
| 2026-08-18 | Streaming, and why the wrapper agent stays | [spec](specs/2026-08-18-streaming-limits-design.md) | — design note, folded into later plans |
| 2026-08-19 | Spike: native Claude Code subagents on foreign models | [spec](specs/2026-08-19-native-foreign-subagents-spike.md) | — spike, superseded by the native path design below |
| 2026-08-19 | The native path | [spec](specs/2026-08-19-native-path-design.md) | [plan](plans/2026-08-19-native-path.md) |
| 2026-08-20 | BYOK (bring your own key) | — | [plan](plans/2026-08-20-byok.md) |
| 2026-08-20 | Ink TUI rewrite | — | [plan](plans/2026-08-20-ink-tui-rewrite.md) |
| 2026-08-21 | Credential sources: choose, import, or log in | [spec](specs/2026-08-21-credential-sources-design.md) | [plan](plans/2026-08-22-credential-sources.md) |
| 2026-08-23 | Add Provider / Import From Harnesses wizard redesign | [spec](specs/2026-08-23-add-provider-flow-design.md) | [plan](plans/2026-08-23-add-provider-flow.md) |
| 2026-08-25 | Tier routing: native-first subagents, difficulty tiers, loop skill | [spec](specs/2026-08-25-tier-routing-design.md) | [plan](plans/2026-08-25-tier-routing.md) |
| 2026-08-27 | Usage and route ledger | [spec](specs/2026-08-27-usage-ledger-design.md) | [plan](plans/2026-08-27-usage-ledger.md) |
| 2026-08-27 | Daemon identity: a lifecycle you can trust | [spec](specs/2026-08-27-daemon-identity-design.md) | [plan](plans/2026-08-27-daemon-identity.md) |
| 2026-08-27 | Dynamic context-window resolution | [spec](specs/2026-08-27-dynamic-context-window.md) | — **queued**, not yet implemented |
| 2026-08-27 | Pricing accuracy follow-ups (genai-prices, day-of-week windows, cache-creation rate) | [spec](specs/2026-08-27-pricing-accuracy-followups.md) | — **queued**, not yet implemented |
| 2026-08-30 | `sonata init` hardening: decompose the front door, and test it | [spec](specs/2026-08-30-init-hardening-design.md) | [plan](plans/2026-08-30-init-hardening.md) |
