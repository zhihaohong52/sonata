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

/**
 * A line of LiteLLM's output saying its ChatGPT login has been refused and it
 * is falling back to a device code — anchored on the exact lines LiteLLM
 * writes, never a substring anywhere: every line of the child's output is
 * scanned, including request bodies echoed in a debug log, and a conversation
 * that merely mentions "re-login required" must not take ChatGPT down.
 *
 * - the warning, after LiteLLM's plain log prefix
 *   (`\x1b[92m<HH:MM:SS> - LiteLLM:WARNING\x1b[0m: authenticator.py:55 - `),
 *   colour codes optional; or as the `message` of LiteLLM's JSON log line;
 * - the device-code prompt, which is a bare `print` and so begins its line.
 */
export const LITELLM_CHATGPT_LOGIN_REFUSED = new RegExp([
  '^(?:\\x1b\\[[\\d;]*m)?\\d{2}:\\d{2}:\\d{2} - LiteLLM[\\w ]*:[A-Z]+(?:\\x1b\\[[\\d;]*m)?: \\S+:\\d+ - ' +
    'ChatGPT refresh token failed, re-login required',
  '^\\{"message": "ChatGPT refresh token failed, re-login required',
  '^Sign in with ChatGPT using device code',
].join('|'));

/**
 * The line with a device-code login's user code masked. Nobody should act on
 * that code — the login it starts would be LiteLLM's, into a token directory
 * serve throws away, and a device code is a phishing target besides — so the
 * one a user reads in serve's log is never live. ChatGPT's prompt
 * (`2) Enter code: XXXX-XXXX`) and Copilot's (`Please visit … and enter code
 * XXXX-XXXX to authenticate.`), either case.
 */
export function redactDeviceCode(line: string): string {
  return line
    .replace(/(Enter code:\s*)\S.*$/i, '$1****')
    .replace(/(enter code\s+)\S+(\s+to authenticate)/i, '$1****$2');
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
 * How much forwarded output a sink may hold unwritten before lines are
 * dropped. Past it — or once `write` has returned false and the sink has not
 * yet drained — every further line would be queued in serve's memory without
 * bound, since the child's output is never paused (a full pipe would stall
 * LiteLLM itself).
 */
export const SINK_BACKLOG_CAP_BYTES = 1024 * 1024;

/** Lines dropped per sink while it was blocked, not yet reported. */
const droppedLines = new WeakMap<Writable, number>();

function sinkBlocked(sink: Writable): boolean {
  return sink.writableNeedDrain || sink.writableLength > SINK_BACKLOG_CAP_BYTES;
}

/** Writes the one-line account of what a blocked sink missed, once it can take it. */
function reportDropped(sink: Writable): void {
  const dropped = droppedLines.get(sink) ?? 0;
  if (dropped === 0 || sinkBroken(sink) || sinkBlocked(sink)) return;
  droppedLines.delete(sink);
  try {
    sink.write(`sonata serve: dropped ${dropped} lines of LiteLLM output while the log was blocked\n`);
  } catch { /* the log is gone */ }
}

/** Counts a line dropped for a blocked sink, and arranges the report for when it drains. */
function dropLine(sink: Writable): void {
  const dropped = droppedLines.get(sink) ?? 0;
  droppedLines.set(sink, dropped + 1);
  if (dropped === 0) sink.once('drain', () => reportDropped(sink));
}

/**
 * Forwards `stream` to `sink` one line at a time — each line as it was, but
 * for a device code's user code — and hands every line to `onLine`. A final
 * line with no newline is still forwarded when the stream ends. A sink that
 * cannot be written to (a closed log) never stops the child's output being
 * read, since a full pipe would stall LiteLLM itself; one that fails
 * asynchronously (EPIPE) is marked broken and skipped from then on. One that
 * stops draining has lines dropped rather than queued, counted, and reported
 * in a single line once it drains — every line is still handed to `onLine`.
 */
export function pipeLitellmOutput(stream: Readable, sink: Writable, onLine: (line: string) => void): void {
  guardSink(sink);
  const lines = lineSplitter((line) => {
    if (!sinkBroken(sink)) {
      if (sinkBlocked(sink)) dropLine(sink);
      else {
        reportDropped(sink);
        try { sink.write(`${redactDeviceCode(line)}\n`); } catch { /* the log is gone; keep reading */ }
      }
    }
    try { onLine(line); } catch { /* a listener never breaks forwarding */ }
  });
  stream.on('data', (chunk: Buffer | string) => lines.push(chunk));
  stream.on('end', () => lines.end());
  stream.on('error', () => lines.end());
}
