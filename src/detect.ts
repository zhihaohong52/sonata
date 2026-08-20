/**
 * Environment detection for `sonata init` and `sonata doctor`.
 *
 * Parsing is separated from process execution so the interesting logic can be
 * tested against real fixture files rather than a live machine.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkVersion } from './commands/doctor.js';
import { parsePiRefs } from './adapters/pi.js';
import { parseCodexModels, codexModelList } from './adapters/codex.js';
import { parseReasonixRefs, reasonixDoctorJson } from './adapters/reasonix.js';
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
  /**
   * Provider name → base URL, for opencode only. This is what makes a
   * provider a candidate native gateway (`sonata init`'s native-model
   * screen): a native model is served by LiteLLM through a plain HTTP
   * endpoint, so only a provider whose endpoint opencode already knows can be
   * offered.
   */
  providerBaseUrls?: Record<string, string>;
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

// Well-known provider endpoints, merged from:
// - https://opencode.ai/docs/providers/ (opencode's built-in providers)
// - litellm.openai_compatible_endpoints (litellm's authoritative list)
// - https://docs.litellm.ai/docs/providers (litellm docs)
// Custom/self-hosted provider URLs are discovered from harness configs.
const WELL_KNOWN_PROVIDER_URLS: Record<string, string> = {
  // OpenAI ecosystem
  'openai': 'https://api.openai.com/v1',
  'openai-codex': 'https://api.openai.com/v1',
  'codex': 'https://api.openai.com/v1',

  // OpenCode's own gateways
  'opencode': 'https://api.opencode.ai/v1',
  'opencode-go': 'https://opencode.ai/zen/go/v1',

  // Major providers
  'anthropic': 'https://api.anthropic.com/v1',
  'deepseek': 'https://api.deepseek.com/v1',
  'google': 'https://generativelanguage.googleapis.com/v1beta',
  'mistral': 'https://api.mistral.ai/v1',
  'xai': 'https://api.x.ai/v1',
  'meta_llama': 'https://api.llama.com/compat/v1',

  // Aggregators / routers
  'openrouter': 'https://openrouter.ai/api/v1',

  // Inference providers
  'groq': 'https://api.groq.com/openai/v1',
  'together': 'https://api.together.xyz/v1',
  'together_ai': 'https://api.together.xyz/v1',
  'fireworks': 'https://api.fireworks.ai/inference/v1',
  'fireworks_ai': 'https://api.fireworks.ai/inference/v1',
  'cerebras': 'https://api.cerebras.ai/v1',
  'deep-infra': 'https://api.deepinfra.com/v1',
  'deepinfra': 'https://api.deepinfra.com/v1/openai',
  'sambanova': 'https://api.sambanova.ai/v1',
  'nebius': 'https://api.studio.nebius.ai/v1',
  'lambda_ai': 'https://api.lambda.ai/v1',
  'hyperbolic': 'https://api.hyperbolic.xyz/v1',
  'perplexity': 'https://api.perplexity.ai',
  'nvidia_nim': 'https://integrate.api.nvidia.com/v1',
  'featherless_ai': 'https://api.featherless.ai/v1',
  'novita': 'https://api.novita.ai/v3/openai',
  'nscale': 'https://inference.api.nscale.com/v1',

  // Other known providers
  'moonshot': 'https://api.moonshot.ai/v1',
  'dashscope': 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  'galadriel': 'https://api.galadriel.ai/v1',
  'friendliai': 'https://api.friendli.ai/serverless/v1',
  'chutes': 'https://llm.chutes.ai/v1',
  'empower': 'https://app.empower.dev/api/v1',
  'morph': 'https://api.morphllm.com/v1',
};

export function parseOpenCodeProviderBaseUrls(text: string): Record<string, string> {
  // Start with well-known defaults — opencode's built-in providers are not
  // listed in the config file at all, so iterating config entries alone misses
  // every standard provider.
  const out: Record<string, string> = { ...WELL_KNOWN_PROVIDER_URLS };
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    return out;
  }
  for (const [provider, def] of Object.entries<any>(parsed?.provider ?? {})) {
    const baseUrl = def?.options?.baseURL;
    if (typeof baseUrl === 'string' && baseUrl.trim() !== '') {
      out[provider] = baseUrl;
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
    const text = readFileSync(path, 'utf8');
    return text.includes('forwarding wrapper around the sonata runtime')
      || /^name:\s+native-[^\s]+/m.test(text);
  } catch {
    return false;
  }
}

/**
 * Deletes the named agent files, returning those actually removed.
 *
 * Takes an explicit list rather than recomputing, so the files shown to a user
 * are exactly the files deleted — there is no window in which the set changes
 * between the question and the deletion.
 */
export function pruneAgents(agentsDir: string, files: string[]): string[] {
  const removed: string[] = [];
  for (const f of files) {
    try {
      unlinkSync(join(agentsDir, f));
      removed.push(f);
    } catch {
      // Already gone. A concurrent sync is a race, not a failure.
    }
  }
  return removed;
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
  const configText = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  const named = configText === '' ? [] : parseOpenCodeModels(configText);
  for (const ref of refs) {
    ref.name = named.find((m) => m.provider === ref.provider && m.id === ref.id)?.name;
  }
  const providerBaseUrls = parseOpenCodeProviderBaseUrls(configText);

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
    providerBaseUrls,
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

/**
 * Codex, discovered through `codex app-server`'s `model/list`.
 *
 * Codex has no provider dimension, so every model lands under the single
 * pseudo-provider `codex`. An install that is present but not logged in lists
 * nothing, which is reported as a warning rather than an error: a machine with
 * only opencode is normal.
 */
export async function detectCodex(env: DetectEnv): Promise<HarnessStatus> {
  const version = await tryRun('codex', ['--version'], process.env);
  if (version === null) {
    return { name: 'codex', installed: false, supported: false, refs: [], authedProviders: [], problems: [] };
  }

  const listing = await codexModelList();
  const refs = listing === null ? [] : parseCodexModels(listing);
  const problems: Problem[] = [];
  if (refs.length === 0) {
    problems.push({
      severity: 'warn',
      message: 'codex is installed but listed no models',
      fix: 'codex login',
    });
  }

  return {
    name: 'codex',
    installed: true,
    version,
    supported: true,
    refs,
    // Codex has one account rather than per-provider auth; listing models at
    // all is the evidence that it is usable.
    authedProviders: refs.length > 0 ? ['codex'] : [],
    problems,
  };
}

/**
 * Reasonix, discovered through `reasonix doctor --json`.
 *
 * There is no `models` subcommand, but `doctor --json` carries the provider
 * catalogue and the per-provider key state in one call, so discovery and the
 * auth check are the same request. `parseReasonixRefs` drops providers without
 * a key, which is why an install that lists nothing is reported as a warning
 * rather than an error: a machine with only opencode is normal.
 */
export async function detectReasonix(_env: DetectEnv): Promise<HarnessStatus> {
  const version = await tryRun('reasonix', ['--version'], process.env);
  if (version === null) {
    return { name: 'reasonix', installed: false, supported: false, refs: [], authedProviders: [], problems: [] };
  }

  const json = await reasonixDoctorJson();
  const refs = json === null ? [] : parseReasonixRefs(json);
  const problems: Problem[] = [];
  if (refs.length === 0) {
    problems.push({
      severity: 'warn',
      message: 'reasonix is installed but no provider has a usable API key',
      fix: 'reasonix setup',
    });
  }

  return {
    name: 'reasonix',
    installed: true,
    version,
    supported: true,
    refs,
    // `key_present` has already filtered these, so every provider that survived
    // is one reasonix can actually run against.
    authedProviders: [...new Set(refs.map((r) => r.provider))],
    problems,
  };
}

export async function detectHarnesses(env: DetectEnv): Promise<HarnessStatus[]> {
  return Promise.all([detectOpenCode(env), detectPi(env), detectCodex(env), detectReasonix(env)]);
}

/** Where opencode keeps its own configuration. */
function opencodeConfigPath(home: string): string {
  return join(home, '.config', 'opencode', 'opencode.json');
}

function readOpencodeConfig(home: string): Record<string, any> | null {
  const path = opencodeConfigPath(home);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
  } catch {
    // opencode's config is not sonata's to repair. An unreadable one is
    // opencode's problem to report, not a reason for doctor to fail.
    return null;
  }
}

/**
 * Agents the user's opencode config switches off.
 *
 * A disabled agent is not an error opencode reports: `opencode run --agent
 * explore` falls back to the default agent with a warning in the pane that
 * nothing parses. A read-only role then runs under the write-capable `build`,
 * which is how sonata came to document an enforcement it did not have.
 */
export function disabledOpencodeAgents(home: string): string[] {
  const cfg = readOpencodeConfig(home);
  const agents = (cfg?.agent ?? {}) as Record<string, { disable?: boolean }>;
  return Object.entries(agents)
    .filter(([, v]) => v?.disable === true)
    .map(([name]) => name);
}

/**
 * Switches one opencode agent back on, returning whether anything changed.
 *
 * This writes another tool's configuration, so it changes exactly one field
 * and leaves the rest of the document alone. It never creates a config that
 * was not already there.
 */
export function enableOpencodeAgent(home: string, name: string): boolean {
  const path = opencodeConfigPath(home);
  const cfg = readOpencodeConfig(home);
  if (cfg === null) return false;
  if (cfg.agent?.[name]?.disable !== true) return false;

  cfg.agent[name].disable = false;
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`);
  return true;
}
