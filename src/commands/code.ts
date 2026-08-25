import { spawn } from 'node:child_process';

import { loadConfig, type SonataConfig } from '../config.js';
import { serveHealthUrl } from './serve.js';

export interface CodePlan {
  env: Record<string, string>;
  argv: string[];
  banner: string;
}

export interface CodeOptions {
  cwd: string;
  home: string;
  passthrough: string[];
}

/**
 * The env vars that route a Claude Code session through the sonata router.
 *
 * Shared by `planCode` (which spawns `claude` with them) and `sonata route`
 * (which writes them into `.claude/settings.local.json`) so the two session
 * paths cannot drift.
 */
export function nativeSessionEnv(config: SonataConfig): Record<string, string> {
  if (!config.native) return {};
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: `http://localhost:${config.native.ports.router}`,
  };
  const windows = [
    ...Object.values(config.native.models).map((model) => model.contextWindow),
    ...Object.values(config.unifiedModels)
      .map((model) => model.contextWindow)
      .filter((window): window is number => window !== undefined),
  ];
  if (windows.length > 0) {
    env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(Math.min(...windows));
  }
  return env;
}

export function planCode(opts: CodeOptions): CodePlan {
  const config = loadConfig(opts.cwd, opts.home);
  if (!config.native) throw new Error('sonata code: no [native] table');

  return {
    env: nativeSessionEnv(config),
    argv: ['claude', ...opts.passthrough],
    banner: 'Native Claude session started. Remote Control unavailable in sonata code.',
  };
}

async function defaultEnsureServe(cwd: string, home: string): Promise<number> {
  const config = loadConfig(cwd, home);
  if (!config.native) throw new Error('sonata code: no [native] table');
  const port = config.native.ports.router;
  try {
    const response = await fetch(serveHealthUrl(port));
    if (response.ok) return port;
  } catch {
    // Start the user-owned daemon below when the health probe cannot connect.
  }

  const child = spawn('sonata', ['serve', '--daemon'], { detached: true, stdio: 'ignore' });
  child.unref();
  return port;
}

/**
 * Hands the terminal to `claude` and never comes back.
 *
 * The returned promise deliberately never settles on success: this process
 * exists only to own the child, and the child's `exit` is what ends it. An
 * earlier version threw on the line after `spawn`, on the theory that the exit
 * handler made it unreachable — but that handler fires on a later tick, so the
 * throw always won. `sonata code` printed its banner and then
 * "failed to start claude", every time, while claude was starting perfectly
 * well. Only a genuine spawn failure — claude not on PATH — rejects.
 */
export interface ExecDeps {
  /** Injected by tests, which must not spawn a real editor or exit the runner. */
  spawn?: typeof spawn;
  exit?: (code: number) => void;
  signal?: (signal: NodeJS.Signals) => void;
}

export function execClaude(
  argv: string[],
  env: Record<string, string>,
  deps: ExecDeps = {},
): Promise<never> {
  const spawnFn = deps.spawn ?? spawn;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const raise = deps.signal ?? ((sig: NodeJS.Signals) => process.kill(process.pid, sig));

  const child = spawnFn(argv[0], argv.slice(1), { env: { ...process.env, ...env }, stdio: 'inherit' });

  return new Promise<never>((_resolve, reject) => {
    child.on('error', (error: NodeJS.ErrnoException) => {
      reject(error.code === 'ENOENT'
        ? new Error(
          `sonata code: ${argv[0]} is not on PATH — install Claude Code, or run it by hand ` +
          `with ANTHROPIC_BASE_URL=${env.ANTHROPIC_BASE_URL}`)
        : error);
    });
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      // Relay how claude ended, so a shell sees the status it would have seen.
      if (signal) raise(signal);
      exit(code ?? 1);
    });
  });
}

export async function cmdCode(
  opts: CodeOptions & {
    exec?: (argv: string[], env: Record<string, string>) => never | Promise<never>;
    ensureServe?: () => Promise<number>;
  },
): Promise<void> {
  const plan = planCode(opts);
  await (opts.ensureServe ?? (() => defaultEnsureServe(opts.cwd, opts.home)))();
  console.log(plan.banner);
  await (opts.exec ?? ((argv, env) => execClaude(argv, env)))(plan.argv, plan.env);
}
