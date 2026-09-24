# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/) informally
(pre-1.0, so minor bumps can carry breaking changes).

## [Unreleased]

### Fixed

- **An OpenCode Zen gateway now lists its models.** Its base URL was
  `https://api.opencode.ai/v1`, which answers `/models` with a 200 plain-text
  "Not Found", so adding Zen fetched nothing while OpenCode Go (on
  `opencode.ai/zen/go/v1`) listed fine. It is now `https://opencode.ai/zen/v1`.

## [0.12.1] - 2026-09-23

### Added

- **`sonata usage` opens in the shell.** In a terminal it now shows a live
  usage screen, also reachable from the menu or with `u`. Keys change the
  view in place: `d` cycles the breakdown (model, role, tier, effort,
  gateway, session, project), `w` the window (1h, 24h, 7d, 30d), and `g`
  switches between every project and this one. Unpriced, covered and
  no-prompt-count volume stay beside the total, as in the printed report.
  `--json`, `--session`, `--project <other path>` and any non-terminal
  caller still get the printed report.

### Fixed

- **New models were filtered out of `simple` and `normal`.** Artificial
  Analysis scores a new model on intelligence before publishing coding and
  agentic scores. Sonata stored that intelligence score as a coding score and
  judged it against a coding-scale threshold, so `gpt-6-luna` and `gpt-6-sol`
  failed and were left unranked. A missing coding score is now treated as
  unknown instead.
- **Every tier ranks on intelligence.** The value tiers ranked on agentic
  scores, which new models don't have yet (14 of 36 candidates on one real
  config), so old and new models were compared on different scales. That made
  `glm-5.3-flash` the `normal` knee although `mimo-v2.6-pro` beats it on both
  intelligence and price. `normal` now leads with `mimo-v2.6-pro`.
- **Value ranking no longer floors prices at one cent.** Per-task costs below
  $0.01 were all treated as $0.01, which hid a 2.2x price difference between
  `gpt-6-luna@low` and `gpt-5.6-luna@low`. The cheaper one now leads `simple`.
- **The capable threshold is removed.** Models with an Artificial Analysis
  coding score under 40 were left out of every tier. The threshold checked a
  score no tier ranks by and couldn't judge new models, which don't have a
  coding score yet. Weak models now stay in the lists as fallbacks, and the
  ranking places them below the models that beat them.
- **`sonata init` asks for `/reload-plugins` only when an agent file changed.**
  A new ranking never changes an agent file: each agent names only its routed
  alias, and the router reads the ranked list from `sonata.toml` on every
  request. When `init` creates the agents directory, it asks for a Claude Code
  restart instead: a running session doesn't watch a directory created after
  it started.
- **A model without an intelligence score ranks below every model with one.**
  Its agentic or coding score used to be plotted on the intelligence axis. It
  stays in the tier as a fallback.
- **A malformed score in the cached catalog is dropped, not kept.** A row
  with one valid score kept its other scores unchecked, and a non-number one
  could crash a ranking label.

## [0.12.0] - 2026-09-23

### Added

- **One terminal UI, reached from every command that has a screen.** Bare
  `sonata` opens it; `sonata status`, `sonata agents` and `sonata init` open
  it on their own screen. Arrow keys move a menu, Enter opens, Esc goes back
  one level, `q` quits. Each command keeps its plain printed output whenever
  stdout or stdin is not a terminal, and for the flags a screen cannot honour
  (`sonata status --session/--all`, `sonata agents --json/--list`, any
  scripting flag to `sonata init`).
- **The overview shows only what is wrong.** Passing doctor checks are not
  listed; `sonata doctor` still prints every check.
- **Light and dark themes, toggled with `Ctrl-T`.** Each theme paints its own
  background and names its own text colour, so light mode works on a dark
  terminal. The palette and the selection highlight — an orange edge over a
  band — match claude-swap's. `SONATA_THEME=light|dark` sets the starting
  theme.
- **`sonata init` runs inside the shell.** Discovery reports each harness as
  its probe finishes rather than sitting on one line, and a cancelled run
  says "cancelled — nothing written".
- **`sonata status` is live, and scoped to this project.** It polls every
  two seconds and shows each route's local time, model and effort level
  (`gpt-5.6-terra@max`), and the gateway that served it. By default it shows
  only the project the command is run in — resolved as the router resolves a
  tenant, so a worktree sees its checkout's rows — and `--global` (or `g` on
  the screen) shows every project. `--session` / `--all` still select along
  the session axis, within the project.
- **The ranking board labels its columns**, including which metric the bar
  measures: `intelligence` on `complex` lists, `agentic` on `simple` and
  `normal`. Rows the catalog shows are beaten on both cost and capability are
  marked `standby` and struck through; rows you simply left unranked are
  marked `held`.
- **Every screen fits any terminal size and redraws on resize.** Lines are
  cut short with `…` rather than wrapping, lists scroll with `↑`/`↓ N more`,
  and quitting restores the shell exactly as it was.

### Changed

- **Tiers are derived from the price-performance frontier.** For each tier,
  on the metric it ranks by, sonata finds the models no other model beats on
  both cost per task and capability, and the *knee* of that frontier — the
  point where more capability stops being cheap, found on a log-cost scale
  and reproducing Artificial Analysis's own chart. `simple` leads with the
  cheapest (under the existing 12x cost cap), `normal` leads with the knee,
  and `complex` leads with the strongest. A top rung whose extra capability
  costs far more than it returns is moved to the end of the list — measured,
  `gpt-6-astra@max` buys +0.3 index points for 41% more than `@xhigh` — and
  every model stays in its list as a fallback. This replaces ranking the
  value tiers purely by capability per dollar, which could never pick the
  knee: it ranked 12th of 129 by that ratio.
- **Every action on the Actions screen runs**, including installing LiteLLM
  and routing the project, with a progress line instead of a refusal.

### Fixed

- **An account-level refusal cools the whole gateway, not just one candidate.**
  A rejected credential (401/403) or an exhausted billing cap (402) cannot be
  model-specific, so discovering it once per model is pure waste: measured
  2026-09-21, one project has 5 of its 11 native models on `anexto`, and an
  exhausted anexto budget cost five separate 402 refusals per dispatch — each
  a round trip to be told the same thing about the same account. The first
  refusal now cools the gateway and its remaining models are skipped.

  Skipped *without* cooling those models: they have done nothing wrong, and
  recording a failure against them would make an account problem look like a
  broken model for a minute after the account recovered. Everything else,
  including the capability-400 fingerprints, keeps the old per-candidate
  scope — a 500 says nothing about the account, so a sibling on the same
  gateway is still worth trying.

  429 is the one member of that set resting on inference rather than
  evidence: a gateway may rate-limit per key or per model and sonata has
  probed neither. It is included because the error is bounded by the 60s
  cooldown and asymmetric in the direction chosen — treating a per-model
  limit as provider-wide skips healthy siblings for a minute, while the
  reverse pays a refusal per model on every request until it lifts.

  The 529 exhaustion message names any gateway skipped this way. Without it a
  tier whose candidates all sit on one cooled gateway reports "all native
  routes failed" with no attempt recorded against them, which reads as a tier
  with no candidates rather than one waiting out an account problem.

### Fixed

- **A model Artificial Analysis states no effort level for is no longer
  recorded as "reasoning off".** `parseAaEffort` already told the two apart —
  returning `none` only for an explicit `Non-Reasoning` — and the catalog then
  coerced `undefined` to `none`, throwing the distinction away. Measured on a
  real catalog: **235 of 315 families** were `none` on that coercion alone,
  among them `claude-4-5-sonnet-thinking`, `claude-4-5-haiku-reasoning` and
  `gemini-2-5-pro` — models ranked on a reasoning score and then sent
  `reasoning_effort: none`, which is exactly the mismatch the `@<effort>`
  grammar exists to prevent. Most degraded silently. `glm-5.3-flash` failed
  loudly, its endpoint answering `Reasoning is mandatory for this endpoint and
  cannot be disabled` to every request, so all 24 of its ranked entries 400d
  unconditionally.

  Such a row is now recorded `@default` — send no `reasoning_effort` at all,
  which is both what AA measured and what "as it ships" means. It stays a
  family of one and is still never offered bare, so a candidate continues to
  name the level it will run at. After refreshing, the same catalog reports
  225 `default` against 73 genuinely `none`.

  `default` is deliberately **not** sent as the literal string, although
  LiteLLM's own signature accepts one: the `direct` transport bypasses LiteLLM
  and posts to an Anthropic-native gateway that has no `reasoning_effort`
  field at all, so omitting is the only behaviour correct on both transports.
  `wireEffort` is the single definition the router and all four adapters share
  — codex passes no `-c model_reasoning_effort`, opencode no `--variant`, pi
  no `--thinking` (distinct from `none`, which maps to pi's `off` and actively
  disables thinking).
- **A fourth capability-400 signature: `Reasoning is mandatory`.** The safety
  net for configs already written with `@none`, which stay that way until
  their owner re-proposes tiers. A true capability failure by the definition
  the list uses: the request is well-formed and the next candidate serves it.
- **`sonata doctor` reports both halves.** `effort freshness` names tier
  entries pinned `@none` that the catalog states no level for, and only on a
  positive catalog statement — an unscored model says nothing, and a model
  that genuinely has a `none` variant is correctly pinned. `effort levels`
  additionally detects a catalog cache written before the split, since the fix
  is otherwise invisible until `sonata catalog update` runs; the test is
  airtight rather than heuristic, because `default` is a new enum member
  nothing could have written before.

- **The bare-candidate refusal now covers the `normal` tier.** It iterated
  `simple` and `complex` only: `normal` was added after the refusal and the
  loop was never widened, so a bare key there alone slipped past the very
  check that stops a candidate ranking on one row's score and then running at
  whatever the gateway defaults to. Same "two eras in one config" shape as the
  inverted tier split in 0.11.0.

- **`schema_version` bumps to 2, because `@default` is a forward-breaking
  config value.** A config carrying it is unloadable by any sonata predating
  it, and unstamped that failure reads `unknown effort level "default" — one
  of none, minimal, …`: it blames the value, names no remedy, and takes down
  the **whole** config, so every tier in the project dies rather than the one
  rung. Measured 2026-09-21 after a config was hand-edited to `@default`
  while the router still ran pre-`@default` code. Stamped v2 the same file
  refuses with `schema_version is 2, but this sonata understands up to 1 —
  upgrade sonata`, which is true and actionable; that refusal already ships in
  0.11.2, so the bump reaches installs in the wild. No transform is needed in
  either direction — a v1 file cannot contain the value.
- `sonata doctor` no longer suggests hand-editing to `@default` without
  saying what it costs: the entry needs this sonata version everywhere the
  config is read, **including a router still running older code**, so the
  advice now leads with `--repropose-tiers` (which stamps the file) and names
  `sonata restart`.

### Changed

- **`complex` ranks on the intelligence index, not the agentic one.** It is
  the one tier defined by judgement — "needs a design decision affecting other
  components, or is ambiguous about what done means" — and the agentic index
  measures driving tools in a loop, which every tier does equally. The two
  disagree materially: over one project's 22 complex candidates,
  `glm-5.3-flash` (50.9), `gpt-5.6-sol@max` (50.2) and `gpt-6-astra@max`
  (51.0) all sat inside the 1.0 tie margin on agentic, so the tie-break
  decided the top of the tier — and the tie-break is cost, in the one tier
  deliberately left cost-uncapped, so the cheapest led. On intelligence the
  same three are 41.8 / 47.0 / 52.7. `simple` and `normal` keep the agentic
  index: they are value tiers, and throughput is the right numerator there.
- **The capability tolerance is applied as a class, not pairwise.** "Within
  the margin" cannot be asked pairwise: tolerance is not transitive. With
  scores 52.1, 51.5 and 51.0 the first two tie and so do the last two, but
  52.1 and 51.0 are 1.1 apart and rank outright; prices running the other way
  close the loop. Measured on exactly that fixture — six input permutations
  produced **three different orderings** of the same three candidates, so the
  tier a user got depended on the order their models happened to be declared
  in. Quantising to a `capabilityClass` first makes the comparison an integer
  equality, which cannot cycle. The cost is a boundary: two scores either side
  of a class edge are separated even when closer together than the margin —
  the standard trade for bucketing, and the safe direction, since it can only
  rank by capability where the old code ranked by price.

  The band is applied as a scalar per candidate rather than as a special case
  inside the comparator. The first implementation did the latter and was not
  transitive — it produced a real 3-cycle
  (`deepseek > luna@xhigh > luna@max > deepseek`), which makes the sort depend
  on input order, so the tier differed run to run. A test now asserts the
  ranking is identical under shuffled input.
- `EFFORT_LEVELS` gains `default`, the one member that is not wire vocabulary.

### Fixed

- **The router retries every candidate-specific status, instead of an
  allow-list.** The set was `{5xx, 429, 401, 403}`, which was wrong in one
  direction only: every status nobody had enumerated counted as fatal, so a
  failure specific to ONE candidate took down a tier that existed precisely to
  survive it. Measured on two machines — a tier of 42 candidates stopped dead
  on its first because anexto answered `Budget exceeded: 200.0409 >= 200.0000`
  (402), while the codex and openrouter candidates behind it had their own
  accounts, their own caps, and were never tried. It is now a deny-list:
  everything `>= 400` retries except `TERMINAL_STATUSES` =
  `{400, 405, 415, 422}`, which
  describe the *request* and would be rejected identically everywhere. That
  also picks up 404 "model not found", 408, 413 "payload too large" and 451,
  each terminal before now for no reason but omission. Keeping 400/422
  terminal is deliberate: retrying a malformed request discards the error body
  naming the offending field, answers a generic 529, and cools every candidate
  in the tier — so concurrent agents that were fine start failing too. A 400
  that *is* candidate-specific still falls through via the capability
  fingerprints, on captured evidence only. 413 is deliberately *not* terminal
  although it looks like a sibling: "payload too large" is a limit that
  differs per model, and the next candidate may have a larger context window
  and serve the identical request.
- **`sonata restart` refuses to signal a recorded pid that does not own the
  port.** `isSonataRouter` proves a sonata router answers, not that the
  recorded pid is the one answering — a record outlives a daemon that died
  hard, and the OS reuses pid numbers. With the SIGKILL escalation above that
  went from "a signal a stranger can ignore" to "a process that dies". Refused
  only on positive evidence of a mismatch: `findPortPid` answers undefined for
  every failure and ambiguity, and treating "cannot tell" as "mismatch" would
  refuse every restart on a machine without `lsof`.
- **A third capability-400 signature: `No tool output found for function
  call`.** The Codex backend's answer when the Responses `input` holds a
  `function_call` with no matching `function_call_output` — the pairing is lost
  inside LiteLLM's translation. Captured across four serve logs: 28
  occurrences over 12 distinct `call_id`s, every one on the codex-oauth
  gateway and never on an api-key gateway serving the same tiers. It is
  self-sustaining, since the failing turn never completes and the next turn
  re-sends the same transcript, so it wedges a conversation until the agent
  dies. Two did.
- **`serve` no longer orphans a SIGTERM-deaf litellm.** One expired ChatGPT
  refresh token is enough to start the pile: LiteLLM answers a 401 refresh by
  falling back to an *interactive* device-code login and blocking in its
  15-minute poll, so uvicorn never binds and the prompt is printed into a
  daemon log nobody reads — and such a child ignores SIGTERM throughout. Six
  orphans were found on one machine, oldest six hours, none holding the port
  it was started for, each making the next `sonata restart` look like it had
  failed too. `stopServe` now escalates to SIGKILL and says so when even that
  fails; the failed-startup path escalates through the same idiom the
  model-registry restart already used, instead of sending SIGTERM and then
  deleting the child's config out from under it.
- **The litellm startup-timeout message names the real cause.** It described
  only "failed to bind (another litellm running?)", the rarer case, sending
  the reader to `lsof`. It now names the expired-credential case first, quotes
  the log lines to look for, and gives the remedy (`sonata auth login
  <gateway>`, or `codex login` for `credential_source = "codex"`).
- **`sonata doctor` checks the litellm port, not just the router.** It
  reported `ok  serve health: up · 4 project(s)` while nothing was listening
  on the litellm port and every dispatch was failing 502. The probe is bounded
  at 3s, because the failure has a variant that accepts the connection and
  never answers — an unbounded fetch hangs `doctor` on the very fault it
  diagnoses.

### Changed

- `npm run typecheck` now type-checks the test suite too. `typecheck:tests`
  existed but was excluded, so CI never ran it and the error count could only
  grow; the last 17 are fixed and the two are folded into one command.
- The three timeout-bound e2e tests moved to their own file. They were ~10.7s
  of a ~21.4s file and every second is a deliberate wait for a configured
  timeout to expire, so the only lever is running them beside the rest — a
  file boundary, since vitest parallelises files. Suite wall time 25.4s →
  18.8s, measured over five runs each.

## [0.11.2] - 2026-09-20

### Fixed

- `sonata init`'s Add provider flow can now reach ChatGPT OAuth. Every BYOK
  row was routed straight to key entry, so a provider offered without a
  harness — which is every provider on a machine with none installed — could
  only ever be an API key. The capability was already there and already
  worked: sonata's `CHATGPT_CLIENT_ID` is the same OAuth app opencode uses,
  and the device flow runs standalone from sonata's own LiteLLM venv with no
  codex CLI and no opencode present. Only the route to it was missing.
  `PROVIDER_OAUTH_AUTHS` now records which providers *can* authenticate by
  OAuth, kept deliberately separate from `oauthProvidersFor`, which answers
  the different question of which credentials already *exist*. Completing the
  login then offers that gateway's models from the models.dev catalogue sonata
  already caches — the same source opencode builds its own catalogue from —
  since an OAuth gateway has no bearer key and its endpoint is not
  OpenAI-shaped, so the live `/models` refresh skips it and the credential
  would otherwise be recorded with no model to use it. Reserved `claude-` ids
  are filtered out, because the router sends that prefix to Anthropic and
  `parseConfig` refuses them; a cache that knows nothing about the provider
  falls back to entering ids by hand rather than an empty picker.
- A BYOK gateway chosen as OAuth no longer takes a metered `base_url`. The
  well-known URL for `openai`/`codex` is `api.openai.com`, which a ChatGPT
  subscription reaches only to be refused with `insufficient_quota` after
  passing auth — a failure that reads as a missing key. The URL is still
  correct for a real API key, so it is the OAuth case that now resolves to
  its own implied endpoint rather than the entry being removed.
- `sonata auth login` no longer ignores sonata's own LiteLLM venv. It
  resolved the interpreter with `command -v litellm`, so on a machine with no
  pip-installed litellm the login failed with `pip install 'litellm[proxy]'`
  even though `sonata litellm install` had already provisioned the managed
  venv. It now prefers the managed path and names the right command.

## [0.11.1] - 2026-09-20

### Fixed

- `sonata init` no longer refuses to run on a machine with no harness
  installed. `detectOpenCode` reported an absent opencode as an `error` — a
  leftover from when opencode was the only harness, and the one blocking
  problem in the preflight on such a machine, so the BYOK path that exists
  precisely for it could never be reached. It is now reported the way pi,
  codex and reasonix already report their own absence: not as a problem, with
  the per-harness status line and the existing "no harness reported a usable
  model provider" warning carrying the news.

### Changed

- Bumped vitest to 4.x, clearing seven Dependabot advisories (one critical,
  one high, five moderate) against vitest, vite and esbuild. All were
  dev-only — sonata's runtime dependencies are unaffected and nothing shipped
  in the published tarball ever carried them. `restoreAllMocks` no longer
  resets `vi.fn()` module mocks in vitest 3+, so `tests/cli-status.test.ts`
  clears mock history explicitly.

## [0.11.0] - 2026-09-19

### Added

- The config TUI gains Models, Providers, Tiers, Keys and Actions screens
  beside the health overview. **Models** names configured models that sit in no
  tier and so are unreachable by any alias; **Providers** shows which gateway is
  reached directly and which goes through LiteLLM, and names gateways serving
  no models; **Tiers** is the `sonata agents` ranking editor, writing through
  the same `writeTiers` rather than a second copy of it; **Keys** is read-only
  by design and shows only which gateway has a credential and where it comes
  from, never a value; **Actions** runs `sync` and `catalog update` and names
  the two it deliberately does not run — a multi-minute `litellm install` is
  indistinguishable from a hang inside a TUI, and `route auto` edits settings
  that screen does not own.
- `sonata doctor` reports agent files generated by an older sonata. A fix to a
  generated agent prompt only reaches a project when `sonata sync` runs *there*,
  and nothing said so: the existing check compares filenames, so an agent that
  keeps its name and carries an old body was invisible. Measured — a project
  whose agents predated the fan-out bounds went on running the unbounded
  `review-complex` that had spawned eight children and exhausted a $200 budget.

- `sonata usage` reports completed streams that produced output but no prompt
  tokens, beside the total rather than inside it. Measured on a real ledger,
  226 requests over 7 days were priced on their output alone because the prompt
  count never arrived — `openrouter-z-ai-glm-5.3-flash` on 77 of 77 completed
  streams, though OpenRouter's own API returns `prompt_tokens` for that model
  in a plain stream. Sonata cannot invent the count, but it can decline to
  present the result as complete: the same rule unpriced volume already
  follows, and it matters because `[budget]` counts priced spend.
- `sonata tui` — a persistent config TUI, which a bare `sonata` also opens on a
  terminal. It boots into a health check, shows `doctor`'s findings as its home
  screen so a problem is opened rather than looked up, and edits
  `[budget] daily_usd`. Without a TTY on **both** stdin and stdout, `sonata`
  prints help and exits 2 exactly as before — Ink's `useInput` needs raw mode
  on stdin, so `sonata < /dev/null` from a terminal would otherwise crash
  instead of printing help. Writes go through targeted block replacement and
  are parsed before they are written, so nothing outside the edited table moves.

- `sonata init --repropose-tiers` discards saved `[tiers]` rankings and
  re-ranks from the catalog. A saved list is otherwise sticky forever, so a
  tier written before the catalog changed could never be re-proposed.
  Stickiness stays the default, because a hand-tuned ranking surviving an
  ordinary `init` is the property it exists to provide.
- `sonata doctor` reports a `simple` tier holding candidates the cost cap would
  now exclude, naming them and `--repropose-tiers`. Measured on a real config:
  `simple` led with a candidate 4.5x dearer per task than `normal`'s leader and
  reached one 34x dearer by rank 4 — the tier split inverted, with the cheap
  tier the expensive one, and nothing reporting it. `simple` and `complex`
  predated the current catalog and were sticky; `normal`, added later, had been
  seeded from a fresh proposal, so the lists were computed in different eras.

### Fixed

- `sonata doctor` no longer spawns `claude --version` on every run, which cost
  ~0.7s each time. It is now injected, which also took this command's own test
  file from 17.1s to 8.7s and the suite from 34.4s to 29.9s.
- `sonata doctor` no longer dies of a file it cannot read. A single unreadable
  agent file made it reject outright, losing its other twenty checks — and
  doctor is the command you run *when* the filesystem is in an odd state. Both
  read paths now report what they cannot read as an ordinary failing check.

- OpenRouter routes through LiteLLM's own `openrouter` provider instead of the
  generic `openai` fallback. `PROVIDER_FOR_GATEWAY` never named it, so a known
  vendor with a first-class LiteLLM provider reached the fallback its own
  comment reserves for the unknown.
- `sonata doctor` names a Claude Code build known to be broken with sonata,
  rather than reporting it as inside the tested range. 2.1.275 failed **every**
  request with a 400 naming `Input tag 'advisor_20260301'` whenever
  `ANTHROPIC_BASE_URL` pointed at a proxy — which is exactly how the native
  path works — and was fixed in 2.1.276. A blocklist rather than a version
  bound, because `<2.1.275` would also reject the build carrying the fix, and
  because a bound can only say "outside tested range" while the reason is what
  a reader needs. The *client* is checked separately from the harnesses: the
  harness loop covers `claude` only when the config names it as a harness,
  while every native dispatch runs inside whatever Claude Code is already
  running.

- `sonata init` no longer deletes a hand-added `[budget] daily_usd`.
  `nativeTomlFor` preserved `[run]`, `pricing_provider` and `[price]` but had
  no budget parameter at all, so a cap survived only until the next rewrite.
  Its loss was invisible by construction: a cap's only effect is a refusal that
  has not happened yet, so a deleted one reads exactly like a working one.

- Tier-agent fan-out is now bounded by a strict tier descent: `complex` may
  delegate to `normal` and `simple`, `normal` to `simple`, and `simple` to
  nothing. A collapsed agent (all of a role's tiers identical) is a leaf, since
  every tier resolves to the same ranked models. Previously the only bound was
  "keep fan-out proportionate", and a `review-complex` given a nine-item list
  judged that splitting it was proportionate: it spawned 8 further
  `review-complex` agents plus 4 `claude` ones, whose children spawned again,
  and the tree's leaves exhausted a $200 gateway budget. A descent terminates
  by construction and every hop is cheaper than the one above it.
- Fan-out width is capped alongside depth: an agent may spawn at most 3
  subagents across its whole run. The descent alone still permitted 12 siblings
  from one node, which is what the measured `review-complex` did.
- `review-*` agents are told to narrow scope rather than grow to fill the
  request, to name what they did not cover, and to answer `grep`-shaped
  questions themselves instead of delegating them.
- The managed `CLAUDE.md` block now names its audience. It is injected into
  every subagent, and its fan-out paragraph read from inside one as standing
  permission to spawn more — the reviewer above had followed it correctly.
- A saved `[tiers]` list now absorbs new reasoning-effort variants of models it
  already holds. When the `<key>@<effort>` grammar shipped, every model gained
  `@low`/`@max`/etc. candidates — new candidate *keys* but not new *models* —
  so nothing re-selected them and `reconcileTierList` had no way to merge them.
  A tier written before that feature could never gain them. Measured on a real
  machine config: `simple` and `complex` predated the grammar and held 11 and
  12 entries over 5 and 6 models, while `normal`, added later and seeded from a
  fresh proposal, held 44 over 12 — `complex` has no cost cap and should be the
  largest list, yet was the smallest. A variant qualifies only when its bare key
  is already kept, so a model deliberately removed from a tier stays removed.
- **`scripts/pr-status.mjs` reads the verdict where it actually is.** It parsed
  only issue comments, and CodeRabbit's authoritative count —
  `**Actionable comments posted: N**` — lives in a *review* body, so every PR
  reported "no recognisable verdict — findings outstanding", clean ones
  included. A guard that always cries wolf stops being read. It now reconciles
  that count against unresolved threads (N findings all resolved is clean), and
  surfaces failed pre-merge checks from the walkthrough, which have no thread to
  resolve and were previously invisible — the docstring-coverage warning on #46
  is the case in point. The star-threshold notice is checked *after* the
  actionable count, because the walkthrough carries it even on a PR that was
  reviewed.

- **The router UI's run cache is bounded and no longer shared by reference**
  (#41). `MAX_RUN_ROWS` caps a response, so the unfiltered list it filtered from
  had no ceiling: every run across up to 200 projects, held in the process that
  proxies every native agent's requests. It is now capped per discovery key —
  never per filter, which would make a quiet project's filter show the newest N
  globally — and each caller gets its own array, so a future caller sorting in
  place cannot corrupt the cache and leak one project's rows under another's
  filter.

### Changed

- The bundled `sonata-loop` skill records three rules, each from a measured
  failure: an agent that is stuck should hand back with the question rather
  than guess, since resuming it costs one round trip while guessing burns a
  whole dispatch; the orchestrator decides the fix before dispatching it, which
  drops the tier because difficulty is how much has to be decided; and the
  final review gate stays on a foreign model, with the orchestrator writing its
  brief rather than substituting for it.


## [0.10.0] - 2026-09-16

### Added
- **A third tier, `normal`, ranked by capability per task-dollar.**
  `[tiers.<role>]` accepts an optional `normal` list beside `simple` and
  `complex`, and each tier is now one pure sort key: `complex` by capability,
  `normal` by value, `simple` by that same value ranking under a cost cap of
  12x the best-value model's own cost-per-task — making `simple` a cost-capped
  subsequence of `normal` that can never be empty. `SIMPLE_CAPABILITY_FLOOR` is
  removed: flooring the value tier produced a list byte-identical to the cheap
  tier. **Nothing migrates** — `normal` is optional, so an existing config
  parses, generates the same agents and routes exactly as before, with no
  `schema_version` bump; you gain the tier by re-running `sonata init`.

- **Generated agents say how to choose a tier, and no longer say to default
  upward.** Measured over 30 days of one machine's ledger, `complex` took 74%
  of tiered requests and 80% of priced spend, caused by sonata's own "when
  unsure, use `-complex`" in every agent description. `-normal` is now the
  default, each tier carries an observable criterion rather than an adjective,
  and the agents state that size is not difficulty. The `sonata-loop` skill
  escalates `simple` → `normal` → `complex` and stops after two failures at
  `complex`, which is what makes starting at a lower tier cheap to correct.

- **A local build reports `0.9.1+dev.<yyyymmdd-hhmmss>`.** `npm run build` now
  stamps `dist/build-info.json` with the build time, the commit, and whether the
  worktree was dirty, and `sonata --version` reports it. A development install's
  manifest version is whatever the last release set, so every clone at every
  commit claimed the same number — and `sonata` on PATH runs `dist/`, not
  `src/`, which is how a fix lands and appears not to. The stamp never touches
  `package.json`, is skipped on CI, and is excluded from the published tarball
  (CI fails the pack check if one appears). The stamp is semver build metadata,
  after a `+`: the first form used `-dev-`, a prerelease, which sorts *below*
  its own release — so a build made from newer code announced itself as older,
  backwards on the one question the stamp exists to answer.

- A local web UI on the router at `http://localhost:4100/`, served by
  every `sonata serve`. Lists routed sessions and `sonata dispatch` runs in one
  list with their logs, and a usage dashboard by model, role, tier, effort,
  gateway, session or project — all filterable by project and session. It is
  read-only, loopback-only and GET-only, and computes no figure of its own: the
  numbers come from the same functions `sonata usage` and `sonata status` use,
  so the page cannot disagree with the CLI or with `[budget] daily_usd`. A
  dispatch run's usage reads "not observable" rather than `0`, because such a
  run never transits the router. The page is served at `/` as well as the
  original `/__sonata/`; the JSON API stays under `/__sonata/api/`. Nothing
  else about the proxy changes — a bare `POST /` is not intercepted. Every
  read the UI makes is asynchronous and bounded (day files outside the queried
  window are never opened, run reports are never read to test their presence,
  and a transcript's tail is read through a file handle rather than loading the
  whole file), because the router is on the request path of every native
  agent.

### Changed
- **Every generated agent says not to pass a `model` argument, and the managed
  `CLAUDE.md` block says it to the caller.** The Agent tool's `model` parameter
  takes precedence over an agent's frontmatter, so passing one runs sonata's
  prompt and tools on a Claude model that never reaches the router — silently.
  Reported after ~15 dispatches had already run that way, where every
  "foreign-model review" was Claude reviewing Claude. The warning is in each
  agent's `description` as well as its body, because the description is what
  the dispatching model reads while the body arrives only after the override
  has taken effect (#42).

- **Every generated agent now carries a fan-out rule, not just read-only ones.**
  A tier agent that delegates to Claude's own `Plan`, `Explore` or
  `general-purpose` ends the foreign-model lane silently — the subagent runs and
  reports and looks exactly like a routed one. The old `## Delegating` guard sat
  only on read-only roles, so `code-*`, the agents most able to fan out, were
  told nothing; one called `Plan` (Opus) in practice. The rule names the tier
  agent to reach for instead (`plan-complex`, not `Plan`).

- **`sonata init` ranks only AA models with a published cost per task.** Per-token
  blended prices and dollars per task are incomparable, so uncosted models are
  no longer offered or ranked by the wizard. The picker names excluded models
  and explains that they remain valid hand additions to `sonata.toml`; the
  router, config parser, sync, and dispatch continue to accept them. `sonata
  doctor` now reports configured hand-held models that the wizard would not
  offer, and `sonata agents` preserves them on a no-op edit.

### Fixed
- Preserve the recorded `routerPid` when LiteLLM orphan cleanup runs. Lazy
  startup and a losing `sonata serve` instance could otherwise remove the
  router's state record, leaving `sonata restart` unable to stop the daemon;
  startup cleanup now runs only after the router wins its port bind, and
  `stopServe` already refuses before killing an unpaired LiteLLM pid.

## [0.9.1] - 2026-09-14

### Added
- **`sonata doctor` names a `pricing_provider` id models.dev does not
  publish.** The setting's only visible effect is a price that *appears*, so
  an id matching nothing is invisible: the gateway reads as configured, every
  model on it still resolves to `source: none`, and the "gateway prices
  nothing" warning has already been silenced by the key's presence. Measured
  on three real configs — `"tencent"` is not a models.dev provider id (it
  files `tencent-tokenhub`), so those gateways' Tencent models were unpriced
  despite being asked for, and `[budget] daily_usd` did not bound them.
  Checked in `doctor` rather than `parseConfig`, which is pure
  text-in/config-out and has no cache to compare against; with no cache the
  check is skipped rather than guessed.

### Changed
- **Value is measured per task, never across units.** The simple tier's sort
  divided capability by whichever cost a row carried: `costPerTask` (dollars
  per unit of work) where AA costed the model, the per-1M blend (dollars per
  token) where it did not — two orders of magnitude apart. Measured,
  `deepseek-v4-flash@none` (18.9 at $0.12/1M) out-valued `deepseek-flash@max`
  (39.5 at $0.265/task) on a unit error. Every per-task-costed row now ranks
  ahead of every uncosted one, and the ratio is only taken within a unit; the
  complex tier's cost tie-break is likewise void across units. Admission
  already compared per-task costs only — this is the sort catching up. A
  catalog with no per-task costs at all ranks exactly as before.
- **Every catalog row is offered at a level; a row stating none is `@none`.**
  AA's only DeepSeek V4.1 Flash row is "(Reasoning, Max Effort)"; the wizard and
  `sonata agents` offered the bare key, which ranked on the max-effort score
  and ran at whatever the gateway defaulted to — the exact mismatch the
  `@<effort>` grammar exists to prevent, and one it had been drawing the line
  at "two or more levels" to avoid. A single-row family is now a family: the
  key is offered as `@max` (or whichever level the row states), a hand-pinned
  level scores, and a bare key is refused at load like any other family's —
  `sonata init` re-proposes it. A row whose name carries **no** level
  parenthetical was scored with no reasoning level in play, so it is recorded
  at `none` and offered as `@none` for the same reason: offered bare it would
  rank on that score and then run at whatever the gateway defaults to. Every
  tiered candidate therefore now names the level it was ranked at, and an
  existing config's bare keys are refused until `sonata init` re-ranks them.

## [0.9.0] - 2026-09-14

### Fixed
- **A vendor's versionless alias ranks.** DeepSeek's API serves V4.1 Flash as
  `deepseek-flash`, and no shortening of that spelling reaches Artificial
  Analysis's versioned `deepseek-v4-1-flash`, so a BYOK DeepSeek gateway
  ranked it from the unscored default. models.dev names each provider's own
  slug (`deepseek-flash` → "DeepSeek V4.1 Flash"), so `sonata catalog update`
  now caches that name and every ranking lookup — the wizard, `sonata
  agents`, `sonata doctor`'s coverage check and `loadConfig`'s effort check —
  offers it as a second spelling after the id. The id always wins when it
  scores, and the name is consulted only under the providers the gateway
  prices by (`pricing_provider`, else the proposal its name earns), because
  the same slug means a different model under a different reseller.
- **A gateway named after its vendor scores its models.** `normalizeModelName`
  strips configured gateway names off a *key*, but every ranking caller hands
  it the bare *id* — and a vendor's model names begin with the vendor, so a
  gateway called `deepseek` had `deepseek-` eaten off `deepseek-v4-pro` and AA
  asked about `v4-pro`. Measured: every model on such a gateway ranked from the
  unscored default and lost its effort variants. Each spelling is now offered
  stripped, then as-is; a lookup that was already right is unchanged.
- **At equal capability and price, the higher effort level ranks first.**
  Adjacent levels of one model sit inside the capability tie margin and, when
  AA has not costed the row per task, share one per-1M price — so the sort
  had nothing left to order them by and kept weakest-first, ranking
  `gemini-3.7-flash@low` above `@medium`. A level exists to think harder; at
  equal cost it now leads, in both tiers. A real capability edge or a cheaper
  price still wins over it.
- **`npm test` runs on a fresh clone again.** `.gitignore` said
  `node_modules/`, whose trailing slash matches only a directory, so a symlink
  of that name was committed (#33) pointing at one machine's absolute path.
- **`sonata route auto` routes again, and still keeps Remote Control.** Each
  session now writes the routing env at `SessionStart` and schedules a settle
  that takes it back out a few seconds later, so the session routes from its
  first request while the *next* session still launches into a clean file.
  Routing at `SubagentStart` had stopped working: the subagent that fires that
  hook has already resolved its endpoint, so it reached `api.anthropic.com` and
  died with `model_not_found` — which reads as a broken agent rather than
  unrouted plumbing. The `SubagentStart`/`SubagentStop` pair is kept as a repair
  path, since the value a session holds is long-lived but not proven permanent.
- **A collapsed tier agent can route at all.** `SONATA_AGENT_MATCHER` required a
  trailing hyphen, so a role whose `simple` and `complex` lists are element-wise
  identical — generated as one agent named for the role alone, e.g. `explore` —
  matched nothing, fired no hook, and died at Anthropic. The matcher now ends
  `(-|$)`; Claude Code's own `Explore`/`Plan` are still excluded by case, and a
  longer name like `planner` by the boundary.

### Added
- **Effort-level tier candidates** (`"gpt-5.6-luna@xhigh"`). `sonata catalog
  update` now records which reasoning-effort level each Artificial Analysis
  row was scored at, `sonata init` and `sonata agents` rank every scored
  level of a model as its own candidate, and `[tiers]` lists may pin one.
  Measured on the current catalog, GPT-5.6 Luna at `max` out-scores GPT-5.6
  Terra at every level below `max` at an eighth of the cost per task —
  a comparison the ranking could not previously express.
- **A pinned level now reaches the model, on both lanes.** On the native path
  the router sets top-level `reasoning_effort` per candidate and deletes
  `thinking` / `output_config.effort` on that request — LiteLLM translates
  Claude Code's `thinking: {type: "adaptive"}` into `reasoning_effort: medium`,
  so leaving both in is how an explicit `xhigh` was silently overwritten. The
  ledger records the level and `sonata usage --by effort` breaks down by it.
  On the harness path `sonata dispatch --tier <role>-<tier>` reads each
  candidate's level and `--model <key>@<effort>` takes the same grammar:
  codex gets `-c model_reasoning_effort=<level>` (on `codex exec` and the
  interactive TUI alike), opencode `--variant <level>`, pi `--thinking <level>`
  — where sonata's `none` is mapped to pi's own spelling, `off` — and the
  claude harness carries the level in the model name, which the router already
  splits. All four measured against the real binaries.
- **A harness sonata cannot set a level on annotates its report rather than
  failing.** The run goes ahead at the harness default and `sonata tail`
  prefixes `[effort <level> not honoured: sonata has no effort control for
  <harness>]` — the same shape as the existing `[no worktree change: …]` note,
  and deliberately not a `degraded` verdict: effort is a preference, not a
  safety boundary, so the permission-mode precedent of refusing rather than
  downgrading does not apply. It reports what sonata knows — that sonata has
  no control for that harness — not that the harness has none. Today that is
  reasonix alone, and only because it was not installed on the machine where
  the other four were probed.
- **`sonata verify` speaks the same variant `sonata dispatch` prints.** A
  dispatch reports `model=flash@high`; pasting that into `sonata verify
  --model` used to fail, because a run records the key and the level in
  separate fields. A bare `--model flash` still matches any level of that
  model — the question it asks is which model ran — while a level must match
  exactly. The provenance line appended to every finished report names the
  variant too, so a run at a pinned level no longer understates itself.

### Changed
- **A bare tier candidate whose model the catalog scores at several levels
  is refused when the config loads.** It was ranked at the model's default
  (usually highest) level and dispatched at the gateway's own, so the
  ranking and the dispatch described different models. The error names the
  candidate and its levels; `sonata init` re-ranks with levels. The check
  needs a catalog cache; without one it is skipped and `sonata doctor` says
  so.

### Fixed
- **`sonata init` no longer corrupts a `CLAUDE.md` that documents the marker
  contract** (#29). Markers were counted wherever they appeared, so a file
  merely *quoting* `<!-- sonata:begin -->` and `<!-- sonata:end -->` in prose
  looked like a well-formed pair and the managed block was spliced into the
  middle of the sentence joining them. A marker now counts only when it stands
  alone on its line; a file that only quotes them has no block and is appended
  to cleanly. This repository's own `CLAUDE.md` was the file it ate.
- **A multi-turn tier agent no longer dies when its candidate changes** (#30).
  Ranked fallback picks a candidate per request, so a conversation carrying one
  model's extended-thinking blocks could be handed to another, which rejects
  the whole transcript (`The content[].thinking in the thinking mode must be
  passed back to the API`). The router now remembers which candidate served a
  conversation and tries it first — a preference, not a pin, so cooldowns still
  apply — and drops the previous model's thinking blocks when a conversation
  does change hands, on both the litellm and direct transports.
- **`sonata usage` reports candidates a request fell past.** The ledger has
  always recorded them in each row's `attempts` and nothing read them, so a
  candidate that failed every time it was reached appeared in no breakdown at
  all while being very visible as dead subagents.
- **A new gateway is born with a `pricing_provider`** (#31), from a
  models.dev provider table verified against the live feed, or from the
  gateway's `auth` (which outranks its name, since a `codex` gateway serves
  OpenAI models). Without one, `resolvePrice` returned `source: 'none'` before
  models.dev was consulted at all — so a fresh config reported every request
  unpriced, `[budget] daily_usd` bounded $0 forever, and an OAuth gateway never
  reached `relabelCovered` and read as unpriced rather than covered. Only a
  gateway sonata is writing for the *first* time gets a proposal, so deleting
  the key declines it permanently. `sonata doctor` names each gateway that
  prices nothing, and the exact line that would fix it — skipping one priced by
  a hand-written `[price]` block, since `pricing_provider` is only the third
  thing `resolvePrice` consults.

## [0.8.3] - 2026-09-12

### Added
- **`sonata reset [--global] [--yes]`** — remove sonata's configuration and
  generated files at one scope. `sonata init` writes to five places (the
  config, the tier agents, the loop skill, a block inside a `CLAUDE.md` sonata
  does not own, and two settings files carrying the routing env, four
  lifecycle hooks, the permission hook and the tool allow-list), so undoing it
  by hand meant knowing all five. Reset removes **only what sonata wrote**: an
  agent file without sonata's marker survives, `permissions.allow` keeps every
  entry that is not sonata's, `CLAUDE.md` loses what is between the markers and
  the blank line separating them, and nothing else (a whitespace-only file
  round-trips byte-identically; a file that ended with no trailing newline
  comes back with one, because the three possible originals are
  indistinguishable once the block is appended), and a settings file is rewritten rather than deleted,
  since sonata is one writer of it among several. It **keeps** what is
  expensive to recreate — gateway keys, the usage ledger, the ranking and
  pricing caches, the `.sonata/` run store — and prints that list, because a
  command called "reset" that says nothing about keys and spend history reads
  as having destroyed both. Hooks are matched by the file they run rather than
  by this install's own absolute path, so a setup installed from a different
  checkout is still removable. The full plan is shown and confirmed before
  anything is touched, so the set named is exactly the set removed.
- **`sonata agents [--list] [--json]`** — see what each generated tier agent
  actually runs on, and re-rank it without walking the whole `sonata init`
  wizard. A tier is a ranked fallback list, and the things that matter about
  one were invisible in the config file: what each key resolves to, its context
  window, whether every candidate clears 1M (and so whether the alias carries
  `[1m]`), and whether a key still names a model at all. In a terminal the view
  is also the editor — enter re-ranks one list through the same `RankedSelect`
  the wizard uses, `w` writes and regenerates the agent files.

  This makes it the **second writer of `sonata.toml`**, which is the risk it is
  designed around. It writes through `replaceTiersBlock`, which removes the
  `[tiers.*]` tables and emits new ones in their place, leaving every other
  byte untouched. Round-tripping through `nativeTomlFor` was rejected: that
  rebuilds the file from a reconstructed `NativeCandidate[]`, so anything the
  reconstruction cannot recover is deleted on write — precisely the failure
  that silently un-priced a gateway on every `sonata init`, and a second writer
  carrying it would double the places it can recur. Here preservation is the
  default rather than a list of fields kept in step with the parser. The result
  is parsed back **before** it is written, since a rewrite that will not load
  leaves no working config at all and would surface later from an unrelated
  command.

  The view is derived with the same predicates `sync` writes by
  (`tiersCollapse`, `tierQualifiesForExtendedContext`) rather than re-deriving
  either: a view that disagrees with the files on disk about what exists is
  worse than no view. The editor lists role × tier rather than agent-shaped,
  because a collapsed pair has to be openable separately or the tiers could
  never be made to differ again; each row names the agent file it lands in.

- **`sonata --version`** prints the running version and the directory it
  resolved from (`-v` and a bare `version` work too). The path is not padding:
  `sonata` on PATH runs `dist/`, not `src/`, and two bugs in this repo's
  history were "fixed" and went on reproducing for exactly that reason — so
  the first question in that state is which install actually answered. The
  version is read from the manifest beside the executing file rather than
  baked in at build time, so it can only describe the code that is running.

### Fixed
- **A provider added during `sonata init` had no models to select.** After
  adding a provider and typing its key, models could be chosen on that
  provider's own screen and were then absent from the models step — reported
  as "I can select models, but when I click Continue the models are not
  available for selection". `refreshableGateways` derived the set of gateways
  it may ask what they serve from `candidates`, which is
  `allNativeCandidates`, computed once at startup: a gateway that did not
  exist then contributes no rows, so the one provider whose key had just been
  typed was never queried. The models survived in `nativeKeys` and reached the
  written config, which is why this looked like a display bug rather than a
  lost selection. Gateways added during the run are now named explicitly —
  from `byokKeys` and `customProviders` — rather than inferred from the key
  store, which also holds keys for gateways the user did not select this run;
  their base URLs are merged in for the same reason. Every existing exclusion
  still applies: an added gateway with no key, no base URL, or an OAuth
  credential is still not asked.


- **A model added by key was never ranked properly.** Reported as "adding
  models by key doesn't get ranked automatically". The wizard's tier screens
  derived their gateway names from `data.candidates` — `allNativeCandidates`,
  computed once at startup — so a provider added during the run was invisible
  to the ranker. A model key is `<gateway>-<id>`, so without the gateway name
  `normalizeModelName` cannot strip the prefix, the model misses its catalog
  entry and scores as the `default` row (capable, *not* cheap); with nothing
  left clearing the cheap bar, `proposeTiers` falls back to making `simple`
  mirror `complex` and the tier stops discriminating at all. Measured on a
  two-model set: `simple` and `complex` came back identical before the fix and
  differ after it. Ranking now runs over every model actually selected
  (`knownCandidates`), which also covers a model only a gateway's own
  `/models` answer knew about. The bulk "accept all remaining" path takes the
  same universe, because the two are required to write a byte-identical
  config and fixing only the screens would have broken that quietly.

## [0.8.2] - 2026-09-12

### Added
- **models.dev pricing falls back to OpenRouter, and to nothing else.** A lab's
  own models.dev entry lags its releases: `deepseek-v4.1-flash` is absent from
  the first-party `deepseek` provider while eight resellers publish it, so a
  gateway serving that model priced as unknown even though models.dev held a
  rate for it all along. OpenRouter is now consulted after every provider the
  config named — never ahead of one — and if it has nothing either the row
  stays unpriced exactly as before. Nothing else is consulted, because the
  resellers disagree: the same model is $0.15/1M input from OpenRouter and
  $0.30 from two others, so picking among them would be a guess on a money
  value.
- **A bare model id now matches a provider that vendor-qualifies its keys.**
  models.dev files each provider the way that provider does — OpenRouter uses
  `deepseek/deepseek-v4.1-flash` where a sonata config carries the bare
  upstream id — and `normalizeModelName` only ever *strips* prefixes, so such
  an entry was unreachable. The match compares the part after the first slash
  and is taken only when every candidate agrees on the rate: two vendors can
  publish the same model name, and choosing between two different prices would
  be a coin flip. This applies to any provider the config names, not only the
  fallback, so naming OpenRouter yourself behaves the same way.

- **A tier whose candidates are all 1M now declares that window.** Claude Code
  sizes a subagent from its model and cannot recognise a sonata alias, so every
  foreign subagent shared one session-wide number — the smallest window in the
  config — no matter which tier it belonged to. Two levers exist and were
  measured on 2026-09-11: an unrecognized id carrying `[1m]` is assumed to have
  a 1M window and the suffix is stripped before forwarding (verified live — an
  agent declaring `model: sonata-explore-simple[1m]` produced the router line
  `model=sonata-explore-simple -> gpt-5.6-luna -> litellm`, so routing is
  untouched), while `CLAUDE_CODE_MAX_CONTEXT_TOKENS` applies to an
  unrecognized id *without* it. `sonata sync` now suffixes a tier's alias when
  every natively-routed candidate declares at least 1M, and the floor is
  computed over the models still below that threshold — omitted entirely when
  none remain. A tier qualifies only if **every** candidate does, since a tier
  is a ranked fallback list and the claim must hold for whichever model
  answers; an absent `context_window` disqualifies it, because unknown is not
  1M and guessing upward turns a wasted window into a hard context-limit error.
- **`sonata doctor` reports what routing costs the main session.** Behind a
  gateway Claude Code cannot verify native 1M support, so Sonnet 5, the Fable
  models and Opus 4.7+ are budgeted at 200K unless `[1m]` is explicit — an 80%
  reduction sonata causes and nothing on screen mentions. Reported, not fixed:
  on Pro, Opus at 1M draws usage credits, and behind a gateway the credit check
  is skipped, so enabling it unasked could spend a user's money.

### Fixed
- **`sonata init` wrote `context_window = 128000` for every model whose real
  window it did not know**, and a guess is indistinguishable from a decision
  once it is in the file. Measured on the development machine: 18 of 24 models
  carried the placeholder wrongly, including four at 1M
  (`glm-5.3-flash`, `deepseek-v4-pro`, `gemini-3.7-flash`) and the GPT models
  at 278528. Since Claude Code sizes a foreign subagent from one session-wide
  number — the smallest window in the config — every subagent was capped at
  128k. `init` now fills the window from models.dev's `limit.context`, which
  sonata already fetches for pricing, and touches **only** models still
  carrying the default: a different value came from somewhere, and models.dev
  is a better guess than sonata's but not better than a decision. The floor
  rose 128000 → 262144 on a real config.
- **The context lookup reads a consensus, not an extreme.** models.dev files
  each provider as that provider does, so the lookup strips a serving-variant
  suffix (`:free`, `:nitro`) and matches a bare id against a vendor-qualified
  key — without which `z-ai/glm-5.2:free` matched nothing and, sitting in all
  eight tiers, held every one of them at the default. Where providers disagree
  it takes the **most commonly published** window: a dozen providers list
  `glm-5.2` between 202752 and 1048576, nearly all at ~1M, and taking the
  minimum let one outlier understate it fivefold. A tie breaks toward the
  smaller window, since an overstated window fails hard upstream while an
  understated one only wastes context.

## [0.8.1] - 2026-09-11

### Fixed
- **`sonata init` silently deleted `pricing_provider` and every `[price]`
  block.** Both were read by `parseConfig` and used by `resolvePrice`, and
  written back by nobody — and `sonata init` is the sole writer of
  `sonata.toml`, so anything it does not emit is gone. Every rewrite therefore
  un-priced the gateway: `resolvePrice` returns `source: 'none'` at its
  `provider === undefined` guard, before models.dev is ever consulted. Measured
  on a real config, one rewrite flipped a gateway from priced to unpriced
  between two requests 64 seconds apart, and 429 later requests recorded no
  cost at all. The second-order effect is worse than the missing report line:
  unpriced volume is deliberately excluded from `[budget] daily_usd`, so a
  dropped key also stops the cap counting that spend — a ceiling quietly
  measuring less than it claims. This is the same defect `avoid_gateways` is
  written back out to prevent; the lesson was recorded for one key and not
  applied to the others. `nativeTomlFor` now receives the config being
  rewritten and preserves all three, windows included in declaration order,
  since the first matching window wins at read time. Harness-only models are
  emitted by a second loop and are preserved there too — fixing only the
  native loop left the identical deletion one block further down.

## [0.8.0] - 2026-09-10

### Added

- **`sonata init` can make tier agents the default subagent lane.** Claude Code
  already *discovers* the generated agents natively — they are ordinary
  `.claude/agents/*.md` files — but it does not *prefer* them: a subagent is
  chosen by matching the task against each agent's `description`, where
  sonata's compete with `general-purpose`, `Explore` and `Plan`, all broader
  and carrying no routing precondition. Nothing sonata wrote could express a
  preference, so the default pull was toward Claude's own subagents, which is
  the opposite of why sonata is installed. `init` now offers to write a
  delimited block into `CLAUDE.md` — the one file Claude Code loads in every
  session unconditionally — naming the tier agents, how to pick a tier, and
  what `model_not_found` means (an unrouted session, not a broken agent).
  `--guidance project|global|skip` serves the unattended path. Sonata owns only
  what is between its `<!-- sonata:begin -->` / `<!-- sonata:end -->` markers:
  text either side survives byte-for-byte, a file whose markers do not pair up
  is refused rather than repaired, and a refusal is reported as a warning
  instead of failing an init whose config, agents and hook are already written.

- **Subscription-backed work is valued without being counted as spend.** A
  gateway authenticated by an OAuth subscription (`codex-oauth`,
  `copilot-oauth`) fits neither existing price state: the work has a knowable
  list value, but no money changes hands per token. It used to collapse into
  `source: 'none'`, so 829 real requests worth ~$25 were invisible and
  indistinguishable from a genuinely unknown model. `LedgerPrice.source` gains
  `'covered'`: `resolvePrice` resolves rates exactly as before and then
  relabels when the gateway's auth is OAuth, so one resolution path serves
  both and a subscription gateway cannot drift from a metered one. There is no
  new config key — a gateway already declares its auth, and OAuth auth *is* a
  subscription; only `pricing_provider` is needed, to say which rates value
  the work.

  `[budget] daily_usd` never sees it: `spentTodayUsd` skips covered rows, so
  free-at-the-margin traffic can never trigger a refusal. `sonata usage`
  reports it on its own line and marks a covered figure with ` ~`, so a
  per-row number cannot be silently summed into a spend total. Verified
  against real ledger data: on a day holding $14.36 of covered work beside
  $0.34 of real spend, the budget saw $0.34.

- **The router keeps the price cache fresh.** Nothing refreshed it before:
  `sonata catalog update` is manual, so a machine that had not run it in
  months priced every ledger row on stale rates and said so only in one line
  of `sonata usage` output. `sonata serve` now checks on bind and every 6
  hours, refreshing when the cache is missing, unreadable or older than 24
  hours (`src/price-refresh.ts`). The daemon is deliberately the only host: it
  is long-lived, already does network I/O, and is what writes prices into
  ledger rows — putting a fetch into `usage` or `doctor` would make a
  read-only command hang on a bad network, which is exactly when someone runs
  `doctor`. Three properties keep it off the request path: it is never awaited
  by a request, a failure is inert (the existing cache is kept and the next
  tick retries — no tight loop, since the likeliest failure is "no network"),
  and the timer is unref'd so it never holds the process open. A cache whose
  `fetchedAt` will not parse counts as stale, because an unreadable timestamp
  is not evidence of freshness and reading it as such would pin a broken cache
  forever.
- **`sonata usage --project <dir>`** restricts the report to one project. The
  default stays machine-wide, so nothing already parsing the output changes.

### Changed

- **Token prices now come from models.dev, not ai-pricing.fyi.** The old source
  was wrong, not merely sparse: its OpenAI `output_token` values were that
  model's *cache-write* price, so `gpt-5.6-terra` was published at $2.50/1M
  output against OpenAI's real $12.00 — understating the expensive half of an
  agentic workload roughly five-fold. Verified against OpenAI's published
  pricing page, with models.dev, OpenRouter and LiteLLM's own table agreeing
  against ai-pricing.fyi on every model checked; models.dev matched the
  primary source exactly on all four, including the long-context tier.
  `sonata catalog update` now fetches `https://models.dev/api.json` — public,
  no key, one request — and caches `provider → model → rates` at
  `~/.config/sonata/models-dev.json`. Coverage rises from 694 models to 7181
  costed ones. The abandoned `ai-pricing.json` is neither read nor migrated.
- **`pricing_provider` accepts an ordered list**, so a gateway reselling
  several labs can be priced at each lab's own published rate:
  `pricing_provider = ["openai", "deepseek", "google"]`. The first provider
  that *lists the model* wins. A bare string keeps working unchanged. Deriving
  the lab automatically was rejected: Artificial Analysis publishes a display
  name (`"Z AI"`, `"Kimi"`) matching none of models.dev's provider ids, and
  OpenRouter's prefixes are its own slugs — both need a curated map that rots
  silently.

### Fixed

- **`sonata usage --by project` split a worktree from its main checkout** while
  `[budget] daily_usd` pooled them — the cap counts a worktree against the
  config it borrows, so a refusal could fire at a number appearing nowhere in
  the report. Grouping now resolves each row's directory through `configPath`,
  the same borrow the router uses. Computed at report time, not read from the
  row's `tenant` id: only 2,871 of 24,774 rows on the development machine
  carry one, so tenant grouping would bucket 88% of history as "unknown". A
  directory that no longer exists keeps its recorded path rather than
  resolving by fallthrough to the machine config, and a cwd resolving to the
  machine config keeps its own label rather than collapsing every configless
  directory into one bucket.
- **`sonata usage` blended covered work into the cost column.** A bucket's
  `costUsd` included subscription-covered rows while `pricedTotalUsd` excluded
  them, so summing the cost column disagreed with the report's own
  `priced total`, and a trailing ` ~` was the only signal. A flag cannot say
  *how much*: measured on real data, one project showed $167.10 of which
  $0.000000 was covered, and another showed $10.34 of which all of it was —
  rendered identically. `UsageBucket` gains `coveredUsd`, `costUsd` is spend
  alone, and the two render as separate `spent` / `covered` columns (shown
  only when some bucket carries covered work). Buckets are ordered by total
  value so a wholly-subscription bucket does not sink to the bottom now that
  its spend is 0.

- **No OpenRouter model could ever be priced.** models.dev keys each provider
  the way that provider does: `openai` files a bare `gpt-5.6-terra`, but
  `openrouter` files `nvidia/nemotron-3.5-lightning:free` — vendor prefix and
  serving-variant suffix included. `resolvePrice` looked up only
  `normalizeModelName(id)`, which strips exactly those two things, so every
  OpenRouter row resolved to unpriced (2,870 real rows on the development
  machine). The raw upstream id is now tried before the normalized name, which
  cannot mis-match: an exact hit under the named provider *is* that model.
  Provider order remains the outer loop, so an earlier provider still outranks
  an exact id match found in a later one.
- **Cache-creation tokens were billed at the input rate.** models.dev
  publishes `cache_write` separately and it is materially higher —
  `gpt-5.6-terra` is $2.50 against $2.00 input — so every priced row
  undercounted cache creation by 25%. `Rates` gains `cacheWrite` and `costOf`
  charges `cacheWrite ?? input`, unchanged where no cache-write rate exists.
- **A partial scraped rate table priced the gap at zero.** `costOf` charges an
  absent dimension 0 by contract, so a models.dev entry carrying only an
  output rate returned `{ source: 'models-dev', totalUsd: 0 }` for a request
  that spent a million input tokens. That is worse than declining: a $0 row
  counts as *priced*, so it disappears from the unpriced volume `sonata usage`
  reports separately, and `[budget] daily_usd` treats the spend as free.
  `resolvePrice` now declines unless the table covers every dimension the
  request actually used. Latent rather than live — all 7181 costed models on
  models.dev carry both input and output today — which is precisely why it
  would have gone unnoticed had the feed changed. Hand-written `[price]`
  blocks are unaffected: a partial one there is a deliberate statement.
- `sonata catalog update` previously fetched only the first 1000 rows of the
  ai-pricing.fyi feed, which paginates by offset and truncates silently — 441
  of 694 models were missing. Fixed before the source was replaced; recorded
  because the same shape of bug is what a single un-paged request always
  produces.

## [0.7.1] - 2026-09-09

### Fixed
- **A linked git worktree borrows its main checkout's `sonata.toml`.**
  `sonata.toml` is untracked, so `git worktree add` produced a directory with
  none of the project's sonata state: every command run there fell through to
  the machine config, or to none, and a session launched in a worktree resolved
  no project config at all — its native tier agents 404'd with
  `model_not_found` against `api.anthropic.com` rather than reaching the router.
  `configPath` now resolves a linked worktree to the main checkout's config,
  below the worktree's *own* `sonata.toml` (one that has been given a config
  means it) and above the machine one (a checkout of this repository is this
  project). Borrowing also gives the worktree the main checkout's router tenant
  id, so cooldowns and `[budget]` are shared rather than split. Detection is
  pure filesystem — the `.git` pointer file and its gitdir's `commondir`, never
  `git rev-parse` — because `configPath` is on the router's per-request tenant
  resolution path, and every malformed shape answers "not a worktree" rather
  than throwing.

  Routing settings and hooks are the one thing a worktree cannot borrow: Claude
  Code reads `.claude/settings.local.json` relative to its own cwd, so
  `sonata route auto` must be run in the worktree itself. `sonata doctor` now
  says exactly that, naming the main checkout, instead of repeating the bare
  "run `sonata route auto`" that a user standing in a fresh worktree has no way
  to act on.

## [0.7.0] - 2026-09-09

### Added
- **One router serves every project.** `sonata serve` is now a machine-wide
  daemon that resolves each request's own `sonata.toml` from the project the
  request came from, instead of one daemon per config. A routed session names
  its project in an `x-sonata-project` header (written into settings `env` as
  `ANTHROPIC_CUSTOM_HEADERS` at project scope, which Claude Code re-applies to a
  running session); the router falls back to the session registry, then to the
  machine config, and strips the header before forwarding on every path. One
  LiteLLM child serves them all, its model list the union of every known
  project's models under `<tenant>/<key>` — namespaced because two projects may
  each call a model `flash` and mean different things, while credentials stay
  machine-wide by gateway name. That child starts **lazily**, the first time any
  project needs it, and its union snapshot is committed only once the child is
  confirmed ready, so a `sonata litellm install` after a 502 is picked up by the
  next request rather than needing a manual restart.
  - **Ports come only from the machine config.** A project `[native.ports]`
    still parses but is ignored, and `sonata doctor` says so and names the line
    to delete. `/__sonata_health` reports `multiTenant: true` and the projects
    it knows, and no longer reports a `configPath` — a router is no longer
    identified by one config, so every caller that used to compare paths now
    refuses only a router that *predates* this change, naming `sonata restart`.
  - **A tenant is identified by the realpath of its config.** The first live
    two-project run registered one config as two tenants,
    `/private/var/…/sonata.toml` and `/var/…/sonata.toml`, because macOS
    symlinks `/var` to `/private/var` and the path string was the identity. That
    one project carried duplicate LiteLLM entries, fired a needless restart, and
    split its cooldowns and budget attribution across two ids. Any path
    traversing a symlink does this — a symlinked `~/Code`, a mounted path, a
    worktree — not only a temp directory. Canonicalisation is best-effort: a
    path that cannot be resolved keeps its original spelling rather than
    throwing.
  - **Spend is attributed per project.** Ledger rows carry `project`; a
    `[budget] daily_usd` in a project's config caps that project's priced spend
    for the UTC day while one in the machine config caps everything the router
    forwards, and each refusal names the file that set the cap. `sonata usage
    --by project` reads the row's own attribution.
  - **Upgrading: run `sonata restart` first.** Routing now targets the machine
    port, so a stale pre-multi-tenant daemon holding it would answer with
    whatever single config started it. Every entry point refuses such a router
    rather than trusting it — including `SubagentStart`, which previously wrote
    the routing env with no check at all and is how a dispatch in this
    repository was served by another project's config and failed against
    gateways this project never names.
  - **The project header is authorised by a loopback token.** Naming a project
    picks whose gateways and stored credentials serve a request, and the router
    authenticates nobody on loopback, so the hint is honoured only alongside
    `x-sonata-token` matching the 0600 `~/.config/sonata/router-token`. A
    process that cannot read that file — a different local user, a sandbox —
    reaches the port and gets ordinary session-then-machine resolution instead
    of its pick; one that can could already read the credential store. An
    unauthorised hint is dropped and logged, never refused, so a session whose
    settings predate the token keeps working.
  - Design and the live-run evidence:
    `docs/superpowers/specs/2026-09-09-multi-tenant-router-design.md`.

### Fixed
- **The codex-oauth `System messages are not allowed` 400 is closed.** The
  hole that survived `flattenSystemBlocks` + `supports_system_message: false`
  was never in `system` at all: Claude Code 2.1.266 sends mid-conversation
  system messages as a `role: "system"` turn inside `messages`, which
  Anthropic accepts. Captured through a logging proxy on 2026-09-09
  (`messageRoles: ["user","system"]` on the very first request), then probed
  directly against the live LiteLLM child: a string `system` with no system
  turn streams fine, the identical request plus a system turn 400s. LiteLLM's
  Anthropic adapter forwards the turn as a system-role chat message, its
  chat→responses bridge emits it as a system-role input item, and the Codex
  backend refuses it. `demoteSystemTurns` (`src/native/router.ts`) rewrites
  each such turn to `role: "user"`, content and position untouched, on the
  litellm path only; verified live on a scratch daemon — the `claude -p`
  session that 400'd a minute earlier returned 200 from `gpt-5.6-luna`.
- **Native write-role agents (`code-simple`, `code-complex`) died on their first
  request to every OpenAI-compatible provider** with HTTP 400 `Invalid schema
  for function 'Artifact': '^(?!__.*__$)[^\p{Cc}…' is not a 'regex'`
  (`tools[1].parameters`), and LiteLLM reported no fallback, so the agent
  terminated. Claude Code sends a write-capable agent its full tool set, and
  the Artifact tool's `field` parameter constrains a string with Unicode
  property classes (`\p{Cc}`) that JavaScript and Anthropic accept but the
  reference JSON Schema validator — which runs `format: regex` on Python's
  `re`, where `\p` is a *bad escape* — refuses. Read-only roles never hit it
  only because their agents carry an explicit `tools:` allowlist without
  Artifact. `sanitizeToolSchemas` (`src/native/router.ts`) now strips, on the
  litellm path only, each `pattern` that uses a Unicode property escape and
  nothing else; both litellm forwarding paths share the one `litellmBody`
  transform with `flattenSystemBlocks`, an Anthropic request stays
  byte-identical, and the direct path stays a pass-through. First reported
  from a project outside this repository (2026-09-09).
- **`sonata route session-start` refused silently when the configured router
  port was held by *another* project's daemon**, so the `route auto`
  SessionStart hook never routed the session and pinned tier aliases went
  straight to `api.anthropic.com` and 404ed. The refusal itself was correct —
  two projects each holding their own `sonata.toml` on the default port cannot
  share one router — but the hook ran the CLI with stdio ignored and always
  exited 0, so nothing surfaced. Both `route auto` hooks now relay a non-zero
  CLI exit to the user as a hook `systemMessage` (Claude Code honours it on
  SessionStart and SubagentStart), while the CLI exits 0 for the one *expected*
  failure — no config in this directory, now the typed `NoConfigError` — so a
  global hook stays silent where it has nothing to do. **The refusal this
  surfaced no longer exists**: the multi-tenant router added above serves every
  project from one daemon, so two projects sharing a router port is the
  supported case rather than a collision. What the hooks surface now is the one
  refusal that remains — a router predating multi-tenant routing. The relaying
  is what mattered and it stands; the check behind it was replaced within the
  same release, which is why this entry names both.

## [0.6.1] - 2026-09-07

### Fixed
- **A valid Google API key was rejected outright during `sonata init`'s BYOK
  flow, with `google rejected that key (HTTP 401)`.** `fetchModels` sends every
  provider `Authorization: Bearer <key>` against `GET <base>/models`, the
  OpenAI-compatible convention `WELL_KNOWN_PROVIDER_URLS` otherwise follows —
  but Google's entry points at the *native* Generative Language API (needed so
  LiteLLM's `gemini/` provider can reach it for real inference), not its
  separate `v1beta/openai` compatibility shim. That endpoint authenticates with
  `x-goog-api-key`, not Bearer — an API key is not an OAuth token, so Google
  answers Bearer auth with a flat 401 regardless of whether the key is valid —
  and lists models as `{ models: [{ name: "models/<id>", ... }] }`, not
  OpenAI's `{ data: [{ id }] }`. `fetchModels` now detects the Google host and
  switches both the auth header and the response parsing; a genuinely bad key
  (Google's 400 `INVALID_ARGUMENT`/"API key not valid") is still reported as
  `unauthorized` rather than falling through to "type ids by hand".
- **`sonata init` could stall for however long `opencode models` felt like
  taking, with no bound and no feedback.** `detectHarnesses` runs all four
  harness checks in parallel, so the whole startup checklist waits on
  whichever is slowest — and `detectOpenCode`'s `opencode models` call used
  the unbounded `tryRun`, unlike `pi`'s equivalent (`tryRunLimited`, already
  guarded with the comment "a hung provider must not stall init"). Measured
  live: `opencode models` took 35 real seconds on a cold local catalogue cache
  and 2 seconds once warm — a real, if intermittent, cost with no way for
  `init` to bound or explain it. Both `opencode --version` and `opencode
  models` are now bounded (10s and 45s) with `tryRunLimited`; a timeout reports
  as its own warning ("opencode models timed out — its catalogue may be slow
  or stalled on this machine") rather than the misleading "opencode reported
  no models → opencode auth login", which was never the right fix for a
  timeout.

## [0.6.0] - 2026-09-03

### Added
- **`[budget] daily_usd` — a daily spend ceiling the router enforces**
  (roadmap item 04). Set it in `sonata.toml` and the router sums the usage
  ledger's **priced** rows for the current UTC day before forwarding anything,
  refusing at or past the cap with a 429 that names the cap, the spend to date,
  and the file to edit. The check sits at the top of `routeRequest`, above
  *both* the tier and direct branches — a cap enforced on one of two paths is
  not a cap — and both halves are re-read per request, so raising the number
  frees the router without `sonata restart`. Absent `[budget]`, nothing
  changes; a non-numeric or non-positive `daily_usd` is refused at parse time,
  because a cap's only visible effect is a refusal that has not happened yet,
  so one silently dropped for being the wrong type reads exactly like one that
  works.

  The refusal states the two things the cap cannot see, rather than leaving you
  to discover them from a bill: it counts **priced volume only** (unpriced rows
  are excluded, never folded in as zero — counting unknown as zero would make
  the cap quietly permissive in the case you are least able to notice), and it
  covers the **native router path only** (`sonata dispatch` runs execute in the
  foreign CLI's own process and never transit the router). Refusals are
  deliberately not written to the ledger: a row records a request that was
  forwarded, and putting avoided spend into the store that defines spend is how
  the number stops meaning what it says.
- **A finished run now reports whether it changed anything** (roadmap item 07).
  `sonata` fingerprints the working tree at launch (`git rev-parse HEAD`, `git
  status --porcelain`, and a blob hash for the content of every path git does
  not consider committed-clean) and compares at exit, so a run that finished
  cleanly, un-degraded, reporting "fixed the bug" while touching no file says
  so: the report is prefixed `[no worktree change: …]`. This is the one shape
  of false success the report contract cannot catch, since a model that did
  nothing writes the same `report.md` as one that did everything.

  It **annotates rather than degrades**, on purpose — `degraded` means sonata
  cannot mechanically trust a result, and a run that correctly concluded no
  change was needed is a legitimate outcome; degrading it would trade this
  check's false successes for false alarms instead of removing either. It is
  **inert outside git**: no repository, no `git`, or any failure at all yields
  *unknown*, never "unchanged", because a check for silent failures must not
  invent one. Read-only roles (`review`, `explore`, `plan`) skip it entirely.
- **One report-contract manifest** (roadmap item 12). `src/report-contract.ts`
  is now the single definition of where a run's result lives. `report.md` had
  been a bare literal in five executable places — the prompt in `run.ts`, the
  read-back in `store.ts`, the existence check in `runs.ts`, and the watcher
  loops in the codex and reasonix adapters — with nothing forcing them to
  agree, and disagreement fails silently in the worst direction: the model
  writes its report where it was told, nothing reads it there, and the run is
  reported degraded despite having succeeded. A drift-guard test asserts no
  other file under `src/` names the filename in code. The degraded *verdict*
  deliberately stays in `tail.ts`'s `decide()`.
- **Config schema v1, with migration that runs on load** (roadmap item 10).
  `sonata.toml` now carries a `schema_version` stamp, written by `sonata init`
  above every table header. `parseConfig` reads it, walks the file forward
  through an ordered migration chain (`src/migrations.ts`) before any
  field-level validation, and **refuses** a file stamped newer than this
  sonata understands rather than parsing it best-effort into something that
  means something else. Migration is in-memory: an unstamped file — including
  a pre-`[tiers]` one — keeps loading exactly as before, so no read-only
  command rewrites your config. `sonata doctor` reports a file behind the
  current schema as advisory, never a blocker.

  The chain ships **empty**, which is the honest state for v1: version 1 names
  the shape `parseConfig` already accepts, so nothing needs transforming yet.
  What ships is the mechanism, the stamp and the refusal — so the next
  breaking change appends one step and every file on disk walks forward on its
  next load. Composition is proven by tests against a synthetic chain rather
  than asserted about an empty one.

- **`sonata doctor` reports ranking-catalog *coverage*, not just its age.**
  Freshness is measured in days, which is the wrong instrument for the failure
  it was standing in for: a catalog fetched yesterday is reported fresh and
  still knows nothing about a model released today, so selecting that model
  ranks it from the capable-not-cheap default with no warning anywhere. The
  check now asks whether the catalog can score the models *this config
  actually tiers* — `2 of 13 tiered models unscored (gemini-3.8-flash, …) —
  ranked from built-in defaults; run \`sonata catalog update\`` — and only
  falls back to the age line when coverage is complete. Models are named by
  their upstream id, which is what the catalog is keyed by; reporting the
  config key would send you looking for the wrong string.

### Fixed
- **`[` and `]` now visibly reorder a tier ranking.** Reported as "[ and ]
  does not work in sonata TUI". The keys were reaching the reducer and the
  ranking really was changing — the *display* was what made it look dead. Rows
  were drawn in item order with the rank as a marker, so a real 19-row screen
  read `·  ·  ·  ·  1.  5.  ·  ·  ·  ·  ·  ·  2.  6.  ·  ·  3.  7.  ·`:
  reordering swapped two numbers between rows that were nowhere near each
  other, the highlight stayed where it was, and pressing `[` twice was a round
  trip. Sixteen of those nineteen rows were unranked, where the keys correctly
  do nothing and nothing said why. The list now draws the ranked models first,
  in rank order, above the unranked ones, and the highlight follows the row it
  moved — including through `space`, so `[` after picking a model reorders the
  model just picked.
- **The simple tier admitted models on dollars-per-token while ranking them on
  dollars-per-task, so a cheap model could be refused by the gate that was
  meant to let it in.** Admission tested `blendedPriceUsd <= 1.0` — a per-1M
  *token* rate — while ordering inside the tier used AA's `cost_per_task`,
  which prices the work. Gemini 3.8 Flash is $1.50/1M and $0.577/task: refused
  at any catalog freshness, on a threshold that was never measuring what the
  tier optimises. So was Gemini 3.7 Flash, at the same rate. Admission now
  uses the same measure as ranking, and it is **relative** — a model is cheap
  when its cost per task is within `SIMPLE_COST_CEILING` (12×) of the cheapest
  model that can actually *enter* the tier — for the same reason
  `SIMPLE_CAPABILITY_FLOOR` is: an absolute bar is wrong in both directions as
  prices move. Measured on two real configs, the simple tier went from three
  admitted models to four (with Gemini 3.8 Flash ranked, previously absent
  outright) and from three to five. Only models that clear the capability gate
  and the floor may set the ceiling: it is a `Math.min`, so — unlike the
  floor's `Math.max` — one very cheap, very weak model would otherwise drag the
  bar below everything eligible, empty the tier, and leave the fallback
  mirroring `complex`, which is the tier ceasing to discriminate at exactly its
  strictest moment. A model with no AA `cost_per_task` keeps the absolute
  admission rule it had before — the curated table's `cheap` flag, else the
  `AA_CHEAP_BLENDED_PRICE_USD` per-1M bar — since the change has no better
  information about it; with nothing costed at all there is no ceiling and
  behaviour is unchanged.
- **A namespaced OpenRouter ref no longer falls through to the
  capable-not-cheap default.** Two causes, both in `normalizeModelName`. A
  serving-variant suffix (`:free`, `:nitro`) was kept, so
  `nvidia-nemotron-3-super-120b-a12b:free` matched nothing while AA held that
  exact row minus the suffix — the suffix picks a route for the same weights
  and must not change the name a score is looked up under. And a sonata key
  flattens `vendor/model` to `vendor-model`, leaving nothing to tell the vendor
  from the model, so `z-ai/glm-5.2` looked up `z-ai-glm-5.2` while AA files it
  as `glm-5.2`. `aaLookupNames` now offers up to two shortened spellings after
  the full name. The guess is bounded so it can only ever add a score where
  there was none: the full name is always tried first and wins, a shortened
  name is accepted only on an exact catalog hit, and a candidate must still
  carry a version digit — `gemini-2.5-flash-lite` never offers `flash-lite`,
  which is a family another vendor might publish under. Three of five
  OpenRouter models on a real config were mis-scored by this.
- **The Codex backend's "System messages are not allowed" 400 now cools its
  candidate instead of killing the subagent.** Sonata already carries two
  structural fixes for this refusal — `flattenSystemBlocks` in the router and
  `supports_system_message: false` on the codex model — and they are still
  correct and still necessary. They are not, however, sufficient: measured live
  on 2026-09-03 against a verified-current `dist/`, a tier request the router
  had already flattened came back
  `litellm.BadRequestError: ChatgptException - {"detail":"System messages are
  not allowed"}. Received Model Group=gpt-5.6-terra`. The remaining hole is
  unidentified. Adding the string to `CAPABILITY_400_SIGNATURES` means three
  consecutive identical failures cool the candidate and the tier falls through
  to the next model, ending — if every candidate is exhausted — in a 529 naming
  `sonata dispatch`, instead of a bare 400 that reads to the caller as a defect
  in the agent's own work.
- **Parallel daemons no longer corrupt each other's pid record.** Serve state
  moved from one global `serve-state.json` to `serve-state-<router port>.json`.
  A project with its own `sonata.toml` needs its own ports and therefore its
  own daemon — the router resolves tiers against the daemon's *own* cwd — and
  with one shared file those daemons overwrote each other field by field.
  Measured live with two routers up (:4100 and :4110): the single record ended
  up naming the second router's pid beside the *first* router's litellm child,
  so `sonata restart` in either project would have killed one daemon's router
  and the other's litellm — surfacing as the untouched project suddenly 502ing
  on every native request. The legacy unkeyed record is still honoured (never
  written) so a daemon started before this change stays stoppable across the
  upgrade, but only against proof of ownership: it names no port, so it cannot
  say which router it describes, and it is now used only when the pid it
  records is the process actually listening on the port being asked about.
  Reading it unconditionally left every caller port-scoped in name only — and
  because `recordRouterPid`/`recordLitellmPid` merge the current state into
  each write, it would also have copied a foreign daemon's `routerPid` forward
  into a *fresh* port-keyed file, laundering the stale value into the new
  scheme.
- **A corrupt serve-state file no longer parses as a record.** `JSON.parse`
  answers a bare `null`, `[]` or `"x"` without throwing, and the result was
  cast straight to `ServeState`, so `state.routerPid` on a truncated or
  hand-edited file read as `undefined` from a value that is not an object at
  all. It is now rejected the same way unparseable JSON already was, which is
  what keeps `sonata serve` starting rather than throwing on one.
- **`sonata serve` no longer adopts somebody else's LiteLLM.**
  `/health/liveliness` needs no credential — *any* LiteLLM on that port answers
  it — so waiting on liveness alone proved only that something was listening,
  and a port clash was adopted silently and then failed later as unexplained
  502s. The wait now probes `/v1/models` with this router's own master key;
  measured on 1.98.0, the correct key answers 200, a foreign key answers 400
  `No connected db.`, and no key answers 500. A port held by a LiteLLM that
  refuses this router's key now fails with a message naming the clash and
  `[native.ports]`, instead of the generic "did not come up".
- **The worktree check no longer measures edits made after the run exited.**
  The closing fingerprint was sampled by `sonata tail`, but `sonata run`
  returns immediately and the first tail can arrive much later — so anything
  you touched in between counted as the run's work, and a run that genuinely
  changed nothing stopped saying so. The launch wrapper now writes the capture
  into the run directory *before* writing the exit sentinel, and tail hashes
  that rather than the tree. Both ends run one shared script
  (`WORKTREE_CAPTURE_SH`) and the fingerprint is sha256 of its raw bytes, so
  there is no formula left to reimplement in bash; a test asserts the two ends
  agree byte-for-byte. A run launched by an older sonata has no capture and
  still falls back to the live sample.
- **The worktree check now sees content, not just which paths are dirty.**
  `git status --porcelain` records a path's *state* and never its bytes: an
  already-modified tracked file reports the same modified-but-unstaged line
  however many times it is rewritten, and so does an existing `?? path`.
  Dispatching into a dirty worktree is the ordinary mid-feature case, so a run
  that edited exactly the file you were already working on — and nothing else
  — was reported as having changed nothing. The capture now includes a `git
  hash-object` blob hash for every path git does not consider committed-clean,
  which is exact for binaries too (a diff renders those as "Binary files
  differ"), costs one process, and writes nothing into the repository — no
  `-w`, because a check that exists to be inert must not grow someone else's
  object store. `.sonata` is excluded from that enumeration: `status`
  collapses an untracked directory to a single entry, but `ls-files -o` lists
  every file under it — including the `report.md`, `exit` and capture files
  the run is itself about to write — and counting those would mark *every* run
  as changed, an annotation that is always present and therefore says nothing.
- **`startServeDaemon`'s tests no longer read the developer's own config.**
  They passed a temp `home` but inherited the real `process.cwd()`, so a
  sonata checkout containing its own `sonata.toml` (any contributor who has
  run `sonata init` there) failed five tests with "expected 4110 to be 4100" —
  naming a port nothing in the test mentions.
- **`sonata init`'s tier ranking screen no longer opens a newly-added model
  unranked.** Adding a model and re-running `sonata init` showed it as `·`
  (unranked) on the simple/complex tier screens, and `[`/`]` — which only
  reorder an already-ranked row — did nothing on it, reading as "the reorder
  keys are broken." The screen (and the "accept all remaining" bulk path) now
  seed a newly native-selected model at the rank the fresh proposal gives it,
  the same insertion `reconcileTierList` already does at write time — so it
  opens pre-ranked instead of needing a manual space-then-reorder to place.

## [0.5.1] - 2026-09-02

### Added
- **`sonata doctor --json`** (roadmap item 11). `cmdDoctor` already returned a
  structured `{ ok, checks }`; the CLI only ever rendered it as text. `--json`
  prints that same structure verbatim, so scripts and CI can gate on doctor's
  output instead of scraping stdout.

### Fixed
- **The complex tier no longer lets a noise-level capability edge override a
  real cost difference.** `qwen3.8-max` (58.4 agentic index, $0.91/task)
  outranked `glm-5.3-flash` (58.2, $0.087/task) — over 10x the cost for a
  0.34%, almost certainly-noise capability lead — because price only broke an
  *exact* tie. A gap within `AA_CAPABILITY_TIE_MARGIN` (1.0 points) is now
  treated the same as an exact tie and broken on price; a real gap still wins
  outright. `glm-5.3-flash` is Pareto-undominated across the whole AA
  catalog — nothing beats it on both capability and cost — which is what
  made the old ranking's outcome wrong rather than merely debatable.
- **Adding a model to an existing config no longer skips ranking.**
  `reconcileTierList` (`sonata init`'s tier merge) always appended a
  newly-added model after every model already in `[tiers]`, regardless of how
  it actually compared — a model that `sonata catalog`'s capability-per-dollar
  ranking would put first landed last, tried only after every existing
  candidate had already failed. It now inserts the new model at the rank the
  fresh proposal gives it relative to the models already kept, without
  reordering anything the user (or a prior run) already ranked.

## [0.5.0] - 2026-09-02

### Upgrading

**Existing native-path installs need one command after upgrading:**
`sonata litellm install`. Sonata now runs its own pinned LiteLLM rather than
whatever `litellm` happened to be on `PATH`, and `sonata serve` refuses to
start — naming that command — rather than silently using a version its
behaviour was never measured against. `sonata doctor` reports the same thing.

Two configs need nothing at all: one whose gateways all speak the Anthropic
Messages API natively (no LiteLLM is used, so none is required), and one that
does not use the native path.

`wire_format` is superseded by `provider` but still parses, so no config edit
is required. `sonata init` writes the new key from now on.

### Added
- **Sonata manages its own LiteLLM, and often needs none at all.** A gateway now
  declares a `provider` (superseding `wire_format`), and the transport is
  derived from it: a gateway that speaks the Anthropic Messages API natively is
  reached **directly by sonata's own router, with no LiteLLM in the path** —
  which also keeps `cache_control` that the LiteLLM path discards on every tier
  request, and round-trips `redacted_thinking` byte-identical. A config whose
  routable models all sit on such gateways needs no LiteLLM, no venv and no
  Python whatsoever. `pip install 'litellm[proxy]'` is no longer a step anyone
  performs by hand.
- **`sonata litellm install|status`.** When LiteLLM *is* needed, sonata installs
  its own venv at `~/.config/sonata/litellm`, pinned to exactly `1.98.0` — the
  version every LiteLLM behaviour recorded in `CLAUDE.md` was measured against.
  The install is atomic: any existing venv is moved aside and restored if the
  install throws, so a network failure leaves `missing` (which has a working
  repair) rather than a half-built environment, and a failed upgrade does not
  cost you the working install you had. `uv` is used when present (seconds, and
  it can fetch a conforming interpreter); `python3 -m venv` otherwise, and both
  run against one test suite. `sonata init` offers the install, `sonata doctor`
  reports it, and **`sonata serve` never installs** — it is started headless
  from a SessionStart hook, where a silent multi-minute install is
  indistinguishable from a hang. Verified live on the pip path (29–36 s),
  producing a venv whose `litellm --version` really answers `1.98.0`; `doctor`
  reports `broken` — not `ok` — for a venv whose interpreter has gone, which is
  the failure a file-exists check cannot see.
- Each gateway's own LiteLLM provider prefix is emitted (`gemini/<id>` for a
  Google gateway rather than `openai/<id>`), so a request reaches the vendor's
  native API instead of a compatibility shim — which is where vendor-specific
  state such as Gemini's `thought_signature` has nowhere to live.

### Changed
- `sonata doctor`'s LiteLLM check reports one of six states, each naming its own
  repair. It previously printed `not found — pip install 'litellm[proxy]'` for
  every cause, including the one where nothing needs LiteLLM at all — where the
  correct answer is that its absence is fine, not that something is broken. A
  LiteLLM on `PATH` is now reported as information and explicitly not used:
  `which litellm` resolving says a script exists, not that an importable
  LiteLLM does.


## [0.4.1] - 2026-09-01

### Fixed
- **A model that rejects every request no longer absorbs its whole tier.** A
  400 was returned as the answer and never cooled the candidate down, so a
  permanently-broken model stayed the first non-cooling candidate forever and
  killed every agent that reached it — retry could not recover, because the
  failure never earned a cooldown. Observed live: `gemini-3.7-flash` rejects
  every multi-turn tool-use request (LiteLLM does not preserve Gemini 3's
  `thought_signature`), and once the candidates ranked above it were cooling it
  took four consecutive requests and two agents with it. The symptom read as
  "the model is flaky".

  A 400 is now told apart by *fingerprint*, not by status: a recognised
  capability failure repeated three times consecutively cools the candidate,
  and everything else is still returned to you with its body intact, because
  only you can tell a genuine client error from a broken model.
- **`sonata route off` now recovers a project whose routing is pinned on.** A
  subagent killed before its `SubagentStop` hook leaves its id in
  `.sonata/route-subagents.json`; the count never returns to zero, routing
  stays on, and every session launched afterwards loses Remote Control. The
  documented recovery did not recover — it cleared the session registry and the
  env but left the subagent registry untouched, so the pin survived its own fix
  and the next `SubagentStart` took the count 6 → 7, never 0.
- **Two registry defects that produced that pin from ordinary use.** The writer
  and the cleaner of `route-subagents.json` defaulted to *different scopes*, so
  a caller omitting `scope` wrote one file and cleared another. And the two
  guarded that one file with two *different* locks, which exclude nothing: a
  `SubagentStart` could read the pre-clear list, pause, and write it back after
  a cleanup, restoring every id the cleanup had just erased.

### Changed
- `tests/commands/tail.test.ts` waits for tmux to render rather than sleeping a
  fixed 100 ms. The flake blocked an `npm publish`, and `prepublishOnly` runs
  this suite — a release gate that fails on timing rather than on correctness
  teaches you to re-run a red suite instead of read it.

## [0.4.0] - 2026-08-31

### Added
- Generated agents can spawn subagents of their own. Write-capable roles
  already inherited the agent tools, since they carry no `tools:` line at all;
  read-only roles are now granted them explicitly (`Agent, Task, Workflow` —
  `Task` is the pre-rename alias, and a stale name in an allow-list matches
  nothing).

  Read-only agents also carry a `## Delegating` section telling them to
  delegate only to other read-only roles, because delegating to a `code-*`
  agent writes to the repository through it. **That is guidance, not
  enforcement**: `tools:` frontmatter grants tools, not permitted argument
  values, so nothing stops a read-only agent from naming a write-capable
  subagent. Nothing bounds recursion depth either — see Known Limitations in
  `CLAUDE.md` for the full shape of what is unguarded.
- `sonata init`'s tier screens take `A` to accept the ranking every remaining
  screen would have opened with, so four roles no longer cost eight
  near-identical confirmations. It is not a shortcut past the picker: it
  applies the same seed-then-filter the screen itself applies, so a model
  whose provider is deselected is dropped exactly as confirming would drop it.
- `npm run release -- <version>` prepares the release commit and its tag from
  the `[Unreleased]` section above, and `release.yml` publishes on the pushed
  tag using npm trusted publishing (OIDC) with provenance — no long-lived
  token in repository secrets.

### Changed
- `src/commands/init.ts` went from 1502 lines to 184, decomposed into a
  pipeline under `src/init/` (discover → interactive/scripted state → validate
  → plan → apply). Every write is expressed as one `InitPlan` value and all
  I/O is confined to `apply`, so what the wizard is about to do can be
  inspected without performing it.
- `sonata doctor` now says *why* tier routing is not detected rather than only
  what to run. Five states printed one sentence naming the fix; the one that
  bit in practice was hooks belonging to a *different* sonata install, where
  the advice was to run the command that was already correctly applied.

### Fixed
- `sonata init`'s confirm summary counted agent files as roles × models, a
  rule `sonata sync` does not use — a four-role config on two models was
  promised 8 files and given 4, on the one screen whose purpose is to say what
  is about to be written. `tiersCollapse` is now the single definition shared
  by the code that writes the files, routes to them, and counts them.
- A gateway whose API key was typed during `sonata init` was reported as
  having none, immediately above the line confirming the key had been stored.
- The models step could not be used at the size it reaches in practice: the
  picker filters as you type and shows a `Filter:` field, but its footer never
  said so, and on a 396-model list that is the difference between a usable
  list and an unusable one. It now also shows how many are selected, and
  labels the bulk toggle with what it will act on.
- Confirming a tier screen with nothing selected did nothing at all, against a
  footer promising `enter confirm` — indistinguishable from a hang.
- `Write these changes?` was asked on a cleared screen, because the prompt
  draws in the alternate screen buffer and hid the summary printed just above
  it. The prompt now carries its own copy of what it is asking about.
- `sonata usage` printed a nameless row for requests that never resolved a
  model, and misaligned every column once a model key exceeded 30 characters.

## [0.3.4] - 2026-08-29

### Fixed
- `sonata init` wrote `avoid_gateways` *after* the `[models."…"]` tables, and a
  bare TOML key belongs to the table above it — so the key became a field of
  the last model entry and `parseConfig` never saw it. The setting was written,
  silently ignored, and the next `sonata init` re-proposed the very ordering it
  exists to prevent. `sonata doctor` reported no failures throughout.

  If you set `avoid_gateways` on 0.3.3 and have run `sonata init` since, check
  that the key sits at the very top of `sonata.toml`, above every `[table]`
  header; move it there if not.

## [0.3.3] - 2026-08-29

### Added
- `avoid_gateways` — a top-level list of gateway names whose models rank
  *last* within every tier. Ranking optimises capability per task-dollar and
  knows nothing about whether a gateway is reliable, rate-limited, or simply
  one you would rather not send work to; the only remedy was reordering
  `[tiers]` by hand, which the next `sonata init` re-proposed away.

  It demotes rather than excludes, so those models stay as fallback
  candidates and avoiding a gateway costs preference rather than the depth a
  ranked tier exists to provide. A name matching no gateway is refused at
  parse time — the setting's failure mode is that its absence is invisible, so
  a typo would otherwise read as "not avoided".

  ```toml
  avoid_gateways = ["flaky-gw"]
  ```

## [0.3.2] - 2026-08-29

Tier ranking, mostly. Tiers were ordered on a coding index and a per-1M price
that almost never matched a model; they are now ordered on how well a model
does *agentic* work and what one task actually costs.

### Added
- `sonata doctor` reports the ranking catalog's freshness, and says when there
  is none. Advisory rather than blocking — a stale catalog still produces
  tiers, just from superseded scores, so the failure is a silently wrong
  ordering rather than an error.

### Changed
- Tiers rank on Artificial Analysis's **agentic index** and **cost per task**,
  read from their free `language/models` endpoint. Every sonata role runs as an
  agentic subagent driving tools in a loop, which the agentic index measures
  more closely than a coding score; and cost per task prices the *work* rather
  than the tokens, where a per-1M rate says nothing about how many tokens a
  model spends reaching an answer.
- **`simple` now ranks by capability per task-dollar**, where it used to take
  the most capable model that happened to be cheap — backwards for a tier whose
  purpose is cost. `complex` still ranks by raw capability. A relative floor
  (0.75 of the best model you selected) keeps a very cheap, very weak model from
  winning on ratio alone.
- `sonata catalog update` fetches every page of the paginated endpoint and
  refuses a response whose intelligence-index version changes mid-fetch, since
  two versions are not comparable scales.

### Fixed
- Codex models are declared as not supporting system messages. The Codex
  backend refuses any `role: system` with
  `{"detail":"System messages are not allowed"}`, and LiteLLM's chatgpt
  provider does not normalise it — [BerriAI/litellm#22968](https://github.com/BerriAI/litellm/issues/22968)
  reports exactly this and its fix, PR #22967, was closed without merging.
  Flattening the system block array was necessary but not sufficient; the two
  now work as a pair.
- Model names are matched against the catalog by stripping the provider
  prefixes actually in your config, not a hardcoded list. Any gateway nobody
  had thought to hardcode fell through to "capable, not cheap" and dropped out
  of the simple tier — and when no model clears the cheap bar, simple mirrors
  complex and the tier stops discriminating at all. On a real 17-model config
  the simple tier went from 2 models to 7.
- The tier ranking screen for a role's *second* tier opened with nothing
  ranked and could not be confirmed, trapping the wizard. It only happened when
  no tiers were saved yet — that is, on a first run.

### Notes
- Ranking is no longer per-role: one agentic measure serves all four roles, so
  `sonata init` proposes the same tiers for each. Per-role `[tiers]` lists are
  still honoured, and can still be ranked differently by hand.
- An existing `[tiers]` is never overwritten by a changed proposal — saved
  rankings win. To adopt this one, remove `[tiers]` from `sonata.toml` and
  re-run `sonata init`.

## [0.3.1] - 2026-08-28

Almost entirely `sonata init`: the wizard now asks providers what they serve
rather than trusting a cached harness catalogue, and stops offering the same
credential twice.

### Added
- The models step asks each gateway what it actually serves
  (`GET <base_url>/models`) instead of trusting the harness catalogue, which
  keeps listing models a gateway has dropped and misses ones it has added.
  A gateway that does not answer — unreachable, no key, OAuth, timed out —
  keeps its harness list, so a failed refresh degrades to the previous
  behaviour rather than emptying the picker. Models already listed keep their
  existing key, so a refresh never silently deselects what you had chosen.
- The import screen names the harness each provider came from
  (`acme · via opencode · key from sonata`). It matters because providers
  are deduped by name: several harnesses can serve one, only the first is
  shown, and it is that one's credential the import uses.

### Fixed
- `init` offered one provider per harness rather than one per credential, so
  the same ChatGPT subscription appeared twice — once as `codex`, once as
  opencode's `openai`, whose entry is the identical OAuth credential. Picking
  both wrote one subscription as two gateways serving overlapping models under
  different keys, doubling the generated agents. The canonical provider is now
  kept per OAuth kind, and only when it is actually offered, so a machine with
  opencode and no codex still reaches ChatGPT.
- Re-entering an already-configured provider's name under "Add a custom
  provider" dead-ended on `"<name>" is already a provider`, with no route back
  to that provider. It now redirects into re-entering its credential.
- A gateway no harness discovers any more (unlinked from opencode, say) could
  not be re-authenticated through the wizard at all; its base URL now falls
  back to the one already recorded in `sonata.toml`.
- A tier-ranked model whose provider had been deselected was resurrected by
  merely confirming the tier screen.
- A gateway named in `sonata.toml` was credited to a harness whose provider
  name only coincidentally matched, pre-selecting a harness that was never
  chosen and could not be unticked.

### Notes
- Codex and Copilot are deliberately excluded from the live refresh: their
  credentials are OAuth, not bearer keys, and neither serves an
  OpenAI-shaped `/models`. Codex's catalogue already comes from
  `codex app-server`'s `model/list`, so it is live by another route.

## [0.3.0] - 2026-08-28

### Fixed
- `sonata route auto` degraded into `sonata route on`. Routing turned on at
  SessionStart and off only when the *last* registered session ended, which
  with overlapping sessions is never — so the settings file stayed dirty and
  every session after the first launched into it and lost Remote Control,
  which is the one thing auto mode exists to prevent. Routing now follows the
  foreign-model subagents that actually need it: a `SubagentStart` /
  `SubagentStop` hook pair, matched to sonata's own agents, turns it on for
  the duration of a run and off again after. Sessions launch — and stay — in
  a clean file unless a foreign model is working.
- `autoInstalled` now requires all four hooks, so an install predating the
  change is reported by `sonata doctor` as stale rather than working. It
  would otherwise carry only the session pair and never route at all. Fix by
  re-running `sonata route auto`.
- `sonata restart` could report false success against a stale daemon still
  holding the router port: `startServeDaemon` accepted any healthy sonata
  router as proof its own spawn had bound. It now generates a random instance
  id, hands it to the child it spawns, and waits for a router reporting that
  exact id — never a stale survivor. `stopServe`'s dead-end refusal (a router
  with no recorded pid) now prints an actionable `kill <pid>` suggestion via
  a print-only `lsof -ti:<port> -sTCP:LISTEN` lookup; sonata still never
  kills a pid it did not itself record.

### Added
- `sonata usage`, `sonata status` and `sonata runs`, over a new append-only
  ledger the router writes (one JSON line per request, daily files under
  `~/.config/sonata/usage/`, 30-day retention).
- Per-model and per-gateway price tables in `sonata.toml`, with optional UTC
  time windows for providers that charge different rates off-peak.
- `sonata catalog update` also caches per-token rates from ai-pricing.fyi.

### Notes
- `sonata usage` measures the native path only; `sonata dispatch` runs never
  transit the router and cannot be measured.
- Unpriced volume is reported separately and never summed into the total.

## [0.2.1] - 2026-08-26

### Fixed
- `sonata init`'s "Import from other harnesses" screen pre-ticked a
  candidate by bare provider name, not by its exact `<harness>/<provider>`
  key — so if the same provider name was configured through one harness
  (e.g. opencode), a different harness's row for that same name (e.g. Pi)
  showed as pre-selected too, every run, with no way to make it stick
  unticked. Fixed by matching on exact key (`alreadyImportedKeys`,
  `src/tui-ink/app-state.ts`).
- The model-registry restart snapshot in `sonata serve` only hashed
  `unifiedModels`, so a gateway-only edit (`base_url`/`wire_format`/`auth`/
  `credential_source`) or an edit to a legacy `[native.models]` entry's
  `id`/`gateway` never triggered a LiteLLM restart. Now hashes
  `native.models` and `native.gateways` too.
- `deriveInitState`'s `roles` returned `[]` (not `undefined`) for a
  native-only unified config with neither `[tiers]` nor a legacy
  `generate.native` table, which `sonata init --yes` read as "zero roles
  selected" and refused with "no roles selected". A related gap in the
  same code path — the `configuredGateways` scan only read legacy
  `[native.models]`, never `unifiedModels` — meant such a config's gateway
  was rejected as unknown before role selection was ever reached.
- `configNativeCandidates` returned only unified or only legacy model
  candidates depending on which was non-empty, silently dropping a
  legacy-only key from a transitional config that has both. Now merges
  the two, scoped to untiered configs only — `parseConfig` mirrors every
  unified model into `native.models` whenever `[tiers]` is present, so
  treating that projection as independent legacy data on a *tiered*
  config would have shadowed each model's own harness routing.
- `RankedSelect`'s caller-supplied footer (e.g. the Artificial Analysis
  attribution line) replaced the `space`/`[ ]`/`enter`/`back`/`esc`
  control legend outright instead of appearing alongside it, making the
  tier-ranking screen's own controls undiscoverable whenever a footer was
  set.
- The bounded exit wait added for the model-registry restart escalates to
  `forceKill` (SIGKILL) once and gives up rather than hanging
  `litellmReady` forever against a LiteLLM child that ignores SIGTERM.
- `activeModelsJson` (now `activeNativeSnapshot`) is committed only after
  the replacement LiteLLM config and credentials are prepared
  successfully — a gateway added before its credential was available used
  to mark the change "handled" regardless, so fixing the credential
  afterward never retried the restart.

### Docs
- Added release dates to every CHANGELOG entry; linked it from the
  README, with a version badge.
- Tagged and released `v0.1.0` and `v0.2.0` — both had bumped
  `package.json` but were never tagged, so GitHub's Releases page had
  been stuck reporting `v0.0.3` as latest.

## [0.2.0] - 2026-08-25

Tier routing: agents are now generated per role × difficulty tier, backed by
a ranked model list the native router tries in order — with a CLI fallback
to the model's own harness when every native route fails. The MCP server is
removed.

### Added
- **Tier agents.** `sonata init`/`sonata sync` generate one agent per role ×
  tier (`code-simple`, `code-complex`, `review-simple`, …) instead of one per
  role × model. Each agent's frontmatter names a router alias
  (`model: sonata-code-simple`), not a specific model. A role whose `simple`
  and `complex` lists are element-wise identical collapses to a single agent
  (`sonata-code`).
- **Unified `[models]` + `[tiers]` config.** A `[models."<key>"]` entry can
  carry a native route (`gateway`/`id`/`context_window`), a harness route
  (`harness`/`harness_id`), or both — one model reachable two ways.
  `[tiers.<role>]` is `{ simple: [...], complex: [...] }`, ranked by
  position. `resolveTierAlias`/`harnessModelFor` (`src/config.ts`) resolve an
  alias to its ranked routes.
- **Ranked native fallback in the router.** `sonata serve`'s router resolves
  a `sonata-<role>-<tier>` alias against `[tiers]` and tries each native
  candidate in rank order, skipping one in a 60-second post-failure
  cooldown. The first response that isn't ≥500 or 429 (rate-limited) goes to
  the client; every candidate exhausted returns 529 naming the CLI fallback.
- **`sonata dispatch`** — a blocking CLI (`--tier <role>-<tier>` or `--model
  <key>`) that tries each harness-routed candidate in rank order, moving to
  the next on a thrown launch, a degraded finish, or an empty report.
  Replaces the MCP `dispatch`/`wait`/`approve` tools entirely: the same
  three verbs now exist as Bash commands
  (`Bash(sonata dispatch|wait|approve:*)`), allow-listed the same way.
- **Model catalog.** `normalizeModelName`, a curated capability/cost table,
  and `proposeTiers` (`src/catalog.ts`) rank a role's selected models into
  `simple`/`complex`. `sonata catalog update` optionally refreshes the
  ranking from a user's own Artificial Analysis API key
  (`sonata auth add artificialanalysis`) — coding index for capability,
  blended price for cost. Never bundles or redistributes Artificial
  Analysis's own data.
- **Legacy config migration.** A config still in the pre-tier
  `[generate.roles]`/`[generate.native]` shape is migrated automatically the
  next time `sonata init` runs (`migrateLegacyConfig`, `src/normalize.ts`) —
  every model and role assignment carries through, including a harness-only
  model with no native route. `sonata doctor` warns on a config that hasn't
  migrated yet.
- **`sonata route --global`.** `on|off|auto|manual|status` all take a
  project or machine-wide scope now, writing to `~/.claude/settings.json`
  instead of the project's `settings.local.json`. The session registry
  stays per-project regardless of scope.
- **`sonata-loop` skill** (`skills/loop/SKILL.md`) — plan a feature, route
  each task to a tier by difficulty, gate behind review with an
  escalate-to-`complex`-after-two-failures rule, final review. Installed by
  `sonata init`.
- **`sonata serve` respawns its LiteLLM child** if it exits on its own,
  instead of leaving the router answering every request with a dead
  upstream until someone notices and runs `sonata restart` by hand. A
  crash-loop guard (5 respawns/60s by default) gives up and logs why rather
  than respawning forever against a genuinely broken gateway.
- `sonata doctor` gains checks for a tiered config with no routed session,
  a legacy (pre-`[tiers]`) config, and a stale `.mcp.json`/`~/.claude.json`
  registration of the now-removed MCP server.

### Changed
- `sonata init`'s tier-assignment step (`RankedSelect`,
  `src/tui-ink/components/ranked-select*`) replaces the old "same models for
  every role?" choice and per-role model picker: selection order **is** the
  ranking, seeded from the cached Artificial Analysis catalog when one
  exists, else built-in defaults.
- A 429 from a native candidate is now treated as a retryable failure
  (cooldown + fallback), not returned to the client as if healthy.

### Removed
- **The MCP server** (`src/mcp/`) is deleted entirely — `dispatch`, `wait`,
  and `approve` are Bash commands now, not MCP tools. `sonata mcp` no
  longer exists as a command.

### Fixed
Found via a live smoke test and an automated PR review, both against this
same change:
- `sonata init --routing project|global|skip` was accepted by the wizard's
  state but the CLI never parsed the flag.
- `sonata dispatch` discarded the real reason a launch or wait failed,
  showing only an opaque `FAILED (degraded)`; the caught error's message is
  now recorded per attempt and printed.
- `sonata dispatch` re-opened a full wait window on every `RUNNING` result
  instead of returning control to the caller, so `sonata wait <id>` was
  unreachable and a dispatch could block indefinitely.
- `sonata dispatch` fell through to the next harness candidate when
  observing a successfully-launched run failed, risking two harnesses
  concurrently modifying the same working tree.
- `sonata dispatch --tier sonata-code-simple` (prefixed form) derived the
  role by splitting the raw option, yielding `"sonata"` instead of `"code"`.
- A unified `[models]` entry's `gateway` was never validated against
  `[native.gateways]` (unlike the legacy `[native.models]` path); an unknown
  gateway parsed fine and crashed `sonata serve` later.
- `sonata doctor`'s tier-routing check treated any `ANTHROPIC_BASE_URL` as
  routed without comparing it to the configured router port, so a stale
  port from a since-changed `[native.ports].router` still counted as
  routed.
- Re-initializing an already-tiered config silently dropped harness-only
  models (no native route) and could leave `[tiers]` referencing a model
  just deselected from the native picker, which `sonata sync` then rejected
  as an unknown model.
- `sonata restart`/`stopServe`'s startup-failure cleanup path could
  schedule a doomed LiteLLM respawn against a temp directory the same
  cleanup had just deleted.

## [0.1.0] - 2026-08-25

`sonata route auto|manual` — no-wrapper native routing that keeps Remote
Control, the first user-facing feature since 0.0.3.

## [0.0.3] - 2026-08-24

Documents the "Import from other harnesses" screen doubling as an unimport
toggle. Native-path work (subagent-model dispatch through a local routing
proxy) landed in this cycle.

## [0.0.2] - 2026-08-23

Per-gateway credential sources: `sonata auth login <gateway>` drives
LiteLLM's own device-login flow as a subprocess; `sonata init`/`sonata doctor`
ask and report where each gateway's credential comes from.

## [0.0.1] - 2026-08-11

First tagged release. Foreign-model subagents for Claude Code: dispatch a
subagent backed by OpenCode, Codex, or Pi through the ordinary Agent tool.

- Provider selection from each harness's own model catalogue.
- Machine-level config resolution (`./sonata.toml`, else
  `~/.config/sonata/sonata.toml`), with `sonata init` keeping the config and
  its generated agents in the same scope.
- Per-role models via `[generate.roles]`, replacing an earlier flat
  `roles`/`models` pair.
- Wrapper agents hold only `mcp__sonata__run`/`tail`/`approve` and no Bash;
  `sonata mcp` serves those tools over stdio; `sonata verify` confirms a run
  reached the foreign harness; `sonata doctor` checks the dispatch path end
  to end.
