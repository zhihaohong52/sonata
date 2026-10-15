import { classifyOpening, insideCode, TOOL_CALL_OPEN } from './text-tool-calls.js';

/**
 * Holds the start of a streamed turn back from the client until it is clear
 * whether the model wrote a tool call as text — so that a call the router
 * cannot recover is a turn the client never saw, and the next ranked
 * candidate can be asked instead (spec
 * docs/superpowers/specs/2026-10-02-text-tool-calls-design.md, "fall through").
 *
 * Only the decision is made here. Rewriting stays in
 * `rewriteTextToolCallStream`, whose output is what is held and replayed, so a
 * held turn reaches the client byte for byte as an unheld one would.
 *
 * What is held, and for how long:
 *
 * - Everything before the first content block (`message_start`, `ping`):
 *   withdrawing a turn is only possible while the client has received none
 *   of it.
 * - A first content block that is not text (thinking, a real `tool_use`)
 *   releases at once: those stream as they always have, and the turn can no
 *   longer be withdrawn.
 * - A text block is held until its first `PROBE_NON_WHITESPACE` non-whitespace
 *   characters are known, its end, or the marker. No marker in that prefix
 *   releases it; a marker holds the rest of the turn until it ends, when the
 *   rewriter's counts say whether the call was recovered.
 * - A whitespace-only text block keeps holding: the marker may be in the next.
 *
 * `limits` bound the whole hold: past `maxBytes` of held output, `idleMs`
 * without an upstream byte, or `maxMs` in total, what is held is released and
 * the rest streams as it would have unheld.
 */

/** Non-whitespace characters of a text block read before it is ruled marker-free. */
export const PROBE_NON_WHITESPACE = 64;

export interface HoldLimits { maxBytes: number; idleMs: number; maxMs: number }

type ProbeState = 'pending' | 'released' | 'marker';

/** Reads raw upstream SSE bytes and decides whether the turn must be held. */
export function createMarkerProbe() {
  const decoder = new TextDecoder();
  let buffer = '';
  let carry = '';
  let state: ProbeState = 'pending';
  let textIndex: number | undefined;
  let text = '';

  const nonWhitespace = (s: string): number => s.replace(/\s+/g, '').length;
  /** Whether `s` ends with a proper prefix of the marker, which the next delta may complete. */
  const endsInMarkerPrefix = (s: string): boolean => {
    for (let n = Math.min(TOOL_CALL_OPEN.length - 1, s.length); n > 0; n--) {
      if (TOOL_CALL_OPEN.startsWith(s.slice(-n))) return true;
    }
    return false;
  };

  const event = (raw: string): void => {
    const payload = raw.split('\n').filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, '')).join('\n');
    if (payload === '') return;
    let data: Record<string, any>;
    try { data = JSON.parse(payload) as Record<string, any>; } catch { return; }
    switch (data.type) {
      case 'content_block_start':
        if (textIndex !== undefined) return;
        if (data.content_block?.type === 'text') {
          textIndex = data.index;
          text = String(data.content_block.text ?? '');
          check();
        } else {
          state = 'released';
        }
        return;
      case 'content_block_delta':
        if (data.index !== textIndex || data.delta?.type !== 'text_delta') return;
        text += String(data.delta.text ?? '');
        check();
        return;
      case 'content_block_stop':
        if (data.index !== textIndex) return;
        // A marker-free block with something in it is ordinary text; one of
        // only whitespace leaves the question to the next block.
        if (nonWhitespace(text) > 0) state = 'released';
        textIndex = undefined;
        text = '';
        return;
      case 'message_delta':
      case 'message_stop':
        // The turn is ending with no marker seen: nothing left to decide.
        state = 'released';
        return;
      default:
    }
  };

  const check = (): void => {
    // A tag quoted in code, or mentioned in prose, is no call; one whose body
    // has not arrived yet keeps the turn held.
    let undecided = false;
    for (let at = text.indexOf(TOOL_CALL_OPEN); at !== -1; at = text.indexOf(TOOL_CALL_OPEN, at + 1)) {
      if (insideCode(text.slice(0, at))) continue;
      const opening = classifyOpening(text.slice(at + TOOL_CALL_OPEN.length));
      if (opening === 'call') { state = 'marker'; return; }
      if (opening === 'undecided') undecided = true;
    }
    if (!undecided && nonWhitespace(text) >= PROBE_NON_WHITESPACE && !endsInMarkerPrefix(text)) state = 'released';
  };

  return {
    get state(): ProbeState { return state; },
    push(chunk: Uint8Array): void {
      if (state !== 'pending') return;
      let piece = carry + decoder.decode(chunk, { stream: true });
      if (piece.endsWith('\r')) { carry = '\r'; piece = piece.slice(0, -1); } else carry = '';
      buffer += piece.replace(/\r\n?/g, '\n');
      let split: number;
      while (state === 'pending' && (split = buffer.indexOf('\n\n')) !== -1) {
        event(buffer.slice(0, split));
        buffer = buffer.slice(split + 2);
      }
    },
  };
}

export type HoldOutcome =
  /** Serve this body: the turn either had no unrecoverable call, or part of it already had to stream. */
  | { kind: 'serve'; body: AsyncIterable<Uint8Array> & { cancel(): void } }
  /** The whole turn was held and held an unrecoverable call; `held` is it, rewritten, never sent. */
  | { kind: 'unrecoverable'; held: Buffer }
  /** The client left while the turn was held; `held` is what had been held, for its ledger row. */
  | { kind: 'client-gone'; held: Buffer };

/**
 * Drives `rewrite` over `upstream` while holding its output, as described
 * above. `unparsed` is read once the rewriter has ended, when its counts
 * have been settled.
 */
export async function holdForTextToolCalls(
  upstream: AsyncIterable<Uint8Array>,
  rewrite: (input: AsyncIterable<Uint8Array>) => AsyncIterable<Uint8Array> & { cancel(): void },
  unparsed: () => number,
  limits: HoldLimits,
  signal?: AbortSignal,
): Promise<HoldOutcome> {
  const probe = createMarkerProbe();
  const started = Date.now();
  let lastInput = started;
  async function* tapped(): AsyncIterable<Uint8Array> {
    for await (const chunk of upstream) {
      lastInput = Date.now();
      probe.push(chunk);
      yield chunk;
    }
  }
  const input = Object.assign(tapped(), { cancel: () => { (upstream as { cancel?: () => void }).cancel?.(); } });
  const rewritten = rewrite(input);
  const iterator = rewritten[Symbol.asyncIterator]();
  const held: Buffer[] = [];
  let heldBytes = 0;

  const release = (pending?: Promise<IteratorResult<Uint8Array>>): HoldOutcome => {
    async function* chunks(): AsyncIterable<Uint8Array> {
      for (const chunk of held) yield chunk;
      let next = await (pending ?? iterator.next());
      while (next.done !== true) {
        yield next.value;
        next = await iterator.next();
      }
    }
    return { kind: 'serve', body: Object.assign(chunks(), { cancel: () => rewritten.cancel() }) };
  };

  for (;;) {
    if (probe.state === 'released') return release();
    const pending = iterator.next();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const limit = new Promise<'limit'>((resolve) => {
      const arm = (): void => {
        const nowMs = Date.now();
        const idleLeft = limits.idleMs - (nowMs - lastInput);
        const totalLeft = limits.maxMs - (nowMs - started);
        if (idleLeft <= 0 || totalLeft <= 0) { resolve('limit'); return; }
        timer = setTimeout(arm, Math.min(idleLeft, totalLeft));
      };
      arm();
    });
    const aborted = new Promise<'aborted'>((resolve) => {
      if (signal === undefined) return;
      if (signal.aborted) { resolve('aborted'); return; }
      onAbort = () => resolve('aborted');
      signal.addEventListener('abort', onAbort, { once: true });
    });
    let next: IteratorResult<Uint8Array> | 'limit' | 'aborted';
    try {
      next = await Promise.race([pending, limit, aborted]);
    } catch {
      // The upstream broke while held. What reached nobody is released as
      // it would have streamed, and the break surfaces where it always has:
      // in the body the client reads, so the turn is recorded as incomplete.
      return release(pending);
    } finally {
      clearTimeout(timer);
      if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
    }
    if (next === 'aborted') {
      pending.catch(() => { /* the client is gone; nothing to report to */ });
      rewritten.cancel();
      return { kind: 'client-gone', held: Buffer.concat(held) };
    }
    if (next === 'limit') {
      // The read in flight is the released body's first result, not a fresh one.
      pending.catch(() => { /* surfaced where the released body awaits it */ });
      return release(pending);
    }
    if (next.done === true) {
      // Nothing of this turn has reached the client: an unrecoverable call in
      // it can still be withdrawn.
      if (unparsed() > 0) return { kind: 'unrecoverable', held: Buffer.concat(held) };
      return release(Promise.resolve(next));
    }
    const chunk = Buffer.from(next.value);
    held.push(chunk);
    heldBytes += chunk.length;
    if (heldBytes > limits.maxBytes) return release();
  }
}
