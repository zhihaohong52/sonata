# Native path — full design record

Moved out of `CLAUDE.md` verbatim to keep that file within its size limit; `CLAUDE.md` keeps the day-to-day summary and points here.

The native path runs foreign models inside Claude Code's own loop, tools, and permission modes through a local routing proxy. The harness path instead runs the foreign model's own loop in OpenCode, Codex, Pi, or Reasonix.

Its `[native]` config surface describes foreign `models`, `gateways`, and their `ports`; native model keys reach a role either through a unified `[models]` entry's `gateway`, listed in `[tiers.<role>]`, or (for a legacy config not yet migrated) `[generate.native]`. `sonata serve` runs the router, plus a managed LiteLLM child when — and only when — some routable model's gateway needs translating; `sonata code` launches a Claude Code session routed through it. `sonata route on` achieves the same routing for every plain `claude` launched in the project: it writes the routing `ANTHROPIC_BASE_URL` env into `.claude/settings.local.json` and installs a SessionStart hook (`hooks/ensure-serve.mjs`) so the router comes up like `sonata code` does — no wrapper needed. The Remote Control loss below then applies to every session in the project, not just wrapped ones, until `sonata route off`. Nuance, observed live 2026-08-25 on Claude Code 2.1.x: the Remote Control gate reads the base URL at session launch, but the settings `env` is picked up per-request — so a session already running when `route on` was issued keeps Remote Control *and* routes native agents (proven: a native-explore dispatch from such a session logged `-> litellm` on the router). Sessions launched after `route on` lose Remote Control as documented. The pickup is one-way: `route off` (also probed live) cleans the file for future sessions, but an already-routed session keeps sending through the router until restarted — the exported env survives the key's removal, so until then that session depends on the router staying up. `sonata route auto` turns that asymmetry from a curiosity into the supported way to route without losing Remote Control — see the command list above.

**Tenancy: one router, every project.** A *tenant* is a resolved `sonata.toml`
— a project's own, or the machine config — identified by the first 12 hex of
sha256 over its **realpath**. `TenantRegistry` (`src/native/tenants.ts`)
resolves a request in one order, first hit wins: the `x-sonata-project` header
(honoured only beside `x-sonata-token`, matching the 0600
`~/.config/sonata/router-token` — naming a project picks whose credentials
serve the request, and the router authenticates nobody on loopback; an
unauthorised hint is dropped and logged, never refused)
(written into settings `env` as `ANTHROPIC_CUSTOM_HEADERS` at project scope by
`nativeSessionEnv`, and picked up by a running session because Claude Code
re-applies project `env` when the merged env changes); then `sessions.json`,
keyed by `x-claude-code-session-id`; then the machine config, which is what a
bare curl or an unregistered session gets. The header is **stripped before
forwarding on every path** — a foreign upstream has no use for a local
directory name, and an Anthropic request must stay byte-identical.

Everything config-dependent in `RouterDeps` takes that tenant: tier resolution,
gateway lookup, budget, pricing, credentials, and the ledger row's `project`.
Cooldowns and capability-400 counters key off `<tenantId>/<key>`, so one
project's failing candidate never cools another's. **The realpath is
load-bearing**: on the first live run one config was registered as two tenants
(`/var/…` and `/private/var/…`, macOS symlinking `/var`), which duplicated its
LiteLLM entries, fired a needless restart, and split its cooldowns and budget
across two ids. Canonicalising is best-effort — an unresolvable path keeps its
spelling rather than throwing, because improving identity must never turn a
working resolution into a failure.

Four failures are shaped deliberately, and none is written to the ledger: a
cwd with no config anywhere and a config that will not parse are **400**s
naming the paths or the parse error (the request is not the router's fault); a
tenant needing LiteLLM while the venv is unhealthy is a **502** naming `sonata
litellm install` (and litellm candidates are skipped *without* cooling while it
is unavailable, so a repair is picked up by the next request); a cap reached is
a **429** naming the file that set it. A request carrying a session id while
`sessions.json` has never been read successfully (the latest read failed, and
there is no earlier good read to answer from) is also a **400**, saying to
retry: "no record" would otherwise serve it as the machine tenant, with that
config's credentials and budget. A ledger row records a request the
router forwarded, so a refusal has no place in it.

**LiteLLM is conditional and managed.** `litellmRequired` (`src/native/providers.ts`) asks whether any
routable model — every `[models]` entry and every legacy `[native.models]` one, not just tier members,
since a request naming a bare model key never calls `resolveTier` — sits on a gateway whose transport is
`litellm`. When none does, `serve` starts no child, needs no port, and needs no Python. When one does,
sonata runs its own venv at `~/.config/sonata/litellm`, pinned to exactly `1.98.0` — the version every
LiteLLM behaviour recorded in this file was measured against. `init` installs it, `doctor` reports which
of six states it is in, and **`serve` never installs**: `hooks/ensure-serve.mjs` starts serve headless
from a SessionStart hook, where a silent multi-minute install is indistinguishable from a hang. A PATH
`litellm` is reported as information and never used — measured on the development machine, `which
litellm` resolves to a script whose interpreter cannot `import litellm`.

Sonata implements no OAuth itself; it drives LiteLLM's own authenticator as a subprocess, so no token passes through sonata's process memory. A login needs neither the codex CLI nor a prior `codex login`: LiteLLM's authenticator is a self-contained HTTP client, and the Codex OAuth app id is compiled into it. The login script calls `get_access_token()`, never `_login()` — only the former persists the token, while `_login()` starts a second device flow against an empty directory.

For Copilot, `api-key.json`, written by `get_api_key()`, proves entitlement. A bare `ghu_` token proves nothing: LiteLLM's Copilot credential is a GitHub App token with no OAuth scopes, while opencode's stored `gho_` token has only `read:user` and cannot be exchanged for a Copilot key. These are different credential kinds and remain distinct sources. Copilot's device flow polls for 60 seconds; ChatGPT's polls for 15 minutes. Copilot makes up to three attempts total, each with a fresh code.

The `sonata` credential source points LiteLLM's token directory at `~/.config/sonata/credentials/<gateway>/`, so refreshes persist across runs. The old temp-directory approach silently discarded every refresh; Copilot's `api-key.json` is short-lived and re-exchanged in place, so persistence is load-bearing. Never pass `api_base` for Copilot: `get_api_base()` reads `endpoints.api` from `api-key.json`, and business tenants have different endpoints.

**A harness-sourced ChatGPT token has exactly one writer once LiteLLM runs: LiteLLM.** For a `codex-oauth` gateway reading codex's or opencode's store, serve copies the token only into a **new, empty** directory it creates for a LiteLLM spawn (`seedTokenDirs`, `src/commands/serve.ts`), never into one a running LiteLLM uses. A crash respawn, or a restart for any other reason, reuses the directory as LiteLLM left it. LiteLLM refreshes `auth.json` in place with `open("w")` and ChatGPT rotates refresh tokens, so rounds 5–8 of review each found a new hole in "sync the store's copy in, newer wins" (an opencode v2 row has no `account_id` and always looked like another account, reviving `refresh_token_reused`; a re-merge overwrote LiteLLM's half-written file). Do not reintroduce a live sync. What restarts LiteLLM into a fresh directory is a **lineage change** — `chatgptLineageChanged`: another store (`resolvedOauthIdentity`'s spelling), or another account where both sides name one (`chatgptAccountId`: the record's `account_id`, else the JWT's `https://api.openai.com/auth.chatgpt_account_id` from the id token else the access token — the order LiteLLM's `get_account_id()` uses), or a login returning after positively going away — "gone" meaning the store the seeded login came from positively holds none (`chatgptGone`) — never a store that could not be read or was skipped for staying unreadable, which says nothing about the login it holds — keyed on the login and never the gateway's name, and for opencode.db's "empty twice" only once a later build reads empty too (the first such read refuses the request but keeps the gateway's LiteLLM config and seed — a `tentative` failure). Unknown→known is not a change. It rides the ordinary model-change restart: `litellmPlanSnapshot` names the seed *generation* a spawn would use, which moves only on a lineage change, so a same-account re-login or a store refreshing itself restarts nothing. A retired directory is removed only once every child spawned into it has been seen to exit, and a crash respawn is serialised with deliberate restarts: a restart that goes ahead cancels a pending crash respawn, a crash respawn waits for a model-change check in flight and spawns only if nothing replaced the crashed child, and a restart of a child whose exit was already observed neither signals nor waits on it. **Known limitation:** a login LiteLLM can no longer refresh (sessions revoked server-side, or its refresh token spent by another client) needs a re-login and `sonata restart`. LiteLLM 1.98.0 never reports that refusal to its caller — `get_access_token` logs "re-login required" and falls into a device-code login polling for fifteen minutes — so serve scans LiteLLM's output for that warning or the device-code prompt (`LITELLM_CHATGPT_LOGIN_REFUSED`, anchored on the lines as LiteLLM writes them — the warning after its `HH:MM:SS - LiteLLM:LEVEL: file:line - ` log prefix, colour codes optional, or as a JSON log line's `message`; the prompt at the start of its line — never on the phrase anywhere, since echoed request bodies pass through the same scanner), and the router's responses for how that login ends — read only for a candidate on a codex-oauth gateway (`isCodexOauth`), and matched against the envelope's `error.message` anchored at its start (`CHATGPT_LOGIN_REFUSED`, `src/native/router.ts`), never anywhere in a body, since an api-key gateway's own "re-login required" 401 used to take every ChatGPT gateway down. Measured through a real 1.98.0 proxy, that response is a **400** — `litellm.BadRequestError: GetLLMProvider Exception - ` then `litellm.AuthenticationError: Polling failed: …` / `…: Timed out waiting for device authorization` / `Failed to request device code: …` (`tests/fixtures/litellm/chatgpt-refresh-refused-proxy.json`; the messages as raised are in `chatgpt-refresh-refused-errors.json`) — which the router did not read at all until 400 was added beside 401 and 500. Either marks every codex-oauth gateway — all served from the one token directory — so `gatewayUnavailable` answers a named 502 at once, and logs the remedy once. That includes the request whose response showed it: `forwardToLitellm` marks such a response `loginRefused`, and the tier loop tries the next candidate, counting it as not served, so a tier left with nothing answers the same named 502 (`loginRefusedMessage`, serve's `gatewayUnavailable` text) — and so does a bare key — with no ledger row; returning LiteLLM's raw 400 instead ended the tier on a candidate-specific failure. **The detecting request cools nothing when serve's mark now covers the gateway**: the tier loop re-checks `gatewayUnavailable` after telling serve, and when it answers, the mark already skips the gateway and governs recovery — a 60 s cooldown on top outlived the mark's clearing and answered a new login 529. With no mark resulting (no serve to tell), the candidate and its gateway cool as for an unservable 400. The router also records the token directory a ChatGPT request was forwarded into (`chatgptTokenDir`) and passes it to `chatgptLoginRefused`: a refusal arriving after that LiteLLM was replaced by a new login neither marks nor cools the new child (the output scanner's own guard is `child === spawned`). **A crashed child stays the current one until its respawn replaces it**, and its directory is kept with it (`sweepRetiredTokenDirs` never removes the current child's `childTokenDir` entry): a refusal it gives in that window — stdout buffered past its exit, or a response to a request forwarded to it — is its own, and is marked on its directory. Sweeping that entry on its exit marked such a refusal with no directory, which "a different directory clears" then cleared on a same-directory restart serving the refused token, and dropped a response as "replaced". A mark that knows no directory at all is never cleared by a spawn — no spawn's directory can be told apart from it — and stays until `sonata restart`. The mark is keyed on the refused **token** (`chatgptTokenHash`: sha256 of the child's `auth.json` `refresh_token`, else `access_token`), never on the file's stat, and keeps the directory the refused child served. The token is read at mark time; a read that lands mid-write or finds no token is retried at later checks for `REFUSED_TOKEN_CAPTURE_MS` (1 s) only, then never (`refusedToken`) — reading on indefinitely caught a sonata-owned re-login written into that same directory as "the refused token" and kept the mark on it. A deliberate spawn clears the mark when **(a)** it starts LiteLLM on a different directory from the refused one — a lineage change, seeded fresh — whether or not a token was captured, or **(b)** on the same directory holding a readable token that differs from the captured one — a sonata-owned login rewritten by `sonata auth login`. The same directory with no token captured keeps it; `sonata restart` is the remedy. A crash respawn, a restart for anything else (a model-list edit), a restart with no ChatGPT gateway at all (no directory, which says nothing), and LiteLLM's own rewrite of `auth.json` to record `device_code_requested_at` all keep it; a fresh process (`sonata restart`) starts without it. Doctor says it beside each ChatGPT gateway.

**An unreadable credential store is "torn" only while it may be mid-write** (`boundUnreadable`, `src/native/credential-reads.ts`). For a file whose bytes can be read — what failed is their parse — that is judged by content, never by time: `boundUnreadable` compares a hash of the bytes the read parsed (`StoreRead.contentHash`, set by `jsonStoreRead`) — never a second read of the file, which could find a valid file renamed into place in between and compare valid bytes — and a read is torn only while they differ from the previous failed read's, or were first seen less than `TORN_REPEAT_MS` (1 s) ago. A writer does not hold one partial state for a second, so the same bytes 1 s apart are stuck and skipped — however fresh the file's mtime (something touching it without changing it) and however long ago it was last read; different bytes are a new write and torn again, however long the file was quiet. Neither mtime (beyond a file's first sighting, below) nor a gap between reads counts: mtime could not tell a file being rewritten from one being touched, and a gap rule read a touched broken file as torn again after every quiet spell. **Known limitation:** a file rewritten with different unparseable bytes on every read stays torn for as long as that goes on — nothing on disk tells it from a writer mid-write, and the first read of new broken content is torn — unless it is the file's first sighting with a stale mtime, below — costing a refusal for every request within the following second (`TORN_REPEAT_MS`), not just one, before it is skipped: measured, a burst of requests ~0.2 s apart was refused for the first 0.7 s and served from 0.9 s. Bytes seen for the first time — no failed read on record — count from the file's mtime only when it is at least `FIRST_SIGHT_STALE_MS` (5 s) in the past, else from now: a file corrupt since before serve started, last written over 5 s ago, is skipped on its first read and costs no refused request; mtime counts only for that first sighting, never after. The margin rests on an assumption — a write in progress is never dated more than a few seconds back — sized for FAT's 2 s mtime granularity plus a file server's clock lagging the host's; counted from any mtime earlier than now, a torn codex file dated 1.5 s back was skipped on its first read and opencode's account served. A first-sight skip is logged as the file's age ("has not been modified for Ns"), never as "the same unparseable content for Ns", which only real observations may claim. A file whose bytes cannot be read at all (EACCES, EISDIR) has nothing to compare and is torn for `UNREADABLE_STORE_WINDOW_MS` (10 s) from its first failure, with no gap reset — nothing rewrites a file into EACCES. That run is timed apart from any unparseable bytes on record (`errorSince` beside `hash`/`since`): a read error returns no bytes, so it says nothing about them, and replacing their record with it made one EMFILE between two reads of the same stuck bytes count them as first seen and torn for another second. opencode.db keeps its own rule: it counts only for the first window of a run of failed queries, and its run is **not** ended by a gap — its length is the only evidence there, and a database locked for good but read once a minute would otherwise never be skipped. Past it the store is skipped as absent — logged once, naming path and error. **Each store is read once per build, and the classification and the parse share that read** (`withReadSnapshot`, `src/native/read-snapshot.ts`, opened around the gateway merge and `resolveChildEnv` together; the merge that decides LiteLLM's model list, `servableTenants`, runs in a snapshot of its own and so can read a store again — a disagreement there leaves the build uncommitted and is repaired by the next request's rebuild): inside it every `readOnce(path)` returns the first read's bytes or error, and opencode.db's `opencodeDbRead` count and `readOpencodeCredentials` parse come from one `queryCredentialRows`. They used to be separate reads, so a codex write landing between `jsonStoreRead` (clean: the store answered) and `readCodexOAuth` (torn: no login) read as a logout — `chatgptGone`, "logged in again", LiteLLM killed and reseeded. The scope is a module variable, so it takes synchronous functions only; `opencodeDbRead`'s deliberate second count on an empty table stays a fresh connection. **A skipped store reads as absent, and resolution goes on from the stores that remain — with one exception: the store the lineage's last-good credential came from.** `resolveChildEnv` records that store with each last-good entry (`CredentialMemory.lastGoodSource`: the last store in the lookup chain, which ends at the one that answered), and a gateway whose source is the skipped store keeps its last-good credential and ChatGPT seed (a `transient`, logged): that store not reading is not a logout, its lineage does not end, and the file reading again restarts and re-seeds nothing. A credential from any *other* store is not kept through it — keeping it there pinned a key rotated or removed in opencode while `keys.json` was skipped, and kept opencode's ChatGPT account through an opencode logout while codex's `auth.json` was skipped. A default ChatGPT gateway's identity in `mergeGateways` follows the same rule (kept through a skipped codex file only when it was `codex store`). A gateway that has never resolved falls through, so a permanently corrupt, empty or EACCES `~/.codex/auth.json` on a fresh gateway reaches opencode's login instead of answering 502 forever. A build that read anything as torn is never committed (and forgets the last committed fingerprint), so the next request really retries. The plan fingerprint's stat signal carries each store's inode, mtime, size and **mode**, so a `chmod` — which moves no mtime — is re-read on the next request; opencode.db's signal is its credential rows' hash, which a `chmod`, `chown` or ACL change does not move (an ACL change moves not even the mode), so the database's **ctime** is added to it. ctime also moves on opencode's own writes to the main file (a checkpoint, in WAL mode); that costs a re-merge and no restart unless a credential changed — measured, 20 checkpointed and 20 rollback-journal writes to an unrelated table spawned nothing. `sonata doctor` warns, naming the file.

There are two deliverables: (A) `sonata serve`/`sonata code` for a complete local routing path, and (B) the `claude` harness adapter for dispatching foreign-on-Claude-loop through `sonata dispatch`.

**A gateway declares how it authenticates.** `auth = "api-key"` (the default, so existing configs are unaffected) sends a stored bearer to `base_url`. `auth = "codex-oauth"` uses the ChatGPT subscription credential written by `codex login`, and takes **no** `base_url` — parsing refuses one, because that credential is refused by the metered `api.openai.com` with `insufficient_quota` *after* passing auth and scopes, and reaches only `https://chatgpt.com/backend-api/codex`. A subscription is not API credit; a config naming the metered URL authenticates and then 429s, which reads as a missing key. LiteLLM's `chatgpt` provider handles that endpoint, the Responses wire API, the mandatory streaming, and token refresh, so sonata emits `model: chatgpt/<id>` with `model_info.mode: responses` and **no** `api_base`/`api_key` — passing either overrides the provider and breaks it. Without `mode: responses` LiteLLM POSTs to the bare `backend-api/codex/` URL and gets a Cloudflare HTML page. Non-streaming calls hit an open upstream bug (BerriAI/litellm#25429) that streaming clients — Claude Code included — never reach. Full detail in `docs/guide/codex-subscription.md`.

**`auth = "copilot-oauth"`** uses opencode's GitHub Copilot login and emits `model: github_copilot/<id>` — no `mode` override, because Copilot speaks chat-completions. `serve` writes the `gho_` token to `access-token` and sets `GITHUB_COPILOT_TOKEN_DIR`; LiteLLM exchanges it for a Copilot key. **That exchange usually fails**: opencode's token carries scope `read:user` only, so GitHub answers `copilot_internal/v2/token` with 403, LiteLLM drops the deployment, and the request fails as "no healthy deployments" naming neither cause. So `init` and `doctor` check the `copilot` scope first (asking GitHub, failing closed) and refuse to offer models the credential cannot serve.

**One OAuth credential is offered as one provider.** opencode's `openai` entry is the *same* ChatGPT credential codex holds (identical `client_id`, which is how `oauthProvidersFor` recognises it), so both resolve to `codex-oauth`. Offering both let one subscription be configured as two gateways serving overlapping models under different keys (`gpt-5.6-luna` and `openai-gpt-5.6-luna`), doubling the generated agents for no added capability. `dedupeOauthProviders` (`src/commands/init.ts`) keeps the canonical provider per OAuth kind (`codex-oauth` → `codex`, `copilot-oauth` → `github-copilot`) — but only when that one is actually offered, so a machine with opencode and no codex still reaches ChatGPT through `openai`. It runs *after* the BYOK block, since that filter skips any name already in `offered` and would otherwise re-add the hidden provider as a BYOK row.

**opencode.ai routes by a session header, and LiteLLM drops it unless told otherwise.** OpenCode Zen (`opencode.ai/zen/v1`) and Go (`opencode.ai/zen/go/v1`) answer any request that names no conversation with 400 `MissingSessionID` ("Request is missing x-opencode-session and cannot be routed efficiently"). Claude Code's own `x-claude-code-session-id` is accepted in its place, but LiteLLM forwards no client header by default, so the upstream saw neither and **no native request to an opencode.ai gateway ever succeeded** — the ledger held 30 such requests on 2026-09-26, every one a 400. Three pieces fix it, each necessary:
- `litellmConfig` lists every model on an `opencode.ai` host under `litellm_settings.model_group_settings.forward_client_headers_to_llm_api` (`requiresSessionHeader`, `src/native/providers.ts`). Keyed by **host**, since a gateway may be called anything; scoped, never global, because forwarding hands the upstream every client `x-*` header.
- The router sets `x-opencode-session` on every LiteLLM request (`withSessionHeader`, `src/native/router.ts`): the conversation key, which is stable across a transcript's turns and distinct between two subagents of one session, else Claude Code's session id. It then **drops every other client `x-*` header** — read the session first, strip after — so nothing but the session reaches opencode.ai (a CodeRabbit security finding on PR #69). Nothing on the LiteLLM path reads the dropped headers; the router takes its own session from the incoming request.
- `UNSERVABLE_400_SIGNATURES` (`MissingSessionID`) is the backstop: such a 400 falls through on the **first** occurrence and cools the whole gateway. `CAPABILITY_400_SIGNATURES` wait for three in a row because a shape-specific 400 might be the request's fault; a refusal of *every* request is proof the first time, and waiting kills two agents to learn it. Without this, a tier ranking an opencode.ai model first killed every agent that reached it — including ones already running when the model above it hit a 5xx, which is how a six-agent audit died whole.

Verified end to end through a scratch LiteLLM 1.98.0 on the generated config: `/v1/messages` 400 without the header, 200 with it. The Anthropic-shaped `/messages` endpoint is no escape: MiMo answers it `ModelProtocolUnsupported`.

**`init` must never offer a model the router cannot reach.** Copilot, acme and anthropic all serve Claude models, and the router sends `claude-` upstream, so `parseConfig` refuses those ids — 27 such candidates were being offered, and selecting one wrote a config that then failed to load. `isAnthropicRoutedName` is the single definition, used by both the parser and the candidate filter.

**The router port's occupant is usually sonata.** `sonata run`/`sonata dispatch`
auto-start `sonata serve --daemon` when the router is down, so a prior dispatch
can leave a daemon holding the port long after that dispatch ended. `serve`
after that hits `EADDRINUSE`, and its old message called that "a non-sonata
listener", sending the user to hunt a foreign program that did not exist.
`occupiedPortMessage` asks the health endpoint first, which costs one request
and makes the message true.

**Serve state stays keyed by router port**, `serve-state-<port>.json`, even
though there is now one daemon per machine rather than one per project. The key
costs nothing, keeps the legacy fallback readable, and the reasoning it came
from is worth keeping because it is what the multi-tenant router replaced: a
project with its own `sonata.toml` used to get its own ports and therefore its
own daemon, since the router resolved tiers with `loadConfig(<daemon cwd>,
home)` and a shared daemon would have served every project the config of
whichever directory started it. That is exactly the constraint per-request
tenant resolution removes. With a single global `serve-state.json` those daemons overwrote
each other field by field: measured live on 2026-09-03 with two routers up
(:4100 pid 53992 and :4110 pid 72171, litellm children 73032 and 72298
respectively, confirmed by ppid), the one record read
`{routerPid: 72171, litellmPid: 73032}` — the *second* router paired with the
*first* router's child. `sonata restart` in either project would have killed
one daemon's router and the other's litellm, which reads as the surviving
project suddenly 502ing on every native request. `readServeStateFrom` still
falls back to the legacy unkeyed path, read-only, so a daemon started before
this change stays stoppable across the upgrade, and clears whichever file it
actually read rather than both.

**`sonata restart` clears that occupant instead of just naming it.** `cmdServe`
records `process.pid` as `routerPid` in `serve-state-<port>.json` once the
router successfully binds. `stopServe` reads that file, kills only the pids sonata
itself recorded (never a pid found by scanning the OS — the same discipline as
the pre-existing litellm-orphan kill), and polls the health endpoint until the
port actually frees before returning. `cmdRestart` runs that then
`startServeDaemon`. If the port answers as a sonata router but the state file
has no matching pid (a different sonata install, state left by an older
version, or a live record damaged by LiteLLM startup), `stopServe` refuses
rather than guessing — same principle as `occupiedPortMessage`. The old
`killRecordedOrphan` unlinked the whole per-port file: the first request that
started lazy LiteLLM, or a `serve` that lost the bind race after touching the
file, could leave only `litellmPid`, so several `restart` attempts could refuse
until someone killed the stale pid by hand. Shared-state cleanup now happens
only after this process owns the port, which makes the losing instance harmless.

**`serve` watches its own LiteLLM child and respawns it if it exits on its
own** (`cmdServe`, `src/commands/serve.ts`) — the child dying used to go
unnoticed until the next request 502'd and someone ran `sonata restart` by
hand, with the router staying up and answering every request with a dead
upstream in the meantime. A crash-loop guard (5 respawns/60s by default) stops
trying and logs why rather than respawning forever against a genuinely broken
gateway. This is safe in a way an *external* health-probe respawn is not:
there is only ever one spawn racing here, never a second `serve` guessing
whether an existing one is healthy.

**The router logs which upstream served each request** — `POST /v1/messages
model=gpt-5.6-terra -> litellm`. `serve` never passed a `log` before, so that
line had never produced output, and LiteLLM's access log records the path and
status but not the model. That left "did this native agent really run on the
foreign model, or fall back to Claude?" answerable only by inference. It is now
evidence: a `claude-`-prefixed model logs `-> anthropic` and never reaches
LiteLLM at all, so a foreign-model line in `serve`'s log is proof of routing.

**Claude Code's `system` array must be flattened for codex.** Claude Code always
sends `system` as an array of text blocks. LiteLLM turns a *string* system prompt
into a `developer` message the Codex backend accepts, but leaves block arrays as
role `system` — and that backend answers `{"detail":"System messages are not
allowed"}`, a 400 naming neither the field nor the shape, so it reads as a model
or auth problem. Probed directly: a string system prompt streams fine, the
identical text as a one-element array 400s, an empty array is accepted.
`flattenSystemBlocks` (`src/native/router.ts`) joins the blocks with blank lines
on the **litellm path only** — an Anthropic request stays byte-identical, since
Anthropic understands its own shape. `cache_control` is dropped with the block
wrapper, costing prompt caching on this path; the alternative is a request that
cannot be sent. A non-text block (an image) has no string form, so the body is
passed through unchanged rather than silently losing content. Verified live: the
model obeys the flattened prompt, not just accepts it.

**And mid-conversation system turns are demoted on that path — this was the
hole.** Claude Code 2.1.266 sends "system turns" as a `role: "system"` entry
inside `messages` (Anthropic accepts them). Neither `flattenSystemBlocks` nor
`supports_system_message: false` looks at `messages`, which is why the pair
was measured necessary but not sufficient on 2026-09-03. Captured 2026-09-09
through a logging proxy (`messageRoles: ["user","system"]` on a session's
first request) and probed directly against the live LiteLLM child: string
`system`, no system turn → streams; same request plus a system turn → 400.
`demoteSystemTurns` (`src/native/router.ts`) rewrites each such turn to
`role: "user"` — the role LiteLLM's own `map_system_message_pt` demotes to —
content and position untouched; `litellmBody` is now `demoteSystemTurns ∘
sanitizeToolSchemas ∘ flattenSystemBlocks`. Verified live on a scratch daemon
before the 4110 router was restarted onto it. Note LiteLLM 1.98.0 reads
`supports_system_message` from `litellm_params`/kwargs (`main.py`), not from
`model_info` where sonata writes it — so that declaration has never had an
effect; it is left in place pending its own fix, since the demotion makes the
question moot for the shape that actually failed.

**Tool schemas are repaired for the regex dialect on the same path.** A tool
schema may constrain a string with `\p{Cc}`-style Unicode property classes —
the case that surfaced this was the Artifact tool's `field` parameter, sent to
every write-capable agent.
JavaScript and Anthropic accept those; an OpenAI-style endpoint validates each
tool's parameters as JSON Schema with `format: regex`, and the reference
validator runs that on Python's `re`, where `\p` is a *bad escape* — so Azure
answered a `code-simple` request with 400 `'…' is not a 'regex'`
(`tools[1].parameters`) and the agent died on its first request (reported
2026-09-09 from another project; reproduced against `python3 -c
"re.compile(...)"`). Read-only roles never hit it only because their agents
carry an explicit `tools:` allowlist that omits Artifact. `sanitizeToolSchemas`
(`src/native/router.ts`) strips exactly those patterns and nothing else, and
`litellmBody` is the one transform both litellm forwarding paths take
(`sanitizeToolSchemas ∘ flattenSystemBlocks`), so they cannot drift. An
Anthropic request stays byte-identical; the direct path is a pass-through by
contract. Giving write roles an allowlist instead was rejected: it would drop
fan-out for the roles that use it, and any future tool with the same shape
would break the same way.

**Claude Code 2.1.268 fixed that Artifact schema, and the transform stays.**
The upstream fix covers the tools Claude Code itself ships. A tool contributed
by an **MCP server** can carry the same pattern, reach the same validator and
fail identically — sonata forwards those schemas untouched otherwise — and
sonata is installed from npm against whatever Claude Code the user already
has, so a session on 2.1.265–2.1.267 still sends the old schema. Because
`sanitizeToolSchemas` walks every tool rather than a named one, it covers both
cases without knowing about either, and it returns the identical bytes when
there is nothing to strip. Reverting it would trade a per-request JSON parse
for a 400 that reads as a model or auth failure.

**Flattening alone is not enough: the codex model is also declared
`supports_system_message: false`.** The Codex backend refuses *any* `role:
system` message — not merely the block-array shape — with
`{"detail":"System messages are not allowed"}`, and LiteLLM's chatgpt provider
does not normalize it: BerriAI/litellm#22968 reports exactly this, and its fix
(PR #22967) was **closed without merging**, so 1.98.0 still emits the rejected
role. Observed live 2026-08-28: a tier request the router had already flattened
(`model=sonata-code-complex -> gpt-5.6-terra -> litellm`) still 400'd. The
declaration (`src/native/litellm.ts`) routes the prompt through LiteLLM's own
`map_system_message_pt` instead. The two fixes are a **pair**: that helper
concatenates onto message content and raises `can only concatenate list (not
"str") to list` on Claude Code's block arrays (BerriAI/litellm#32904), so
flattening to a string first is what keeps this off its crash path. Neither is
sufficient alone, and it is declared only for codex-oauth — an api-key gateway
takes a system message fine, and folding it there would degrade the prompt for
nothing.

**The response side is rewritten too, for models that write their tool calls
as text.** Some open models reply with the Qwen-Coder `tool_call` markup
instead of a structured call and leave the server to parse it; when the
serving backend has no such parser the markup arrives as plain text in a turn
that ends `end_turn`, and Claude Code reads the agent as finished — it ended
with no report. Measured 2026-10-02 on `mimo-v2.6-pro` through one gateway,
intermittently within a single agent (spec:
docs/superpowers/specs/2026-10-02-text-tool-calls-design.md).
`src/native/text-tool-calls.ts` turns that markup into real `tool_use` blocks
on the **LiteLLM path only** — Anthropic speaks `tool_use` itself, so a direct
response is left byte-identical — and rewrites `end_turn` to `tool_use`
whenever anything was recovered, so the client runs the call instead of
ending the turn. It recovers only what it can prove: a call naming a tool the
request actually offered, with each argument coerced to the type that tool's
`input_schema` declares. An unknown tool, or markup that does not close, is
never guessed at and stays the text it was. That is a turn the model never
served, so the candidate is cooled for `TIER_COOLDOWN_MS` (60 s) and the
conversation stops preferring it — stickiness is set only on a turn with
nothing left unparsed. The ledger records `textToolCalls: { recovered,
unparsed }` per request, and `sonata doctor` carries a `text tool calls`
check that names the models doing this in the last 24 h and goes red when a
call was left unrecovered.

**ChatGPT's Codex endpoint returns `output: []` under concurrent load, which LiteLLM surfaces as a 500.** When 8+ native agents dispatched simultaneously hit the same `codex-oauth` gateway, the upstream accepts the requests (no 429) but returns empty completions. LiteLLM's Responses API transformation (`transformation.py`) raises `ValueError: Unknown items in responses API response: []` and the proxy emits 500. The router (`src/native/router.ts`) catches 500 responses from LiteLLM whose body contains that string and re-emits them as 529 (overloaded) — Claude Code treats 529 as a retriable backpressure signal rather than a hard fault, so the turn is retried automatically. The match is string-level because the body is LiteLLM's rendered exception, not a structured field. LiteLLM 1.97.0 added an SSE recovery attempt for this case but still raises when recovery fails, so the router catch is still needed.

**A gateway declares its `provider`, and the transport is derived from it.**
`provider` supersedes `wire_format` (which still parses, and is folded into
`provider` at load) because the real axis is *which LiteLLM provider* — LiteLLM
picks its wire format from the prefix on `litellm_params.model`, so this one
decision determines whether a request reaches a vendor's native API or a
compatibility shim. `PROVIDER_FOR_GATEWAY` (`src/native/providers.ts`) carries
the prefix for gateways whose endpoint has been exercised, so a `google`
gateway emits `gemini/<id>` rather than `openai/<id>`; `openai` is the fallback
for the genuinely unknown, never the default for a known vendor. Transport is
**derived, never configured separately** (`transportFor`): `provider =
"anthropic"` with `auth = "api-key"` is reached **directly by sonata's own
router with no LiteLLM in the path**, every other api-key provider goes through
LiteLLM as `<provider>/<id>`, and an OAuth gateway's dialect is fixed by its
auth. Two keys that can disagree is the shape of the item-14 scope bug, where a
writer and a cleaner defaulted differently and ids leaked forever.

**The direct path is a third header mode, and that is a security boundary.**
`forwardDirect` strips the incoming `authorization`/`x-api-key` and injects
*that gateway's* key: the caller's credential is Claude Code's own Anthropic
credential, and forwarding it to a third-party gateway is a leak. The body is
passed through **unmodified** — no `flattenSystemBlocks`, so `cache_control`
survives, and assistant content blocks round-trip byte-identical because
`redacted_thinking` carries opaque vendor state (measured: Gemini's
`thought_signature` through OpenRouter) the upstream requires echoed back
exactly. Tier ranking, cooldowns, capability-400 fingerprinting, the 529
exhaustion message and usage recording are upstream-agnostic and shared by both
transports. `serve` resolves each direct gateway's key into a record the router
reads per request — without it every direct forward goes out with an empty
credential, which is how the transport shipped structurally dead until the
`serve` wiring landed.

**`serve` forwards every line of LiteLLM's output to its own.** A per-model startup failure appears only in LiteLLM's own output; discarding it is what turned a plain 403 into an unrelated-looking "no healthy deployments for this model". The child's stdout and stderr are piped rather than inherited only so serve can read them on the way (`pipeLitellmOutput`, `src/native/litellm-output.ts`): every line is written to serve's stdout/stderr as it was — a final line with no newline included — except that a device-code prompt's user code is masked — ChatGPT's `Enter code: ****` and Copilot's `… enter code **** to authenticate.`, case-insensitively — since that login would be LiteLLM's, into a directory serve discards. A sink that fails asynchronously (EPIPE: `sonata serve | head`) gets one no-op `'error'` listener and is written to no more, while the child's output is still read and scanned; unhandled, that event crashed serve and skipped its `stop()` cleanup.

**opencode's OAuth entries are not API keys.** `opencodeKeys()` resolves `type: api` entries only, which is correct — but the `type: oauth` ones (`openai`, `github-copilot`) were then invisible, so doctor reported "no key" for a credential sitting on disk. opencode's `openai` entry is the *same* ChatGPT credential codex holds (identical `client_id`), so `readChatGptOAuth` prefers codex and falls back to opencode; the `client_id` is checked, because another OpenAI grant would fail confusingly inside LiteLLM. opencode writes `expires: 0` on the Copilot entry to mean "never expires".

**opencode v2 keeps credentials in `opencode.db`, beside `auth.json`, and migrates nothing.** Read from opencode's own source (dev branch, 2026-09-25) because no v2 release existed to measure: the `credential` table holds plaintext JSON keyed by `integration_id` (the same ids as `auth.json`'s keys), `{"type":"key","key":…}` or `{"type":"oauth","access":…,"refresh":…,"expires":<epoch ms>}`; `connector_id`, `method_id` and `active` are dead columns, and the newest `time_created` wins. v1 and v2 coexist, so `readOpencodeCredentials` (`src/native/opencode-store.ts`) overlays table rows on `auth.json` per provider — table wins — and every opencode credential reader goes through it. The db is opened read-only and synchronously (`src/sqlite.ts`, `node:sqlite` loaded with `createRequire` so Node < 22.13 degrades to `auth.json` rather than failing). `sonata doctor` names the store a credential came from and warns — never fixes — when `opencode.db` is group/world-readable while holding credentials, since opencode writes it 0644 where `auth.json` is 0600. If the released v2 disagrees with the source this was built from, this is the paragraph that is wrong.

**`serve` must clean up on signals.** It runs until killed, so its signal handlers *are* its normal exit path; without them the run's temp directory survives, carrying the generated master key and, for a codex-oauth gateway, the ChatGPT credential. One such token was found in the system temp directory. `ServeDeps.tempDir` exists so tests never write into the real temp directory — two 0600 files carrying a test fixture's gateway URL were found there after a suite run.

Remote Control is the trade-off: `ANTHROPIC_BASE_URL` is process-wide, and `isFirstPartyAnthropicBaseUrl` gates Remote Control. Sessions launched by `sonata code` therefore lose Remote Control while routed through the local proxy.

The `claude-` prefix is load-bearing because the router sends that prefix to Anthropic. Native model keys and ids beginning with `claude-` are refused at parse time. Credentials flow only store → memory → LiteLLM environment; keys are never logged or put in a Claude conversation. The user starts `sonata serve`: the classifier correctly blocks launching an auth-forwarding proxy from inside a session.

The `claude` harness adapter is the simplest adapter: it runs headless `claude -p`, has no TUI, and maps permission modes directly. For native dispatches it assumes `sonata serve` is already running.

## Auto-routed tier branch

After tenant resolution, the budget check and `repairNamelessToolCalls`, the router recognizes `sonata-<role>-auto` before the ordinary tier-alias path. With `[auto_route]` enabled it sends only the first user message's text, cleaned of `<system-reminder>` blocks and capped at 8,000 characters, to Jev at `<base_url>/v1/systemone` — TypeSafe (`https://api.typesafe.ai`), OpenRouter (`https://openrouter.ai/api`) or a self-hosted `jev-compatible-server`, whichever the project's `base_url` names. The key follows the host (`decisionKeyFor`): `openrouter.ai` takes the `openrouter` gateway's key, `api.typesafe.ai` a `typesafe` one, any other host an `auto-route` one when one is stored, else none — and a key is only ever sent to the host it belongs to. The URL is per project while one router serves every project, so `serve` hands the router `classifierFor(settings)`, which builds one classifier per `baseUrl|model` (`decisionClassifier`) and resolves the model per call: `settings.model` when it pins one, else `chooseDecisionModel` over that URL's listing (`ModelListCache` — `GET <base_url>/v1/models`, cached 1 h per URL, 5 min after a failure) and the cached JevBench scores (`loadDecisionCatalog`), so a `sonata catalog update` or a new model at the URL needs no restart. The decision is stored by conversation and the chosen tier is converted to `sonata-<role>-<tier>`; that alias then takes the unchanged ranked tier path, including cooldowns, stickiness and budget handling.

The decision store is bounded to 1,000 conversations with a two-hour TTL, and concurrent first requests for one conversation share one in-flight classification. Failures, invalid or low-confidence answers, missing keys and timeouts fail open to `normal`, or `complex` when no normal tier exists. A request with no task at all — Claude Code's own task-less side requests, whose first message is nothing but reminders — asks the classifier nothing, takes that same fallback tier with outcome `no-task`, and is left out of `sonata doctor`'s decision health rather than counted as a failure. A `-auto` request while auto-routing is disabled, or for a collapsed role, returns a typed 400 rather than silently behaving as a manual alias.

Ledger rows reached through an explicit tier carry `route: "manual"`; rows resolved through an auto alias carry `route: "auto"`. The request that makes the decision additionally carries `autoRoute` with the choice, confidence, probabilities, outcome, latency, classifier model and token counts. `sonata usage --by route` groups the two routes and reports classifier tokens beside the priced total; a response-reported `usage.cost` (OpenRouter reports one) is recorded as `autoRoute.costUsd` and summed separately, never into the priced total, and a loopback URL (`localhost`, `127.0.0.0/8`, `::1`) records $0 when its response reports none (`loopbackFree` in `decisionClassifier`). Only a non-loopback decision whose response reports no cost stays unpriced, and none of it is counted in `[budget] daily_usd`, which bounds priced model traffic only.
