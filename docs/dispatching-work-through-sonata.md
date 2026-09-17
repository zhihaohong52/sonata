# Dispatching work through sonata

**Date:** 2026-08-11

Notes from using sonata to implement its own provider-selection feature — eleven
of thirteen plan tasks were written by `deepseek-v4-flash` through
`opencode-go`, with three review runs on other models. Everything below was
observed on real runs, not reasoned about in advance.

## A task file must be self-contained

The obvious way to dispatch a planned task is "read the plan at `docs/.../x.md`
and do section 12". This fails once the plan is large. The provider-selection
plan is 2140 lines; the agent spent its whole context reading it and stopped,
its log ending:

```
Read docs/superpowers/plans/2026-08-11-provider-selection.md [offset=1497]
The plan file output was truncated. Let me read the Task 12 section.
```

Extract the section — 320 lines here — and paste it into the task file instead.
The task text reaches the model directly and costs no tool calls.

Name the files the agent may read, and the ones it must not. Task 12 touched
six files totalling 2120 lines, and needed only three of them before its first
edit. Saying "do not read README.md, src/tui.ts, src/cli.ts" was the difference
between failing and succeeding.

## Split a task by what it must hold in context, not by what it delivers

Task 12 was one coherent deliverable — the two-step `init` flow — and it failed
twice as a single run. Split into the flow rewrite and then the CLI flag plus
README, both passed first try. Coherence is the right criterion when writing a
plan for a human; context footprint is the right criterion when dispatching it.

## Exit 0 is not success

A run that exhausts its context exits 0, writes no report, and leaves the tree
clean. Nothing distinguishes it from a no-op except the log. Check:

```bash
cat .sonata/runs/<id>/exit          # 0 proves only that nothing crashed
wc -c .sonata/runs/<id>/harness.log # a few hundred bytes means it barely started
git log --oneline -1                # did the commit it claims exist?
```

A log containing only `Read` lines means the agent ran out of room.

## Verify the work, not the report

Agent reports are confident and sometimes wrong about their own effects. For
each task, check the commit's diff and file count, that the trailers are
present, and run the full suite yourself. Two things worth checking that no
unit test covers:

- Run the new parser over real data. `parseOpenCodeRefs` was verified against a
  live 496-line `opencode models` catalogue — 496 parsed, none lost, and
  `openrouter/~anthropic/claude-fable-latest` split correctly.
- Drive the state machine directly for invariants a green suite can hide. The
  filtering rewrite hinged on `checked` holding original indices while `cursor`
  indexes the filtered view; a script proving a checked item survives filtering
  is stronger evidence than the tests asserting it.

## Scope reviews to one file

A review of a fifteen-commit diff hit `run_timeout_seconds` (1800s, exit 143)
with no output. The same work split one file per run finished in minutes, and
found a real defect: `tomlFor` escaped its TOML table header but interpolated
`generate.models` raw, so a key containing a quote produced a config that no
longer parsed.

Give the reviewer the invariants to hunt and tell it to say plainly when a
category is clean. Otherwise a review of correct code produces plausible
suggestions rather than a finding of nothing.

## Parallel dispatch is bounded by the gateway, not by the work

Generic parallel-dispatch guidance — including
`superpowers:dispatching-parallel-agents` — decides concurrency from the
*tasks*: independent problem domains, no shared state, fan out. Through sonata
that is only half the question, because agents that share nothing in the
repository still share one upstream.

Measured 2026-09-16 while executing an eleven-task plan with seven agents on a
single `codex-oauth` gateway: **three agents died mid-run** on an upstream
`400 — No tool output found for function call`, and a fourth hit **529 with
every native candidate exhausted**. Task independence bought nothing there;
the tier's eleven candidates were all effort variants of two models behind one
subscription, so they queued behind each other, failed, and cooled down
together. The work survived only because each agent committed before it
crashed, and the one that did not had its work verified and committed by hand.

So pick concurrency from what the *gateway* can carry:

- Count the distinct upstreams, not the distinct tasks. Eleven ranked
  candidates on one subscription is one upstream.
- A tier that exhausts returns 529 naming `sonata dispatch --tier`, which is
  the harness lane — a real fallback, but it runs outside the router and its
  tokens never reach the ledger.
- Expect crashes rather than preventing them: have every agent commit its own
  work, scoped to the files it owns, so a death costs one agent's turn rather
  than the wave.

### Never let an agent run `git stash` — worktrees do not save you

`refs/stash` is a single repository-wide ref, so the stash stack is shared by
every linked worktree. Verified 2026-09-17 on a scratch repo: agent 1 ran
`git stash` in worktree `wt1`; agent 2, in worktree `wt2` on a *different
branch*, saw that entry in `git stash list`, popped it, and ended up holding
agent 1's edits — which were gone from agent 1's tree and dropped from the
stack. Neither agent did anything wrong, and nothing errored.

So isolation by worktree is not a defence here. Put the prohibition in every
agent prompt, whichever layout you use, along with the other repository-global
or neighbour-destroying commands:

- `git stash` (any form) — shared stack, as above
- `git reset --hard`, `git checkout -- .`, `git clean -fd` — discard whatever
  uncommitted work other agents have in a shared tree
- `git add -A`, `git commit -a` — stage a neighbour's in-flight edits into your
  commit
- `git checkout <branch>` in a shared checkout — moves every agent's HEAD

The positive form is one line: **stage the paths you own, commit them, and
touch nothing else.**

### Shared checkout or one worktree per agent?

Default to a **shared checkout with exclusive file ownership**, and reach for
worktrees only when the tasks are genuinely disjoint.

The reason is that plans are less independent than they look. In the
eleven-task run above, task 1 widened a shared type and that was a compile
error in three files owned by tasks 5, 8 and a file no task owned — 7 errors
in total. In a shared tree the owning agents fixed them as they landed, and
every later agent verified against an integrated state. In separate worktrees
each of those agents would have been staring at errors it was forbidden to fix,
in files it could not see being repaired, and the integration would have
happened at merge time with nobody watching.

Worktrees earn their cost when tasks touch genuinely separate subsystems, share
no types, and each wants to run a long suite without seeing a neighbour's
half-applied change. The costs are real: `npm install` per worktree, N merges
instead of none, and — specific to this repository — `sonata.toml` is untracked,
so a worktree borrows the main checkout's config (`mainWorktreeDir`), while
`.claude/settings.local.json` cannot be borrowed at all and routing must be set
up in the worktree itself.

Two rules made a shared checkout safe for seven concurrent agents, and both are
worth keeping whatever the concurrency:

**Give every agent exclusive file ownership**, and say so in its prompt —
"modify only these paths; if the task seems to need another, stop and report
it". Seven agents produced no merge conflict under that rule.

**Never `git add -A`.** Each agent stages only its own paths. This is written
here because the one place it was violated in that session was the coordinator's
own commit, which swept up another agent's in-flight edits and a stray scratch
file, and split one task's history across two commits under a misleading
message.

**Substitute tier agents for `general-purpose`.** That skill's examples all
dispatch `general-purpose`, which runs on Claude and ends the foreign-model
lane silently — the subagent works, reports, and looks exactly like a routed
one. Dispatch `code-*`, `review-*`, `explore-*` or `plan-*` instead, and omit
the `model` argument: the tier is the model choice.

## Model notes

`grok-4.5` did not complete either review dispatched to it — one hit the 1800s
timeout, the other produced 29 bytes of output in forty minutes, both with a
blank pane. `kimi-k3` and `gpt-5.6-terra` completed the same shape of review in
minutes. `deepseek-v4-flash` handled every mechanical task in the plan and,
given a literal specification, reproduced it faithfully; it also caught a test
fixture the plan had not listed.

This is one afternoon's evidence on one machine, not a benchmark.

## A read-only role cannot write its report

Dogfooding surfaced a real defect. A review run ended:

> Unable to write the required report because plan mode prohibits file edits.

Read-only roles run under opencode's `plan` agent, which blocks writes, so
`report.md` can never be produced. The adapter did not say so, and `meta.json`
recorded `canWriteReport: true` — meaning every review and plan run on opencode
was judged degraded for a file it was structurally incapable of writing. Fixed
by keying `canWriteReport` off the agent actually chosen, since `explore` is
read-only yet still able to write.

## Clean up sessions

Finished runs leave their tmux sessions behind; eighteen had accumulated by the
end of the afternoon, which reads as "stuck" when it is merely untidy. `sonata
gc` kills the finished ones.
