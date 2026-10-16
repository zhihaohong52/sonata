import { PARSE_BUFFER_CAP_CHARS } from './text-tool-calls.js';

/**
 * Holds a streamed tier turn back from the client until it is clear whether
 * the model wrote a tool call as text — so that a call the router cannot
 * recover is a turn the client never saw, and the next ranked candidate can
 * be asked instead (spec
 * docs/superpowers/specs/2026-10-02-text-tool-calls-design.md, "fall through").
 *
 * Only the decision is made here. Rewriting stays in
 * `rewriteTextToolCallStream`, whose output is what is held and replayed, so
 * the rewriter's output is unchanged by the hold. (That output is not the
 * upstream's bytes: the rewriter normalises line endings and re-serialises
 * block events.)
 *
 * Used only on tier routes (`sonata-<role>-<tier>`, `-auto`), which carry
 * subagent traffic nobody watches stream; a main session's own model and a
 * bare `--model` request are never held. So the whole turn is held —
 * thinking and text alike, since a text call can follow either — until:
 *
 * - the first real `tool_use` block starts: a turn that calls tools properly
 *   is released at once and streams on as it always has;
 * - the turn ends, when the rewriter's counts decide (an unrecovered call
 *   withdraws it, anything else is served);
 * - or a limit is hit: past `maxBytes` of upstream input or of held output,
 *   `idleMs` without an upstream byte once the first has arrived, or `maxMs`
 *   in total (time to first token included), what is held is released and
 *   the rest streams as it would have unheld. A limit only costs that turn
 *   its withdrawal.
 *
 * Memory per held response is therefore about `maxBytes` of held output plus
 * the chunk in flight, and the parsers' own buffers — the scanner's unclosed
 * call, the rewriter's and this probe's unterminated frame — are each capped
 * at `PARSE_BUFFER_CAP_CHARS`, past which they give up and pass through.
 */

export interface HoldLimits { maxBytes: number; idleMs: number; maxMs: number }

type ProbeState = 'pending' | 'released';

/** Reads raw upstream SSE bytes and releases the hold at the first real `tool_use` block. */
export function createToolUseProbe(maxFrameChars: number = PARSE_BUFFER_CAP_CHARS) {
  const decoder = new TextDecoder();
  let buffer = '';
  let carry = '';
  let state: ProbeState = 'pending';

  const event = (raw: string): void => {
    const payload = raw.split('\n').filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, '')).join('\n');
    if (payload === '') return;
    let data: { type?: unknown; content_block?: { type?: unknown } };
    try { data = JSON.parse(payload) as typeof data; } catch { return; }
    if (data.type === 'content_block_start' && data.content_block?.type === 'tool_use') state = 'released';
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
      // A frame too large to read is no evidence either way: stop holding.
      if (buffer.length > maxFrameChars) state = 'released';
      // A turn's text is held whole; only the scan for the next event is kept.
      if (state !== 'pending') buffer = '';
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
  const probe = createToolUseProbe();
  const started = Date.now();
  // Idle is measured from the first upstream byte: a model slow to its first
  // token has sent nothing to release yet. Before then only `maxMs` applies.
  let lastInput: number | undefined;
  // Raw upstream bytes count toward `maxBytes` too: a scanner holding an
  // unclosed call emits nothing, so held output alone would never trip it.
  let inputBytes = 0;
  // The overflow signal is a fresh promise per iteration, not one long-lived
  // promise raced every time: each race would attach a reaction to it that
  // retains that iteration's chunk for as long as the promise lives, which on
  // the release path is the whole stream — a second copy of the held bytes.
  let overflowedFlag = false;
  let overflowResolve: ((value: 'limit') => void) | undefined;
  const overflowed = (): void => { overflowedFlag = true; overflowResolve?.('limit'); };
  async function* tapped(): AsyncIterable<Uint8Array> {
    for await (const chunk of upstream) {
      lastInput = Date.now();
      inputBytes += chunk.length;
      if (inputBytes > limits.maxBytes) overflowed();
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
      // A read of the rewriter started by the hold and not yet awaited here.
      let inFlight = pending !== undefined;
      try {
        for (const chunk of held) yield chunk;
        let next = await (pending ?? iterator.next());
        inFlight = false;
        while (next.done !== true) {
          yield next.value;
          next = await iterator.next();
        }
      } finally {
        // A consumer that stops early stops the rewriter too, so its own
        // cleanup (settling counts, releasing the upstream) still runs.
        // Harmless once the rewriter has finished. A read still in flight
        // would queue `return` behind it, possibly forever: the upstream is
        // cancelled first so that read settles, and nothing waits on it here.
        if (inFlight) {
          rewritten.cancel();
          iterator.return?.().catch(() => { /* nothing to tell */ });
        } else {
          try { await iterator.return?.(); } catch { /* already surfaced, or nothing to tell */ }
        }
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
        const idleLeft = lastInput === undefined ? Infinity : limits.idleMs - (nowMs - lastInput);
        const totalLeft = limits.maxMs - (nowMs - started);
        if (idleLeft <= 0 || totalLeft <= 0) { resolve('limit'); return; }
        timer = setTimeout(arm, Math.min(idleLeft, totalLeft));
      };
      arm();
    });
    const overflow = new Promise<'limit'>((resolve) => {
      if (overflowedFlag) { resolve('limit'); return; }
      overflowResolve = resolve;
    });
    const aborted = new Promise<'aborted'>((resolve) => {
      if (signal === undefined) return;
      if (signal.aborted) { resolve('aborted'); return; }
      onAbort = () => resolve('aborted');
      signal.addEventListener('abort', onAbort, { once: true });
    });
    let next: IteratorResult<Uint8Array> | 'limit' | 'aborted';
    try {
      next = await Promise.race([pending, limit, aborted, overflow]);
    } catch {
      // The upstream broke while held. What reached nobody is released as
      // it would have streamed, and the break surfaces where it always has:
      // in the body the client reads, so the turn is recorded as incomplete.
      return release(pending);
    } finally {
      clearTimeout(timer);
      overflowResolve = undefined;
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
    if (heldBytes > limits.maxBytes || inputBytes > limits.maxBytes) return release();
  }
}
