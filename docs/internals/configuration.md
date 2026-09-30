# Configuration — full reference

Moved out of `CLAUDE.md` verbatim to keep that file within its size limit; `CLAUDE.md` keeps the day-to-day summary and points here.

Sonata resolves exactly one config, in this order (`configPath` in `src/config.ts`):

1. `./sonata.toml` — the current repository, wins outright
2. `~/.config/sonata/sonata.toml` — the machine

A project config **replaces** the machine one; they are never merged, so it is always possible to say which file produced a run. `sonata doctor` prints the resolved path.

**A linked git worktree resolves its main checkout's config, between those two.** `sonata.toml` is untracked, so `git worktree add` yields a directory holding none of the project's sonata state, and every command run there fell through to the machine config or to none — which is how a worktree session's native tier agents 404'd with `model_not_found` at `api.anthropic.com` instead of reaching the router (reported 2026-09-10). Borrowing sits *below* the worktree's own `sonata.toml`, because a worktree that has been given one means it, and *above* the machine config, because a checkout of this repository is this project; it also gives the worktree the same router tenant id as the main checkout, sharing its cooldowns and `[budget]` rather than splitting them. `mainWorktreeDir` (`src/git-worktree.ts`) is pure filesystem — the `.git` pointer file, then that gitdir's `commondir` — never `git rev-parse`, because `configPath` is on the router's per-request tenant-resolution path and a subprocess per request is not affordable; the `commondir` check is also what keeps a **submodule**'s `.git` file (a gitdir pointer with no `commondir`) from being read as a worktree. Every malformed shape answers "not a worktree" rather than throwing: a repository sonata cannot read must degrade to the old behaviour, not break a working command.

**Routing settings and hooks are the one thing a worktree cannot borrow.** Claude Code reads `.claude/settings.local.json` relative to its *own* cwd, so `sonata route auto` in the main checkout does not reach a worktree and sonata cannot redirect it — it must be run in the worktree itself. `sonata doctor` says exactly that, naming the main checkout (`borrowedWorktreeConfigDir`, checked before every hook diagnosis, since in a fresh worktree they all reduce to "nothing is installed" and none of them says why).

```toml
# sonata.toml
schema_version = 1                  # which shape this file is in

[models."flash"]
gateway = "acme"                    # native route: resolves through the router
id = "deepseek-v4-flash-0731"
context_window = 128000

[models."kimi-k3"]
harness = "opencode"                # harness route: sonata dispatch falls back to this
id = "openrouter/kimi-k3"

[native.gateways."acme"]
base_url = "https://gateway.acme.example/v1"

[tiers.code]
simple  = ["flash", "kimi-k3"]       # ranked — first is tried first
normal  = ["flash", "kimi-k3"]       # optional; absent is valid, empty is refused
complex = ["kimi-k3", "flash"]

[tiers.review]
simple  = ["kimi-k3"]
normal  = ["kimi-k3"]       # optional
complex = ["kimi-k3"]

avoid_gateways = ["flaky-gw"]   # rank this gateway's models last, but keep them as fallbacks

[budget]
daily_usd = 25                 # this PROJECT's priced spend per UTC day; the
                               # machine config's own cap bounds everything the
                               # router forwards, and each refusal names its file

# [native.ports] belongs in the MACHINE config only — one router serves every
# project, so a project's own ports are ignored (`sonata doctor` warns).

[run]
tail_window_seconds   = 20     # how long `sonata tail` blocks per call
stall_timeout_seconds = 120    # silence before a run is reported STALLED
run_timeout_seconds   = 1800   # hard cap; the run is killed at this point
dispatch_window_seconds = 1500 # blocking window for sonata wait/dispatch
```

- **`schema_version` stamps the shape, and migration runs on load** (`src/migrations.ts`). `parseConfig` reads the stamp off the raw TOML, walks the file forward through an ordered chain **before** any field-level validation, and records the pre-migration number as `SonataConfig.schemaVersion` — read after migrating, it would always answer "current", and `sonata doctor` could never report a file as behind. A stamp *newer* than `CURRENT_SCHEMA_VERSION` is **refused**: a best-effort parse of a future shape does not fail, it succeeds and means something else. Absent means version 0, which is a real version, not a malformed file; a present-but-nonsense value is an error, because reading it as 0 would migrate a file whose author believed it was stamped. Migration is **in-memory only** — `sonata init` is the sole writer of `sonata.toml` (`sonata sync` regenerates agents and never touches it), so no read-only command rewrites your config. The chain ships **empty on purpose**: v1 names the shape `parseConfig` already accepts, so a v0 file needs no transform to load, and inventing one would risk the path that already works. `applyMigrations` takes the list as a parameter so composition is proven against a synthetic chain rather than asserted about an empty one, and it advances past a version with no step rather than looping forever. The stamp is written **above every table header** for the same reason `avoid_gateways` must be — a bare key after one belongs to *that table*.
- **`[budget] daily_usd` is a ceiling the router enforces, and it is honest about what it cannot see** (`src/budget.ts`). A cap in a *project's* config bounds that project's priced spend; one in the *machine* config bounds everything the router forwards; both are checked per request and whichever is reached refuses, naming its own file. Before forwarding *anything* — checked at the top of `routeRequest`, above both the tier and direct branches, since a cap enforced on one of two paths is not a cap — the router sums the ledger's **priced** rows for the current UTC day and refuses at or past the cap with a 429 naming the cap, the spend, and the file to edit. Both halves are re-read per request, so raising the cap frees the router without `sonata restart`. Two limits are stated in the refusal itself rather than papered over: it counts **priced volume only** (the ledger reports unpriced volume separately and never folds it in as zero, so a cap that only sees the priced part can be exceeded — counting unknown as zero would make it quietly permissive in the case the user is least able to notice), and it counts a **`sonata dispatch` run only once it finishes** (its tokens are read from the harness's store afterwards and land in the same ledger, so both lanes count toward one cap; `sonata dispatch` refuses to launch once a cap is reached, `dispatchBudgetStatuses`, but cannot stop a run midway, so one run can carry spend past the cap). The refusal is deliberately *not* written to the ledger: a row records a request the router forwarded, and putting avoided spend into the store that defines spend is how the number stops meaning what it says. Absent `[budget]` means no cap; a non-numeric or non-positive `daily_usd` is **refused at parse time**, because a cap's only visible effect is a refusal that has not happened yet, so one silently dropped for being the wrong type reads exactly like one that is working. No forecasting, no per-role split, no auto-tuning — those need usage data nobody has measured yet.
- **`[models."<key>"]` is unified: a native route (`gateway`/`id`/`context_window`), a harness route (`harness`/`harness_id`), or both** (`UnifiedModelConfig`, `src/config.ts`) — one model can be reachable two ways: natively through the router, and as a `sonata dispatch` fallback candidate through its harness. `harnessModelFor(config, key)` maps a unified entry's harness half onto the shape `cmdRun` already consumes, so a unified-only key dispatches with no legacy `[models]` entry needed.
- **`[tiers.<role>]` is `{ simple: string[], normal?: string[], complex: string[] }`**, keys into `[models]`, ranked — position is priority, not a separate field. `resolveTierAlias(config, "sonata-<role>-<tier>")` resolves an alias to its ranked routes (`TierRoute[]`, each `{ key, native?, harness? }`); `normal` is optional: absent is valid and preserves the old behavior, while present-but-empty is refused at parse time. `sonata-<role>-normal` resolves only when `normal` is present and never substitutes another tier; it collapses to the unsuffixed `sonata-<role>` alias only when every present list is *element-wise* identical (same models, same order) — a role whose tiers differ even slightly keeps the explicit aliases live. `simple` and `normal` share a value ranking (intelligence index / cost per task), with `simple` filtered to a cost cap of `SIMPLE_COST_CEILING` (12) times the best-value model cost; `complex` ranks by capability. `simple` is a cost-capped *subsequence of the value order* — not a prefix: value is not monotonic in cost, so the filter can skip an over-ceiling candidate and keep a cheaper one behind it. Truncating at the first over-ceiling candidate would make it a prefix and drop qualifying cheap models, which is what the tier exists to hold. It is **not** a subsequence of `normal`, which leads with the frontier's knee before the rest of the value order: where the knee is under the cap, `simple` leads with the best-value model and `normal` with the knee.
- **`parseConfig` refuses *mixing* `[tiers]` with legacy `[generate.roles]`/`[generate.native]`** in the same file — not refusing a legacy-only config outright, since that would brick every existing install the moment this shipped. A legacy config still parses (with a `sonata doctor` warning pointing at `sonata init`) until it's migrated; a migrated config cannot re-grow the old tables.
- **A legacy config migrates automatically** (`migrateLegacyConfig`, `src/normalize.ts`, run by `cmdInit` whenever it loads a config with `generate` data and no `[tiers]`): every `[native.models]` entry becomes a unified native-routed entry; every legacy harness entry becomes a harness-routed entry keyed by `normalizeModelName(key)` — merged onto a native entry when its `id` normalizes to the same upstream (one model, two routes), or kept under its original un-normalized key when two *different* models would otherwise collide on the same normalized name (verified: never silently merges two different models). `[tiers.<role>]` is seeded native-first from `generate.native` + `generate.roles`, deduplicated. A harness-only model with no native counterpart — invisible to the current native-candidate picker — is still carried through into the rewritten config rather than silently dropped.
- **Keys are always quoted.** An unquoted `[models.grok-4.5]` nests as `models → "grok-4" → "5"` and silently stops describing the model it names. Every key and value is written through `tomlKey`, which also escapes control characters. This includes `credential_source` on `[native.gateways]`: its values are `sonata`, `codex`, and `opencode`; when absent, today's credential resolution is unchanged. `parseConfig` refuses `credential_source = "codex"` with `auth = "api-key"` because a Codex subscription is not a bearer API key and the metered endpoint authenticates before failing on quota — see `docs/guide/codex-subscription.md`. Native API-key gateways may also set `wire_format` to `openai` (the default) or `anthropic`; it is refused on OAuth-auth gateways and supports fully custom providers entered through `sonata init`'s Add provider flow.
- **The key is `<harness>-<provider>-<model>`, slashes flattened to dashes**, and doubles as the agent filename (`code-<key>.md`). The harness segment is load-bearing: pi and opencode can serve the identical ref. Flattening is *not* injective (`opencode/go-x` and `opencode-go/x` collide), so `init` checks the keys it is about to write.
- **Ids are provider-qualified for opencode, pi and reasonix**, bare for codex; `parseConfig` enforces this per harness. Picker rows are labelled `<harness>/<provider>/<model>` (`refLabel`), because opencode and pi can serve the identical `provider/model` — labelling by ref alone printed two identical rows that also shared a selection value.
- **Each role chooses its own ranked model list, per tier,** through `[tiers.<role>]`; `sonata sync` generates only tier agents when `[tiers]` is set (skipping legacy per-model generation entirely) — one agent per role × present tier, up to 12, or one collapsed agent when all present lists are element-wise identical. Generated descriptions make `normal` the default and use observable criteria: `simple` is specified closely enough to implement without a question, `normal` needs surrounding-code judgment, and `complex` needs a design decision or has an ambiguous definition of done. They state that size is not difficulty.
- **`tiersCollapse` (`src/config.ts`) is the single definition of "element-wise identical".** Three call sites had each rebuilt that predicate — `cmdSync`, which *writes* the agent files; `resolveTierAlias`, which *routes* to them; and `sonata init`'s confirm summary, which *counts* them. The third had rebuilt it as roles × models, so a four-role config on two models promised 8 files and `sync` then wrote 4 — wrong on the one screen whose entire job is to say what is about to be written. Comparison is ordered, because a tier is a ranking: the same models in a different order are a different fallback chain.
- Four roles ship: `code`, `review`, `explore`, `plan`. The last three are read-only, enforced by the harness (read-only sandbox on codex, tool allowlist on pi, read-only agent on opencode, `dontAsk` on reasonix); a read-only native tier agent can delegate writes through a `code-*` subagent, guarded only by prompt text.
- `sonata init` discovers OpenCode, Pi and Reasonix models (reasonix's catalogue and its per-provider auth state both come from `reasonix doctor --json`). Codex has no provider dimension and is added by hand; hand-written entries survive `sonata init`, which carries through any model whose harness it does not manage.
- **BYOK: a provider can be named directly, with no harness installed.** `init`
  offers ~30 well-known providers from `WELL_KNOWN_PROVIDER_URLS` as a `byok`
  pseudo-harness, alongside the existing `config` one — both bypass the harness
  filter in `providersForHarnesses`, which is what makes the zero-harness case
  work. A provider a harness already covers gets no BYOK row, so it is never
  offered twice. Having no harness is a **warning**, not the blocking error it
  used to be; that downgrade is where the zero-harness claim actually lives.
  - Models come from `GET <base_url>/models` (`src/native/models.ts`), which
    returns a `FetchModelsResult`, not a bare list. **Only 401/403 map to
    `unauthorized`** — that is the one failure whose fix is a different key, so
    it gets its own screen offering a re-prompt. 404, 429, non-JSON and a
    payload with no `data` array stay on the manual-ids path: a provider with no
    `/models` endpoint has nothing wrong with its key, and re-prompting there
    misdiagnoses in the opposite direction from the bug the split exists to fix.
    Fetched ids run through `isAnthropicRoutedName` for the same reason harness
    candidates do.
  - **The rejection screen must keep a way past itself.** Some providers 403 a
    key that is fine for inference, so "keep it and type ids by hand" sits
    beside "re-enter the key"; forcing the retry would trap that user in a loop.
    The retry carries an `attempt` counter because retyping the *same* key
    changes no effect dependency — and a retry usually is the same key, typed
    again by someone who believes they mistyped it.
  - **Keys are written once, after the confirm gate.** They live in
    `InitState.byokKeys` in memory only — `runInitTui` renders in-process and
    serializes nothing — so a cancelled wizard leaves no credential behind.
    There is deliberately **no `--key` flag**: it would put a credential in argv
    and shell history. The scripted path requires `sonata auth add <gateway>`
    first and refuses by name if the key is missing.
  - `byokCandidateKey` is exported and shared rather than inlined: the wizard
    puts the key into `nativeKeys` and `cmdInit` looks the candidate up by it,
    so two copies of the formula is how the two stop agreeing.
- **A gateway unattributable to a single harness is offered as `config/<gateway>`.**
  `deriveInitState` (`src/init/helpers.ts`) names a gateway `config/<gateway>` when
  no harness offers it *or* when more than one distinct harness does — both are
  equally unattributable, since a bare gateway name in `sonata.toml` doesn't record
  which harness's discovery produced it (e.g. opencode and pi both separately
  cataloguing the same public gateway, verified live). The discover phase
  (`src/init/discover.ts`) synthesizes that row for both cases; previously it
  synthesized only the absent case, so an ambiguous gateway produced a
  `providerKey` that `offered` never contained, and scripted `sonata init --yes`
  rejected it as unknown before role selection was even reached. Crediting
  every overlapping harness would be just as wrong — it pre-selects a harness
  the user never actually chose, with no way to make it stick unticked.
- **A prompt must `ref()` stdin while it waits** (`src/tui.ts`, `readKeys`). A
  paused stdin's handle is *unreferenced*, so waiting on a keystroke is not work
  node knows about: with nothing else pending the process exits, code 0,
  mid-prompt. Nothing paused stdin before the Ink wizard existed; Ink pauses it
  on unmount, so **every prompt after the wizard died the instant it was
  drawn** — prompt on screen, shell back, exit 0, nothing written. That was
  "sonata init never saves the config", and it left no error because there was
  no error. `unref()` on the way out, or the last prompt hangs instead.
- **`sonata init` writes a log** (`src/commands/init-log.ts`) to
  `~/.config/sonata/logs/init-<timestamp>.log`, newest ten kept. The wizard owns
  the screen — Ink repaints and the list prompts use the alternate buffer, which
  is discarded on exit — so a run that dies mid-wizard otherwise leaves a
  restored shell and no trace. Every printed line is teed there, along with the
  resolved selections and any error. Keys are recorded as the gateway they
  belong to, never as their value. `cli.ts` prints the directory when a run
  fails or cancels. Logging never throws: an unwritable home degrades to
  `nullInitLog` rather than failing the command it was meant to explain.
- **A `model` argument on the Agent tool silently defeats tier routing.** Each
  generated agent pins its routed alias in frontmatter (`model:
  sonata-code-complex[1m]`), and the tool's own `model` parameter takes
  precedence over frontmatter — so a caller that passes one runs sonata's
  prompt and tools on a Claude model that never reaches the router. Nothing
  errors: reported 2026-09-15 after ~15 dispatches had already run that way,
  noticed only when someone asked which models were in use, and every
  "foreign-model review" in that session had been Claude reviewing Claude.
  Sonata cannot detect it — the request goes straight to `api.anthropic.com`
  and the router sees nothing — so the mitigation is text in the three places
  a caller might read: each agent's `description` (what the dispatching model
  reads while *choosing*, before the body is in context), each agent's body,
  and the managed `CLAUDE.md` block, which is the only text the calling
  session reads unconditionally. The generic multi-agent advice "always
  specify the model explicitly" is what produces this, and is wrong here: for
  a tier agent the model choice **is** the tier. A description is a plain YAML
  scalar, so the warning carries an em dash rather than the colon that reads
  more naturally — `": "` inside an unquoted scalar is a mapping.

- **A tier agent that fans out to a Claude subagent ends the lane, just as
  silently.** Observed 2026-09-16: a `code-complex` agent called Claude's own
  `Plan` (Opus), which runs, reports, and is indistinguishable from a routed
  subagent. Every generated agent therefore carries a `## Fanning out` rule
  naming the tier agent to reach for instead — `plan-complex`, not `Plan` —
  where the older `## Delegating` guard (read-only roles must not delegate
  writes) sat only on read-only roles, leaving the `code-*` agents most able to
  fan out with no fan-out guidance at all. This is prompt text for the reason
  recorded under Known Limitations: `tools:` frontmatter grants tools, not
  permitted argument values, so it can withhold `Agent` outright but cannot
  constrain the `subagent_type` passed to it. Real enforcement would need a
  PreToolUse hook on the Agent tool that can identify its calling agent, which
  has not been probed.

- **Tier agents are discovered natively but not *preferred* natively, which is
  what the CLAUDE.md guidance block exists to fix** (`src/init/guidance.ts`).
  The generated agents are ordinary `.claude/agents/*.md` files, so Claude Code
  lists them with no MCP or wrapper — but selection is the model matching a task
  against each agent's `description`, and sonata's compete there with
  `general-purpose`, `Explore` and `Plan`, every one of them broader and none
  carrying a routing precondition. Nothing sonata already wrote could state a
  preference: agent files describe what an agent *does*, and a skill is invoked
  rather than always loaded. `CLAUDE.md` is the only file Claude Code reads in
  every session unconditionally, so that is where the instruction has to live —
  in a file sonata does not own, which is what shapes the rest of the design.
  Sonata owns what is between `<!-- sonata:begin -->` and `<!-- sonata:end -->`
  and nothing else: text either side is preserved byte-for-byte, and a file
  whose markers do not pair up (or pair in the wrong order, **or repeat**) is
  **refused** rather than repaired. **Only a marker standing alone on its own
  line counts**: quoted inside a sentence it is a citation, not a container, so
  a file that merely documents the contract has no block and is appended to
  cleanly. Counting every occurrence is what let `sonata init` splice the block
  into the middle of the sentence joining the two markers — destroying the one
  paragraph that explains them, in this repository's own `CLAUDE.md` (#29), because every available repair — inventing
  an end, reading a stray marker as prose, rewriting the first of two blocks —
  can eat a paragraph the user wrote or leave a stale block contradicting the
  new one. Counting occurrences is load-bearing rather than fussy: `indexOf`
  alone splices from the *first* begin to the *first* end, and in a file shaped
  begin/…/begin/…/end that span swallows the user text between the two begins.
  For the same reason only a file that does not exist is written whole — a
  whitespace-only `CLAUDE.md` still has bytes, and replacing them is a change
  outside the markers. The
  refusal is surfaced as a warning and does not fail the init, since the config,
  agents and hook are already written and useful by then. The block names the
  routing caveat deliberately: with `route auto` upstream-blocked, an unrouted
  session's tier agent dies with `model_not_found` at `api.anthropic.com`, which
  reads as a broken agent rather than a missing `sonata code`. Scope follows the
  hook's shape — project writes the repository's own `CLAUDE.md` so the
  preference travels with the repo, global writes the user's — and `skip` is a
  true no-op that plans no path at all.
- Run `sonata sync` after editing the config; Claude Code picks up the generated agents automatically. There is no MCP server to reconnect.


## Auto-routed tiers

`[auto_route]` is absent by default. When present, `parseConfig` refuses every key other than `classifier` and `min_confidence`, refuses any classifier other than `"jev"`, and refuses a non-finite or non-numeric `min_confidence` outside `[0, 1]`. An omitted `min_confidence` loads as `0.5`. This deliberate refusal prevents a misspelled switch from appearing to work while silently disabling the feature.

`nativeTomlFor` carries the existing `[auto_route]` section through `sonata init`, including its classifier and confidence threshold. The configuration tests round-trip that emitted TOML through `parseConfig`; this is required because init rewrites the native configuration and must not delete keys it did not otherwise edit.
