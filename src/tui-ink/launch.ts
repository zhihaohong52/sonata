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
  /** The rest of argv, which decides whether `init` is a wizard or a script. */
  rest: readonly string[] = [],
): boolean {
  // Both halves, not just stdout: Ink's `useInput` puts stdin in raw mode,
  // which throws when stdin is not a TTY. `sonata < /dev/null` from a terminal
  // has a TTY stdout and a piped stdin, and checking stdout alone would crash
  // there instead of printing help.
  if (!stdoutIsTty || !stdinIsTty) return false;
  // `init` is the one deep link whose command name is not enough to decide.
  // Every other TUI command has one behaviour; `sonata init --yes --providers
  // …` is a *scripted* run that must not open a screen, and the flag is the
  // only thing distinguishing it. Any scripting flag keeps the old path, not
  // just `--yes`: `--providers` without `--yes` is still a caller telling init
  // what to do rather than asking to be asked.
  if (command === 'init') return !rest.some((arg) => SCRIPTED_INIT_FLAGS.has(arg.split('=')[0]!));
  // The status screen has a PROJECT axis (`--global`, or `g` in place) but no
  // SESSION axis. Opening it for `--session <id>` or `--all` would silently
  // drop the selection the caller made and show something else under the
  // same name, so those keep the plain output that honours them.
  if (command === 'status') return !rest.some((arg) => SESSION_FLAGS.has(arg.split('=')[0]!));
  return command === undefined || TUI_COMMANDS.has(command);
}

/**
 * Flags that mean `sonata init` was told what to do rather than asked.
 *
 * Named exhaustively rather than matched as "any flag", because the ones that
 * are *not* here matter: `--repropose-tiers` changes what the wizard seeds its
 * ranking screens with and is meaningless without a wizard to seed, so it must
 * still open one. A blanket `startsWith('--')` would have sent it down the
 * scripted path, where it silently re-ranks with nobody watching.
 */
/** `sonata status` flags the screen cannot honour; see `shouldLaunchTui`. */
const SESSION_FLAGS: ReadonlySet<string> = new Set(['--session', '--all']);

const SCRIPTED_INIT_FLAGS: ReadonlySet<string> = new Set([
  '--yes', '-y', '--providers', '--models', '--roles',
  '--config-scope', '--scope', '--routing', '--guidance', '--prune',
]);

/**
 * Commands that open the shell rather than printing.
 *
 * Deep links into one app, not separate apps: `sonata status` opens it on the
 * status screen, `sonata agents` on tiers. Both keep their plain output when
 * either half of the terminal is missing, which is what a SessionStart hook,
 * a pipe and CI all get — and `status` in particular is read by scripts, so
 * that fallback is a contract, not a courtesy.
 *
 * `init` is here too, but conditionally — see `shouldLaunchTui`, which is the
 * only command whose name does not settle the question, since a scripted
 * `sonata init --yes` must still run without a screen.
 *
 * `doctor` is deliberately absent. Its whole output is the check list, it is
 * the command a broken machine runs, and it is quoted in error messages that
 * a non-TTY reader has to be able to follow. The overview screen already
 * renders the same checks for anyone who wants them in the shell.
 */
export const TUI_COMMANDS: ReadonlySet<string> = new Set(['tui', 'status', 'agents', 'init']);
