# Spike: native Claude Code subagents on foreign models

Date: 2026-08-19
Status: proven end to end; throwaway code, not yet productized

Sonata emulates subagents from outside Claude Code's loop. This spike proved
the loop itself will run a foreign model — which makes the subagent *native*:
Claude Code's own Read/Edit/Bash, its own permission modes, turns rendering in
the subagent view, no tmux, no wrapper, no report contract.

## The seam

Claude Code never verifies what answers the Anthropic Messages API. Two probes,
both decisive on 2026-08-19 against Claude Code 2.1.233:

1. `claude --model totally-fake-model-xyz -p …` — the client **warns and sends
   the id to the API**; the rejection is the API's. The warning itself names a
   `modelOverrides` setting for registering unknown models and
   `CLAUDE_CODE_MAX_CONTEXT_TOKENS` for declaring their context window.
   Unknown models behind a compatible endpoint are a designed-for case.
2. An agent file with `model: totally-fake-model-xyz` — identical behaviour,
   `query_source: "agent:custom:probe-fake-model"`. Frontmatter model ids ride
   the same pass-through.

## The architecture that ran

```
claude (main loop, --model sonnet)          claude (subagent, model: deepseek-v4-flash)
        │                                            │
        └────────── ANTHROPIC_BASE_URL ──────────────┘
                    router.mjs :4100
              model starts with "claude-"?
              yes │                │ no
                  ▼                ▼
        api.anthropic.com     litellm :4000  (Messages → OpenAI translation)
        (client auth headers        │
         forwarded untouched;       ▼
         Max OAuth works)     bifrost.advai.net/v1  (vendorx gateway)
                              deepseek-v4-flash-0731
```

- **router.mjs** (~50 lines, node, zero deps): reads `model` from each request
  body; `claude-*` passes through to Anthropic with the client's own auth
  headers byte-for-byte, everything else goes to litellm with the local key.
- **litellm** (1.82.3): accepts Anthropic `/v1/messages` inbound, translates to
  the OpenAI-format gateway. `drop_params: true`.
- The agent file is ordinary: `model: deepseek-v4-flash` in frontmatter.

## Measured results

- **Stage 1** (whole session on deepseek-v4-flash through the proxy): read a
  file with the real Read tool, made a correct style-matching Edit, reported
  accurately. Tool-use fidelity held on a simple task.
- **Translation carries tool use**: a Messages-format request with an
  `input_schema` tool came back `stop_reason: tool_use` with a correct block.
- **Stage 2** (mixed): main loop on Sonnet **via forwarded Max OAuth** — no
  auth error, 3 requests to Anthropic — while the `deepseek-native` subagent
  made 3 requests through litellm and added the requested function correctly.
  The parent correctly reported the subagent's work.

## Honest caveats

- Tool-use fidelity is proven only on toy tasks. Claude Code's prompts are
  tuned for Claude; a cheap foreign model may fumble MultiEdit, long contexts,
  or permission-mode nuance. Needs real-work trials before trusting it.
- The unknown-model warning fires per call until the id is mapped in
  `modelOverrides`; context window should be declared via
  `CLAUDE_CODE_MAX_CONTEXT_TOKENS` or the override.
- The OAuth hop is local and unmodified — the router forwards the user's own
  headers on the user's own machine — but it is still the session credential
  transiting extra software; the spike router logs paths only, never headers.
- The Claude Code auto-mode classifier consistently blocked *launching* the
  auth-forwarding router and the proxied session from inside a session; the
  user ran both by hand. Any productization must expect that and make the user
  the one who starts the proxy.
- `claude-code-guide` (asked 2026-08-19) confirmed there is no supported
  extension surface for foreign turns; this works because the API boundary is
  below all of that. It could break in any release — e.g. client-side model
  validation, or auth binding to the default endpoint.

## Relation to sonata

This is not sonata's harness model: opencode/codex/pi/reasonix run *their own*
agent loops with their own tools. Here the foreign model runs *Claude Code's*
loop. Complementary, not a replacement — harness diversity remains sonata's
reason to exist; this path gives cost-diverse models the native experience.

Spike artifacts (throwaway, in the session scratchpad, not committed):
`spike/litellm.yaml`, `spike/router.mjs`, `spike/testproj/`. The vendorx key
was handled by the user; it never entered the conversation or this repo.
