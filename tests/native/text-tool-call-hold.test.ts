import { describe, expect, it } from 'vitest';

import { createToolUseProbe, holdForTextToolCalls } from '../../src/native/text-tool-call-hold.js';
import { rewriteTextToolCallStream, type TextToolCallCounts } from '../../src/native/text-tool-calls.js';

const ev = (type: string, data: Record<string, unknown>): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const start = (index: number, type: string) => ev('content_block_start', { index, content_block: type === 'text' ? { type, text: '' } : { type } });
const text = (index: number, t: string) => ev('content_block_delta', { index, delta: { type: 'text_delta', text: t } });

function probeOf(...events: string[]) {
  const probe = createToolUseProbe();
  for (const e of events) probe.push(bytes(e));
  return probe.state;
}

describe('createToolUseProbe', () => {
  it('holds everything until a real tool_use block starts', () => {
    expect(probeOf(ev('message_start', { message: {} }), ev('ping', {}))).toBe('pending');
    expect(probeOf(start(0, 'thinking'), ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'x'.repeat(5000) } }))).toBe('pending');
    expect(probeOf(start(0, 'text'), text(0, 'x'.repeat(5000)), ev('content_block_stop', { index: 0 }))).toBe('pending');
    expect(probeOf(ev('message_delta', { delta: { stop_reason: 'end_turn' } }), ev('message_stop', {}))).toBe('pending');
  });

  it('releases at the first tool_use block, after thinking or text or first', () => {
    expect(probeOf(start(0, 'tool_use'))).toBe('released');
    expect(probeOf(start(0, 'thinking'), ev('content_block_stop', { index: 0 }), start(1, 'tool_use'))).toBe('released');
    expect(probeOf(start(0, 'text'), text(0, 'Let me look.'), ev('content_block_stop', { index: 0 }), start(1, 'tool_use'))).toBe('released');
  });

  it('is not released by a tool call written as text', () => {
    expect(probeOf(start(0, 'text'), text(0, '<tool_call><function=Bash><parameter=command>ls</parameter></function></tool_call>'))).toBe('pending');
  });

  it('decides the same however the bytes are split', () => {
    const all = [ev('message_start', { message: {} }), start(0, 'text'), text(0, 'ok'), start(1, 'tool_use')].join('').replace(/\n/g, '\r\n');
    for (let cut = 1; cut < all.length; cut++) {
      const probe = createToolUseProbe();
      probe.push(bytes(all.slice(0, cut)));
      probe.push(bytes(all.slice(cut)));
      expect(probe.state, `cut at ${cut}`).toBe('released');
    }
  });
});

describe('holdForTextToolCalls', () => {
  const tools = new Map([['Bash', { type: 'object', properties: { command: { type: 'string' } } }]]);
  const LIMITS = { maxBytes: 1024 * 1024, idleMs: 10_000, maxMs: 60_000 };

  it('stops the rewriter and the upstream when the consumer of a released body stops early', async () => {
    let upstreamClosed = false;
    let settled: TextToolCallCounts | undefined;
    async function* upstream(): AsyncIterable<Uint8Array> {
      try {
        yield bytes(ev('message_start', { message: {} }) + start(0, 'tool_use'));
        for (;;) {
          yield bytes(ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: ' ' } }));
          await new Promise((r) => setTimeout(r, 5));
        }
      } finally { upstreamClosed = true; }
    }
    const outcome = await holdForTextToolCalls(upstream(), (input) => rewriteTextToolCallStream(input, tools, (c) => { settled = c; }), () => 0, LIMITS);
    expect(outcome.kind).toBe('serve');
    if (outcome.kind !== 'serve') return;
    for await (const chunk of outcome.body) { expect(chunk.length).toBeGreaterThan(0); break; }
    expect(settled).toEqual({ recovered: 0, unparsed: 0 });
    expect(upstreamClosed).toBe(true);
  });

  it('releases what it held when the upstream breaks mid-hold, surfacing the break in the body', async () => {
    async function* upstream(): AsyncIterable<Uint8Array> {
      yield bytes(ev('message_start', { message: {} }) + start(0, 'text') + text(0, 'hi'));
      throw new Error('upstream reset');
    }
    const outcome = await holdForTextToolCalls(upstream(), (input) => rewriteTextToolCallStream(input, tools, () => undefined), () => 0, LIMITS);
    expect(outcome.kind).toBe('serve');
    if (outcome.kind !== 'serve') return;
    let out = '';
    await expect((async () => { for await (const chunk of outcome.body) out += new TextDecoder().decode(chunk); })()).rejects.toThrow('upstream reset');
    expect(out).toContain('message_start');
    expect(out).toContain('"text":"hi"');
  });
});
