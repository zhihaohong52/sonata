/**
 * The alternate screen buffer.
 *
 * A full-screen app draws on a page of its own and gives the terminal back
 * exactly as it found it. Without this the shell keeps whatever the last
 * frame happened to be — reported as "pressing Q to quit doesn't clear the
 * shell, but leaves it in place" — and the residue is worse than untidy now
 * that the app paints its own ground: what stays behind is a block of
 * off-white on a dark terminal, sitting above the prompt.
 *
 * The same sequences `src/tui.ts` already uses for its list prompts, so the
 * two halves of sonata's interactive surface behave the same way. A single
 * definition because an app that enters the buffer and fails to leave it
 * looks like a hung terminal.
 */
const ENTER = '\u001b[?1049h';
const LEAVE = '\u001b[?1049l';

/**
 * Run `body` on the alternate screen, restoring the terminal whatever happens.
 *
 * `finally`, not a success path: a throw that skipped the restore would leave
 * the user staring at a blank buffer with no prompt, which reads as a crashed
 * terminal rather than a crashed program. Anything the caller wants the user
 * to keep has to be printed *after* this resolves — the buffer's contents are
 * discarded by definition, which is why `sonata init` writes a log.
 */
export async function onAltScreen<T>(
  body: () => Promise<T>,
  stdout: { write: (s: string) => unknown } = process.stdout,
): Promise<T> {
  stdout.write(ENTER);
  try {
    return await body();
  } finally {
    stdout.write(LEAVE);
  }
}
