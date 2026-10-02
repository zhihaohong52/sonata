# Text-form tool calls: recover them, fall back when they can't be

**Status:** implemented (0.15.3).
**Date:** 2026-10-02
**Ships in:** 0.15.3 (maintainer's call; the repo's rule would read it as a
minor, since the router starts rewriting part of a response and a 200 can now
cool a candidate down).

## The bug

In a routed session in hr-automation (2026-10-02, 05:35–05:55 UTC), three
`code-auto` dispatches each ended after one or two tool uses with "The
subagent ended without delivering a report through SubagentHandback". No
error surfaced, so neither the router's fallback nor the sonata-loop's
`sonata dispatch` fallback fired.

Every request went to `anexto-mimo-v2.6-pro` — first in `normal` for every
role in that project's config — through LiteLLM to
`https://bifrost.advai.net/v1`, and every one answered 200. The subagent
transcripts show the model sometimes made real tool calls (`Edit`, `Bash`) and
sometimes wrote them as text in the turn's content, ending the turn:

```
Cleaning up state first and getting reference parameters:<tool_call><function=Bash><parameter=command>cd … && python3 -c " …
stop_reason: end_turn
```

Claude Code saw a text-only `end_turn` and ended the agent. Its handback
enforcer then asked three times; the model "called" `SubagentHandback` the same
way, as text, and drifted into reports of tasks it was never given.

## What was ruled out

- **The gateway's tool parser, in general.** Three direct probes of
  `mimo-v2.6-pro` on bifrost (tool call alone; prose then a tool call; the same
  streamed) all returned structured `tool_calls`.
- **The request.** The failing agent's history was replayed through sonata's
  LiteLLM six times with a trimmed prompt and six times with the real system
  prompt, real tools (from the transcript's `prompt_snapshot`) and the ~18 KB
  of context Claude Code injected as system turns (which `demoteSystemTurns`
  delivers as a user turn). All twelve returned structured tool calls.
- **Routing.** Traffic did reach the foreign model; the 0–43 input-token rows
  are cache hits (LiteLLM's `input_tokens` counts only uncached input).

What remains is the upstream itself during that window: the same window has a
317-second request and two streams cut off with no tokens, and the same model
through OpenRouter has served 2,213 native requests without this. A gateway
that spreads one model name across several backends, one of them without the
matching tool-call parser, produces exactly this mix — intermittent, within
one agent. The router cannot fix the upstream; it can stop a 200 that carries
an unusable answer from looking like success.

## The design

### 1. Recover text tool calls in the stream

A new module, `src/native/text-tool-calls.ts`, with two parts:

- **The parser** — pure, no I/O. Recognises the Qwen-Coder form
  `<tool_call><function=NAME><parameter=KEY>VALUE</parameter>…</function></tool_call>`
  (whitespace and newlines between tags allowed; one or more calls in one
  turn). Returns the text before, each call, and the text after. The format is
  one entry in a table, so another family's format is an addition, not a
  rewrite.
- **The stream rewriter** — an Anthropic SSE transformer the router places
  between LiteLLM's response and the client, on the LiteLLM transport only.
  Text deltas pass through unchanged until a `<` that could begin
  `<tool_call>`; from there text is held back until the markup completes or
  stops matching the prefix (then released as text). A completed call becomes:
  `content_block_stop` for the open text block, then `content_block_start`
  with a `tool_use` block (`id`: `toolu_` + random, `name`, `input: {}`), one
  `input_json_delta` carrying the whole JSON, and `content_block_stop`. Block
  indexes after it are renumbered. When the turn recovered at least one call,
  `message_delta`'s `stop_reason` `end_turn` becomes `tool_use`.

**Typing the arguments.** Values arrive as strings. Each is converted by the
named tool's `input_schema` from the request: `boolean` ← `true`/`false`;
`number`/`integer` ← a numeric literal; `object`/`array` ← `JSON.parse`;
`string` stays as written (inner leading/trailing newline from the tag layout
trimmed, as the Qwen-Coder parsers do). A value that does not convert stays a
string — the tool then reports its own validation error, which the model can
read, rather than the router guessing.

**What is never recovered.** A call naming a tool that is not in the request's
`tools`; markup still unclosed when the stream ends. Both are released as the
text they were — the router never invents a call.

Non-streamed LiteLLM responses get the same parser applied to the content
array of the one JSON body.

### 2. Fall back when it cannot be recovered

A response whose text still contains tool-call markup when the turn ends
(unclosed, or an unknown tool) is delivered as text — it has already started
streaming and cannot be withdrawn — but the candidate that produced it is put
on the ordinary 60 s tier cooldown, as a failed candidate is today. The next
request in that tier goes to the next-ranked model.

The ledger row gains `textToolCalls?: { recovered: number; unparsed: number }`
(absent when both are zero), validated like the other optional fields.
`sonata doctor` warns, per model key, when the last 24 h of the ledger has any
`unparsed`, and reports `recovered` as information: a model that needs
recovering is one the user may want lower in their ranking.

### 3. Auto-route: no task, no decision

`decideTier` fails with `empty task` when the request's first user message has
no text once `<system-reminder>` blocks are removed. In the incident each agent
start was followed 7–13 s later by such a request on the same alias (7–8k input
tokens, a different first message, so a different `conversationKey`) —
Claude Code's own side request for a background agent. It was recorded as a
failed decision, which also counts against `doctor`'s decision health.

Now: an empty task skips the classifier entirely and takes the fallback tier,
recorded as `outcome: 'no-task'`. `no-task` is not a failure for `doctor`'s
decision health or `sonata usage`'s auto-route summary, and costs no
classifier call.

## Scope

- Anthropic transport untouched (byte-identical, as now).
- The harness lane (`sonata dispatch`) untouched.
- No change to tier ranking or config keys.

## Testing

No network. Parser: a clean call; prose then a call; two calls; typed
parameters (boolean, integer, object, array, unconvertible); unknown tool;
unclosed markup; whitespace variants. Stream rewriter: the failing turn's
shape as SSE; the markup split across chunk boundaries at every offset; text
containing `<` that is not a tool call passes through unchanged and in order;
block indexes renumbered; `stop_reason` rewritten only when something was
recovered; a thinking block before the text left alone. Router: an unparsed
call cools the candidate and the next request takes the next one; a recovered
call does not cool it; the ledger field written and validated. Auto-route: an
empty task makes no classifier call and records `no-task`; doctor and usage do
not count it as a failure.

## Out of scope

- Other text tool-call formats (Hermes JSON, Llama) until one is seen.
- Retrying the same request on the next candidate after an unparsed call
  (the response has already streamed).
- Telling the gateway operator — a separate note, if wanted.
