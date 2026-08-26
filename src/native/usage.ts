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
function mergeUsage(into: UsageTokens, usage: unknown): void {
  if (usage === null || typeof usage !== 'object') return;
  const u = usage as Record<string, unknown>;
  const take = (field: string, key: keyof UsageTokens): void => {
    const value = u[field];
    // Only a positive count overwrites: message_delta repeats input_tokens, and
    // some upstreams report 0 there, which must not erase the real count seen
    // in message_start.
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) into[key] = value;
  };
  take('input_tokens', 'input');
  take('output_tokens', 'output');
  take('cache_read_input_tokens', 'cacheRead');
  take('cache_creation_input_tokens', 'cacheCreation');
}

export function createUsageCollector(): { push(chunk: Uint8Array): void; finish(): UsageResult } {
  const tokens = zero();
  let complete = false;
  let buffer = '';
  let overflowed = false;
  // Streaming decoder: a chunk boundary can fall inside a multi-byte character,
  // and decoding each chunk independently would turn that into a replacement
  // character mid-JSON.
  const decoder = new TextDecoder('utf-8');

  const line = (raw: string): void => {
    const text = raw.startsWith('data:') ? raw.slice(5).trim() : '';
    if (text === '' || text === '[DONE]') return;
    let frame: { type?: unknown; usage?: unknown; message?: unknown };
    try {
      frame = JSON.parse(text) as typeof frame;
    } catch {
      return; // a partial or non-JSON data line is not ours to fail on
    }
    if (frame.type === 'message_start') {
      const message = frame.message as { usage?: unknown } | undefined;
      mergeUsage(tokens, message?.usage);
      return;
    }
    if (frame.type === 'message_delta') {
      mergeUsage(tokens, frame.usage);
      complete = true;
    }
  };

  return {
    push(chunk) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const raw = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!overflowed) line(raw);
        overflowed = false;
        nl = buffer.indexOf('\n');
      }
      if (buffer.length > MAX_SSE_BUFFER_BYTES) {
        // Drop the runaway line and mark it, so its tail is not mistaken for
        // the start of the next one.
        buffer = '';
        overflowed = true;
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
    mergeUsage(tokens, doc.usage);
    return { tokens, complete: true };
  } catch {
    return { tokens, complete: false };
  }
}
