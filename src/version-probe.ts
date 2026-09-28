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

/**
 * The most output a probe may produce on either stream before it is killed —
 * `execFile`'s own cap was dropped with it, and a binary that streams forever
 * would otherwise grow this process's memory until the bound fired.
 */
export const PROBE_MAX_BUFFER = 16 * 1024 * 1024;

/** A probe's failure, shaped like `execFile`'s so existing callers read it unchanged. */
export interface ProbeError extends Error {
  /**
   * `'ENOENT'` for a missing binary, `'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'`
   * (execFile's own code) when the output cap was passed, else the exit code.
   */
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
  opts: { timeoutMs: number; env?: NodeJS.ProcessEnv; maxBuffer?: number },
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
    let overflowed: 'stdout' | 'stderr' | undefined;
    const maxBuffer = opts.maxBuffer ?? PROBE_MAX_BUFFER;
    const overflow = (stream: 'stdout' | 'stderr') => {
      if (overflowed !== undefined) return;
      overflowed = stream;
      killGroup();
    };
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
      if (overflowed !== undefined) return;
      stdout += chunk;
      if (stdout.length > maxBuffer) overflow('stdout');
    });
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => {
      if (overflowed !== undefined) return;
      stderr += chunk;
      if (stderr.length > maxBuffer) overflow('stderr');
    });
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
    // The probe runs in its own process group (detached), so the terminal's
    // Ctrl-C no longer reaches it. Forward SIGINT/SIGTERM to that group while
    // it runs; then, if nothing else was listening, re-raise so this process
    // gets the default handling it would have had without our listener.
    const forward = (signal: NodeJS.Signals) => {
      killGroup();
      unforward();
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
    };
    const onSigint = () => forward('SIGINT');
    const onSigterm = () => forward('SIGTERM');
    const unforward = () => {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
    };
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unforward();
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
        if (overflowed !== undefined) {
          const error = new RangeError(`${overflowed} maxBuffer length exceeded`) as ProbeError;
          error.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
          error.killed = true;
          error.stdout = stdout;
          error.stderr = stderr;
          return reject(error);
        }
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
