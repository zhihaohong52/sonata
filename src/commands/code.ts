import { spawn } from 'node:child_process';

import { loadConfig } from '../config.js';
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

export function planCode(opts: CodeOptions): CodePlan {
  const config = loadConfig(opts.cwd, opts.home);
  if (!config.native) throw new Error('sonata code: no [native] table');

  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: `http://localhost:${config.native.ports.router}`,
  };
  const windows = Object.values(config.native.models).map((model) => model.contextWindow);
  if (windows.length > 0) {
    env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(Math.min(...windows));
  }

  return {
    env,
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

function defaultExec(argv: string[], env: Record<string, string>): never {
  const child = spawn(argv[0], argv.slice(1), { env: { ...process.env, ...env }, stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });
  throw new Error('sonata code: failed to start claude');
}

export async function cmdCode(
  opts: CodeOptions & {
    exec?: (argv: string[], env: Record<string, string>) => never;
    ensureServe?: () => Promise<number>;
  },
): Promise<void> {
  const plan = planCode(opts);
  await (opts.ensureServe ?? (() => defaultEnsureServe(opts.cwd, opts.home)))();
  console.log(plan.banner);
  (opts.exec ?? defaultExec)(plan.argv, plan.env);
}
