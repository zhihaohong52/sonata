---
name: sonata-loop
description: Use when building a feature end-to-end with sonata tier agents — plans the work, routes each task to a difficulty tier, gates every change behind review, and escalates tiers on repeated failure.
---

# Loop engineering with sonata tier agents

Run feature development as a loop over sonata's tier agents. You (the
orchestrating session) judge difficulty and drive the loop; the agents do the
work on foreign models. All of them require a routed session (`sonata route
auto`) — if a tier agent errors with "all native routes … failed", fall back
to `sonata dispatch --tier <role>-<tier> --task-file <path>` in Bash (or pass
the task text directly as the trailing argument).

## Difficulty heuristic

- **simple** — writable without asking a question: one or two files, no
  interface change.
- **normal** — the default. You know what to change but not exactly how; it
  needs reading the surrounding code and may touch several files, but what
  "done" means is not in question.
- **complex** — needs a design decision affecting other components, or "done"
  is still ambiguous.
- Size is not difficulty. A large mechanical change is `simple`; a three-line
  change that decides an interface is `complex`.
- When unsure, use `-normal`.

## The loop

1. **Plan.** Dispatch `plan-complex` with the feature description; planning
   stays at `plan-complex` because it is where a design decision lives. Ask it
   for a numbered task list with per-task difficulty guesses.
2. **Route.** For each task, judge difficulty yourself (the plan's guess is
   advice, not binding) and dispatch `code-simple`, `code-normal` or
   `code-complex` with a self-contained task description — name the files to
   touch and the files to leave alone; never say "see the plan".
3. **Gate.** After each task, dispatch `review-simple` on the diff. Findings →
   dispatch a fix at the same tier, then re-review.
   - **Escalation rule:** a task that fails review twice re-runs one tier up,
     from scratch — `simple` to `normal`, `normal` to `complex`. A task that
     fails twice at `complex` stops and is reported, not re-run: another
     attempt at the same tier is the definition of no progress.
   - **Loop bound:** at most 3 fix iterations per task; then stop and surface
     the findings to the user.
4. **Final gate.** When every task passed, dispatch `review-complex` over the
   whole change. Keep the final gate at `review-complex` even when the tasks
   used a lower tier; findings loop back through step 3.

## Tell every agent to stop and ask rather than guess

Put this in each dispatch, in as many words: **if you are stuck, blocked, or
the task is ambiguous, stop and hand back with the specific question instead of
guessing.**

Handing back early is nearly free, and it loses nothing: `SendMessage` resumes
*the same agent* with its context intact, so an answer costs one round trip
rather than a fresh run. Guessing is the expensive path — a dispatch that
churns on an ambiguity burns its whole budget and usually produces work that
has to be redone anyway. Measured on one task that could not write to the
repository: the agent explored and reasoned for three minutes and 76,000
tokens before reporting that it had changed nothing.

Two things make the ask cheap enough to be worth asking for:

- **A fail-fast probe.** Have the agent attempt the smallest real action first
  — writing one line to the file it will need — and stop immediately if that is
  refused. The same blocked task cost a few hundred tokens the second time.
- **Hand over what you already know.** A reproduction, a measured number, the
  exact call site. Anything a `grep` settles is not worth a dispatch, and
  re-deriving it is the most common way a run wastes its budget.

## If you are also running `superpowers:subagent-driven-development`

The two do the same shape of work — plan, dispatch, review, escalate — and
combine fine: take its review protocol (scoped re-reviews, bounded fix rounds,
a fresh implementer when one gets stuck) and this skill's tier routing.

**One instruction in it must be overridden here.** Its Model Selection section
says to always specify the model explicitly when dispatching a subagent. For a
sonata tier agent that is wrong, and wrong silently: the agent pins its routed
model in frontmatter, the Agent tool's own `model` parameter takes precedence
over frontmatter, and passing one runs sonata's prompt and tools on a Claude
model that never reaches the router. Nothing errors and nothing warns — every
`review-*` dispatch quietly becomes Claude reviewing Claude, which is the one
thing this lane exists to prevent.

That section's goal still applies; the tier is how you meet it. **Choosing
`-simple`, `-normal` or `-complex` is the model selection.** Omit `model`.

The same substitution applies to `superpowers:dispatching-parallel-agents`,
whose examples dispatch `general-purpose`: use tier agents instead, or the
foreign-model lane ends silently. Through sonata, concurrency is also bounded
by the gateway rather than by how independent the tasks are — seven agents on
one subscription produced three upstream crashes and a tier exhaustion.

**When you dispatch agents in parallel, give every one of them this rule:**
stage the paths you own, commit them, and touch nothing else. No `git stash`
in any form — the stash stack is repository-wide and is shared even by
separate worktrees, so one agent's stash can be popped into another's tree and
vanish from its own. No `git add -A`, `git reset --hard`, `git checkout -- .`,
`git clean -fd`, or branch switching. See
`docs/dispatching-work-through-sonata.md` for the measurements behind this.

## When not to loop

A single contained change does not need the loop — dispatch one `code-*`
agent directly, review it yourself or with one `review-simple` pass, done.
