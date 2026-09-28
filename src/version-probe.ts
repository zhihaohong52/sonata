import { spawn } from 'node:child_process';

/**
 * How long any `--version` probe may take.
 *
 * Only opencode's was bounded, so a pi, codex, reasonix or tmux binary that
 * hung on `--version` hung `sonata init` and `sonata doctor` outright. Its own
 * module, importing nothing of sonata's, so `tmux.ts`, `detect.ts` and
 * `doctor.ts` can all use it without `tmux.ts` pulling in the detector (which
 * imports doctor).
 */
export const VERSION_PROBE_TIMEOUT_MS = 10_000;

/** A probe's failure, shaped like `execFile`'s so existing callers read it unchanged. */
export interface ProbeError extends Error {
  /** `'ENOENT'` for a missing binary, else the exit code. */
  code?: string | number;
  /** True when the bound fired and the process group was killed. */
  killed?: boolean;
  stderr?: string;
  stdout?: string;
}

/**
 * Run a probe command, bounded — and guaranteed to settle.
 *
 * `execFile`'s `timeout` is not enough on its own: it signals only the direct
 * child, SIGTERM by default, and then waits for the child's stdio to close. A
 * binary that traps TERM ignores it, and a grandchild holding stdout (any
 * shell-script launcher that runs a subprocess) keeps the pipe open after the
 * child dies — either way the "bounded" probe hung past its bound. So the
 * command runs in its own process group, the whole group gets SIGKILL when the
 * bound fires, and the promise settles on the child's exit rather than on
 * stdio closing, destroying the pipes a surviving descendant may still hold.
 */
export function runProbe(
  cmd: string,
  args: readonly string[],
  opts: { timeoutMs: number; env?: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, [...args], { env: opts.env ?? process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(error as ProbeError);
      return;
    }
    let stdout = '';
    let stderr = '';
    let killed = false;
    let settled = false;
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    // Drop the pipes a surviving descendant may still hold, so nothing keeps
    // the event loop (or this probe) waiting on it.
    const release = () => { child.stdout?.destroy(); child.stderr?.destroy(); };
    const killGroup = () => {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    };
    const timer = setTimeout(() => {
      killed = true;
      killGroup();
    }, opts.timeoutMs);
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    child.on('error', (error: ProbeError) => finish(() => { release(); reject(error); }));
    child.on('exit', (code, signal) => {
      // Give buffered output one turn to arrive, then stop waiting on stdio: a
      // grandchild left holding the pipe must not hold this probe too.
      setImmediate(() => finish(() => {
        // Reap anything the command left behind in its group.
        if (killed || code !== 0) killGroup();
        release();
        if (!killed && code === 0) return resolve({ stdout, stderr });
        const error = new Error(killed
          ? `\`${cmd}\` did not answer within ${opts.timeoutMs}ms`
          : `\`${cmd}\` exited with ${code ?? signal}`) as ProbeError;
        error.code = code ?? undefined;
        error.killed = killed;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }));
    });
  });
}
