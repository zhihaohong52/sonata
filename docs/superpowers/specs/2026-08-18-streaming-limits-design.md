# Streaming, and why the wrapper agent stays

Date: 2026-08-18
Status: measured; the fixes it recommends are implemented

> An earlier revision of this document concluded the opposite — that a
> subagent's tool call never renders progress, and that the wrapper should
> therefore be dropped. That was an observation error: the ticks were rendering
> in the subagent's own nested view while the transcript was being watched. The
> corrected measurements are below. The error is recorded rather than deleted
> because it is the kind that survives review — every individual claim was true,
> and the conclusion was still wrong.

Sonata's ambition is to feel like a native Claude Code subagent: same interface,
same working directory, same report contract, different brain — including
watching the foreign model work, turn by turn, in the terminal.

Measured against Claude Code 2.1.233, protocol 2025-11-25.

## The channel

Claude Code sends `params._meta.progressToken` on `tools/call`, and a
`notifications/progress` referencing that token renders in the terminal. These
are protocol messages, not tool results: they cost no tokens and enter no
model's context. That is why they can show a user a running harness, and why
they can never feed the orchestrator.

## Measurements

1. **A subagent's tool call renders progress, in the subagent's own view.**
   Observed at `sonata tick 53 · t=212s`, still ticking.

2. **A subagent's tool call is never backgrounded.** Claude Code backgrounds
   only main-conversation calls. So the call blocks for the whole run, and
   therefore streams for the whole run.

3. **A main-thread call streams only until it is backgrounded at 120s.** On a
   4-second ticker, ticks stopped at exactly 30. `/tasks` then shows
   `sonata/dispatch · <id> · working` and no progress text.

4. **120s is not a high bar.** A dispatch whose entire task was "say the word
   done" crossed it and was backgrounded; codex startup alone can consume it.

## What follows

| | async | live turns |
|---|---|---|
| via wrapper subagent | yes | **yes, whole run** |
| direct, main thread | after 120s | first 120s only |

**The wrapper is the only path that delivers both**, and it is what makes sonata
feel like a native subagent. It stays.

Direct dispatch remains right for one-offs where the orchestrator wants the
result in its own context and does not care about watching. Its 120-second
streaming ceiling is a property worth knowing, not a defect to fix.

## The wrapper's two failure modes

Both are silent. Both were observed today.

### Paraphrasing

A ~3K step-by-step spec reached the harness as a one-line summary. The wrapper
is a small model relaying `task` as a string, and prose asking it not to
summarise is a request, not a mechanism.

**Fix: `task_file`.** The caller writes the task to a file and passes the path.
A path either arrives intact or the dispatch fails loudly — there is nothing to
rewrite. Evidence this works: every dispatch in this session that used a written
brief arrived verbatim, including one of 120 lines, because what crossed the
wrapper boundary was a filename.

`task` stays for short inline tasks. Exactly one of the two must be given.

### Fabrication

Asked to "say the word done", a wrapper returned `done` in 1.9 seconds with zero
tool calls. No run was launched. The same task dispatched directly took over two
minutes, consumed 13,294 tokens on the foreign model, and returned the identical
word — with provenance. Only the provenance line distinguished them.

This is worse than paraphrasing: paraphrasing degrades a run, fabrication
invents one. It happens precisely when the wrapper believes it can answer, which
is when a caller is least likely to check.

**Fix, in two parts.**

1. The wrapper prompt states the prohibition directly: it may not answer
   anything itself, however easy, and a response it did not obtain from a
   dispatch is a failure rather than a shortcut. It must self-check for the
   provenance line before answering.

2. The provenance line is the mechanism, and it already exists:
   `— sonata <id>: <role> on <model> via <harness> · exit N`, built from
   `meta.json`, which only a real run writes. A response lacking it should be
   treated as fabricated, and `sonata verify <id>` confirms a claimed id.

Neither part is enforceable inside sonata — the wrapper's final message belongs
to Claude Code. What sonata can do is make the rule unmissable and the evidence
checkable, which is what these changes do.

## What would change this

Claude Code rendering progress for backgrounded calls would remove the 120s
ceiling on direct dispatch. Nothing else here depends on upstream behaviour.
