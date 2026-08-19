# The native path: foreign models inside Claude Code's own loop

Date: 2026-08-19
Status: approved design, not yet implemented
Spike evidence: `2026-08-19-native-foreign-subagents-spike.md` (all claims there
are measured; this design builds only on measured behaviour)

## What this is

Sonata's harness path runs a foreign model in *its own* agent loop (opencode,
codex, pi, reasonix) and relays a report. The native path runs a foreign model
inside *Claude Code's* loop: an ordinary agent file whose frontmatter `model:`
names a foreign model, with requests routed through a local proxy. The subagent
is native — Claude Code's Read/Edit/Bash, its permission modes, turns rendering
in the subagent view — with a foreign brain answering the API.

Two deliverables, launcher first:

- **A. `sonata serve` + `sonata code`** — opt-in native sessions.
- **B. `claude` as a fifth harness adapter** — foreign-on-Claude-loop dispatched
  through the existing MCP surface, for sessions that stay first-party.

## The constraint that shapes everything

`ANTHROPIC_BASE_URL` is process-wide and read at session start; subagents run
in the same process. `modelOverrides` is a name map only (binary schema:
"Anthropic model ID → provider-specific model ID", no endpoint field). So
**per-subagent proxying is impossible**: a session either points at the router
or it does not.

Remote Control is gated client-side on `isFirstPartyAnthropicBaseUrl` — the URL
string, not the traffic — so a proxied session loses Remote Control no matter
how faithful the proxy is. The design answers this with per-session choice:
plain `claude` sessions are untouched and keep Remote Control; `sonata code`
sessions get native foreign subagents and knowingly give it up. The claude
harness (B) is the escape hatch when both are wanted at once, at wrapper-level
rendering.

## Config surface

A `[native]` table in `sonata.toml`, parallel to `[models]` — the two paths
need different facts (a harness model needs a harness; a native model needs a
gateway and a context window):

```toml
[native.models."deepseek-v4-flash"]
gateway = "acme"                    # which gateway serves it
id = "deepseek-v4-flash-0731"         # the id the gateway expects
context_window = 128000               # declared to Claude Code, not guessed

[native.gateways."acme"]
base_url = "https://gateway.acme.example/v1"   # discovered from opencode at init, editable

[native.ports]                        # optional; defaults shown
router = 4100
litellm = 4000

[generate.native]
code    = ["deepseek-v4-flash"]
explore = ["deepseek-v4-flash"]
```

Rules carried over from the existing config: every key quoted through
`tomlKey`; generated agent filenames `native-<role>-<model>.md` follow the
flattening conventions including the injectivity check. New parse-time
refusal: a `[native.models]` entry whose `id` or key starts with `claude-` is
rejected outright — the router routes on that prefix, so such a model would
silently pass through to Anthropic instead of the gateway.

## Credentials

A chain, first hit wins, resolved at `sonata serve` launch, held in memory
only:

1. **Sonata's own store** — `sonata auth add <gateway>` prompts for a key and
   writes a chmod-600 JSON file under `~/.config/sonata/`; `sonata auth list`
   shows gateways and sources (never values); `sonata auth remove <gateway>`.
   Explicit always beats discovered.
2. **Discovered stores** — opencode's `~/.local/share/opencode/auth.json`
   first (the rich one). Other agents' stores are added only where the stored
   credential is actually a usable API key, declared per source — codex's
   ChatGPT OAuth, for example, is not one, and the source list says so rather
   than pretending.

Keys are never logged, never written by sonata anywhere but its own store on
explicit `auth add`, and never enter a Claude conversation: store → serve's
memory → litellm child env, nowhere else. `sonata doctor` reports which source
supplied each gateway's key, by name only.

## `sonata serve`

Two processes, one owner:

- **The router** — `src/native/router.ts`, the spike's proven ~50 lines as
  tested TypeScript, zero dependencies. Reads `model` from each request body:
  `claude-*` → `https://api.anthropic.com` with the client's headers forwarded
  byte-for-byte (Max OAuth keeps working); anything else → litellm with the
  local master key. Bodyless/unparsable requests pass through to Anthropic.
  Logs method, path and chosen upstream — never headers, never bodies.
- **litellm** — an external prerequisite like tmux: doctor checks it, sonata
  never ships it. `sonata serve` generates its config from `[native]` (one
  `model_list` entry per native model, `api_key: os.environ/…`, `drop_params:
  true`, a locally generated master key) and launches it as a managed child.
  Translation bugs stay litellm's.

`sonata serve` runs foreground by default, `--daemon` to detach; `sonata gc`
learns to reap a daemonised serve. Health endpoint on the router so doctor and
`sonata code` can distinguish "up" from "port squatted by something else".

**The user starts it.** The Claude Code auto-mode classifier blocks an
in-session agent from launching an auth-forwarding proxy (measured during the
spike, twice) — that line is correct, and nothing in sonata may assume it can
cross it. `sonata code` may start serve because the user typed the command.

## `sonata code`

A thin launcher:

1. Ensure serve is up (reuse warm, else start).
2. Build env: `ANTHROPIC_BASE_URL=http://localhost:<router>`;
   `CLAUDE_CODE_MAX_CONTEXT_TOKENS=<min over configured native models>` — the
   variable is global and no per-model window channel exists (`modelOverrides`
   is a name map only), so the conservative minimum is used: auto-compact may
   fire early for a larger model, but never overflows a smaller one. Auth
   untouched — the router forwards it.
3. Print one honest line: `native session — Remote Control unavailable here
   (first-party URL check); plain 'claude' sessions are unaffected.`
4. `exec` `claude` with remaining args passed through (`sonata code --model
   sonnet`, `sonata code -p "…"`). Exec, not spawn: the session is the
   process; signals and exit codes behave normally.

## Agent generation

`sonata sync` gains a second generator. For each `[generate.native]` role ×
model it writes `native-<role>-<model>.md`:

- frontmatter `model:` is the native model key — the id the router hands to
  litellm;
- **no MCP tools** — these are real agents, not wrappers;
- read-only roles get real client-side enforcement:
  `tools: Read, Grep, Glob` for explore/review/plan; code gets full tools;
- role prompts compose in as harness-independent guidance, **minus the
  reporting contract** — a native agent's final message is already its report.

Native agents only work inside a `sonata code` session; the agent body's first
line says so, so a dispatch from a plain session fails legibly (the API rejects
the model id) and the text explains why.

## `sonata init` TUI

One new screen group, consistent with the existing left-goes-back flow:

- **Native models** — picker over the discovered gateway catalogue (the same
  opencode discovery init already performs), rows labelled
  `native/<gateway>/<model>`. Skippable; skipping writes no `[native]` table
  and changes nothing else.
- **Native roles** — per-role model assignment, same interaction as the
  existing per-role screen.
- **Key check** — per chosen gateway, resolve the credential chain and show
  the source by name (`acme: key from opencode`), or offer inline
  `sonata auth add` for a gateway with no discovered key.
- Unattended flags: `--native-models`, `--native-roles`; `--yes` selects none
  (native stays opt-in under automation).

The new screens are built on the pure `src/tui.ts` primitives and tested the
same way (parseKey/reduce/renderList, no TTY).

## The claude harness (phase B)

`src/adapters/claude.ts`, the smallest adapter: `claude -p` is a well-behaved
headless CLI — no TUI seeding, no prompt regexes, no quit watcher.

- Modes: `plan` → `--permission-mode plan`; read-only roles → restricted
  `--allowedTools`; `default` → `default` (Claude Code has a real approval
  flow); `acceptEdits`/`bypassPermissions` → same-named modes.
- Launch plan injects the proxy env; refuses cleanly when serve is down,
  with doctor saying why.
- `canWriteReport: true` — the model has Write.
- Model keys follow the existing convention: `claude-<gateway>-<model>`,
  ids resolved from the same `[native]` table.

This gives unproxied sessions foreign-on-Claude-loop dispatch at wrapper-level
rendering, keeping Remote Control in the main session.

## Doctor

New checks: litellm on PATH and version; serve health on both ports (and
"port occupied by something that is not sonata" as its own failure); per-
gateway key source; `[native]`/`claude-` prefix collision (belt to the parse-
time braces); a note when native agents exist but no `[native]` table does
(stale files — `sonata sync --prune`).

## Security

CLAUDE.md's security section gains: the router transits the session credential
locally and unmodified, on the user's machine, at the user's command; sonata
logs paths and upstream choices only. Keys flow store → memory → litellm env.
The native path runs foreign models with Claude Code's *real* tool permission
enforcement — stronger than opencode's advisory sandbox — but prompt injection
guidance is unchanged: untrusted code gets read-only roles or a container.

## Testing

- Router against fake upstreams (the repo's existing fixture pattern): routing
  by model prefix, header forwarding fidelity, bodyless pass-through, upstream
  failure → 502 with a typed error body.
- Config: `[native]` parsing, the `claude-` prefix refusal, litellm config
  generation pinned by fixture.
- Credential chain: source precedence, per-source usability declarations,
  nothing sensitive in any output (asserted, not assumed).
- Generation: native agent files, read-only tools lines, prune behaviour.
- Adapter B against the fake harness suite.
- Init TUI: new screens through the pure reducers.

Tests need no API keys and no network, per the repo convention.

## Risks

- **The seam is unsupported.** `claude-code-guide` confirmed no extension
  surface exists; this works because the API boundary sits below all of them.
  Any release could add client-side model validation or bind auth to the
  default endpoint. Doctor should therefore verify the seam cheaply (the
  unrecognized-model warning format is a canary) and the docs must not promise
  stability.
- **Tool-use fidelity** is proven on toy tasks only. The rollout order is the
  mitigation: explore/review roles (read-only, low blast radius) before code.
- **Remote Control loss** is per-session and disclosed at launch, but users
  will forget. The `sonata code` banner is the mitigation; doctor does not
  nag.
