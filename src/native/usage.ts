/**
 * Token counts pulled out of a response as it streams past.
 *
 * Usage arrives in two different frames: `message_start` carries the input and
 * cache counts, and the final `message_delta` carries the output count. Neither
 * alone is the whole picture, so both are merged — and taking the *last*
 * message_delta matters, because a stream may emit more than one.
 */
export interface UsageTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export interface UsageResult {
  /** Whatever was observed, even on a stream that ended early. */
  tokens: UsageTokens;
  /** False when no terminal usage frame arrived — a disconnect, or an upstream that died. */
  complete: boolean;
}

/**
 * A single SSE line past this is discarded rather than accumulated. A stream
 * that never emits a newline would otherwise grow this buffer for as long as it
 * runs, inside the router process serving every other session.
 */
export const MAX_SSE_BUFFER_BYTES = 64 * 1024;

function zero(): UsageTokens {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
}

/** Reads the Anthropic `usage` shape, treating any absent or non-numeric field as unseen. */
function mergeUsage(into: UsageTokens, usage: unknown): boolean {
  if (usage === null || typeof usage !== 'object') return false;
  const u = usage as Record<string, unknown>;
  let seen = false;
  const take = (field: string, key: keyof UsageTokens): void => {
    const value = u[field];
    // Only a positive count overwrites: message_delta repeats input_tokens, and
    // some upstreams report 0 there, which must not erase the real count seen
    // in message_start.
    if (typeof value === 'number' && Number.isFinite(value)) {
      seen = true;
      if (value > 0) into[key] = value;
    }
  };
  take('input_tokens', 'input');
  take('output_tokens', 'output');
  take('cache_read_input_tokens', 'cacheRead');
  take('cache_creation_input_tokens', 'cacheCreation');
  return seen;
}

export function createUsageCollector(): { push(chunk: Uint8Array): void; finish(): UsageResult } {
  const tokens = zero();
  let complete = false;
  let buffer = new Uint8Array(0);
  let bufferBytes = 0;
  let overflowed = false;

  const append = (bytes: Uint8Array): void => {
    if (bytes.length === 0) return;
    const next = new Uint8Array(buffer.length + bytes.length);
    next.set(buffer);
    next.set(bytes, buffer.length);
    buffer = next;
    bufferBytes += bytes.byteLength;
  };

  const line = (raw: Uint8Array): void => {
    const text = new TextDecoder().decode(raw);
    const data = text.startsWith('data:') ? text.slice(5).trim() : '';
    if (data === '' || data === '[DONE]') return;
    let frame: { type?: unknown; usage?: unknown; message?: unknown };
    try {
      frame = JSON.parse(data) as typeof frame;
    } catch {
      return; // a partial or non-JSON data line is not ours to fail on
    }
    if (frame.type === 'message_start') {
      const message = frame.message as { usage?: unknown } | undefined;
      mergeUsage(tokens, message?.usage);
      return;
    }
    if (frame.type === 'message_delta' && mergeUsage(tokens, frame.usage)) {
      complete = true;
    }
  };

  return {
    push(chunk) {
      let start = 0;
      for (let i = 0; i < chunk.length; i += 1) {
        if (chunk[i] !== 0x0a) continue;
        const segment = chunk.subarray(start, i);
        if (!overflowed && bufferBytes + segment.byteLength <= MAX_SSE_BUFFER_BYTES) {
          append(segment);
          line(buffer);
        }
        // Consume the completed line, including its newline, from the raw-byte
        // accounting before looking for the next line in this chunk.
        buffer = new Uint8Array(0);
        bufferBytes = 0;
        overflowed = false;
        start = i + 1;
      }

      const tail = chunk.subarray(start);
      if (overflowed) return;
      if (bufferBytes + tail.byteLength > MAX_SSE_BUFFER_BYTES) {
        // Drop the runaway line and mark it, so its tail is not mistaken for
        // the start of the next one.
        buffer = new Uint8Array(0);
        bufferBytes = 0;
        overflowed = true;
      } else {
        append(tail);
      }
    },
    finish() {
      return { tokens, complete };
    },
  };
}

/** The non-streaming equivalent: usage sits at the top level of the JSON body. */
export function usageFromJsonBody(body: Buffer): UsageResult {
  const tokens = zero();
  try {
    const doc = JSON.parse(body.toString()) as { usage?: unknown };
    if (doc.usage === undefined) return { tokens, complete: false };
    return { tokens, complete: mergeUsage(tokens, doc.usage) };
  } catch {
    return { tokens, complete: false };
  }
}
