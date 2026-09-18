/**
 * Whether this invocation opens the TUI.
 *
 * Pure, and separated from `main` so the decision is testable without a TTY
 * and without rendering anything.
 *
 * The TTY test is a requirement rather than a refinement. Bare `sonata` is
 * already called from places with no terminal — a SessionStart hook, CI, a
 * pipe — and rendering Ink into one of those produces escape sequences where
 * the caller expected help text. Without a TTY the caller gets today's help
 * and today's exit code (2 for a bare `sonata`, 0 for `--help`), so this is a
 * pure addition.
 */
export function shouldLaunchTui(
  command: string | undefined,
  stdoutIsTty: boolean,
  stdinIsTty: boolean,
): boolean {
  // Both halves, not just stdout: Ink's `useInput` puts stdin in raw mode,
  // which throws when stdin is not a TTY. `sonata < /dev/null` from a terminal
  // has a TTY stdout and a piped stdin, and checking stdout alone would crash
  // there instead of printing help.
  if (!stdoutIsTty || !stdinIsTty) return false;
  return command === undefined || command === 'tui';
}
