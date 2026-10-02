import { describe, expect, it } from 'vitest';
import { coerceArguments, parseToolCallMarkup, rewriteTextToolCallJson, rewriteTextToolCallStream, toolSchemas, type TextToolCallCounts } from '../../src/native/text-tool-calls.js';

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
