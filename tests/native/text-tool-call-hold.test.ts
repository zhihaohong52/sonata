import { describe, expect, it } from 'vitest';

import { createMarkerProbe, PROBE_NON_WHITESPACE } from '../../src/native/text-tool-call-hold.js';

const ev = (type: string, data: Record<string, unknown>): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const start = (index: number, type: string) => ev('content_block_start', { index, content_block: type === 'text' ? { type, text: '' } : { type } });
const text = (index: number, t: string) => ev('content_block_delta', { index, delta: { type: 'text_delta', text: t } });

function probeOf(...events: string[]) {
  const probe = createMarkerProbe();
  for (const e of events) probe.push(bytes(e));
  return probe.state;
}

describe('createMarkerProbe', () => {
  it('holds everything before the first content block', () => {
    expect(probeOf(ev('message_start', { message: {} }), ev('ping', {}))).toBe('pending');
  });

  it('releases on a first block that is not text', () => {
    expect(probeOf(start(0, 'thinking'))).toBe('released');
    expect(probeOf(start(0, 'tool_use'))).toBe('released');
  });

  it('sees the marker at the start of text, or after a short preamble', () => {
    expect(probeOf(start(0, 'text'), text(0, '<tool_call>'))).toBe('marker');
    expect(probeOf(start(0, 'text'), text(0, 'Let me check:\n\n<tool'), text(0, '_call>'))).toBe('marker');
  });

  it('releases text once enough of it is known to hold no marker', () => {
    expect(probeOf(start(0, 'text'), text(0, 'x'.repeat(PROBE_NON_WHITESPACE - 1)))).toBe('pending');
    expect(probeOf(start(0, 'text'), text(0, 'x'.repeat(PROBE_NON_WHITESPACE)))).toBe('released');
    // Whitespace does not count toward the window.
    expect(probeOf(start(0, 'text'), text(0, ' \n'.repeat(200)))).toBe('pending');
  });

  it('keeps holding when the window ends inside a possible marker', () => {
    const lead = 'x'.repeat(PROBE_NON_WHITESPACE);
    expect(probeOf(start(0, 'text'), text(0, `${lead}<tool_`))).toBe('pending');
    expect(probeOf(start(0, 'text'), text(0, `${lead}<tool_`), text(0, 'call>'))).toBe('marker');
  });

  it('releases a short text block at its end, but looks past a blank one', () => {
    expect(probeOf(start(0, 'text'), text(0, 'Done.'), ev('content_block_stop', { index: 0 }))).toBe('released');
    expect(probeOf(start(0, 'text'), text(0, '\n'), ev('content_block_stop', { index: 0 }), start(1, 'text'), text(1, '<tool_call>'))).toBe('marker');
  });

  it('releases when the turn ends with nothing decided', () => {
    expect(probeOf(ev('message_delta', { delta: { stop_reason: 'end_turn' } }))).toBe('released');
  });

  it('decides the same however the bytes are split', () => {
    const all = [ev('message_start', { message: {} }), start(0, 'text'), text(0, 'ok <tool_call>')].join('').replace(/\n/g, '\r\n');
    for (let cut = 1; cut < all.length; cut++) {
      const probe = createMarkerProbe();
      probe.push(bytes(all.slice(0, cut)));
      probe.push(bytes(all.slice(cut)));
      expect(probe.state, `cut at ${cut}`).toBe('marker');
    }
  });
});
