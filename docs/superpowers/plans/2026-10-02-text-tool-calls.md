# Text-form tool calls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a model's text-form tool calls (`<tool_call><function=…>`) into real Anthropic `tool_use` blocks in the router's LiteLLM stream, cool the candidate down when they cannot be recovered, and stop recording task-less auto-route requests as failed decisions.

**Architecture:** A pure parser and an incremental Anthropic-SSE rewriter live in a new `src/native/text-tool-calls.ts`. The router wraps a successful LiteLLM response with the rewriter (innermost wrapper, so its counts are final before the usage recorder emits), cools the candidate on an unparsed call, and records the counts in a new optional ledger field. `decideTier` gains a `no-task` outcome that skips the classifier.

**Tech Stack:** TypeScript (Node 22, ESM), vitest.

**Spec:** `docs/superpowers/specs/2026-10-02-text-tool-calls-design.md`

## Global Constraints

- Anthropic transport (`direct`) untouched — byte-identical, as now. Only the LiteLLM path is rewritten.
- The router never invents a call: an unknown tool name or unclosed markup is released as the text it was.
- Argument values convert by the named tool's `input_schema`; a value that does not convert stays a string.
- `stop_reason` `end_turn` → `tool_use` only when at least one call was recovered in that response.
- An unparsed call cools the candidate with the ordinary `TIER_COOLDOWN_MS`.
- Ledger field: `textToolCalls?: { recovered: number; unparsed: number }`, absent when both are zero; validated (non-negative finite counts) like other optional fields.
- Auto-route: an empty task records `outcome: 'no-task'`, makes no classifier call, and is not a failure in doctor's decision health or usage's summary.
- Version ships as 0.15.3 (CHANGELOG `[Unreleased]` only; the release itself is not part of this plan).
- Tests need no network. Run `npm test` and `npm run typecheck` before finishing.

## Review Focus

1. **Markup split across SSE chunks and events** — `<tool_` in one `text_delta`, `call>` in the next: must still recover, and text order must be preserved exactly.
2. **A `<` that is not a tool call** (`a < b`, `<div>`, HTML in code) — must pass through unchanged and in order, with no delay past the next delta that disproves it.
3. **Block indexes after an inserted `tool_use`** — every later `content_block_*` event must carry a fresh, strictly increasing index, or Claude Code mis-assembles the message.
4. **Disconnect mid-rewrite** — the rewriter must forward `cancel()` to the upstream and must not throw from its `finally`, so the usage row is still written as incomplete.
5. **A thinking block before the text** — passes untouched (thinking/signature deltas are not text).

---

## File Structure

- Create `src/native/text-tool-calls.ts` — parser (`parseToolCallMarkup`, `coerceArguments`, `toolSchemas`), stream rewriter (`rewriteTextToolCallStream`), JSON rewriter (`rewriteTextToolCallJson`), the `TextToolCallCounts` type.
- Create `tests/native/text-tool-calls.test.ts`.
- Modify `src/native/router.ts` — wire the rewriter on the LiteLLM success path, cooldown on unparsed, `textToolCalls` into the ledger row.
- Modify `src/ledger.ts` — `LedgerRow.textToolCalls`, validation; `AutoRouteRecord.outcome` gains `'no-task'`.
- Modify `src/native/auto-route.ts` — `no-task` outcome.
- Modify `src/commands/usage.ts`, `src/cli.ts`, `src/tui-ink/screens/usage.tsx` — `no-task` count.
- Modify `src/commands/doctor.ts` — `no-task` excluded from decision health; new text-tool-call check.
- Tests: `tests/native/router-usage.test.ts`, `tests/ledger.test.ts` (or wherever `hasRequiredFields` is tested — find with `grep -rn "autoRoute" tests/ledger*.test.ts`), `tests/native/auto-route.test.ts`, `tests/commands/doctor.test.ts`, `tests/commands/usage.test.ts`.
- Docs: `CHANGELOG.md`, `docs/internals/native-path.md`.

---

### Task 1: The parser

**Files:**
- Create: `src/native/text-tool-calls.ts`
- Test: `tests/native/text-tool-calls.test.ts`

**Interfaces:**
- Produces:
  - `export type ToolSchemas = Map<string, Record<string, unknown>>` (tool name → its `input_schema`)
  - `export function toolSchemas(requestBody: Buffer): ToolSchemas`
  - `export interface ParsedCall { name: string; input: Record<string, unknown> }`
  - `export function parseToolCallMarkup(markup: string, tools: ToolSchemas): ParsedCall | undefined` — `markup` is one whole `<tool_call>…</tool_call>`; undefined when malformed or the tool is unknown.
  - `export function coerceArguments(raw: Record<string, string>, schema: Record<string, unknown> | undefined): Record<string, unknown>`
  - `export const TOOL_CALL_OPEN = '<tool_call>'`, `export const TOOL_CALL_CLOSE = '</tool_call>'`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { coerceArguments, parseToolCallMarkup, toolSchemas } from '../../src/native/text-tool-calls.js';

const REQUEST = Buffer.from(JSON.stringify({
  model: 'm', messages: [],
  tools: [
    { name: 'Bash', input_schema: { type: 'object', properties: { command: { type: 'string' }, timeout: { type: 'number' } } } },
    { name: 'Edit', input_schema: { type: 'object', properties: {
      file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' },
    } } },
    { name: 'Todo', input_schema: { type: 'object', properties: { items: { type: 'array' }, meta: { type: 'object' }, n: { type: 'integer' } } } },
  ],
}));
const tools = toolSchemas(REQUEST);

describe('toolSchemas', () => {
  it('maps each request tool to its input_schema', () => {
    expect([...tools.keys()]).toEqual(['Bash', 'Edit', 'Todo']);
  });
  it('is empty for a body with no tools or that is not JSON', () => {
    expect(toolSchemas(Buffer.from('{"messages":[]}')).size).toBe(0);
    expect(toolSchemas(Buffer.from('not json')).size).toBe(0);
  });
});

describe('parseToolCallMarkup', () => {
  it('parses the Qwen-Coder form with newlines between tags', () => {
    const markup = '<tool_call>\n<function=Bash>\n<parameter=command>\nls /tmp\n</parameter>\n</function>\n</tool_call>';
    expect(parseToolCallMarkup(markup, tools)).toEqual({ name: 'Bash', input: { command: 'ls /tmp' } });
  });
  it('parses the compact form seen in the incident', () => {
    const markup = '<tool_call><function=Bash><parameter=command>cd /x && python3 -c "print(1)"</parameter></function></tool_call>';
    expect(parseToolCallMarkup(markup, tools)).toEqual({ name: 'Bash', input: { command: 'cd /x && python3 -c "print(1)"' } });
  });
  it('keeps a multi-line value intact apart from the one newline each tag adds', () => {
    const markup = '<tool_call><function=Bash><parameter=command>\nline1\n  line2\n</parameter></function></tool_call>';
    expect(parseToolCallMarkup(markup, tools)?.input).toEqual({ command: 'line1\n  line2' });
  });
  it('types arguments by the tool schema', () => {
    const markup = '<tool_call><function=Edit><parameter=file_path>/a.py</parameter><parameter=old_string>x</parameter>'
      + '<parameter=new_string>y</parameter><parameter=replace_all>false</parameter></function></tool_call>';
    expect(parseToolCallMarkup(markup, tools)?.input).toEqual({ file_path: '/a.py', old_string: 'x', new_string: 'y', replace_all: false });
  });
  it('returns undefined for a tool the request does not offer', () => {
    expect(parseToolCallMarkup('<tool_call><function=SubagentHandback><parameter=message>hi</parameter></function></tool_call>', tools)).toBeUndefined();
  });
  it('returns undefined for malformed markup', () => {
    expect(parseToolCallMarkup('<tool_call><function=Bash><parameter=command>ls</function></tool_call>', tools)).toBeUndefined();
    expect(parseToolCallMarkup('<tool_call>{"name":"Bash"}</tool_call>', tools)).toBeUndefined();
  });
  it('accepts a call with no parameters', () => {
    expect(parseToolCallMarkup('<tool_call><function=Bash></function></tool_call>', tools)).toEqual({ name: 'Bash', input: {} });
  });
});

describe('coerceArguments', () => {
  const schema = (toolSchemas(REQUEST).get('Todo'))!;
  it('converts integer, array and object by schema', () => {
    expect(coerceArguments({ n: '3', items: '[1,2]', meta: '{"a":1}' }, schema)).toEqual({ n: 3, items: [1, 2], meta: { a: 1 } });
  });
  it('leaves a value that does not convert as a string', () => {
    expect(coerceArguments({ n: '3.5', items: '{not json', meta: '[1]' }, schema)).toEqual({ n: '3.5', items: '{not json', meta: '[1]' });
  });
  it('keeps unknown keys and a missing schema as strings', () => {
    expect(coerceArguments({ other: 'true' }, schema)).toEqual({ other: 'true' });
    expect(coerceArguments({ x: '1' }, undefined)).toEqual({ x: '1' });
  });
  it('converts number and boolean', () => {
    const bash = toolSchemas(REQUEST).get('Bash')!;
    expect(coerceArguments({ timeout: '1.5e3', command: 'true' }, bash)).toEqual({ timeout: 1500, command: 'true' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/native/text-tool-calls.test.ts`
Expected: FAIL — cannot resolve `../../src/native/text-tool-calls.js`.

- [ ] **Step 3: Implement**

```ts
/**
 * Tool calls a model wrote as text, recovered into real ones.
 *
 * Some open models emit a tool call as markup in their text —
 * `<tool_call><function=Bash><parameter=command>ls</parameter></function></tool_call>`
 * (the Qwen-Coder form) — and rely on the server's tool-call parser to turn it
 * into a structured call. When the serving backend has no matching parser the
 * markup arrives as plain text in a turn that ends `end_turn`, and Claude Code
 * ends the agent. Measured 2026-10-02 on `mimo-v2.6-pro` through one gateway,
 * intermittently within a single agent (spec:
 * docs/superpowers/specs/2026-10-02-text-tool-calls-design.md).
 *
 * Nothing here guesses: a call naming a tool the request did not offer, or
 * markup that does not close, is left as the text it was.
 */

export const TOOL_CALL_OPEN = '<tool_call>';
export const TOOL_CALL_CLOSE = '</tool_call>';

/** Tool name → its `input_schema`, from the request the response answers. */
export type ToolSchemas = Map<string, Record<string, unknown>>;

export interface ParsedCall { name: string; input: Record<string, unknown> }

export function toolSchemas(requestBody: Buffer): ToolSchemas {
  const schemas: ToolSchemas = new Map();
  let tools: unknown;
  try {
    tools = (JSON.parse(requestBody.toString()) as { tools?: unknown }).tools;
  } catch {
    return schemas;
  }
  if (!Array.isArray(tools)) return schemas;
  for (const tool of tools) {
    if (tool === null || typeof tool !== 'object') continue;
    const { name, input_schema: schema } = tool as { name?: unknown; input_schema?: unknown };
    if (typeof name !== 'string') continue;
    schemas.set(name, schema !== null && typeof schema === 'object' ? schema as Record<string, unknown> : {});
  }
  return schemas;
}

const CALL = /^<tool_call>\s*<function=([^>\s]+)>([\s\S]*?)<\/function>\s*<\/tool_call>$/;
const PARAMETER = /<parameter=([^>\s]+)>([\s\S]*?)<\/parameter>/g;

export function parseToolCallMarkup(markup: string, tools: ToolSchemas): ParsedCall | undefined {
  const match = CALL.exec(markup.trim());
  if (match === null) return undefined;
  const [, name, body] = match;
  if (!tools.has(name)) return undefined;
  const raw: Record<string, string> = {};
  for (const parameter of body.matchAll(PARAMETER)) {
    // One newline on each side is the tag layout, not the value.
    raw[parameter[1]] = parameter[2].replace(/^\n/, '').replace(/\n$/, '');
  }
  // Anything but whitespace outside the parameters means the markup is not
  // the form this parser knows — an unclosed parameter, JSON, prose.
  if (body.replace(PARAMETER, '').trim() !== '') return undefined;
  return { name, input: coerceArguments(raw, tools.get(name)) };
}

const NUMBER = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

function typesOf(schema: Record<string, unknown> | undefined, key: string): string[] {
  const properties = schema?.properties;
  if (properties === null || typeof properties !== 'object') return [];
  const type = (properties as Record<string, { type?: unknown }>)[key]?.type;
  if (typeof type === 'string') return [type];
  return Array.isArray(type) ? type.filter((t): t is string => typeof t === 'string') : [];
}

function convert(value: string, types: string[]): unknown {
  for (const type of types) {
    if (type === 'boolean' && (value === 'true' || value === 'false')) return value === 'true';
    if ((type === 'number' || type === 'integer') && NUMBER.test(value.trim())) {
      const n = Number(value.trim());
      if (type === 'number' || Number.isInteger(n)) return n;
    }
    if (type === 'object' || type === 'array') {
      try {
        const parsed: unknown = JSON.parse(value);
        if (type === 'array' ? Array.isArray(parsed) : parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      } catch { /* not JSON: stays a string */ }
    }
  }
  return value;
}

export function coerceArguments(raw: Record<string, string>, schema: Record<string, unknown> | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, convert(value, typesOf(schema, key))]));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/native/text-tool-calls.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/native/text-tool-calls.ts tests/native/text-tool-calls.test.ts
git commit -m "feat(router): parse text-form tool calls against the request's tools"
```

---

### Task 2: The stream and JSON rewriters

**Files:**
- Modify: `src/native/text-tool-calls.ts`
- Test: `tests/native/text-tool-calls.test.ts`

**Interfaces:**
- Consumes: Task 1's `parseToolCallMarkup`, `ToolSchemas`, `TOOL_CALL_OPEN`, `TOOL_CALL_CLOSE`.
- Produces:
  - `export interface TextToolCallCounts { recovered: number; unparsed: number }`
  - `export function rewriteTextToolCallStream(body: AsyncIterable<Uint8Array>, tools: ToolSchemas, onEnd: (counts: TextToolCallCounts) => void, newId?: () => string): AsyncIterable<Uint8Array> & { cancel(): void }` — Anthropic SSE in, Anthropic SSE out. `onEnd` runs exactly once, in a `finally`, never throws out.
  - `export function rewriteTextToolCallJson(body: Buffer, tools: ToolSchemas, newId?: () => string): { body: Buffer; counts: TextToolCallCounts }` — a non-streamed Anthropic message; returns the body unchanged when nothing was found.

**Behaviour of the stream rewriter (the exact rules):**
- Split input on `\n\n` into SSE events (keep an incomplete tail across chunks). Each event: lines `event: X` and `data: {json}`. An event whose `data` is not JSON passes through untouched.
- Output block indexes are allocated sequentially: every upstream `content_block_start` gets `nextOut++`; every inserted block gets `nextOut++`. Every event carrying `index` is rewritten to its mapped output index.
- A `text` block's `text_delta`s go through a scanner with state `{ mode: 'text' | 'call', pending: string }`:
  - `text` mode: emit everything before the first `<`. From the `<`: if the rest is a proper prefix of `<tool_call>`, hold it; if it starts with `<tool_call>`, switch to `call` mode holding it; otherwise emit the `<` and keep scanning after it.
  - `call` mode: when `</tool_call>` appears, take the markup up to and including it. `parseToolCallMarkup` → on success: close the current text block (`content_block_stop` with its out index) unless it was already closed, emit `content_block_start` `{type:'tool_use', id, name, input:{}}`, one `content_block_delta` `{type:'input_json_delta', partial_json: JSON.stringify(input)}`, `content_block_stop`; `recovered++`; mark the text block closed. On failure: emit the markup as text, `unparsed++`. Continue scanning after it in `text` mode.
  - Emitting text when the current text block is closed: if the text is whitespace-only, drop it; otherwise open a new text block (`content_block_start {type:'text', text:''}` at `nextOut++`) and emit into it.
  - Text is emitted as one `content_block_delta {type:'text_delta'}` per scanner flush, at the current text block's out index.
- On the upstream `content_block_stop` of a text block: flush — held text (a partial `<tool_c`, or unclosed `call`-mode markup) is emitted as text; unclosed markup counts `unparsed++`. Then forward the stop only if the current text block is open.
- `message_delta`: when `recovered > 0` and `delta.stop_reason === 'end_turn'`, rewrite it to `'tool_use'`.
- Every other event (including `thinking` blocks and their deltas) passes through with only its index remapped.
- `cancel()` cancels the upstream body (forward to `(body as {cancel?}).cancel?.()`).

- [ ] **Step 1: Write the failing tests** (append to `tests/native/text-tool-calls.test.ts`)

```ts
import { rewriteTextToolCallJson, rewriteTextToolCallStream, type TextToolCallCounts } from '../../src/native/text-tool-calls.js';

const ev = (type: string, data: Record<string, unknown>): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const textStream = (deltas: string[], stop = 'end_turn', withThinking = false): string => [
  ev('message_start', { message: { id: 'm', role: 'assistant', content: [] } }),
  ...(withThinking ? [
    ev('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }),
    ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'hmm <tool_call>' } }),
    ev('content_block_stop', { index: 0 }),
  ] : []),
  ev('content_block_start', { index: withThinking ? 1 : 0, content_block: { type: 'text', text: '' } }),
  ...deltas.map((text) => ev('content_block_delta', { index: withThinking ? 1 : 0, delta: { type: 'text_delta', text } })),
  ev('content_block_stop', { index: withThinking ? 1 : 0 }),
  ev('message_delta', { delta: { stop_reason: stop }, usage: { output_tokens: 5 } }),
  ev('message_stop', {}),
].join('');

async function* chunked(text: string, sizes: number[]): AsyncIterable<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  for (const size of sizes) { yield bytes.slice(at, at + size); at += size; }
  if (at < bytes.length) yield bytes.slice(at);
}

async function run(text: string, sizes: number[] = [text.length]): Promise<{ events: Array<Record<string, any>>; counts: TextToolCallCounts }> {
  let counts: TextToolCallCounts | undefined;
  let n = 0;
  const out = rewriteTextToolCallStream(chunked(text, sizes), tools, (c) => { counts = c; }, () => `toolu_test${n++}`);
  let raw = '';
  for await (const chunk of out) raw += new TextDecoder().decode(chunk);
  const events = raw.split('\n\n').filter(Boolean).map((e) => JSON.parse(e.split('\n').find((l) => l.startsWith('data: '))!.slice(6)));
  return { events, counts: counts! };
}

const text = (events: Array<Record<string, any>>): string => events
  .filter((e) => e.type === 'content_block_delta' && e.delta.type === 'text_delta').map((e) => e.delta.text).join('');

const CALL = '<tool_call><function=Bash><parameter=command>ls /tmp</parameter></function></tool_call>';

describe('rewriteTextToolCallStream', () => {
  it('passes a stream with no markup through unchanged in content', async () => {
    const { events, counts } = await run(textStream(['Hello ', 'world']));
    expect(text(events)).toBe('Hello world');
    expect(events.find((e) => e.type === 'message_delta').delta.stop_reason).toBe('end_turn');
    expect(counts).toEqual({ recovered: 0, unparsed: 0 });
  });

  it('turns prose then a call into a text block and a tool_use block', async () => {
    const { events, counts } = await run(textStream(['Listing now: ', CALL]));
    expect(text(events)).toBe('Listing now: ');
    const start = events.find((e) => e.type === 'content_block_start' && e.content_block.type === 'tool_use');
    expect(start).toMatchObject({ index: 1, content_block: { type: 'tool_use', id: 'toolu_test0', name: 'Bash', input: {} } });
    const json = events.find((e) => e.type === 'content_block_delta' && e.delta.type === 'input_json_delta');
    expect(JSON.parse(json.delta.partial_json)).toEqual({ command: 'ls /tmp' });
    expect(events.find((e) => e.type === 'message_delta').delta.stop_reason).toBe('tool_use');
    expect(counts).toEqual({ recovered: 1, unparsed: 0 });
    // Exactly one stop per opened block, and indexes strictly increasing by first appearance.
    const starts = events.filter((e) => e.type === 'content_block_start').map((e) => e.index);
    const stops = events.filter((e) => e.type === 'content_block_stop').map((e) => e.index);
    expect(starts).toEqual([0, 1]);
    expect(stops.sort()).toEqual([0, 1]);
  });

  it('recovers the call however the stream is split, at every byte offset', async () => {
    const full = textStream(['Listing now: ', CALL]);
    for (let cut = 1; cut < full.length; cut++) {
      const { events, counts } = await run(full, [cut]);
      expect(counts, `cut at ${cut}`).toEqual({ recovered: 1, unparsed: 0 });
      expect(text(events)).toBe('Listing now: ');
    }
  });

  it('recovers markup split across text deltas', async () => {
    const { counts, events } = await run(textStream(['Go <tool_', 'call><function=Bash><parameter=command>ls', ' /tmp</parameter></function></tool_call>']));
    expect(counts).toEqual({ recovered: 1, unparsed: 0 });
    expect(text(events)).toBe('Go ');
  });

  it('passes a < that is not a tool call through unchanged and in order', async () => {
    const { events, counts } = await run(textStream(['if a < b and <div> ', '<tool', 'tip> done']));
    expect(text(events)).toBe('if a < b and <div> <tooltip> done');
    expect(counts).toEqual({ recovered: 0, unparsed: 0 });
  });

  it('releases a call to an unknown tool as text and counts it unparsed', async () => {
    const unknown = '<tool_call><function=SubagentHandback><parameter=message>r</parameter></function></tool_call>';
    const { events, counts } = await run(textStream(['x', unknown]));
    expect(text(events)).toBe('x' + unknown);
    expect(counts).toEqual({ recovered: 0, unparsed: 1 });
    expect(events.find((e) => e.type === 'message_delta').delta.stop_reason).toBe('end_turn');
  });

  it('releases unclosed markup at the block end and counts it unparsed', async () => {
    const { events, counts } = await run(textStream(['x <tool_call><function=Bash><parameter=command>ls']));
    expect(text(events)).toBe('x <tool_call><function=Bash><parameter=command>ls');
    expect(counts).toEqual({ recovered: 0, unparsed: 1 });
  });

  it('recovers two calls in one turn as two tool_use blocks', async () => {
    const { events, counts } = await run(textStream([CALL, '\n', CALL]));
    expect(counts).toEqual({ recovered: 2, unparsed: 0 });
    expect(events.filter((e) => e.type === 'content_block_start' && e.content_block.type === 'tool_use').map((e) => e.index)).toEqual([1, 2]);
  });

  it('opens a new text block for prose after a recovered call', async () => {
    const { events } = await run(textStream([CALL, ' and then more']));
    const starts = events.filter((e) => e.type === 'content_block_start');
    expect(starts.map((e) => e.content_block.type)).toEqual(['text', 'tool_use', 'text']);
    expect(starts.map((e) => e.index)).toEqual([0, 1, 2]);
  });

  it('leaves a thinking block alone and shifts the text after it correctly', async () => {
    const { events, counts } = await run(textStream(['ok ', CALL], 'end_turn', true));
    expect(events.find((e) => e.delta?.type === 'thinking_delta').delta.thinking).toBe('hmm <tool_call>');
    expect(counts.recovered).toBe(1);
    expect(events.filter((e) => e.type === 'content_block_start').map((e) => e.index)).toEqual([0, 1, 2]);
  });

  it('calls onEnd once even when the consumer stops early, and forwards cancel', async () => {
    let ends = 0;
    let cancelled = false;
    const upstream = Object.assign(chunked(textStream(['a', 'b']), [5]), { cancel: () => { cancelled = true; } });
    const out = rewriteTextToolCallStream(upstream, tools, () => { ends += 1; });
    for await (const _ of out) break;
    out.cancel();
    expect(ends).toBe(1);
    expect(cancelled).toBe(true);
  });
});

describe('rewriteTextToolCallJson', () => {
  it('splits a text block holding a call into text and tool_use, and sets stop_reason', () => {
    const body = Buffer.from(JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'Now: ' + CALL }], stop_reason: 'end_turn' }));
    const { body: out, counts } = rewriteTextToolCallJson(body, tools, () => 'toolu_x');
    const message = JSON.parse(out.toString());
    expect(message.content).toEqual([
      { type: 'text', text: 'Now: ' },
      { type: 'tool_use', id: 'toolu_x', name: 'Bash', input: { command: 'ls /tmp' } },
    ]);
    expect(message.stop_reason).toBe('tool_use');
    expect(counts).toEqual({ recovered: 1, unparsed: 0 });
  });
  it('returns the identical buffer when there is nothing to recover', () => {
    const body = Buffer.from(JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' }));
    expect(rewriteTextToolCallJson(body, tools).body).toBe(body);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/native/text-tool-calls.test.ts`
Expected: FAIL — `rewriteTextToolCallStream` / `rewriteTextToolCallJson` are not exported.

- [ ] **Step 3: Implement** (append to `src/native/text-tool-calls.ts`)

```ts
import { randomBytes } from 'node:crypto';

export interface TextToolCallCounts { recovered: number; unparsed: number }

const defaultId = (): string => `toolu_${randomBytes(12).toString('hex')}`;

/** One scan of text: what to emit as text, what calls were found, in order. */
type Piece = { kind: 'text'; text: string } | { kind: 'call'; call: ParsedCall };

/**
 * The scanner both rewriters share. `push` returns the pieces that are
 * settled; `end` releases whatever is still held as text.
 */
function createScanner(tools: ToolSchemas, counts: TextToolCallCounts) {
  let pending = '';
  let inCall = false;
  return {
    push(text: string): Piece[] {
      pending += text;
      const pieces: Piece[] = [];
      for (;;) {
        if (inCall) {
          const close = pending.indexOf(TOOL_CALL_CLOSE);
          if (close === -1) return pieces;
          const markup = pending.slice(0, close + TOOL_CALL_CLOSE.length);
          pending = pending.slice(markup.length);
          inCall = false;
          const call = parseToolCallMarkup(markup, tools);
          if (call === undefined) { counts.unparsed += 1; pieces.push({ kind: 'text', text: markup }); } else { counts.recovered += 1; pieces.push({ kind: 'call', call }); }
          continue;
        }
        const lt = pending.indexOf('<');
        if (lt === -1) { if (pending) pieces.push({ kind: 'text', text: pending }); pending = ''; return pieces; }
        if (lt > 0) { pieces.push({ kind: 'text', text: pending.slice(0, lt) }); pending = pending.slice(lt); }
        if (pending.startsWith(TOOL_CALL_OPEN)) { inCall = true; continue; }
        if (TOOL_CALL_OPEN.startsWith(pending)) return pieces; // a prefix: wait for more
        pieces.push({ kind: 'text', text: '<' });
        pending = pending.slice(1);
      }
    },
    end(): Piece[] {
      if (pending === '') return [];
      if (inCall) counts.unparsed += 1;
      const rest = pending;
      pending = '';
      inCall = false;
      return [{ kind: 'text', text: rest }];
    },
  };
}

const sse = (data: Record<string, unknown>): string => `event: ${String(data.type)}\ndata: ${JSON.stringify(data)}\n\n`;

export function rewriteTextToolCallStream(
  body: AsyncIterable<Uint8Array>,
  tools: ToolSchemas,
  onEnd: (counts: TextToolCallCounts) => void,
  newId: () => string = defaultId,
): AsyncIterable<Uint8Array> & { cancel(): void } {
  const counts: TextToolCallCounts = { recovered: 0, unparsed: 0 };
  const encoder = new TextEncoder();
  async function* chunks(): AsyncIterable<Uint8Array> {
    const decoder = new TextDecoder();
    let buffer = '';
    let nextOut = 0;
    const outIndex = new Map<number, number>();
    // The upstream text block being scanned, and where its text goes now.
    let textUpstream: number | undefined;
    let textOut: number | undefined; // undefined = closed by a recovered call
    let scanner: ReturnType<typeof createScanner> | undefined;

    const emitPieces = (pieces: Piece[]): string => {
      let out = '';
      for (const piece of pieces) {
        if (piece.kind === 'text') {
          if (piece.text === '') continue;
          if (textOut === undefined) {
            if (piece.text.trim() === '') continue;
            textOut = nextOut++;
            out += sse({ type: 'content_block_start', index: textOut, content_block: { type: 'text', text: '' } });
          }
          out += sse({ type: 'content_block_delta', index: textOut, delta: { type: 'text_delta', text: piece.text } });
        } else {
          if (textOut !== undefined) out += sse({ type: 'content_block_stop', index: textOut });
          textOut = undefined;
          const index = nextOut++;
          out += sse({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: newId(), name: piece.call.name, input: {} } });
          out += sse({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(piece.call.input) } });
          out += sse({ type: 'content_block_stop', index });
        }
      }
      return out;
    };

    const handle = (raw: string): string => {
      const dataLine = raw.split('\n').find((line) => line.startsWith('data: '));
      if (dataLine === undefined) return `${raw}\n\n`;
      let data: Record<string, any>;
      try { data = JSON.parse(dataLine.slice(6)) as Record<string, any>; } catch { return `${raw}\n\n`; }
      switch (data.type) {
        case 'content_block_start': {
          const index = nextOut++;
          outIndex.set(data.index, index);
          if (data.content_block?.type === 'text') {
            textUpstream = data.index; textOut = index; scanner = createScanner(tools, counts);
          }
          return sse({ ...data, index });
        }
        case 'content_block_delta': {
          if (data.index === textUpstream && data.delta?.type === 'text_delta' && scanner !== undefined) {
            return emitPieces(scanner.push(String(data.delta.text ?? '')));
          }
          return sse({ ...data, index: outIndex.get(data.index) ?? data.index });
        }
        case 'content_block_stop': {
          if (data.index === textUpstream && scanner !== undefined) {
            let out = emitPieces(scanner.end());
            if (textOut !== undefined) out += sse({ type: 'content_block_stop', index: textOut });
            textUpstream = undefined; textOut = undefined; scanner = undefined;
            return out;
          }
          return sse({ ...data, index: outIndex.get(data.index) ?? data.index });
        }
        case 'message_delta':
          if (counts.recovered > 0 && data.delta?.stop_reason === 'end_turn') {
            return sse({ ...data, delta: { ...data.delta, stop_reason: 'tool_use' } });
          }
          return `${raw}\n\n`;
        default:
          return `${raw}\n\n`;
      }
    };

    try {
      for await (const chunk of body) {
        buffer += decoder.decode(chunk, { stream: true });
        let out = '';
        let split: number;
        while ((split = buffer.indexOf('\n\n')) !== -1) {
          out += handle(buffer.slice(0, split));
          buffer = buffer.slice(split + 2);
        }
        if (out !== '') yield encoder.encode(out);
      }
      buffer += decoder.decode();
      if (buffer.trim() !== '') yield encoder.encode(handle(buffer.replace(/\n+$/, '')));
    } finally {
      try { onEnd(counts); } catch { /* bookkeeping never reaches the client */ }
    }
  }
  return Object.assign(chunks(), { cancel: () => { (body as { cancel?: () => void }).cancel?.(); } });
}

export function rewriteTextToolCallJson(body: Buffer, tools: ToolSchemas, newId: () => string = defaultId): { body: Buffer; counts: TextToolCallCounts } {
  const counts: TextToolCallCounts = { recovered: 0, unparsed: 0 };
  let message: { content?: unknown; stop_reason?: unknown };
  try { message = JSON.parse(body.toString()) as typeof message; } catch { return { body, counts }; }
  if (!Array.isArray(message.content) || !message.content.some((b) => b?.type === 'text' && String(b.text).includes(TOOL_CALL_OPEN))) {
    return { body, counts };
  }
  const content: unknown[] = [];
  for (const block of message.content as Array<Record<string, unknown>>) {
    if (block?.type !== 'text' || !String(block.text).includes(TOOL_CALL_OPEN)) { content.push(block); continue; }
    const scanner = createScanner(tools, counts);
    let text = '';
    const flush = (): void => { if (text.trim() !== '') content.push({ type: 'text', text }); text = ''; };
    for (const piece of [...scanner.push(String(block.text)), ...scanner.end()]) {
      if (piece.kind === 'text') text += piece.text;
      else { flush(); content.push({ type: 'tool_use', id: newId(), name: piece.call.name, input: piece.call.input }); }
    }
    flush();
  }
  if (counts.recovered === 0 && counts.unparsed === 0) return { body, counts };
  const stop = counts.recovered > 0 && message.stop_reason === 'end_turn' ? 'tool_use' : message.stop_reason;
  return { body: Buffer.from(JSON.stringify({ ...message, content, stop_reason: stop })), counts };
}
```

Notes for the implementer: keep the `import { randomBytes }` at the top of the file with any other imports. The `sse()` helper re-serialises rewritten events; untouched events are forwarded verbatim (`${raw}\n\n`) so byte-for-byte passthrough holds for everything the rewriter does not change. If a test shows SSE events terminated by `\r\n\r\n` from LiteLLM, normalise `\r\n` → `\n` on input before splitting (check one real captured stream before assuming).

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/native/text-tool-calls.test.ts`
Expected: PASS (all of Task 1 and Task 2).

- [ ] **Step 5: Commit**

```bash
git add src/native/text-tool-calls.ts tests/native/text-tool-calls.test.ts
git commit -m "feat(router): rewrite text-form tool calls into tool_use blocks in a stream or message"
```

---

### Task 3: Router wiring, cooldown, ledger field

**Files:**
- Modify: `src/native/router.ts` (success path in `routeTierRequest`, ~line 1989–2025; `RecordContext` ~line 409; `withUsageRecording` emit ~line 452)
- Modify: `src/ledger.ts` (`LedgerRow`, `hasRequiredFields`)
- Test: `tests/native/router-usage.test.ts`, the ledger validation test file

**Interfaces:**
- Consumes: `toolSchemas`, `rewriteTextToolCallStream`, `rewriteTextToolCallJson`, `TextToolCallCounts` (Tasks 1–2).
- Produces: `LedgerRow.textToolCalls?: { recovered: number; unparsed: number }` (read by Task 4).

- [ ] **Step 1: Write the failing router tests** (append to `tests/native/router-usage.test.ts`; reuses its `sse`, `deps`, `drain`, `req` helpers)

```ts
describe('router — text-form tool calls', () => {
  const CALL = '<tool_call><function=Bash><parameter=command>ls</parameter></function></tool_call>';
  const ev = (type: string, data: Record<string, unknown>): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const stream = (text: string): string => [
    ev('message_start', { message: { id: 'm', role: 'assistant', content: [] } }),
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }),
    ev('content_block_stop', { index: 0 }),
    ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 10, output_tokens: 5 } }),
    ev('message_stop', {}),
  ].join('');
  const withTools = (model: string) => ({
    ...req(model),
    body: Buffer.from(JSON.stringify({ model, messages: [], tools: [{ name: 'Bash', input_schema: { type: 'object', properties: { command: { type: 'string' } } } }] })),
  });

  it('recovers a text tool call, rewrites stop_reason, and records it', async () => {
    clearCooldowns();
    const rows: LedgerRow[] = [];
    const res = await routeRequest(withTools('sonata-code-simple'), deps(rows, () => sse(stream('Go ' + CALL))));
    const out = await drain(res.body);
    expect(out).toContain('"type":"tool_use"');
    expect(out).toContain('"stop_reason":"tool_use"');
    expect(rows[0].textToolCalls).toEqual({ recovered: 1, unparsed: 0 });
  });

  it('cools the candidate on an unparsed call so the next request takes the next one', async () => {
    clearCooldowns();
    const rows: LedgerRow[] = [];
    const seen: string[] = [];
    const twoModels: RouterDeps = {
      ...deps(rows, () => sse(stream('x <tool_call><function=Nope></function></tool_call>'))),
      fetch: (async (_url: string, init: { body: string }) => {
        seen.push(JSON.parse(init.body).model);
        return sse(stream('x <tool_call><function=Nope></function></tool_call>'));
      }) as unknown as typeof fetch,
      resolveTier: (alias) => alias === 'sonata-code-simple'
        ? { role: 'code', tier: 'simple', routes: [{ key: 'flash', native: { gateway: 'acme', id: 'x' } }, { key: 'pro', native: { gateway: 'acme', id: 'y' } }] }
        : undefined,
    };
    await drain((await routeRequest(withTools('sonata-code-simple'), twoModels)).body);
    await drain((await routeRequest(withTools('sonata-code-simple'), twoModels)).body);
    expect(rows[0].textToolCalls).toEqual({ recovered: 0, unparsed: 1 });
    expect(rows[0].key).toBe('flash');
    expect(rows[1].key).toBe('pro');
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  });

  it('writes no textToolCalls field when nothing was found', async () => {
    clearCooldowns();
    const rows: LedgerRow[] = [];
    await drain((await routeRequest(withTools('sonata-code-simple'), deps(rows, () => sse(stream('plain'))))).body);
    expect('textToolCalls' in rows[0]).toBe(false);
  });
});
```

(Check how `seen` should read the routed model: the LiteLLM body's `model` is the LiteLLM model name, which differs per candidate — if `deps.fetch`'s second argument shape differs in this file, adapt the stub to what the existing tests in the file use; the assertion that matters is `rows[1].key === 'pro'`.)

- [ ] **Step 2: Write the failing ledger validation test** — in the file that tests `readRows`/`hasRequiredFields` (find with `grep -rln "autoRouteIsValid\|drops a row" tests/`), add:

```ts
it('keeps a row with valid textToolCalls and drops one with negative or non-numeric counts', () => {
  const home = mkdtempSync(join(tmpdir(), 'ledger-ttc-'));
  const base = { ts: new Date().toISOString(), ms: 1, alias: 'a', upstream: 'litellm', status: 200, complete: true,
    tokens: { input: 1, output: 1 }, price: { source: 'none' }, attempts: [] };
  appendRow(home, { ...base, textToolCalls: { recovered: 1, unparsed: 0 } } as LedgerRow);
  appendRow(home, { ...base, textToolCalls: { recovered: -1, unparsed: 0 } } as LedgerRow);
  appendRow(home, { ...base, textToolCalls: { recovered: 'x', unparsed: 0 } } as unknown as LedgerRow);
  const rows = readRows(home, 0, Date.now() + 1000);
  expect(rows).toHaveLength(1);
  expect(rows[0].textToolCalls).toEqual({ recovered: 1, unparsed: 0 });
});
```

(Use the imports and the `readRows` signature that file already uses.)

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run tests/native/router-usage.test.ts` and the ledger test file.
Expected: FAIL — no `tool_use` in the output; `textToolCalls` undefined; the invalid rows are kept.

- [ ] **Step 4: Implement**

`src/ledger.ts` — in `LedgerRow`, after `litellm?`:

```ts
  /**
   * Tool calls the model wrote as text: `recovered` were turned into real
   * calls by the router, `unparsed` could not be (and cooled the candidate).
   * Absent when there were none.
   */
  textToolCalls?: { recovered: number; unparsed: number };
```

and in `hasRequiredFields`, after the `autoRoute` check:

```ts
  if ('textToolCalls' in row) {
    const t = row.textToolCalls;
    if (t === null || typeof t !== 'object' || Array.isArray(t) || !isCount(t.recovered) || !isCount(t.unparsed)) return false;
  }
```

`src/native/router.ts`:

1. Import: `import { rewriteTextToolCallJson, rewriteTextToolCallStream, toolSchemas, type TextToolCallCounts } from './text-tool-calls.js';`
2. `RecordContext` gains `textToolCalls?: TextToolCallCounts;` (a live object the rewriter fills; read at emit time).
3. In `withUsageRecording`'s `deps.recordUsage?.({...})` object, after `litellm: …`:

```ts
          ...(ctx.textToolCalls !== undefined && (ctx.textToolCalls.recovered > 0 || ctx.textToolCalls.unparsed > 0)
            ? { textToolCalls: { ...ctx.textToolCalls } }
            : {}),
```

4. In `routeTierRequest`'s success path, immediately after the `capability400Counts` cleanup loop and **before** `const completed = …`, add:

```ts
    // A model whose serving backend has no tool-call parser writes its calls
    // as text and ends the turn; Claude Code then ends the agent. Recover
    // what parses; an unparsable call still reaches the client as text (it
    // has started streaming), but cools this candidate so the next request
    // takes the next one. LiteLLM path only: Anthropic speaks tool_use itself.
    const textToolCalls: TextToolCallCounts = { recovered: 0, unparsed: 0 };
    let served = response;
    if (!direct && response.status === 200) {
      const tools = toolSchemas(req.body);
      const onEnd = (counts: TextToolCallCounts): void => {
        textToolCalls.recovered = counts.recovered;
        textToolCalls.unparsed = counts.unparsed;
        if (counts.unparsed > 0) {
          cooldowns.set(cool, now() + TIER_COOLDOWN_MS);
          if (conversation !== undefined) stickyDemote(conversation, route.key);
          deps.log?.(`router: ${alias} ${variant} wrote ${counts.unparsed} tool call(s) as text that could not be recovered; cooling it`);
        }
      };
      if ((response.headers['content-type'] ?? '').includes('text/event-stream') && !Buffer.isBuffer(response.body)) {
        served = { ...response, body: rewriteTextToolCallStream(response.body, tools, onEnd) };
      } else {
        const buffered = Buffer.isBuffer(response.body) ? response.body : await bufferBody(response.body, deps);
        const { body: rewritten, counts } = rewriteTextToolCallJson(buffered, tools);
        onEnd(counts);
        served = { ...response, body: rewritten };
      }
    }
```

then change `const completed = conversation === undefined ? response : withCompletion(response, …)` to use `served` in both places, and add `textToolCalls,` to the `withUsageRecording(completed, { … })` context object. Use the names already in scope there (`cool`, `now`, `alias`, `variant`, `conversation`, `route`, `direct`, `req`); if `now` is not a local function in that scope, use `(deps.now ?? Date.now)()` as the surrounding code does. The `content-length` header must not survive a rewritten JSON body — `responseHeaders` already drops it (hop-by-hop list); confirm by reading it.

**Ordering note (do not change):** the rewriter is the innermost wrapper, so its `finally` (which fills `textToolCalls`) runs before `withUsageRecording`'s `observe` `onEnd` emits the row.

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run tests/native/router-usage.test.ts tests/native/router.test.ts` and the ledger test file.
Expected: PASS, including every pre-existing router test (no text markup → byte-identical content).

- [ ] **Step 6: Commit**

```bash
git add src/native/router.ts src/ledger.ts tests/native/router-usage.test.ts <ledger test file>
git commit -m "feat(router): recover text tool calls on the LiteLLM path; cool a candidate whose call cannot be"
```

---

### Task 4: Doctor reports text tool calls

**Files:**
- Modify: `src/commands/doctor.ts` (after the auto-route block that ends ~line 935)
- Test: `tests/commands/doctor.test.ts`

**Interfaces:**
- Consumes: `LedgerRow.textToolCalls` (Task 3).

- [ ] **Step 1: Write the failing tests** (in `tests/commands/doctor.test.ts`, inside the describe that has `autoRouteRow`, or a new describe with the same imports)

```ts
describe('doctor — text tool calls', () => {
  const row = (tenant: string | undefined, key: string, counts: { recovered: number; unparsed: number }): LedgerRow => ({
    ts: new Date().toISOString(), ms: 500, alias: 'sonata-code-normal', role: 'code', tier: 'normal',
    key, gateway: 'acme', upstream: 'litellm', status: 200, complete: true,
    tokens: { input: 10, output: 2, cacheRead: 0, cacheCreation: 0 }, price: { source: 'none' }, attempts: [], tenant,
    textToolCalls: counts,
  });

  it('fails naming the model when calls could not be recovered in the last 24h', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'doc-ttc-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-ttc-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), 'schema_version = 1\n');
    const tenant = projectTenant(cwd, home);
    appendRow(home, row(tenant, 'anexto-mimo-v2.6-pro', { recovered: 2, unparsed: 1 }));
    const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home });
    const check = checks.find((c) => c.name === 'text tool calls');
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('anexto-mimo-v2.6-pro');
    expect(check?.detail).toContain('1 unrecovered');
    expect(check?.detail).toContain('2 recovered');
  });

  it('reports recovered-only calls as information, not a failure', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'doc-ttc-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-ttc-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), 'schema_version = 1\n');
    appendRow(home, row(projectTenant(cwd, home), 'm', { recovered: 3, unparsed: 0 }));
    const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home });
    const check = checks.find((c) => c.name === 'text tool calls');
    expect(check?.ok).toBe(true);
    expect(check?.detail).toContain('3 recovered');
  });

  it('says nothing when no row has text tool calls', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'doc-ttc-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-ttc-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), 'schema_version = 1\n');
    const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home });
    expect(checks.some((c) => c.name === 'text tool calls')).toBe(false);
  });
});
```

(If `schema_version = 1` alone does not parse as a config here, use the smallest config another doctor test in the file uses; `NO_CLIENT` is the file's existing constant.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/commands/doctor.test.ts -t "text tool calls"`
Expected: FAIL — no `text tool calls` check.

- [ ] **Step 3: Implement** — after the `if (config.autoRoute !== undefined) { … }` block closes, add (reusing `readRows`, `projectTenant`, `now` exactly as the auto-route block does):

```ts
  // A model that writes its tool calls as text ends agents silently. The
  // router recovers what parses and cools the model on what does not; this is
  // where a user finds out it is happening (incident 2026-10-02).
  {
    const tenant = projectTenant(opts.cwd, home);
    const nowMs = now().getTime();
    const byKey = new Map<string, { recovered: number; unparsed: number }>();
    for (const row of readRows(home, nowMs - 24 * 3_600_000, nowMs)) {
      if (row.textToolCalls === undefined || (tenant !== undefined && row.tenant !== tenant)) continue;
      const key = row.key ?? row.alias;
      const total = byKey.get(key) ?? { recovered: 0, unparsed: 0 };
      total.recovered += row.textToolCalls.recovered;
      total.unparsed += row.textToolCalls.unparsed;
      byKey.set(key, total);
    }
    if (byKey.size > 0) {
      const parts = [...byKey.entries()].map(([key, t]) => `${key}: ${t.recovered} recovered, ${t.unparsed} unrecovered`);
      const unrecovered = [...byKey.values()].some((t) => t.unparsed > 0);
      checks.push({
        name: 'text tool calls',
        ok: !unrecovered,
        detail: `last 24h, tool calls written as text — ${parts.join('; ')}`
          + (unrecovered ? ' — an unrecovered call ends the agent; consider ranking that model lower' : ''),
      });
    }
  }
```

If `tenant`/`nowMs` names collide with outer declarations, the block scope above already isolates them; keep the braces.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/commands/doctor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/doctor.ts tests/commands/doctor.test.ts
git commit -m "feat(doctor): report models whose tool calls arrive as text"
```

---

### Task 5: Auto-route `no-task`

**Files:**
- Modify: `src/native/auto-route.ts` (`decideTier`, ~line 277–280)
- Modify: `src/ledger.ts` (`AutoRouteRecord.outcome`, `autoRouteIsValid`)
- Modify: `src/commands/usage.ts` (outcomes type ~157, init ~344), `src/cli.ts:625`, `src/tui-ink/screens/usage.tsx:92`
- Modify: `src/commands/doctor.ts` (decision health ~918–935)
- Test: `tests/native/auto-route.test.ts`, `tests/commands/doctor.test.ts`, `tests/commands/usage.test.ts`

**Interfaces:**
- Produces: `AutoRouteRecord.outcome: 'accepted' | 'low-confidence' | 'invalid' | 'failed' | 'no-task'`.

- [ ] **Step 1: Write the failing tests**

`tests/native/auto-route.test.ts` (use the file's existing classifier stub style):

```ts
it('skips the classifier and records no-task when the first user message has no task', async () => {
  let calls = 0;
  const classifier = { classify: async () => { calls += 1; return { choice: 'simple', confidence: 1, probabilities: { simple: 1 } }; } };
  const body = Buffer.from(JSON.stringify({ messages: [{ role: 'user', content: '<system-reminder>only context</system-reminder>' }] }));
  const decision = await decideTier({ classifier, role: 'code', body, tiers: ['simple', 'normal', 'complex'], minConfidence: 0.5 });
  expect(calls).toBe(0);
  expect(decision.tier).toBe('normal');
  expect(decision.record.outcome).toBe('no-task');
  expect(decision.record.reason).toBeUndefined();
});
```

`tests/commands/doctor.test.ts` (next to the decision-health tests, using `autoRouteRow` — widen its `outcome` parameter type to include `'no-task'`):

```ts
it('does not count no-task decisions as unanswered', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'doc-auto-cwd-'));
  const home = mkdtempSync(join(tmpdir(), 'doc-auto-home-'));
  writeFileSync(join(cwd, 'sonata.toml'), AUTO);
  const tenant = projectTenant(cwd, home);
  appendRow(home, autoRouteRow(tenant, 'accepted'));
  for (let i = 0; i < 4; i++) appendRow(home, autoRouteRow(tenant, 'no-task'));
  const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home, fetch: noModelList });
  const check = checks.find((c) => c.name === 'auto route' && c.detail.includes('last 24h'));
  expect(check?.ok).toBe(true);
  expect(check?.detail).toContain('1 decision(s)');
  expect(check?.detail).toContain('4 without a task');
});
```

`tests/commands/usage.test.ts` — find the existing test asserting `outcomes` (grep `outcomes` in that file) and add a `no-task` row to it, asserting `outcomes['no-task'] === 1`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/native/auto-route.test.ts tests/commands/doctor.test.ts tests/commands/usage.test.ts`
Expected: FAIL — outcome is `failed`; doctor counts 5 decisions; `no-task` key missing.

- [ ] **Step 3: Implement**

`src/ledger.ts`: `outcome: 'accepted' | 'low-confidence' | 'invalid' | 'failed' | 'no-task';` and add `'no-task'` to the list in `autoRouteIsValid`. Update the field's doc comment: "`no-task`: the request's first user message had no task once reminders were removed (Claude Code's own side requests); no classifier call was made."

`src/native/auto-route.ts`, in `decideTier`: move the task check above the classifier check and give it its own outcome —

```ts
  // No task means no question to ask: Claude Code's own side requests for a
  // background agent (measured 2026-10-02: one 7–13 s after each agent start,
  // its first message nothing but reminders) land here. Not a failure.
  const task = cleanTask(opts.body);
  if (task === undefined) return { tier: fallback, record: { classifier: 'jev', outcome: 'no-task', ms: now() - started } };
  if (opts.classifier === undefined) return failed('no classifier');
```

`src/commands/usage.ts`: outcomes type gains `'no-task'`; the initialiser gains `'no-task': 0`. `classifierCostNote` sums outcomes — exclude `no-task` there (it made no classifier call): `const decisions = Object.entries(autoRoute.outcomes).filter(([k]) => k !== 'no-task').reduce((s, [, c]) => s + c, 0);`

`src/cli.ts:625` and `src/tui-ink/screens/usage.tsx:92`: append `, ${o['no-task']} without a task` to the printed line (CLI) and note text (TUI).

`src/commands/doctor.ts`, decision health: compute over decisions excluding `no-task`, and mention them separately —

```ts
    const all = readRows(…).filter(…).map((row) => row.autoRoute!);   // existing line, renamed
    const noTask = all.filter((d) => d.outcome === 'no-task').length;
    const decisions = all.filter((d) => d.outcome !== 'no-task');
    if (decisions.length > 0) {
      … existing summary …
      const summary = `… existing text …` + (noTask > 0 ? `; ${noTask} without a task` : '') + (top === undefined ? '' : …);
```

Keep the existing summary wording otherwise identical so the current doctor tests still pass. When `decisions.length === 0` but `noTask > 0`, push nothing (as today when there are no decisions).

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/native/auto-route.test.ts tests/native/auto-route-router.test.ts tests/commands/doctor.test.ts tests/commands/usage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/native/auto-route.ts src/ledger.ts src/commands/usage.ts src/cli.ts src/tui-ink/screens/usage.tsx src/commands/doctor.ts tests/native/auto-route.test.ts tests/commands/doctor.test.ts tests/commands/usage.test.ts
git commit -m "fix(auto-route): a request with no task is not a failed decision"
```

---

### Task 6: Docs, changelog, full verification

**Files:**
- Modify: `CHANGELOG.md` (`## [Unreleased]`)
- Modify: `docs/internals/native-path.md` (the request-transforms section)
- Modify: `docs/superpowers/specs/2026-10-02-text-tool-calls-design.md` (status line)

- [ ] **Step 1: CHANGELOG** — under `## [Unreleased]`, `### Fixed` (create the heading if absent):

```markdown
- **Native agents no longer end silently when a model writes its tool calls
  as text.** Some open models, behind some serving backends, emit
  `<tool_call><function=…>` markup in their reply instead of a structured
  call; Claude Code read the turn as finished and ended the agent with no
  report. The router now turns that markup into real tool calls on the
  LiteLLM path, and a call it cannot recover (an unknown tool, unclosed
  markup) cools that model so the next request falls through to the next
  ranked one. `sonata doctor` names models doing this in the last 24 h, and
  the ledger records `textToolCalls` per request.
- **Auto-route no longer records Claude Code's own task-less side requests as
  failed decisions.** They take the fallback tier without asking the
  classifier, as `no-task`, and no longer count against `doctor`'s decision
  health.
```

- [ ] **Step 2: Internals** — in `docs/internals/native-path.md`, in the section describing request transforms, add a paragraph: the response-side rewrite (`src/native/text-tool-calls.ts`), LiteLLM path only, what it recovers, what it never recovers, the cooldown on unparsed, and the incident it came from (spec path).

- [ ] **Step 3: Spec status** — change `**Status:** designed, not implemented.` to `**Status:** implemented (0.15.3).`

- [ ] **Step 4: Full verification**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; all tests pass (record the count).

Run: `npm run build && npm link`
Expected: `sonata --version` reports `0.15.2+dev…` from this branch's commit.

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md docs/internals/native-path.md docs/superpowers/specs/2026-10-02-text-tool-calls-design.md
git commit -m "docs: text-form tool call recovery and no-task auto-route"
```
