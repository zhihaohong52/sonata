---
name: sonata-loop
description: Use when building a feature end-to-end with sonata tier agents — plans the work, routes each task to a difficulty tier, gates every change behind review, and escalates tiers on repeated failure.
---

# Loop engineering with sonata tier agents

Run feature development as a loop over sonata's tier agents. You (the
orchestrating session) judge difficulty and drive the loop; the agents do the
work on foreign models. All of them require a routed session (`sonata route
auto`) — if a tier agent errors with "all native routes … failed", fall back
to `sonata dispatch --tier <role>-<tier>` in Bash.

## Difficulty heuristic

- **simple** — mechanical, well-specified, contained: single-file changes,
  bulk edits, scaffolding, test-writing against a clear spec.
- **complex** — cross-cutting, ambiguous, design-sensitive, or needs
  sustained reasoning: multi-file refactors, API design, debugging unknowns.
- When unsure, use `-complex`.

## The loop

1. **Plan.** Dispatch `plan-complex` with the feature description. Ask it for
   a numbered task list with per-task difficulty guesses.
2. **Route.** For each task, judge difficulty yourself (the plan's guess is
   advice, not binding) and dispatch `code-simple` or `code-complex` with a
   self-contained task description — name the files to touch and the files to
   leave alone; never say "see the plan".
3. **Gate.** After each task, dispatch `review-simple` on the diff. Findings →
   dispatch a fix at the same tier, then re-review.
   - **Escalation rule:** a task that fails review twice at `simple` re-runs at
     `complex` from scratch.
   - **Loop bound:** at most 3 fix iterations per task; then stop and surface
     the findings to the user.
4. **Final gate.** When every task passed, dispatch `review-complex` over the
   whole change. Findings loop back through step 3.

## When not to loop

A single contained change does not need the loop — dispatch one `code-*`
agent directly, review it yourself or with one `review-simple` pass, done.
