import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { NativeGatewayAuth } from '../config.js';

export interface LoginProgress {
  /** A line LiteLLM printed - includes the verification URL and user code. */
  line(text: string): void;
}

export interface LoginResult {
  ok: boolean;
  /** Present when the flow failed, safe to display - never token material. */
  problem?: string;
}

/**
 * Where a sonata-minted credential lives. Persistent, unlike serve's temp
 * directory: LiteLLM refreshes tokens into these files, and Copilot's
 * api-key.json is short-lived and re-exchanged in place. A temp directory
 * throws every refresh away.
 */
export function credentialDir(home: string, gateway: string): string {
  return join(home, '.config/sonata/credentials', gateway);
}

export function tokenDirEnvVar(auth: NativeGatewayAuth): 'CHATGPT_TOKEN_DIR' | 'GITHUB_COPILOT_TOKEN_DIR' {
  return auth === 'copilot-oauth' ? 'GITHUB_COPILOT_TOKEN_DIR' : 'CHATGPT_TOKEN_DIR';
}

/**
 * The file whose existence proves the login worked.
 *
 * For Copilot that is `api-key.json`, not `access-token`: only `get_api_key()`
 * writes it, and only that call proves the GitHub token can actually exchange
 * for a Copilot key. Probed 2026-08-22 - a `ghu_` token authenticates fine and
 * still tells you nothing about entitlement.
 */
export function credentialFileFor(auth: NativeGatewayAuth): string {
  return auth === 'copilot-oauth' ? 'api-key.json' : 'auth.json';
}

/**
 * Never `_login()`: it returns a token and persists nothing, so the next call
 * starts a second device flow against an empty directory. Copilot needs the
 * `get_api_key()` follow-up because the device login and the Copilot exchange
 * are separate calls.
 */
function scriptFor(auth: NativeGatewayAuth): string {
  return auth === 'copilot-oauth'
    ? 'from litellm.llms.github_copilot.authenticator import Authenticator\n' +
      'a = Authenticator()\na.get_access_token()\na.get_api_key()\n'
    : 'from litellm.llms.chatgpt.authenticator import Authenticator\n' +
      'Authenticator().get_access_token()\n';
}

/**
 * The interpreter that owns `litellm` is the one named in its shebang - a bare
 * `python3` may be a different install with no litellm on its path.
 */
export function resolveInterpreter(): string {
  const path = execFileSync('sh', ['-c', 'command -v litellm'], { encoding: 'utf8' }).trim();
  if (path === '') throw new Error('litellm is not installed');
  const first = readFileSync(path, 'utf8').split('\n', 1)[0] ?? '';
  if (!first.startsWith('#!')) throw new Error(`litellm at ${path} has no interpreter line`);
  return first.slice(2).trim();
}

export async function loginGateway(opts: {
  home: string;
  gateway: string;
  auth: NativeGatewayAuth;
  progress: LoginProgress;
  signal?: AbortSignal;
  /** Injected in tests; defaults to resolving litellm's shebang. */
  interpreter?: string;
}): Promise<LoginResult> {
  let interpreter: string;
  try {
    interpreter = opts.interpreter ?? resolveInterpreter();
  } catch (err) {
    return { ok: false, problem: `${(err as Error).message}. Install it: pip install 'litellm[proxy]'` };
  }

  const dir = credentialDir(opts.home, opts.gateway);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  // PATH plus the one token-directory variable. No other parent value is
  // forwarded, matching how serve builds childEnv.
  const env: NodeJS.ProcessEnv = process.env.PATH ? { PATH: process.env.PATH } : {};
  env[tokenDirEnvVar(opts.auth)] = dir;
  if (process.env.FAKE_MODE) env.FAKE_MODE = process.env.FAKE_MODE;

  return await new Promise<LoginResult>((resolve) => {
    let child;
    try {
      child = spawn(interpreter, ['-c', scriptFor(opts.auth)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      return resolve({ ok: false, problem: `could not run litellm's interpreter ${interpreter}` });
    }

    let cancelled = false;
    const onAbort = () => { cancelled = true; child.kill('SIGTERM'); };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', () => {
      resolve({ ok: false, problem: `could not run litellm's interpreter ${interpreter}` });
    });

    // Line by line, so the device code reaches the user the instant it is
    // printed - Copilot only polls for 60 seconds.
    for (const stream of [child.stdout, child.stderr]) {
      createInterface({ input: stream }).on('line', (text: string) => opts.progress.line(text));
    }

    child.on('close', (code: number | null) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (cancelled) return resolve({ ok: false, problem: 'login cancelled' });
      if (code !== 0) return resolve({ ok: false, problem: `litellm's authenticator exited ${code}` });
      // An exit code alone is not evidence.
      if (!existsSync(join(dir, credentialFileFor(opts.auth)))) {
        return resolve({ ok: false, problem: 'the login reported success but wrote no credential' });
      }
      resolve({ ok: true });
    });
  });
}
