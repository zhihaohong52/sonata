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
