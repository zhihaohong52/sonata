import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { shellQuote } from './shell.js';
import { VERSION_PROBE_TIMEOUT_MS, runProbe } from './version-probe.js';
import type { PaneSource } from './pane-record.js';

const run = promisify(execFile);

async function tmux(args: string[]): Promise<string> {
  const { stdout } = await run('tmux', args, { encoding: 'utf8' });
  return stdout;
}

/**
 * Runs `fn` again when tmux reports the server exited under it.
 *
 * A tmux server exits when its last session closes, and a client that
 * connects while it is exiting fails with "server exited unexpectedly" having
 * created nothing — so trying again is safe, and starts a fresh server.
 * Sonata's parallel dispatches share the user's server, so one run ending
 * while another launches is enough to lose the race (reproduced 3 in 300 by
 * churning sessions beside a creator; seen in CI as a failed e2e launch).
 * Only that message is retried: any other failure, a duplicate session name
 * included, is the caller's to see.
 */
export async function retryWhenServerExits<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const delayMs = opts.delayMs ?? 100;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? '');
      const message = error instanceof Error ? error.message : '';
      const raced = `${stderr}\n${message}`.includes('server exited unexpectedly');
      if (!raced || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/**
 * `tmux -V`, bounded: `sonata doctor` awaits it first, so a tmux that hangs
 * here hung doctor outright. Bounded by default rather than opt-in — doctor is
 * the only caller, and an unbounded probe is never what anyone wants.
 */
export async function tmuxVersion(timeoutMs: number = VERSION_PROBE_TIMEOUT_MS): Promise<string> {
  const { stdout } = await runProbe('tmux', ['-V'], { timeoutMs });
  return stdout.trim().replace(/^tmux\s+/, '');
}

/**
 * Creates a detached session running a persistent shell. The harness command is
 * sent separately via runScript so the pane outlives the command — without this
 * the pane-tail fallback is unavailable exactly when a harness crashes.
 */
export async function newSession(opts: { session: string; cwd: string }): Promise<void> {
  await retryWhenServerExits(() => tmux([
    'new-session', '-d',
    '-s', opts.session,
    '-c', opts.cwd,
    '-x', '200', '-y', '50',
  ]));
  await tmux(['set-option', '-t', opts.session, 'remain-on-exit', 'on']);
  await tmux(['set-option', '-t', opts.session, 'history-limit', '10000']);
}

export async function hasSession(session: string): Promise<boolean> {
  try {
    await tmux(['has-session', '-t', session]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sends the command to run a script to the pane's interactive shell.
 *
 * The path is single-quote wrapped (`shellQuote`), not JSON-quoted: these are
 * keystrokes typed into a live shell, so `$()`, backticks and history `!` are
 * all live there — `JSON.stringify` leaves every one of them unescaped, and a
 * script path carrying them broke the launch or ran commands. Single quotes
 * suppress all three in bash and zsh.
 */
export async function runScript(session: string, scriptPath: string): Promise<void> {
  await tmux(['send-keys', '-t', session, `bash ${shellQuote(scriptPath)}`, 'Enter']);
}

export async function sendKeys(session: string, keys: string): Promise<void> {
  await tmux(['send-keys', '-t', session, keys]);
}

export async function capturePane(session: string): Promise<string> {
  return (await tryCapturePane(session)) ?? '';
}

/**
 * Distinguishes a genuinely empty pane ('') from a failed capture (null). The
 * tmux server rejects calls transiently under load, and treating that as an
 * empty pane makes callers believe the pane was cleared.
 */
export async function tryCapturePane(session: string): Promise<string | null> {
  try {
    return await tmux(['capture-pane', '-p', '-t', session]);
  } catch {
    return null;
  }
}

/**
 * The pane as `recordPane` reads it (`src/pane-record.ts`): its history count
 * and mode, its visible rows, and exact slices of its scrollback. Each read
 * answers null on a failed call, never an empty pane.
 */
export function paneSource(session: string): PaneSource {
  const lines = (out: string): string[] => {
    const rows = out.split('\n');
    if (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();
    return rows;
  };
  return {
    async info() {
      try {
        const out = await tmux(['display-message', '-p', '-t', session,
          '#{history_size} #{history_limit} #{alternate_on} #{pane_height}']);
        const [size, limit, alt, height] = out.trim().split(' ').map((n) => Number.parseInt(n, 10));
        if (![size, limit, alt, height].every((n) => Number.isFinite(n))) return null;
        return { historySize: size!, historyLimit: limit!, alternate: alt === 1, height: height! };
      } catch {
        return null;
      }
    },
    async screen() {
      try {
        return lines(await tmux(['capture-pane', '-p', '-t', session]));
      } catch {
        return null;
      }
    },
    async history(count) {
      if (count <= 0) return [];
      try {
        return lines(await tmux(['capture-pane', '-p', '-S', `-${count}`, '-E', '-1', '-t', session]));
      } catch {
        return null;
      }
    },
  };
}

export async function listSessions(): Promise<string[]> {
  try {
    const out = await tmux(['list-sessions', '-F', '#{session_name}']);
    return out.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Name of the tmux session this process is running inside, or null when not
 * inside tmux. Used to stop sonata killing the pane it lives in.
 */
export async function currentSession(): Promise<string | null> {
  if (!process.env.TMUX) return null;
  try {
    return (await tmux(['display-message', '-p', '#{session_name}'])).trim() || null;
  } catch {
    return null;
  }
}

export async function killSession(session: string): Promise<void> {
  try {
    await tmux(['kill-session', '-t', session]);
  } catch {
    /* already gone */
  }
}
