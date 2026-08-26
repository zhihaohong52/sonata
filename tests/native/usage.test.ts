import { describe, expect, it } from 'vitest';
import { createUsageCollector, usageFromJsonBody, MAX_SSE_BUFFER_BYTES } from '../../src/native/usage.js';

const enc = (s: string) => new TextEncoder().encode(s);

const START = 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1632,"output_tokens":0,"cache_read_input_tokens":40,"cache_creation_input_tokens":7}}}\n\n';
const DELTA = 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":1632,"output_tokens":11}}\n\n';

describe('createUsageCollector', () => {
  it('merges input and cache counts from message_start with output from message_delta', () => {
    const c = createUsageCollector();
    c.push(enc(START));
    c.push(enc(DELTA));
    expect(c.finish()).toEqual({
      tokens: { input: 1632, output: 11, cacheRead: 40, cacheCreation: 7 },
      complete: true,
    });
  });

  it('parses a frame split across chunk boundaries', () => {
    const whole = START + DELTA;
    const cut = whole.indexOf('"output_tokens":11') + 4; // mid-JSON, mid-line
    const c = createUsageCollector();
    c.push(enc(whole.slice(0, cut)));
    c.push(enc(whole.slice(cut)));
    expect(c.finish().tokens.output).toBe(11);
  });

  it('parses a frame split mid multi-byte character', () => {
    const withText = `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"café"}}\n\n${DELTA}`;
    const bytes = enc(withText);
    const cut = withText.indexOf('café') + 4; // lands inside the 2-byte é
    const c = createUsageCollector();
    c.push(bytes.slice(0, cut));
    c.push(bytes.slice(cut));
    expect(c.finish().tokens.output).toBe(11);
  });

  it('reports incomplete when no message_delta arrives', () => {
    const c = createUsageCollector();
    c.push(enc(START));
    const res = c.finish();
    expect(res.complete).toBe(false);
    expect(res.tokens.input).toBe(1632);
  });

  it('reports incomplete and zeroed for an empty stream', () => {
    expect(createUsageCollector().finish()).toEqual({
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      complete: false,
    });
  });

  it('ignores malformed data lines rather than throwing', () => {
    const c = createUsageCollector();
    c.push(enc('data: {not json\n\n'));
    c.push(enc(DELTA));
    expect(c.finish().tokens.output).toBe(11);
  });

  it('drops an oversized line even when its newline arrives later', () => {
    const c = createUsageCollector();
    const oversized = `data: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 99 }, padding: 'x'.repeat(MAX_SSE_BUFFER_BYTES) })}`;
    c.push(enc(oversized));
    c.push(enc('\n\n'));
    // The oversized line is valid JSON, so this proves the cap—not JSON parsing—drops it.
    expect(c.finish().tokens.output).toBe(0);
  });

  it('drops an oversized line whose newline arrives in the same chunk', () => {
    const c = createUsageCollector();
    const oversized = `data: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 99 }, padding: 'x'.repeat(MAX_SSE_BUFFER_BYTES) })}\n\n`;
    c.push(enc(DELTA + oversized));
    expect(c.finish().tokens.output).toBe(11);
  });

  it('measures the line cap in UTF-8 bytes', () => {
    const c = createUsageCollector();
    const oversized = `data: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 99 }, padding: 'é'.repeat(MAX_SSE_BUFFER_BYTES / 2) })}\n\n`;
    c.push(enc(DELTA + oversized));
    expect(c.finish().tokens.output).toBe(11);
  });

  it('does not complete on a message_delta without usage', () => {
    const c = createUsageCollector();
    c.push(enc('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n'));
    expect(c.finish().complete).toBe(false);
  });

  it.each([
    ['null', 'null'],
    ['an empty object', '{}'],
    ['a non-numeric field', '{"output_tokens":"twelve"}'],
  ])('does not complete on a message_delta with usage %s', (_label, usage) => {
    const c = createUsageCollector();
    c.push(enc(`event: message_delta\ndata: {"type":"message_delta","usage":${usage}}\n\n`));
    expect(c.finish().complete).toBe(false);
  });

  it('takes the last message_delta when several arrive', () => {
    const c = createUsageCollector();
    c.push(enc(DELTA));
    c.push(enc('event: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":1632,"output_tokens":99}}\n\n'));
    expect(c.finish().tokens.output).toBe(99);
  });
});

describe('usageFromJsonBody', () => {
  it('reads usage from a non-streaming response body', () => {
    const body = Buffer.from(JSON.stringify({
      type: 'message',
      usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 1, cache_creation_input_tokens: 2 },
    }));
    expect(usageFromJsonBody(body)).toEqual({
      tokens: { input: 12, output: 3, cacheRead: 1, cacheCreation: 2 },
      complete: true,
    });
  });

  it('reports incomplete for a body with no usage', () => {
    expect(usageFromJsonBody(Buffer.from('{}')).complete).toBe(false);
  });

  it.each(['null', '{}', '{"output_tokens":"twelve"'])('reports incomplete for a body with unusable usage %s', (usage) => {
    expect(usageFromJsonBody(Buffer.from(`{"usage":${usage}}`)).complete).toBe(false);
  });

  it('reports incomplete for a non-JSON body', () => {
    expect(usageFromJsonBody(Buffer.from('<html>503</html>')).complete).toBe(false);
  });
});
