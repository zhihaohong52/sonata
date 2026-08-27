# Daemon identity: a lifecycle you can trust

**Date:** 2026-08-27
**Status:** Approved design, pre-implementation
**Release:** 0.3.0 (roadmap item 05, the last item in scope — 01/02/03 shipped
in PR #3, 04 deferred to 1.0)

## Summary

`sonata restart` can report success repeatedly while a stale daemon from a
previous session still holds the router port. Reproduced live 2026-08-26:
`serve-state.json` carried no `routerPid` for the stale process (so
`stopServe` correctly refused to guess and kill it — existing, deliberate
safety behavior), but `startServeDaemon`'s polling loop accepted *any*
router answering `/health` as proof that its own freshly-spawned instance
had bound. The stale router was still there; the new spawn never actually
took the port; the command lied about it.

Two independent gaps, one fix each:

1. **False success** — `startServeDaemon` has no way to tell "a sonata
   router answered" apart from "*my* sonata router answered."
2. **Unactionable refusal** — when `stopServe` finds a router on the port
   it has no recorded pid for, it throws a dead-end error with no next step
   sonata can offer.

## Decision 1: identity handshake

`startServeDaemon` generates a random instance id (`crypto.randomUUID()`)
*before* spawning the child, and passes it via an environment variable
(`SONATA_SERVE_INSTANCE_ID`). `cmdServe` reads that variable — falling back
to generating its own id when absent (a foreground `sonata serve` with no
daemon wrapper still needs one) — and reports it on `/__sonata_health` as a
new `instanceId` field, alongside the existing `sonata`/`configPath`
fields. `startServeDaemon`'s polling loop checks not just `sonata === true`
but `instanceId === <the id it generated>`, so it only declares success once
the process it actually spawned is the one holding the port — never a
stale survivor that happens to still be listening.

Every daemon-start path in the codebase funnels through this single
function (`cli.ts`'s `sonata serve --daemon`, `code.ts`'s `sonata code`
auto-start, `route.ts`'s routing auto-start, `run.ts`'s auto-start) — fixing
`startServeDaemon` and `cmdServe` covers all four call sites with no
per-caller changes needed.

**Not persisted.** The instance id lives only for the duration of one
`startServeDaemon` call, in memory. `serve-state.json` keeps its current
shape (`routerPid`/`litellmPid` only) — persisting instance ids for
diagnostics is out of scope; the roadmap's problem doesn't need it, and
adding it would be scope creep beyond what a lifecycle-trust fix requires.

### Simplification this enables

`route.ts`'s daemon-auto-start path (`cmdRouteSession`'s daemon-ensure
logic) currently re-checks `sonataRouterConfigPath` after `startServeDaemon`
returns, specifically to catch a race where a concurrent `SessionStart` in a
different project wins the same default port with *its* daemon between the
initial probe and this daemon-spawn's poll completing. Once
`startServeDaemon` waits for its own instance id specifically, that race is
closed by construction: a different instance's id will never match, so
`startServeDaemon` keeps waiting (and correctly times out, since the daemon
this call spawned never actually got the port). The secondary check in
`route.ts` becomes redundant for the race it exists to guard and should be
removed as part of this work — `startServeDaemon` becomes the single place
this identity guarantee lives, rather than being partially reimplemented at
one call site.

`configPath` stays on the health endpoint as-is (still useful for
`sonata doctor` and cross-project diagnostics) — only the redundant
re-check in `route.ts` goes away, not the field itself.

## Decision 2: actionable takeover message

When `stopServe` finds a router on the port with no recorded pid, sonata
still never kills it — the existing "never act on a pid found by scanning
the OS" discipline (established through a real prior incident, documented
in `CLAUDE.md`) stays absolute. What changes is the message: instead of a
dead-end refusal, `stopServe` shells out to `lsof -ti:<port>` (macOS/Linux —
matches the project's existing "macOS or Linux only" support scope) purely
to *print* whatever pid it finds, giving the user a copy-pasteable next
step:

```text
sonata restart: router port 4100 answers as a sonata router, but no recorded
pid for it was found in ~/.config/sonata/serve-state.json — it may have been
started by a different sonata install or an older version.

Kill it yourself, then run `sonata serve --daemon`:
  kill 48213
```

If the pid lookup itself fails (unsupported platform, permission denied, an
ambiguous or missing result), fall back to today's generic "kill it by hand"
wording rather than printing something potentially wrong. Sonata never acts
on what it finds this way — only describes it.

## Edge cases

- **A pre-this-change sonata router already on the port** never reports
  `instanceId`. The new check simply never matches (`undefined !== uuid`),
  so `startServeDaemon` keeps waiting and times out with its existing "did
  not answer, see `<logPath>`" message. The detached child's own bind
  attempt fails with `EADDRINUSE` and logs `occupiedPortMessage`'s
  explanation to that log file — consistent with how daemon failures
  already surface; no new message needed for this case.
- **`sonata restart`** (`cmdRestart`: `stopServe` then `startServeDaemon`)
  is structurally unaffected — `stopServe` either kills what it has recorded
  and proceeds, or now throws the new actionable message instead of the old
  dead-end one; `startServeDaemon` then runs with the instance-id check as
  normal.

## Testing

- `startServeDaemon`'s existing `probe` test seam becomes instance-id-aware:
  a test proves it only succeeds when the probed router reports the exact
  id this call generated, not merely `sonata: true` — this is the direct
  regression test for the false-success bug.
- `cmdServe` needs a test confirming it reads `SONATA_SERVE_INSTANCE_ID`
  when present and generates its own id when the variable is absent.
- `stopServe`'s new takeover message needs tests for both the pid-lookup-
  succeeds path (message includes a real `kill <pid>` line) and the
  lookup-fails/unavailable path (falls back to the generic wording).
- `route.ts`'s removed secondary `configPath` re-check: confirm its
  existing race-condition test (a concurrent SessionStart racing for the
  same port) still passes purely on the instance-id guarantee, without the
  removed code.

## Out of scope

- Persisting instance ids in `serve-state.json` or exposing them via
  `sonata doctor` — not needed for this fix; can be a later addition if a
  real diagnostic need for it shows up.
- Any automatic killing of an unrecorded process — the takeover fix is
  message-only, by deliberate choice, to preserve the existing safety
  discipline absolutely rather than carve an exception into it.
