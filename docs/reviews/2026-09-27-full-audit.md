# Full audit — 2026-09-27 (sonata 0.13.1)

Six read-only `review-*` tier agents, run through sonata's own native lane
(the first attempt on 2026-09-26 died whole on the OpenCode session-header bug
fixed in 0.13.1). Each area was audited against `CLAUDE.md` as the spec;
findings are verified against the code by the agent that reported them, and
the most severe from each area was re-checked by the orchestrating session
(marked ✅). Severities are the orchestrator's, after re-checking; where they
differ from the agent's, the agent's is in parentheses.

About 72 distinct findings after de-duplication. The top nine are being fixed
on one branch; the rest are recorded here as the backlog.

## Top nine (being fixed)

1. ✅ **P0 dispatch — a crashed run is reported DONE, un-degraded, and ranked
   fallback never engages.** `src/commands/tail.ts:133` derives `degraded` from
   `report === null` and timeout only; the claude adapter redirects
   stdout+stderr into `last-message.txt` (`src/adapters/claude.ts:88`), the
   fallback report, so a run that exits 1 with "API Error: 404" carries a
   non-null report and `sonata dispatch` returns success without trying the
   next candidate (`src/commands/dispatch.ts:201`). `src/commands/runs.ts:36`
   defines degraded differently (`exit !== 0 || report === null`).
2. ✅ **P1 dispatch — shell quoting.** `src/watchdog.ts:44` interpolates paths
   into raw `'…'`; `src/tmux.ts` `runScript` uses `JSON.stringify` (not shell
   quoting) for a line typed into the interactive pane shell;
   `src/adapters/opencode.ts:71,100-102` leaves `cd`/`-m`/`-f` raw. A project
   path containing `'`, `$()` or `!` breaks every launch there or executes.
3. ✅ **P1 (agent: P0) router — gateway env-var collision.**
   `envVarForGateway` (`src/native/litellm.ts:37`) maps `acme-prod`,
   `acme_prod` and `ACME-prod` to one variable; one gateway's key is sent to
   the other's endpoint. Nothing refuses the pair.
4. ✅ **P1 credentials — key follows redirects.** `updateAaCatalog`
   (`src/commands/catalog.ts:174`) sends `x-api-key` with default redirect
   following and no timeout; `validateAaKey` in the same file already guards
   both, with the reason. `fetchModels` (`src/native/models.ts:135`) has the
   same redirect gap for BYOK keys.
5. ✅ **P1 (agent: P0) serve — unvalidated `litellmPid` kill.** `stopServe`
   (`src/commands/serve.ts:1488`) and `killRecordedOrphan` (`:236`) signal the
   recorded LiteLLM pid with no identity check; the router pid is checked
   against the port holder. A recycled pid is an unrelated process.
6. ✅ **P1 serve — `sonata code`/`sonata run` cold start fails after 60 s.**
   `src/commands/code.ts:88` and `src/commands/run.ts:108` pass
   `['sonata','serve','--daemon']` to `startServeDaemon`; the child re-enters
   `startServeDaemon` with a new instance id, so the parent's readiness probe
   never matches and times out while a router is in fact up.
7. ✅ **P1 config — `sonata init` deletes settings.** `nativeTomlFor` writes
   a gateway's `provider` only when it is `anthropic`, and not even that
   survives a second run (`src/init/toml.ts:187`); `deriveInitState` copies
   tiers as `{simple, complex}`, dropping a hand-ranked `normal`
   (`src/init/helpers.ts:573`); `[native.ports]` is never emitted.
8. ✅ **P1 (agent: P0) money — spend vanishes from the budget.**
   `priceHarnessRun` accepts `resolvePrice`'s OAuth `covered` relabel
   (`src/harness-usage.ts:92`), so a metered harness run of a model whose
   *native* route is OAuth is excluded from spend; `count()` coerces missing
   fields to 0 and pi/opencode/reasonix report `observed` with no records, so
   an unparsed run is marked recorded with zero tokens forever; a failed
   `appendRow` still finalises the marker (`harness-usage.ts:225`).
9. **P1 money — a broken machine config switches the machine cap off.** The
   router's `machineConfig()` swallows load errors (`serve.ts:753`) and
   `dispatchBudgetStatuses` does the same (`src/budget.ts:117`), so projects
   keep spending with no machine limit.

## Backlog

### Routing and serve
- **P1** Router cannot start on a project-only machine: `~/.config/sonata` is
  created before `existsSync` picks the daemon cwd (`serve.ts:1313-1327`).
- **P1** `sonata code` sends `x-sonata-project` without `x-sonata-token`
  (`code.ts:74`); the hint is dropped and the machine tenant serves it.
- **P1** `ensure-serve.mjs` has no failure branch after its 10 s poll — a
  router that never comes up is silent.
- **P1** A re-entering session keeps its old registry position
  (`route.ts:935`) while settle gates on the last entry (`:809`).
- **P2** `route auto` reads live sessions outside the lock (`route.ts:708`).
- **P2** Settings read-modify-write has no cross-writer lock (`settings.ts`).
- **P2** Stale-lock reclaim is stat → rm with no revalidation
  (`filelock.ts:41`).
- **P2** `cmdRouteSubagent` registers before `cmdRoute('on')` and never rolls
  back on throw (`route.ts:1144`).
- **P2** `stop()`/`killRecordedOrphan` SIGTERM LiteLLM and never escalate,
  then delete its temp dir (`serve.ts:1254`, `:234`) — found by two agents.
- **P2** A model-change restart commits the new registry before readiness;
  a replacement that never comes up is never retried (`serve.ts:1004`).
- **P2** Hooks swallow CLI spawn failures (`route-session.mjs:63`,
  `route-subagent.mjs:72`).
- **P2** LiteLLM venv install has no concurrency lock and can discard
  `.previous`.
- **P2** Ledger/session retention runs only at daemon start (`serve.ts:1084`).
- **P3** `startServeDaemon` leaks its log fd; `ensure-serve.mjs` ignores
  `--global`.

### Router
- **P1** A 429 on one codex candidate cools the whole codex gateway (429 is
  provider-scoped), skipping nine ranked candidates at once; the tier then
  reached `opencode-deepseek-v4.1-flash@none`, which answered a real Claude
  Code request with a bare 400 (`{'model': 'deepseek-v4.1-flash'}`) — terminal,
  so two `code-simple` agents died (2026-09-27 11:47Z). The same model, key and
  effort answer 200 to hand-built requests with tools, tool history, thinking
  blocks, streaming and `max_tokens` up to 128k, so the offending shape is not
  yet identified; the router logs no request bodies to find it with.
- **P1** A bare model key on a `direct` gateway always goes to LiteLLM
  (`router.ts:1518`); on a direct-only config nothing listens → 502.
- **P1** Only the first `codex-oauth`/`copilot-oauth` gateway's credential is
  installed (`serve.ts:518-575`).
- **P2** Deferred pricing re-reads the config at stream end
  (`serve.ts:1151`).
- **P2** `conversationKey` collisions share `lastServed`, so a switch can skip
  `stripForeignThinking` — the issue #30 failure.
- **P2** `stickySet` pins on status before the body is consumed
  (`router.ts:1384`).
- **P2** Error-body drains are unbounded in size and time (`drainBody`,
  `bufferBody`) — one upstream can stall the whole fallback chain.
- **P2** The server's catch appends JSON to a started SSE stream; `respond`
  ignores backpressure (`router.ts:1609-1656`).
- **P2** `sessions.json` is written non-atomically and read without the lock.
- **P2** `defaultWaitForLitellm` fetches with no abort (`serve.ts:291`).
- **P3** `noteProject` is FIFO, not LRU (`tenants.ts:105`); router-token
  compare is not constant-time and an existing file's mode is never repaired;
  an unknown `sonata-*` alias falls to LiteLLM instead of the typed 400.

### Dispatch lane
- **P1** Empty `report.md` is trusted, shadows the fallback file, and
  dispatch's empty-report fallback is unreachable (the provenance line is
  always appended first).
- **P1** `spoke` counts the post-run shell prompt as harness output
  (`tail.ts:83-129`), defeating the "nothing ran" guard for read-only runs.
- **P1** A read-only run's report is the last 20 pane lines (`tail.ts:178`).
- **P2** Adapters write the exit sentinel inside `harness.sh`, before the
  wrapper's worktree capture — the capture-before-sentinel invariant is
  inverted.
- **P2** `createRun` precedes steps that throw; a refused plan leaves a
  permanent RUNNING record (`run.ts:159`).
- **P2** A timed-out run discards the report body (`tail.ts:175`).
- **P2** Run ids are unsanitised path segments (`store.ts:14`).
- **P2** Read-only roles on the claude harness can write via allow-listed
  `Bash` (`claude.ts:46`).
- **P2** `sonata log` misses lines that scroll off between polls.
- **P3** `run_timeout_seconds` accepts 0/negative; 3-byte run ids collide;
  watchdog kill order orphans its `sleep`; `truncateReport` overshoots.

### Config and init
- **P2** `[native.ports]` — see top nine (7).
- **P2** Gateway `base_url` collapses last-writer-wins across candidates
  (`init/toml.ts:140`).
- **P2** Any user agent named `native-*` is claimed as sonata's and deleted
  (`detect.ts:237`).
- **P2** `[run]` numbers of the wrong type or sign fall back silently
  (`config.ts:255`) — also found by the dispatch audit.
- **P3** A collapsed agent's body reads "pick , and let the frontmatter…"
  (`sync.ts:507`); model keys enter YAML frontmatter unescaped.

### Credentials and catalog
- **P2** Copilot `access-token` keeps LiteLLM's umask
  (`oauth-login.ts:135`).
- **P2** A `$0` cost per task is admitted, then ranked as unscored in value
  tiers and cheapest in the complex tie-break (`catalog.ts:610`).
- **P2** Nothing detects two gateways sharing a `base_url` (the
  `opencode`/`opencode-go` duplication).
- **P2** Harness-prefix stripping runs before provider-prefix stripping, so
  `opencode-go-` loses to `opencode-` (`catalog.ts:283`).
- **P3** 200-with-garbage reported as unreachable; truncated catalog written
  silently at `AA_MAX_PAGES`; Google host matched by hostname only; version
  probes unbounded; three stale docs (level-less rows record `default`, not
  `none`; `simple` is no longer a prefix of `normal`; `geometryFor` comment).

### Money
- **P1** A claude-harness run decides routed-or-not at finish, not launch
  (`claude.ts:113`) — double or zero count across a config change.
- **P1** A dispatch run crossing a price window is priced at the exit rate
  (`harness-usage.ts:200`).
- **P2** Ledger validation accepts negative costs and tokens and never checks
  cache fields (`ledger.ts:231`).
- **P2** `sonata usage --project <subdir>` selects nothing (`usage.ts:350`).
- **P3** A price window with `from == to` never applies; comments disagree.

### Tests
- `tests/commands/serve.test.ts` flakes under full-suite load because every
  `cmdServe` fires an unawaited, uncancellable models.dev fetch
  (`price-refresh.ts:101`) that lands in whichever test is running.

## Answered questions

- **Why the `opencode` gateway held the Go URL:** the machine's
  `~/.config/opencode/opencode.json` names its Go provider `opencode`;
  detection deliberately lets harness configs override the built-in table,
  and a config's own candidates then win on every re-init, so it perpetuates.
- **"When unsure, use -complex"** in `.claude/agents` is stale; current sync
  does not emit it. `sonata sync` regenerates.
- **`retryWhenServerExits` scope** is adequate: only `new-session` can meet a
  server with no sessions.

## Checked clean

Tier fallback and per-tenant cooldowns; the 529 exhaustion message; body
transforms scoped to the LiteLLM path; `x-sonata-*` header stripping; tenant
resolution order and realpath identity; budget-check placement; SSE usage
accounting; the 0.13.1 session-header change; `resolvePrice` precedence and
`qualifiedMatch`; codex cumulative/cached token maths; UTC day boundaries;
double-record protection; `--by`/`--since` parsing; migrations; the effort
grammar; worktree config borrowing; CLAUDE.md marker handling; reset's
settings edits; `tomlKey`; `tiersCollapse`; the opencode v1/v2 overlay; the
ChatGPT client-id check; `proposeTiers` invariants; the AA cache; `sqlite.ts`;
effort flags; permission-mode mapping for codex, reasonix, pi and opencode;
the watchdog's process-group kill; task text never entering a shell.
