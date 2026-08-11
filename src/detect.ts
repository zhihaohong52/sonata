/**
 * Environment detection for `sonata init` and `sonata doctor`.
 *
 * Parsing is separated from process execution so the interesting logic can be
 * tested against real fixture files rather than a live machine.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkVersion } from './commands/doctor.js';
import { parsePiRefs } from './adapters/pi.js';
import type { ModelRef, ProviderHarness } from './types.js';

const run = promisify(execFile);

export type Severity = 'error' | 'warn' | 'info';

export interface Problem {
  severity: Severity;
  message: string;
  /** A command the user can run, or a description of the repair sonata offers. */
  fix?: string;
  /** True when `sonata init` can perform the repair itself. */
  autoFixable?: boolean;
}

export interface OpenCodeModel {
  provider: string;
  id: string;
  name?: string;
}

export interface HarnessStatus {
  name: string;
  installed: boolean;
  version?: string;
  supported: boolean;
  binPath?: string;
  refs: ModelRef[];
  authedProviders: string[];
  problems: Problem[];
}

export function parseOpenCodeModels(text: string): OpenCodeModel[] {
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const out: OpenCodeModel[] = [];
  for (const [provider, def] of Object.entries<any>(parsed?.provider ?? {})) {
    for (const [id, model] of Object.entries<any>(def?.models ?? {})) {
      out.push({ provider, id, name: model?.name });
    }
  }
  return out;
}

export function parseAuthedProviders(text: string): string[] {
  try {
    return Object.keys(JSON.parse(text) ?? {});
  } catch {
    return [];
  }
}

/**
 * Parses `opencode models`, which prints one `provider/model` ref per line —
 * exactly the string `-m` accepts.
 */
export function parseOpenCodeRefs(stdout: string): ModelRef[] {
  const out: ModelRef[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    const slash = line.indexOf('/');
    // A ref needs a non-empty provider and a non-empty id either side.
    if (slash <= 0 || slash === line.length - 1) continue;
    out.push({
      harness: 'opencode',
      provider: line.slice(0, slash),
      id: line.slice(slash + 1),
      ref: line,
    });
  }
  return out;
}

export interface ProviderSummary {
  harness: ProviderHarness;
  provider: string;
  count: number;
  /** `harness/provider` — identifies a picker row. */
  key: string;
}

/**
 * OpenCode's free tier needs no auth entry, so it is offered alongside the
 * authenticated providers.
 */
const FREE_OPENCODE_PROVIDERS = ['opencode'];

/**
 * Groups refs into picker rows.
 *
 * The auth filter applies to opencode only. `pi --list-models` lists just the
 * models pi can actually run — that is what piHealth relies on when it treats
 * an empty list as "no usable provider" — so filtering pi by an auth file
 * would invent a concept pi does not have.
 */
export function offerableProviders(refs: ModelRef[], authed: string[]): ProviderSummary[] {
  const allowed = new Set([...authed, ...FREE_OPENCODE_PROVIDERS]);
  const counts = new Map<string, ProviderSummary>();

  for (const ref of refs) {
    if (ref.harness === 'opencode' && !allowed.has(ref.provider)) continue;
    const key = `${ref.harness}/${ref.provider}`;
    const seen = counts.get(key);
    if (seen) seen.count += 1;
    else counts.set(key, { harness: ref.harness, provider: ref.provider, count: 1, key });
  }

  return [...counts.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** Agent files that sonata generated but the current config no longer covers. */
export function staleAgents(agentsDir: string, expected: string[]): string[] {
  if (!existsSync(agentsDir)) return [];
  const wanted = new Set(expected.map((n) => `${n}.md`));
  return readdirSync(agentsDir)
    .filter((f) => f.endsWith('.md'))
    .filter((f) => isSonataAgent(join(agentsDir, f)))
    .filter((f) => !wanted.has(f))
    .sort();
}

function isSonataAgent(path: string): boolean {
  try {
    return readFileSync(path, 'utf8').includes('forwarding wrapper around the sonata runtime');
  } catch {
    return false;
  }
}

async function tryRun(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    const { stdout } = await run(cmd, args, { env: env ?? process.env });
    return stdout.trim();
  } catch {
    return null;
  }
}

/** Like `tryRun`, but bounded — a hung provider must not stall `init`. */
async function tryRunLimited(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  ms: number,
): Promise<string | null> {
  try {
    const { stdout } = await run(cmd, args, { env, timeout: ms });
    return stdout.trim();
  } catch {
    return null;
  }
}

export async function detectTmux(): Promise<{ installed: boolean; version?: string; problems: Problem[] }> {
  const out = await tryRun('tmux', ['-V']);
  if (out === null) {
    return {
      installed: false,
      problems: [{
        severity: 'error',
        message: 'tmux is not installed — sonata runs every harness inside a tmux session',
        fix: 'brew install tmux',
      }],
    };
  }
  return { installed: true, version: out.replace(/^tmux\s+/, ''), problems: [] };
}

export interface DetectEnv {
  home: string;
  supportedVersions: string;
}

export async function detectOpenCode(env: DetectEnv): Promise<HarnessStatus> {
  const problems: Problem[] = [];
  const localBin = join(env.home, '.opencode', 'bin', 'opencode');

  const path = `${join(env.home, '.opencode', 'bin')}:${process.env.PATH ?? ''}`;
  const version = await tryRun('opencode', ['--version'], { ...process.env, PATH: path });

  if (version === null) {
    return {
      name: 'opencode',
      installed: false,
      supported: false,
      refs: [],
      authedProviders: [],
      problems: [{
        severity: 'error',
        message: 'opencode is not installed',
        fix: 'curl -fsSL https://opencode.ai/install | bash',
      }],
    };
  }

  const supported = checkVersion(version, env.supportedVersions);
  if (!supported) {
    problems.push({
      severity: 'warn',
      message: `opencode ${version} is outside the tested range ${env.supportedVersions}`,
      fix: 'Prompt detection may misbehave; upgrade or pin a tested version.',
    });
  }

  const listing = await tryRun('opencode', ['models'], { ...process.env, PATH: path });
  const refs = listing === null ? [] : parseOpenCodeRefs(listing);

  // The CLI emits no display names; the config has them for custom providers.
  const configPath = join(env.home, '.config', 'opencode', 'opencode.json');
  const named = existsSync(configPath)
    ? parseOpenCodeModels(readFileSync(configPath, 'utf8'))
    : [];
  for (const ref of refs) {
    ref.name = named.find((m) => m.provider === ref.provider && m.id === ref.id)?.name;
  }

  const authPath = join(env.home, '.local', 'share', 'opencode', 'auth.json');
  const authedProviders = existsSync(authPath)
    ? parseAuthedProviders(readFileSync(authPath, 'utf8'))
    : [];

  if (refs.length === 0) {
    problems.push({
      severity: 'error',
      message: 'opencode reported no models',
      fix: 'opencode auth login',
    });
  }

  return {
    name: 'opencode',
    installed: true,
    version,
    supported,
    binPath: existsSync(localBin) ? localBin : 'opencode',
    refs,
    authedProviders,
    problems,
  };
}

export async function detectPi(env: DetectEnv): Promise<HarnessStatus> {
  const path = `${join(env.home, '.local', 'bin')}:${process.env.PATH ?? ''}`;
  const version = await tryRun('pi', ['--version'], { ...process.env, PATH: path });

  // Absence is not an error. A machine with only opencode is normal.
  if (version === null) {
    return { name: 'pi', installed: false, supported: false, refs: [], authedProviders: [], problems: [] };
  }

  // Pi can block when a provider is unreachable, and doctor must never hang.
  const listing = await tryRunLimited('pi', ['--list-models'], { ...process.env, PATH: path }, 5_000);
  const problems: Problem[] = [];
  if (listing === null) {
    problems.push({
      severity: 'warn',
      message: 'pi is installed but did not list any models',
      fix: 'pi auth check --provider <name>',
    });
  }

  return {
    name: 'pi',
    installed: true,
    version,
    supported: true,
    refs: listing === null ? [] : parsePiRefs(listing),
    authedProviders: [],
    problems,
  };
}

export async function detectHarnesses(env: DetectEnv): Promise<HarnessStatus[]> {
  return Promise.all([detectOpenCode(env), detectPi(env)]);
}
