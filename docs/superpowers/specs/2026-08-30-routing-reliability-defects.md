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
requests of this shape*. A 400 that repeats for a candidate is the second —
but the per-candidate counter must be keyed by something that separates the
two, not by the response status alone. A bare count of "400s seen for this
candidate" would catch the gemini case AND cool every healthy candidate
whenever a caller sends a request the model genuinely cannot serve (a
malformed tool call, a payload shape the model never accepted), turning a
legitimate 400 into a 529. The counter has to be keyed by an error
fingerprint that is stable across "this candidate cannot serve requests of
this shape" (the gemini `thought_signature` error, a 400 on every streaming
tool-call turn) and unstable across "this request was malformed" (a different
client-side error, a payload the model has never been asked). One
implementation: a narrow allow-list of candidate-capability failures (the
thought-signature text, plus a small set of equivalent "this model has
never served this shape" signatures), and the counter increments only when
a 400 body matches one of them. A different fingerprint — or a successful
response — resets the count. The cooldown then fires on `count >= N`
identical matches, the same way the existing `>= 500 / 429 / 401 / 403`
cooldown fires on a single failure. The retry remains pre-first-byte, so
nothing about streaming changes.

**Fingerprinting must not consume the body.** The fingerprinting path reads
the response body to decide whether to count the 400, but `forwardToLitellm`
returns non-500 responses with `response.body` as a one-shot async iterable
— the existing 500 path in `forwardToLitellm` (`src/native/router.ts:355-374`)
already shows the established pattern for this: it buffers the body with
`Buffer.concat` over the async iterable, then returns the buffer as the
response body. The 400 fingerprinting path must do the same: read the body
into a `Buffer` (draining the iterable), compute the fingerprint from the
buffer, and return the **buffer** as the response — not the original
stream. A caller that reads the body to fingerprint and then hands the
unread iterable to Claude Code would deliver an empty error body. The
implementation must therefore mirror the 500 path exactly: same `Buffer.concat`
over the async iterable, same `responseHeaders(response.headers)`, same
`body: responseBodyBuf` in the returned `RouterResponse`. The
above-threshold 400 (cooldown fires, next candidate tried) does not need to
return a body at all, but the **below-threshold 400** must still return the
full buffered body to the caller — a 400 the user can read is what lets them
diagnose a one-off, and a fingerprint-mismatch path that swallows the body
would turn every genuine 400 into a 502-shaped silence.

Tests must cover both cases against `routeTierRequest`: a 400 below the
threshold whose body reaches the caller intact (assert the body bytes
match what the upstream produced), and a 400 at the threshold whose
fingerprint matches N times in a row, cools the candidate, and causes the
router to try the next ranked candidate instead of returning the 400 to
Claude Code.

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
  recover. This is the narrow, safe change: no liveness knowledge required,
  no ordering against `SubagentStart`/`SubagentStop` to reason about, and
  it matches what the user already reached for. **The clear must take the
  same `withSessionLock` (`src/filelock.ts`) that every other registry
  mutation takes** — `cmdRouteSubagent` mutates the registry under that
  lock at `src/commands/route.ts:627, 692, 762`, and a clear that skips
  it can be overwritten by a concurrent `SubagentStart`/`SubagentStop`
  writing back the pre-clear list. That is the exact failure the change
  exists to fix: a clear races against a hook that reads
  count-before-clear, takes a running subagent as `+1` from `0`, and
  then writes its own non-zero list back, restoring a leaked id and
  re-pinning routing. The lock makes the clear atomic with respect to
  those mutations. Tests must exercise this race directly: a `route off`
  interleaved with a `SubagentStart`/`SubagentStop` pair on the same
  registry must leave the registry empty, and a follow-up
  `SubagentStop` whose id was already in the registry when the clear
  ran must not resurrect it.

  **The lock on the session registry cannot be acquired by `route off`
  naively, because `cmdRouteSession('end')` already holds it when the
  last session delegates cleanup.** The paragraph above asks `route off`
  to clear `route-sessions.json` as well as `route-subagents.json`, and
  the natural way to clear each registry atomically is to take *its own*
  `withSessionLock`. The session-registry lock is held by the SessionEnd
  path at `src/commands/route.ts:627`, which opens it and then runs
  `await cmdRoute('off', opts)` at line 637 from inside the lock when
  the last session leaves. `withSessionLock` (`src/filelock.ts:31-49`)
  is a non-reentrant mutex: it takes the lock by winning `mkdirSync` on
  `<file>.lock`, and a re-entry spins on `mkdirSync` failing and throws
  at the 2000 ms deadline with
  `sonata: timed out waiting for lock on <file>`. Today's `route off`
  does not take the session lock, which is why the delegation at line
  637 does not deadlock today — a `route off` that takes the session
  lock to clear `route-sessions.json` would create the bug on the
  last-session-out path. The deadlock only fires when the last session
  leaves, so any reproduction must drive that exact branch, not an
  earlier exit with peers still registered. This constraint was found
  by review, not by running the code: the live failure is reachable on
  every project's last session, but the spec is the first place the
  SessionEnd delegation has been read together with a `route off` that
  takes the session lock.

  Three shapes resolve it. The first is an internal helper holding
  the actual clear logic, called by both `cmdRoute('off', ...)` and
  the SessionEnd path; the locked caller in `cmdRouteSession('end')`
  calls the helper unlocked, the public `cmdRoute('off', ...)`
  acquires the session lock itself and then calls the same helper.
  The second is to pass an explicit "lock already held" signal
  through to the clear path so it knows to skip acquisition. The
  third is to make `withSessionLock` reentrant by recording
  ownership — `withSessionLock` already computes
  `ownerPath = join(lock, 'owner')` (`src/filelock.ts:33`) so an
  ownership check has a foothold, but this is the most invasive
  option because it changes a primitive used by every call site
  in the file (the three writers in `src/commands/route.ts:627, 692,
  762` plus any other consumers), each of which would need to
  tolerate reentrancy semantics they do not ask for. The test that
  would catch the deadlock is a final-session `SessionEnd` that
  exercises the delegation directly: a single registered session, a
  SessionEnd that drives the `left.length > 0` branch to false and
  reaches the `await cmdRoute('off', opts)` at line 637, asserting
  the clear path runs to completion rather than throwing at the
  2000 ms lock deadline. A separate test must call `route off` from
  the shell with no SessionEnd in flight, asserting the session
  lock is still acquired and the file is cleared — together those
  pin down both halves: the locked caller does not self-deadlock,
  and the public entry point still locks.

  **The lock requirement extends to every writer of
  `route-subagents.json`, not just `cmdRouteSubagent`.** Reviewing the
  spec against the current source turned up a pre-existing split-lock
  defect: the SessionEnd path in `cmdRouteSession` already writes
  `route-subagents.json`, and it does so under a *different* lock.
  Concretely, `cmdRouteSession('end')` opens its `withSessionLock`
  against the *session* registry at `src/commands/route.ts:627`
  (the file resolved at line 587), then writes the *subagent*
  registry at line 636, while `cmdRouteSubagent` opens its
  `withSessionLock` against the subagent registry at line 762
  (the file resolved at line 756). Two distinct locks on the same
  file do not exclude each other, so an interleaving like the
  following is real: `SubagentStart` acquires the subagent lock,
  reads the current list, and pauses; SessionEnd acquires the
  session lock, clears `route-subagents.json`, and returns;
  `SubagentStart` resumes and writes its pre-clear list plus its
  new id, restoring every id the cleanup just erased. The cleared
  ids are restored, and the same "stale id pins routing on" failure
  Defect B is about is produced by the cleanup path meant to
  prevent it. The current split-lock arrangement is itself a
  defect, independent of whether the `route off` change above
  ships.

  Two acceptable resolutions. Either **every writer of
  `route-subagents.json` takes the *subagent* registry's lock**
  (so `cmdRouteSession('end')` and `cmdRouteSubagent` acquire the
  same lock, and the clear and the start/stop mutations cannot
  interleave), or **an explicit lock-ordering protocol is defined
  that covers both registries** (so a writer holding one lock may
  acquire the other without risk of deadlock, and the protocol
  itself is the unit reviewed). The first is smaller and the
  second is more general; the choice is a design call, not a
  bug-fix detail. The fix must include a test exercising
  `SessionEnd` concurrently with `SubagentStart` (and a separate
  one for `SubagentStop`) and asserting the post-interleaving
  registry state, since the regression is precisely the kind that
  passes a serial test and only fails under contention.
- A reaper that purges leaked references without the user running `route
  off` is a *separate* change, and it must be designed before it ships. The
  current registry stores only the `agent_id` from the hook payload, which
  does not identify a process, PID, or session — so any liveness check the
  reaper performs has to be defined up front: which signal it uses
  (`pgrep` against a known parent, a heartbeat file the subagent touches
  while alive, an mtime bound on the registry row, or a session id
  cross-referenced against `route-sessions.json`), the ordering against
  `SubagentStart`/`SubagentStop` so the reaper cannot disable routing for
  *active* work, and what it does when the liveness signal is itself
  ambiguous. Until such a signal exists, the only change that is safe to
  ship is the narrower one above.
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
