/**
 * A private tmux server for the whole suite.
 *
 * Tests that create real sessions used to do so on the user's default server,
 * in panes running the user's login shell. That cost three things: the suite
 * appended its keystrokes to the user's shell history; a pane killed ~100 ms
 * after it was created could die holding zsh's `~/.zsh_history.LOCK`, and the
 * next pane's zsh then waited 10 s for it (the flaky pane-poll timeouts); and
 * two suites running at once collided on the fixed session names.
 *
 * So the suite gets its own socket directory (`TMUX_TMPDIR`, with `TMUX`
 * removed so no client follows an enclosing session's socket instead), and a
 * server started here from a config of its own: panes run `/bin/sh` with no rc
 * files and no history file, and the server stays up with no sessions
 * (`exit-empty off`) so every later `tmux` call — sonata's own `newSession`
 * included, which runs plain `tmux new-session` — reaches this server and its
 * options rather than starting one that reads the user's `~/.tmux.conf`.
 * `src/tmux.ts` is deliberately untouched: a real dispatch pane needs the
 * user's rc files for the harness's PATH.
 *
 * The environment set here reaches the test workers because vitest runs
 * global setup before it spawns them, and they inherit `process.env`
 * (asserted by `tests/tmux.test.ts`).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A Unix socket path is capped at 104 bytes on macOS; tmux adds `tmux-<uid>/default`. */
const SOCKET_PATH_MAX = 100;

export default function setup(): () => void {
  let base = tmpdir();
  if (join(base, 'sonata-tmux-XXXXXX', `tmux-${process.getuid?.() ?? 0}`, 'default').length > SOCKET_PATH_MAX) {
    base = '/tmp';
  }
  const dir = mkdtempSync(join(base, 'sonata-tmux-'));
  const conf = join(dir, 'tmux.conf');
  writeFileSync(conf, [
    'set -s exit-empty off',
    'set -g default-shell /bin/sh',
    'set -g default-command "exec /bin/sh"',
    'set-environment -g HISTFILE /dev/null',
    'set-environment -gu ENV',
    '',
  ].join('\n'));

  const previous = { TMUX_TMPDIR: process.env.TMUX_TMPDIR, TMUX: process.env.TMUX };
  process.env.TMUX_TMPDIR = dir;
  delete process.env.TMUX;
  let started = false;
  try {
    execFileSync('tmux', ['-f', conf, 'start-server'], { stdio: 'ignore' });
    started = true;
  } catch {
    // No tmux on this machine: the tests that need it fail on their own, and
    // everything else runs as before.
  }

  return () => {
    if (started) {
      try { execFileSync('tmux', ['kill-server'], { stdio: 'ignore' }); } catch { /* already gone */ }
    }
    rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
