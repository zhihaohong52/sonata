/**
 * Shell quoting for text that is interpolated into a shell script or sent as
 * keystrokes to a pane's interactive shell.
 *
 * Single-quote wrapping is the only form that suppresses `$`, backticks and
 * history expansion (`!`) in both bash and zsh, which is what makes it safe for
 * paths sent to an interactive pane. The sole character that needs care inside
 * single quotes is the single quote itself; `'\''` ends the quote, emits an
 * escaped quote, and reopens.
 *
 * This is the shared definition of the private copies that several adapters
 * already carry (`src/adapters/pi.ts` and friends). Those copies are left in
 * place deliberately — this module exists so new call sites stop inventing
 * their own quoting.
 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
