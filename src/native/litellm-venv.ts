import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The LiteLLM version sonata runs, pinned exactly.
 *
 * Every LiteLLM behaviour recorded in CLAUDE.md was measured against this
 * version — the `supports_system_message: false` declaration for codex-oauth,
 * the `output: []` 500-to-529 rewrite, the streaming cost-header behaviour. A
 * range would reintroduce the "whatever the user happens to have" problem this
 * module exists to remove, and moving the pin is a deliberate, separately
 * verified change rather than a side effect of installing on a later day.
 */
export const LITELLM_VERSION = '1.98.0';

/**
 * LiteLLM declares `requires_python: <3.15,>=3.10`.
 *
 * The ceiling is load-bearing: a check written as "3.10 or newer" passes a user
 * on 3.15 and then fails inside the resolver, which is a far worse error to
 * read than being told the range up front.
 */
export const PYTHON_MIN = [3, 10] as const;
export const PYTHON_MAX_EXCLUSIVE = [3, 15] as const;

export function pythonInRange(version: string): boolean {
  const m = /^(\d+)\.(\d+)/.exec(version.trim());
  if (m === null) return false;
  const v = [Number(m[1]), Number(m[2])] as const;
  const ge = v[0] > PYTHON_MIN[0] || (v[0] === PYTHON_MIN[0] && v[1] >= PYTHON_MIN[1]);
  const lt = v[0] < PYTHON_MAX_EXCLUSIVE[0]
    || (v[0] === PYTHON_MAX_EXCLUSIVE[0] && v[1] < PYTHON_MAX_EXCLUSIVE[1]);
  return ge && lt;
}

/** The python range as pip/uv spell it, so a message and a `uv venv` flag cannot drift apart. */
export const PYTHON_RANGE = `>=${PYTHON_MIN.join('.')},<${PYTHON_MAX_EXCLUSIVE.join('.')}`;

export function venvDir(home: string): string { return join(home, '.config', 'sonata', 'litellm'); }
export function managedLitellmPath(home: string): string { return join(venvDir(home), 'bin', 'litellm'); }
function pinPath(home: string): string { return join(venvDir(home), '.sonata-pin'); }
function stagingDir(home: string): string { return `${venvDir(home)}.installing`; }

/**
 * Not a boolean, because the repair differs per state.
 *
 * `not-required` is the point of the type: for a config where no gateway routes
 * through LiteLLM, its absence is correct, and "not installed" would read as a
 * fault. This is the same correction already made to the tier-routing check,
 * where five distinct causes printed one sentence naming only the fix.
 */
export type LitellmStatus =
  | { state: 'not-required' }
  | { state: 'ok'; version: string; path: string }
  | { state: 'stale'; installed: string; expected: string; path: string }
  | { state: 'missing' }
  | { state: 'broken'; reason: string }
  | { state: 'no-python'; pythonVersion?: string };

/**
 * `deps` is optional and only consulted when the venv is absent: it is what
 * distinguishes "not installed yet" from "not installable here". Without it the
 * answer is `missing`, which is right for every caller that is about to install
 * anyway; `doctor` passes it so it can say "install uv" — which can fetch a
 * conforming interpreter — rather than "install a different Python".
 */
export function litellmStatus(home: string, required: boolean, deps?: InstallerDeps): LitellmStatus {
  if (!required) return { state: 'not-required' };
  if (!existsSync(venvDir(home))) {
    if (deps !== undefined && detectInstaller(deps) === undefined) {
      return { state: 'no-python', pythonVersion: deps.pythonVersion() };
    }
    return { state: 'missing' };
  }
  const bin = managedLitellmPath(home);
  if (!existsSync(bin)) return { state: 'broken', reason: `${bin} is missing` };
  let installed = '';
  try { installed = readFileSync(pinPath(home), 'utf8').trim(); } catch { /* absent */ }
  if (installed === '') return { state: 'broken', reason: 'no .sonata-pin — provenance unknown' };
  return installed === LITELLM_VERSION
    ? { state: 'ok', version: installed, path: bin }
    : { state: 'stale', installed, expected: LITELLM_VERSION, path: bin };
}

export interface InstallerDeps {
  which(bin: string): string | undefined;
  pythonVersion(): string | undefined;
  run?(cmd: string, args: string[]): Promise<void>;
}

export interface Installer {
  readonly kind: 'uv' | 'python3';
  create(venv: string, run: NonNullable<InstallerDeps['run']>): Promise<void>;
  install(venv: string, spec: string, run: NonNullable<InstallerDeps['run']>): Promise<void>;
}

const uvInstaller: Installer = {
  kind: 'uv',
  create: (venv, run) => run('uv', ['venv', '--python', PYTHON_RANGE, venv]),
  install: (venv, spec, run) => run('uv', ['pip', 'install', '--python', join(venv, 'bin', 'python'), spec]),
};

const python3Installer: Installer = {
  kind: 'python3',
  create: (venv, run) => run('python3', ['-m', 'venv', venv]),
  install: (venv, spec, run) => run(join(venv, 'bin', 'pip'), ['install', spec]),
};

/**
 * uv first: it is faster AND can fetch a conforming interpreter, which is the
 * only thing that rescues an out-of-range system python3 — so its presence
 * always makes the venv buildable, and `undefined` is reachable only without it.
 */
export function detectInstaller(deps: InstallerDeps): Installer | undefined {
  if (deps.which('uv') !== undefined) return uvInstaller;
  const v = deps.pythonVersion();
  if (deps.which('python3') !== undefined && v !== undefined && pythonInRange(v)) return python3Installer;
  return undefined;
}

/**
 * Builds in a staging directory and moves into place only on success.
 *
 * A network failure part-way through must leave `missing`, which has a working
 * repair, rather than `broken`, which invites the user to debug a half-built
 * environment.
 */
export async function installLitellm(home: string, deps: InstallerDeps): Promise<void> {
  const installer = detectInstaller(deps);
  if (installer === undefined) {
    throw new Error(
      `sonata: no usable Python. LiteLLM needs ${PYTHON_RANGE} — install uv (which can fetch one) `
      + 'or a conforming python3.',
    );
  }
  const run = deps.run;
  if (run === undefined) throw new Error('sonata: no runner supplied');
  const final = venvDir(home);
  const staging = stagingDir(home);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
  try {
    await installer.create(staging, run);
    await installer.install(staging, `litellm[proxy]==${LITELLM_VERSION}`, run);
    writeFileSync(join(staging, '.sonata-pin'), LITELLM_VERSION);
    rmSync(final, { recursive: true, force: true });
    renameSync(staging, final);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}
