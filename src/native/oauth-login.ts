import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { NativeGatewayAuth } from '../config.js';
import { managedLitellmPath } from './litellm-venv.js';

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
export function resolveInterpreter(home: string, which?: (bin: string) => string | undefined): string {
  const managed = managedLitellmPath(home);
  const path = existsSync(managed)
    ? managed
    : (which ?? ((bin: string) => {
      const result = execFileSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).trim();
      return result === '' ? undefined : result;
    }))('litellm');
  if (path === undefined) throw new Error('litellm is not installed');
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
    interpreter = opts.interpreter ?? resolveInterpreter(opts.home);
  } catch (err) {
    return { ok: false, problem: `${(err as Error).message}. Install it: sonata litellm install` };
  }

  const dir = credentialDir(opts.home, opts.gateway);
  // The login runs into a fresh temp directory, swapped in only on success.
  // LiteLLM's authenticator reads whatever token directory it is pointed at
  // first, so running it against the live directory let a stored — possibly
  // revoked — token pass as a fresh login, and a failed run still rewrote or
  // deleted the working credential. A failure now leaves the old login
  // exactly as it was.
  mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(dirname(dir), '.login-'));
  chmodSync(staging, 0o700);

  // PATH plus the one token-directory variable. No other parent value is
  // forwarded, matching how serve builds childEnv. FAKE_MODE only crosses over
  // when a test-injected interpreter is in play, so production can never leak
  // it through an ambient env var.
  const env: NodeJS.ProcessEnv = process.env.PATH ? { PATH: process.env.PATH } : {};
  env[tokenDirEnvVar(opts.auth)] = staging;
  if (opts.interpreter && process.env.FAKE_MODE) env.FAKE_MODE = process.env.FAKE_MODE;

  if (opts.signal?.aborted) {
    rmSync(staging, { force: true, recursive: true });
    return { ok: false, problem: 'login cancelled' };
  }

  /** Every regular file 0600 and the directory 0700 — LiteLLM writes with the process umask. */
  const fixPermissions = (target: string): void => {
    try { chmodSync(target, 0o700); } catch { return; }
    let names: string[];
    try {
      names = readdirSync(target);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(target, name);
      try {
        if (statSync(full).isFile()) chmodSync(full, 0o600);
      } catch { /* replaced under us, or a subdir; skip */ }
    }
  };

  return await new Promise<LoginResult>((resolve) => {
    let finished = false;
    const finish = (result: LoginResult): void => {
      if (finished) return;
      finished = true;
      fixPermissions(dir);
      fixPermissions(staging);
      rmSync(staging, { force: true, recursive: true });
      resolve(result);
    };
    let child;
    try {
      child = spawn(interpreter, ['-c', scriptFor(opts.auth)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      return finish({ ok: false, problem: `could not run litellm's interpreter ${interpreter}` });
    }

    let cancelled = false;
    const onAbort = () => { cancelled = true; child.kill('SIGTERM'); };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', () => {
      fixPermissions(staging);
      rmSync(staging, { force: true, recursive: true });
      finish({ ok: false, problem: `could not run litellm's interpreter ${interpreter}` });
    });

    // Line by line, so the device code reaches the user the instant it is
    // printed - Copilot only polls for 60 seconds.
    for (const stream of [child.stdout, child.stderr]) {
      createInterface({ input: stream }).on('line', (text: string) => opts.progress.line(text));
    }

    child.on('close', (code: number | null) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (cancelled) {
        fixPermissions(staging);
        rmSync(staging, { force: true, recursive: true });
        return finish({ ok: false, problem: 'login cancelled' });
      }
      if (code !== 0) {
        fixPermissions(staging);
        rmSync(staging, { force: true, recursive: true });
        return finish({ ok: false, problem: `litellm's authenticator exited ${code}` });
      }
      // An exit code alone is not evidence.
      const credentialPath = join(staging, credentialFileFor(opts.auth));
      if (!existsSync(credentialPath)) {
        fixPermissions(staging);
        rmSync(staging, { force: true, recursive: true });
        return finish({ ok: false, problem: 'the login reported success but wrote no credential' });
      }
      // LiteLLM writes with the process umask, commonly 0644 - fix it up
      // rather than trust an interpreter we don't control to have written
      // 0600. Every regular file, not only the one that proves the login:
      // Copilot's long-lived GitHub token sits in `access-token` beside
      // `api-key.json`. Fix-up runs on failure paths too, so a cancelled or
      // failed run's temp files carry no readable secret on their way out.
      fixPermissions(staging);
      // Keep the old login until installation succeeds. Staging and backup
      // live beside the destination so both renames stay on one filesystem.
      const backup = `${staging}-old`;
      let backedUp = false;
      try {
        if (existsSync(dir)) {
          fixPermissions(dir);
          renameSync(dir, backup);
          backedUp = true;
        }
        renameSync(staging, dir);
      } catch {
        if (backedUp) renameSync(backup, dir);
        return finish({ ok: false, problem: 'could not install the new login; the previous credential was kept' });
      }
      if (backedUp) rmSync(backup, { force: true, recursive: true });
      sweepStaleLoginBackups(dirname(dir));
      finish({ ok: true });
    });
  });
}

/** How old a leftover login backup must be before a later login removes it. */
const STALE_LOGIN_BACKUP_MS = 10 * 60_000;

/**
 * Removes the backups a crashed login left beside its destination. A login
 * renames the previous credential to `<staging>-old` and deletes it once the
 * new one is installed; one that survives is a credential nothing reads. Only
 * backups older than ten minutes go, so a login still in its swap window is
 * never swept — its backup is its rollback.
 */
export function sweepStaleLoginBackups(parent: string, now: number = Date.now()): void {
  let names: string[];
  try {
    names = readdirSync(parent);
  } catch {
    return;
  }
  for (const name of names) {
    if (!/^\.login-.+-old$/.test(name)) continue;
    const path = join(parent, name);
    try {
      if (now - statSync(path).mtimeMs >= STALE_LOGIN_BACKUP_MS) rmSync(path, { force: true, recursive: true });
    } catch {
      // Gone already, or not ours to read: nothing to sweep.
    }
  }
}
