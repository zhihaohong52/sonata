# A local UI on the router

Written 2026-09-15 for the 0.9.2 cut. Sonata's observability is five CLI
commands over three stores — `sonata usage`, `sonata status`, `sonata runs`,
`sonata log`, `sonata route status` — and answering "what is this session
actually doing, and what has it cost me" means running several of them and
joining the output by eye. This design serves that join as a page, from the
router the machine is already running: **`http://localhost:4100/` lists every
session and dispatch run, and a dashboard breaks token use and spend down by
model, filterable by project and by session.**

It is a **reader**. It adds no new source of truth, computes no number a CLI
command does not already compute, and writes nothing.

## Why the router, and not a new daemon

The router is already up. `sonata run`, `sonata dispatch` and
`hooks/ensure-serve.mjs` all start `sonata serve --daemon` when it is down, so
on any machine using sonata there is a process on the machine router port
holding exactly the state this UI wants to show: the ledger, the session map,
the tenant registry. A second daemon would need its own lifecycle, its own
port, its own `doctor` diagnosis and its own failure mode when the two
disagree about which projects exist.

It also binds loopback — `server.listen(port, 'localhost')`,
`src/commands/serve.ts:532` — so mounting read-only views of data that process
can already see widens no network boundary. The browser-specific risks that
*are* new are handled in **Security** below.

The UI is served by every `sonata serve`, with no flag. An opt-in flag would
be absent exactly when the daemon came up on its own from a SessionStart hook,
which is most of the time.

## Mounting

Every route sits under `/__sonata/`, beside the existing `/__sonata_health`
check in `createRouterServer` (`src/native/router.ts:1321`). Anthropic's
surface is entirely `/v1/*`, so no proxied path is shadowed and the dispatch
check is a prefix test ahead of `routeRequest`, costing one `startsWith` per
proxied request.

| route | returns |
|---|---|
| `GET /__sonata/` | the page |
| `GET /__sonata/api/sessions` | the merged session + run list |
| `GET /__sonata/api/session/<id>` | one routed session's request stream |
| `GET /__sonata/api/run/<id>?project=<dir>` | one dispatch run's transcript and report |
| `GET /__sonata/api/usage` | the dashboard's aggregation |

`GET` only. A non-GET under the prefix is 405, not a fall-through to the
proxy: a `POST /__sonata/anything` reaching `routeRequest` would be forwarded
upstream as if it were an API call.

## Every number comes from a function that already exists

`readRows` (`src/ledger.ts`), `loadSessions`
(`src/sessions.ts`), `aggregate`, `projectResolver`, `labelOf` and
`parseDuration` (`src/commands/usage.ts`), `recentRoutes`
(`src/commands/status.ts`), `summarizeRuns` (`src/commands/runs.ts`),
`readEvents` and `readReport` (`src/store.ts`).

This is a constraint, not a convenience. `sonata agents` became a second
writer of `sonata.toml` and the design note on it explains at length why the
second writer was made to preserve rather than reconstruct: two definitions of
one thing drift, and the drift is invisible until it matters. A UI that
recomputed "cost" would be a second definition of money. If a helper needs
widening to serve the UI, widen it and let both callers take the new
behaviour — do not copy it.

Concretely: the UI must not sum `tokens.input` itself, must not read
`price.totalUsd` itself, and must not decide what counts as a project. It
calls `aggregate` and renders the `UsageReport` it gets back.

## One list, two row kinds

"Session" names two different things in sonata and only one of them has a
transcript. The list shows both, discriminated by a `kind` field, because a
user asking "what has been running" does not hold that distinction and should
not have to.

```ts
type Row =
  | {
      kind: 'session';
      id: string;            // the Claude Code session id
      project: string;       // resolved label, from projectResolver
      started?: string;
      requests: number;
      input: number;
      output: number;
      costUsd: number;
      coveredUsd: number;
      unpricedRequests: number;
      models: string[];      // distinct candidates that served it
    }
  | {
      kind: 'run';
      id: string;            // the dispatch run id
      project: string;
      role?: string;
      model?: string;
      state: string;         // RUNNING | DONE, from summarizeRuns
      degraded: boolean;
      started?: string;
      usage: null;
      usageReason: string;
    };
```

A routed session's log is its request stream: alias → candidate served →
tokens → cost → the candidates it fell past. A dispatch run's log is its real
terminal transcript.

### `usage: null` is the point, not a gap

A dispatch run executes in the foreign CLI's own process against that CLI's
own credentials and never transits the router, so sonata has no row for it.
The field is `null` with a stated reason and is **never rendered as `0`**.

This is the rule the ledger already follows for unpriced volume, for the same
reason: a total that treats unknown as zero under-reports silently, in the
case the user is least able to notice.

Reading those numbers out of each harness's own structured session store is
possible and was investigated during this design — see **Deliberately not
done** — but it is a second usage subsystem and gets its own spec.

## Where dispatch runs come from

Run directories are per-project (`<cwd>/.sonata/runs/`), and the daemon serves
every project, so it must enumerate candidate directories. Two sources, unioned
and deduplicated on realpath:

1. the tenant registry — every project that has routed a request
2. `sessions.json` — every cwd a session was recorded in

For each, read `<dir>/.sonata/runs` through `summarizeRuns`, which already
skips a half-written or hand-edited run directory rather than failing.

Three consequences, accepted:

- A project that has **never** routed and has **never** registered a session
  will not appear. Its runs are still reachable by `sonata runs` in that
  directory. Scanning the filesystem for `.sonata` directories to close this
  gap is refused: the daemon does not get to walk the user's home.
- Enumeration is capped and results are cached briefly (see **Cost of a
  page load**).
- A directory that no longer exists is skipped, not an error, matching
  `projectResolver`'s existing handling of a deleted project.

## Filtering

Two filters, both applied server-side: `project` and `session`. Also `since`,
parsed by `parseDuration`, defaulting to `24h`.

Project filtering compares **resolved labels** via `projectResolver`, exactly
as `cmdUsage` does — never raw cwd strings. Two spellings of one repository
(a subdirectory, a symlinked path, a linked worktree) resolve to one label, so
the UI's project buckets agree with `sonata usage --by project` and with what
`[budget] daily_usd` actually pools. A worktree lands on its main checkout in
all three.

Getting this wrong would produce a page that disagrees with the cap that
refuses the user's requests, which is worse than no page.

## The dashboard

`GET /__sonata/api/usage?by=model&project=&session=&since=` returns the
`UsageReport` from `aggregate` unchanged, and the page renders it. `by`
accepts the existing `UsageDimension` values — `model`, `role`, `tier`,
`effort`, `gateway`, `session`, `project` — so the dashboard is the existing
report with a selector on it, not a new report.

Three things `UsageReport` already separates and the page must keep separate,
rather than summing into one headline number:

- `pricedTotalUsd` — money spent
- `covered` — subscription-backed work, valued at list, never billed per token
- `unpriced` — volume with no known rate

and `failedAttempts`, the candidates requests fell *past*, rendered as its own
section. These have no bucket of their own by construction and are the visible
cause of dead subagents.

## The page

One static `ui/index.html`: no build step, no bundler, no new dependency. The
repository's four dependencies are all for the Ink wizard, and a read-only
dashboard does not justify a second frontend toolchain or a tarball several
hundred KB larger.

Vanilla JS fetches the JSON endpoints and re-renders on filter change, so
changing a filter does not reload the page. Auto-refresh on a timer, pausable.
The file is added to `package.json`'s `files`, and to CI's required-files list
— a runtime asset outside `files` is absent from the published tarball and
fails only at a user's install, which that CI check exists to catch.

## Security

The router holds gateway credentials, so its new surface is worth stating
precisely.

- **No CORS header.** Without `Access-Control-Allow-Origin`, a page the user
  visits cannot read these endpoints cross-origin. The header is not added.
- **Host check.** Requests whose `Host` is not `localhost` or `127.0.0.1`
  (with the router port) are refused, which is what closes DNS rebinding —
  the residual attack once the origin is loopback.
- **No credential ever rendered.** The UI surfaces gateway *names*, never
  keys. Keys flow store → memory → LiteLLM and appear in no response body.
- **Escaping.** Ledger and transcript content is attacker-influenced in the
  ordinary case (a model wrote it). It is inserted as text, never as HTML, and
  never interpolated into a script context.
- **No writes.** `GET` only; a non-GET under the prefix is 405.

The UI does **not** authenticate, matching the router, which "authenticates
nobody on loopback". The `x-sonata-project` header's token requirement is
unaffected and unused here: this surface reads, it does not choose whose
credentials serve a request.

## Cost of a page load

The router is on the request path of every native agent, so the UI must not be
able to slow it down.

- Ledger reads are bounded by `since` and by the ledger's own 30-day retention.
- Run enumeration is capped at a fixed number of project directories and its
  result is cached for a few seconds, so holding the page open does not stat
  the filesystem per render.
- Transcript responses are capped in bytes, tail-first, with a flag saying the
  response was truncated. `events.jsonl` has no size bound.
- Every handler is wrapped so a throw returns a JSON error rather than
  reaching the server's catch-all, which answers in Anthropic's error shape —
  correct for a proxied request, wrong and confusing for a fetch from the page.

## Testing

At `routeRequest` level against a fixture ledger and a fixture run directory,
in the existing vitest suite. No browser, no screenshot tests.

- each endpoint's shape, including `usage: null` on a run row
- `project` filtering pools two spellings of one project onto one label
- `session` filtering selects only that session's rows
- `since` bounds the window
- a non-GET under `/__sonata/` is 405 and is **not** forwarded upstream
- `POST /v1/messages` still routes — the regression that matters most
- a `Host` that is not loopback is refused
- a project directory that does not exist is skipped, not fatal
- a transcript longer than the cap is truncated and flagged

## Deliberately not done

- **Harness token counts.** Verified during this design that they are
  obtainable: claude writes `message.usage` per assistant record to
  `~/.claude/projects/<slug>/<session>.jsonl`, codex writes
  `total_token_usage` to `~/.codex/sessions/**/rollout-*.jsonl` (confirmed
  live: 873,812 in / 8,755 out on a real run), and pi writes both `usage` and
  its own `cost` to `~/.pi/agent/sessions/<slug>/*.jsonl`. opencode's sqlite
  store is likely and unconfirmed; reasonix's session file showed no usage
  field. Reading a harness's own structured store is not the terminal-scraping
  the conventions forbid — that rule is about the rendered tmux pane — and it
  belongs behind the `HarnessAdapter` boundary. It is excluded here because it
  is a second usage subsystem: five adapters, five formats, a
  run-to-session correlation rule, and pricing for models that never touched
  the router. It also produces *second-class* numbers — sonata's own come off
  the SSE stream, while Claude Code's JSONL is documented to undercount
  against the API's own figures — so it needs a source label per number, which
  is a design question of its own. Own spec, own PR.
- **A `sonata ui` command.** The URL is printed by `sonata status` and
  `sonata doctor`; a command that opens a browser can follow if the link
  proves undiscoverable.
- **Live streaming.** Polling on a timer, not SSE or websockets. A running
  dispatch's live view is `tmux attach -r -t sonata-<id>`, which already
  exists and is better.
- **Any write action.** No approving a paused run, no killing a session, no
  editing tiers from the page. The moment the UI writes, it needs
  authentication, and the loopback-no-auth position stops holding.
- **Authentication.** Follows from the above.
- **Charts.** Tables. The numbers are small in cardinality and exact values
  matter more than trend shape.
