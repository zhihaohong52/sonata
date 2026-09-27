/**
 * Waiting on an Ink screen by condition rather than by clock.
 *
 * Ink renders on a React legacy root: a screen's frame is drawn at commit,
 * but `useInput` subscribes in a passive effect that React defers to a
 * scheduler task (`setImmediate` under Node). A key written in between is
 * dropped without a trace. A fixed 10ms sleep usually spans that gap — but
 * not when the screen mounted from inside an effect or an async callback on
 * a loaded machine, which is how the OAuth login flow lost its SPACE and
 * submitted an empty selection in a full-suite run.
 */

/** Lets React's deferred passive effects (where `useInput` subscribes) run. */
export async function settle(turns = 5): Promise<void> {
  for (let i = 0; i < turns; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** A short sleep followed by `settle` — the drop-in for a bare `setTimeout` tick. */
export async function tick(ms = 10): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
  await settle();
}

/**
 * Polls `check` until it holds, then settles so the screen it describes is
 * listening for keys. Throws naming `what` rather than letting the next
 * assertion fail on a half-drawn frame.
 */
export async function until(check: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  await settle();
}
