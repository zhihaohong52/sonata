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
  return command === undefined || TUI_COMMANDS.has(command);
}

/**
 * Commands that open the shell rather than printing.
 *
 * Deep links into one app, not separate apps: `sonata status` opens it on the
 * status screen, `sonata agents` on tiers. Both keep their plain output when
 * either half of the terminal is missing, which is what a SessionStart hook,
 * a pipe and CI all get — and `status` in particular is read by scripts, so
 * that fallback is a contract, not a courtesy.
 *
 * `doctor` is deliberately absent. Its whole output is the check list, it is
 * the command a broken machine runs, and it is quoted in error messages that
 * a non-TTY reader has to be able to follow. The overview screen already
 * renders the same checks for anyone who wants them in the shell.
 */
export const TUI_COMMANDS: ReadonlySet<string> = new Set(['tui', 'status', 'agents']);
