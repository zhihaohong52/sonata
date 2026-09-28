/**
 * The managed LiteLLM child's stdout and stderr, forwarded line by line and
 * read for the one thing only its own output says.
 *
 * serve used to give the child its stdio outright, so a per-model startup
 * failure reached serve's log unread. That property is kept — every line is
 * forwarded — but read on the way: when LiteLLM's ChatGPT refresh token is
 * refused, LiteLLM 1.98.0 catches the error inside
 * `Authenticator.get_access_token()`, logs "ChatGPT refresh token failed,
 * re-login required: …" to its own stderr, and falls into an interactive
 * device-code login that prints a code to stdout and polls for up to fifteen
 * minutes. The request that triggered it hangs for that long and then fails
 * as "Polling failed" or "Timed out waiting for device authorization" —
 * naming neither the cause nor the fix. These lines are the only early sign.
 *
 * Captured from the real authenticator in tests/fixtures/litellm/.
 */
import { StringDecoder } from 'node:string_decoder';
import type { Readable, Writable } from 'node:stream';

/** A line of LiteLLM's output saying its ChatGPT login has been refused and it is falling back to a device code. */
export const LITELLM_CHATGPT_LOGIN_REFUSED = /re-login required|Sign in with ChatGPT using device code/;

/**
 * The line with a device-code login's user code masked. Nobody should act on
 * that code — the login it starts would be LiteLLM's, into a token directory
 * serve throws away, and a device code is a phishing target besides — so the
 * one a user reads in serve's log is never live.
 */
export function redactDeviceCode(line: string): string {
  return line.replace(/(Enter code:\s*)\S.*$/, '$1****');
}

/**
 * Splits a byte stream into lines. `push` takes chunks as they arrive, split
 * anywhere (mid-line, mid-character); `end` delivers a final line that had no
 * newline. A line is delivered without its `\n`; a `\r` before it is kept.
 */
export function lineSplitter(onLine: (line: string) => void): { push(chunk: Buffer | string): void; end(): void } {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  const drain = (text: string): void => {
    pending += text;
    let at = pending.indexOf('\n');
    while (at !== -1) {
      onLine(pending.slice(0, at));
      pending = pending.slice(at + 1);
      at = pending.indexOf('\n');
    }
  };
  return {
    push(chunk) { drain(typeof chunk === 'string' ? chunk : decoder.write(chunk)); },
    end() {
      drain(decoder.end());
      if (pending !== '') {
        const last = pending;
        pending = '';
        onLine(last);
      }
    },
  };
}

/** Sinks that have a listener for their asynchronous 'error' event, and those that have emitted one. */
const guardedSinks = new WeakSet<Writable>();
const brokenSinks = new WeakSet<Writable>();

/**
 * A write to a closed pipe fails asynchronously: `write` returns, and the
 * sink emits 'error' (EPIPE) later. With no listener that is an uncaught
 * exception — `sonata serve | head` killed serve and orphaned its LiteLLM —
 * and a try/catch around `write` cannot see it. One listener per sink, never
 * more however many children are piped to it, marks the sink broken.
 */
function guardSink(sink: Writable): void {
  if (guardedSinks.has(sink)) return;
  guardedSinks.add(sink);
  sink.on('error', () => { brokenSinks.add(sink); });
}

/** A sink that has errored, or been closed, is written to no more. */
function sinkBroken(sink: Writable): boolean {
  return brokenSinks.has(sink) || sink.destroyed || sink.writableEnded;
}

/**
 * Forwards `stream` to `sink` one line at a time — each line as it was, but
 * for a device code's user code — and hands every line to `onLine`. A final
 * line with no newline is still forwarded when the stream ends. A sink that
 * cannot be written to (a closed log) never stops the child's output being
 * read, since a full pipe would stall LiteLLM itself; one that fails
 * asynchronously (EPIPE) is marked broken and skipped from then on.
 */
export function pipeLitellmOutput(stream: Readable, sink: Writable, onLine: (line: string) => void): void {
  guardSink(sink);
  const lines = lineSplitter((line) => {
    if (!sinkBroken(sink)) {
      try { sink.write(`${redactDeviceCode(line)}\n`); } catch { /* the log is gone; keep reading */ }
    }
    try { onLine(line); } catch { /* a listener never breaks forwarding */ }
  });
  stream.on('data', (chunk: Buffer | string) => lines.push(chunk));
  stream.on('end', () => lines.end());
  stream.on('error', () => lines.end());
}
