# One router for every project

Written 2026-09-09, after the first external bug report against sonata: a
project holding its own `sonata.toml` could not route through the router
another project had started on the default port, and the refusal was
swallowed by a hook. The refusal was fixed to be visible the same day. This
design removes the case it guarded: **one machine router serves every
project, resolving each request's configuration from the project it came
from.** The user chose this over per-project daemons on auto-assigned ports,
and chose it as a replacement, not an addition — a project `[native.ports]`
no longer starts a daemon of its own.

## Why the router is one-config today

`sonata serve` loads one config from the directory it starts in and closes
over that directory: tier resolution, gateway lookup, budget, pricing, the
model-change check and the LiteLLM model list all re-read *that* file.
Nothing in a request says which project it came from, so a second project's
sessions would be served with the first project's tiers, models, gateways,
credentials and cap — silently, and only visibly once the two files diverge.
The identity check on `/__sonata_health` (`configPath`) exists to refuse
exactly that, and `serve-state-<port>.json` is keyed by port because the
intended answer was one daemon per config.

Two facts make per-request resolution possible without a registry the router
does not have:

- Every request Claude Code sends, including a subagent's, carries
  `x-claude-code-session-id`. Measured in this machine's ledger for
  2026-09-09: every one of the 806 rows, tier aliases included, has a session.
- Claude Code 2.1.227+ honours `ANTHROPIC_CUSTOM_HEADERS` from settings `env`
  (`Name: Value`, newline-separated), re-applied to a running session when the
  merged `env` changes — the same rule the routing `ANTHROPIC_BASE_URL`
  already depends on. Project and local settings may set it; it is not on the
  ignored-variables list.

## Tenancy

A **tenant** is a resolved config path: a project directory's own
`sonata.toml`, or the machine config. The tenant **id** is the first 12 hex
characters of sha256 over the resolved path — stable across restarts,
readable in logs, and safe inside a LiteLLM model name.

A request's tenant is resolved in this order, first hit wins:

1. **`x-sonata-project: <cwd>` header.** The routing env planner
   (`nativeSessionEnv`, the one map `sonata code`, `route on`, and the
   `route auto` subagent hooks all write) adds
   `ANTHROPIC_CUSTOM_HEADERS = "x-sonata-project: <cwd>"` beside the base
   URL. The router resolves `configPath(<cwd>, home)`. This is the primary
   key because it needs no registry and no ordering: the header is on the
   very first request, subagents included.
2. **Session registry.** `sessions.json` maps `x-claude-code-session-id` to a
   cwd; `cmdRouteSession` writes it at SessionStart today. Kept as the
   fallback for a Claude Code older than 2.1.227.
3. **Machine config.** No header and no registered session — a bare curl, a
   `sonata run --model` through the claude harness, a session launched before
   routing was on — behaves exactly as a daemon started from home does today.

The header is stripped before forwarding, on every path: a `claude-` request
to Anthropic must stay byte-identical apart from headers Anthropic never
sees, and a foreign upstream has no use for a local directory name. Existing
`requestHeaders`/`litellmHeaders` already own the header allow-list and are
where the strip lives.

A cwd that resolves to no config (the project has none and there is no
machine config) is a 400 naming both looked-up paths; a config that fails to
parse is a 400 naming the file and the parse error. Neither is a 5xx, because
neither is the router's fault, and neither is written to the ledger.

## The router process

**`sonata serve` always starts the machine router.** Its ports are the machine
config's `[native.ports]`, else `4100`/`4000`; `serve`, `restart`, `code`,
`run`, `route`, and `ensure-serve.mjs` all take them from one resolver,
`routerPorts(home)`, and never from a project config. A project
`[native.ports]` parses and is ignored; `sonata doctor` reports it as a
warning naming the file and the line to delete. No schema bump, since nothing
is refused and a v1 file still loads unchanged.

`serve-state-<port>.json` stays keyed by port. There is one port now, but the
key costs nothing and keeps the legacy fallback path readable.

**Known tenants** are the machine config plus every distinct cwd in
`sessions.json` within ledger retention that has a project `sonata.toml`,
plus any cwd seen in an `x-sonata-project` header since startup. The last
matters: a header-routed session need not have been registered. The set is
recomputed by the model-change check, which already runs once per
litellm-bound request.

### LiteLLM: one child, union model list

`litellmConfig` takes a list of tenants and emits every tenant's native
models under `model_name: <tenant-id>/<key>`. The router's `withModel`
rewrite on the litellm path sends `<tenant-id>/<key>`; cooldowns and
capability-400 counts key off that same string, so one project's failing
candidate never cools another's, and no new keying code is needed.

Credential env vars are **not** namespaced. The key store is machine-wide by
gateway name (`resolveKeys(gateway, home)`), so two tenants naming the same
gateway already share one key; `api_base` is per model entry, so two tenants
naming the same gateway with different base URLs still each reach their own.
OAuth token directories are per gateway *kind*, as today.

**Lazy start.** Today `serve` decides at startup whether LiteLLM is needed and
tells the user to `sonata restart` if a later config grows a litellm gateway.
With tenants appearing after startup that is not acceptable, so the child is
started the first time any known tenant needs one, through the same
`litellmReady` gate every request already awaits. `serve` still never
installs: if `litellmStatus` is not healthy, the request fails 502 naming
`sonata litellm install`, and the log says which tenant needed it.

**Registry change** is the existing `maybeRestartForModelChange` with a union
snapshot: the JSON of every tenant's `activeNativeSnapshot`, in tenant-id
order. A new tenant's first request therefore pays one LiteLLM restart,
bounded by the existing exit timeout. A tenant whose config will not parse is
left out of the union and logged once per change, not once per request.

### Direct transport

`gatewayKeys` becomes a map keyed by tenant id, since a direct gateway's base
URL and key source are the tenant's. `refreshGatewayKeys` runs per tenant
inside the same registry-change path.

## Identity, budgets, and the ledger

**Health.** `/__sonata_health` reports `multiTenant: true`, `instanceId` as
today, and `tenants: [{ id, configPath }]` for what it currently knows.
`configPath` is no longer reported as an identity. Every caller that today
compares `configPath` — `cmdRouteSession`, `cmdCode`, `cmdRun`,
`ensure-serve.mjs`, and doctor's serve-health check — instead accepts any
router reporting `multiTenant: true` and refuses one that does not, with one
message: `router on port N predates multi-tenant routing — run sonata
restart`. Unverifiable is still not compatible; the thing verified changed.
The "different configuration" refusal and its doctor line, both added
2026-09-09, are removed with the case they guarded.

**Budget.** A ledger row gains `project: <cwd>` written by the router at
record time from the resolved tenant, so spend can be split without joining
through `sessions.json`. A `[budget] daily_usd` in a *project* config caps
that project's priced spend for the UTC day; one in the *machine* config caps
everything the router forwards. Both are checked per request and either
refuses; the 429 names which file set the cap it hit. `sonata usage --by
project` prefers the row's `project` and falls back to the session join for
rows written before this change.

**Pricing** resolves against the tenant's config, as tier resolution does.

## Errors, in one place

| Situation | Response | Ledger |
|---|---|---|
| Header cwd has no config, no machine config | 400 naming both paths | no |
| Tenant config fails to parse | 400 naming file and error | no |
| Tenant needs LiteLLM, venv unhealthy | 502 naming `sonata litellm install` | no |
| Tenant cap or machine cap reached | 429 naming the file | no |
| Router predates this change | callers refuse, name `sonata restart` | — |

## Testing

Router (`tests/native/router.test.ts`): two tenants sharing the key `flash`
resolving to different models; a cooldown on one tenant's candidate leaving
the other's untouched; header, session, and machine-config resolution in
order; the header stripped on every path; the namespaced rewrite on both
litellm paths and its absence on the direct path.

Serve (`tests/commands/serve.test.ts`): union snapshot across two tenants;
restart on a second tenant's first request; lazy LiteLLM start when the first
tenant needing it arrives after startup; a tenant that will not parse
skipped from the union and logged once; project `[native.ports]` ignored.

Commands: each former identity-check caller accepting a `multiTenant`
router and refusing one without the flag; doctor's warning on a project
`[native.ports]`; budget refusal naming the right file; `usage --by project`
reading the row field.

Live, before the changelog entry is written: two projects with identical
configs and no `[native.ports]`, both routed through one daemon, verified by
the router log naming each tenant id on its own requests and by
`sonata usage --by project` splitting them.

## What the live run produced (2026-09-09)

Two projects (`A`, `B`), each with its own `sonata.toml` copied from this repo's,
plus a machine config, all served by ONE router on a scratch port 4190 under a
scratch `HOME`. The live `:4110` session router was untouched throughout, and the
scratch daemon was stopped by the pids it recorded itself.

- Both projects' requests returned **200** from `gpt-5.6-luna`; the router log
  shows `model=sonata-explore-simple -> gpt-5.6-luna -> litellm` for each.
- `/__sonata_health` reported `multiTenant: true` and **three tenants, three
  distinct ids, three distinct paths** — no duplicates.
- The LiteLLM union grew **lazily**: it started with the machine tenant alone and
  gained `<id>/gpt-5.6-luna` and `<id>/gpt-5.6-terra` for each project on that
  project's first request, restarting the child to pick them up.
- `sonata usage --by project` split the two projects into separate rows.

**The first run of this check found a real defect, since fixed** (`df12401`).
The same machine config was registered as two tenants —
`/private/var/.../sonata.toml` and `/var/.../sonata.toml` — because macOS
symlinks `/var` to `/private/var` and the path string was the identity. That one
project carried duplicate LiteLLM entries, fired a needless restart, and split
its cooldowns and budget attribution across two ids. Tenant identity is now the
**realpath** of the config, best-effort: a path that cannot be resolved keeps its
original spelling rather than throwing. Any path traversing a symlink hit this —
a symlinked `~/Code`, a mounted path, a worktree — not only a temp directory.

**One transition hazard the run also exposed.** Routing now points every project
at the *machine* port. If an **old, pre-multi-tenant** daemon already holds that
port, it answers with whatever single config started it — during this session a
dispatch from this repository was served by a 2026-09-04 daemon running another
project's config, and failed against gateways this repository does not use.
`route session-start`, `sonata code`, `sonata run` and `ensure-serve.mjs` all
refuse such a router by design (Task 8), but `cmdRouteSubagent` writes the
routing env without that check — worth closing before release, and the reason an
upgrade should begin with `sonata restart`.

## What this deliberately does not do

- No per-tenant LiteLLM process. One child, namespaced, was chosen over N
  processes with N ports and N watchers.
- No warming of the union at SessionStart. The first request pays the
  restart; a `route session-start` poke can be added if that latency is
  measured to matter.
- No change to `sonata dispatch`, which never transits the router.
- No cross-tenant sharing of cooldowns, even for the same upstream model:
  two tenants may reach it through different gateways, and a shared cooldown
  would punish the one that is fine.
