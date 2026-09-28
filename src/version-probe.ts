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

/**
 * How long a probe waits, after its command has exited, for the command's
 * output to finish arriving — i.e. for both pipes to reach EOF.
 *
 * `'exit'` is not "the output is in". Node emits it when the process is
 * reaped, and the last bytes on the pipe can be read in a later turn of the
 * event loop: measured in the suite, a stub that printed `works 1.2.3` exited
 * at 3.1 ms and its output was read at 5.4 ms, after the probe had already
 * resolved with an empty string. So a probe settles on EOF, and this bound
 * exists only for the case EOF never comes — a descendant still holding the
 * pipe — where waiting for it would be waiting on that descendant. Normal
 * probes reach EOF within milliseconds and never wait this long.
 */
export const PROBE_STDIO_GRACE_MS = 1_000;

/**
 * How many probes currently have their SIGINT/SIGTERM forwarders registered.
 * Those listeners are this module's own, not the parent's, so they are
 * subtracted before deciding whether the parent handles a signal itself.
 */
let activeForwarders = 0;

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
 * bound fires, and once the child has exited the promise waits for its pipes
 * to reach EOF for at most `PROBE_STDIO_GRACE_MS` — long enough for output
 * still in flight, bounded so a surviving descendant holding the pipes cannot
 * hold the probe too — then destroys them.
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
    let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let openPipes = 2;
    let grace: NodeJS.Timeout | undefined;
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
    //
    // "Nothing else was listening" is judged as the probe STARTED, not when the
    // signal lands: a parent's `process.once('SIGINT')` runs (and removes
    // itself) before this listener does, so counting then would read a parent
    // that handled the signal as one that did not, and re-raise into its exit.
    //
    // Other probes' forwarders are not the parent: `detectHarnesses` probes
    // concurrently, and counting a sibling's forwarder as a parent handler
    // meant that once the sibling finished, Ctrl-C killed this probe and the
    // parent carried on as though it had handled the signal.
    const parentHandles = {
      SIGINT: process.listenerCount('SIGINT') - activeForwarders > 0,
      SIGTERM: process.listenerCount('SIGTERM') - activeForwarders > 0,
    };
    const forward = (signal: 'SIGINT' | 'SIGTERM') => {
      killGroup();
      unforward();
      if (!parentHandles[signal]) process.kill(process.pid, signal);
    };
    const onSigint = () => forward('SIGINT');
    const onSigterm = () => forward('SIGTERM');
    let forwarding = true;
    const unforward = () => {
      if (!forwarding) return;
      forwarding = false;
      activeForwarders -= 1;
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
    };
    activeForwarders += 1;
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      unforward();
      fn();
    };
    child.on('error', (error: ProbeError) => finish(() => { release(); reject(error); }));
    const complete = () => finish(() => {
      const { code, signal } = exited!;
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
    });
    // Settle once the command has exited AND both pipes are at EOF — in
    // whichever order those arrive, since either can come first.
    const pipeClosed = () => {
      openPipes -= 1;
      if (openPipes === 0 && exited !== undefined) complete();
    };
    child.stdout!.on('close', pipeClosed);
    child.stderr!.on('close', pipeClosed);
    child.on('exit', (code, signal) => {
      exited = { code, signal };
      // It answered inside its bound, so the bound is done: left running, it
      // could fire during the grace below and relabel that answer a timeout.
      clearTimeout(timer);
      if (openPipes === 0) return complete();
      // A descendant may be holding a pipe open, so EOF may never come: stop
      // waiting after the grace period. The final setImmediate gives the poll
      // phase one more pass first — a timer fires before poll in a loop turn,
      // so bytes already sitting in the pipe would otherwise be dropped.
      grace = setTimeout(() => setImmediate(complete), PROBE_STDIO_GRACE_MS);
    });
  });
}
