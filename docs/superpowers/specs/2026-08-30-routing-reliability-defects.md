# Two routing reliability defects, found by running sonata against itself

Both were observed live on 2026-08-30 while executing the init-hardening plan
through sonata's own tier agents. Neither is theoretical: each one stopped work
in this session, and each failed in a way that looked like something else.

## Defect A — a 400 is treated as a successful response, so a broken model absorbs its tier

`routeTierRequest` (`src/native/router.ts`) tries each `[tiers.<role>].<tier>`
candidate in rank order and cools a candidate down only on this condition:

```ts
if (response.status >= 500 || response.status === 429 || response.status === 401 || response.status === 403) {
  cooldowns.set(route.key, now() + TIER_COOLDOWN_MS);
  // ... try the next candidate
}
```

**400 is not in that list.** A 400 therefore counts as a response: it is returned
to Claude Code, no cooldown is recorded, and the candidate is not skipped.

That is fine for a genuine client error. It is not fine for a model that 400s
*every* request, because such a model becomes an **absorbing state**: it stays
the first non-cooling candidate forever and kills every agent that reaches it.

### How it presented

`google-gemini-3.7-flash` rejects every multi-turn tool-use request with
`400 ... Function call is missing a thought_signature in functionCall parts`.
Gemini 3 returns a `thought_signature` on each function call and requires it
echoed back; LiteLLM does not preserve it. Probed directly: the identical
two-turn exchange 400s on `gemini-3.7-flash`, `gemini-3.5-flash` and
`gemini-flash-latest`, and returns 200 on `gemini-2.5-flash`.

Once the ranked candidates above it went into cooldown, gemini absorbed the
tier. Two implementer agents were killed in a row, four consecutive requests
went to the same broken model, and retrying could never have recovered —
because the failure never earned a cooldown.

The symptom read as "the model is flaky". The cause was that a permanently
broken model is indistinguishable, to the fallback logic, from a working one.

### What to consider

Distinguish *this request was malformed* from *this candidate cannot serve
requests of this shape*. A 400 that repeats for a candidate is the second. A
consecutive-400 count per candidate, cooled down like any other failure, would
have skipped gemini after the first or second attempt and fallen through to a
working model. The retry remains pre-first-byte, so nothing about streaming
changes.

## Defect B — a killed subagent pins routing on permanently, and `route off` does not recover it

`sonata route auto`'s guarantee is that a session *launches* from a settings
file with no `ANTHROPIC_BASE_URL`, because that is the only moment Claude Code
consults it for the Remote Control gate. Routing is switched on by
`SubagentStart` and off by `SubagentStop`, counted in
`.sonata/route-subagents.json` so a sibling finishing cannot un-route a running
subagent.

**A subagent that dies without firing `SubagentStop` leaves its id in that
file.** The running count then never returns to zero, `route off` never fires,
and `ANTHROPIC_BASE_URL` stays in `.claude/settings.local.json` indefinitely.
Every session launched in that project afterwards inherits it and loses Remote
Control — including sessions that never dispatch a foreign-model agent at all.

This is already documented as the safe failure direction, and it is: losing
Remote Control is visible at launch, whereas silently demoting a foreign-model
agent to Claude is not. The defect is not the direction. It is that **there is
no working recovery path.**

### The recovery path does not work

CLAUDE.md states that `sonata route off` clears the registry. Measured on
2026-08-30 against a project with six leaked subagent ids and zero running
subagents:

- `ANTHROPIC_BASE_URL` was removed from `.claude/settings.local.json` ✓
- `.sonata/route-sessions.json` was cleared ✓
- **`.sonata/route-subagents.json` still held all six ids** ✗

So the pin survives its own documented fix. Worse, it re-arms: the next
`SubagentStart` takes the count 6 → 7, and its `SubagentStop` returns it to 6,
never 0 — so routing turns on and stays on again immediately.

The other stated cleanup — "the last session out clears any leaked subagent
references" — requires *every* session in the project to exit. There were eight
live peer sessions at the time of measurement. In normal use that condition may
not be met for days.

The leak was produced by ordinary conditions, not abuse: roughly a dozen
subagents were killed mid-run by upstream API faults (a 400 on a broken model,
429 quota exhaustion, 529 route exhaustion). A killed process does not run its
stop hook.

### What to consider

- `route off` should clear `route-subagents.json` as well as
  `route-sessions.json` — it is the documented recovery and currently does not
  recover.
- A leaked reference should be reapable without waiting for every session to
  exit. The registry holds agent ids; liveness is checkable.
- `sonata doctor` cannot presently tell a genuinely-routed project from a
  pinned-by-leak one. It reports routing as on in both cases, which is why this
  went unnoticed until Remote Control was missed and looked for deliberately.

## Why these two belong together

Both are failures of *state that outlives the thing it describes* — a cooldown
that is never recorded for a model that always fails, and a subagent reference
that is never cleared for a process that never exited. Both present as
something else: the first as a flaky model, the second as an unrelated loss of
Remote Control. And both were only found by running sonata hard enough, for long
enough, that the leaked state accumulated.
