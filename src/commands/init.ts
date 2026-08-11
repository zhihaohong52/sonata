/**
 * `sonata init` — first-run onboarding and repair.
 *
 * Interactive by default; every choice also has a flag so the command works in
 * CI and scripts. Nothing is written until the user confirms the summary.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { KNOWN_ROLES, configPath, GLOBAL_CONFIG_RELATIVE, parseConfig } from '../config.js';
import type { ModelRef } from '../types.js';
import {
  detectTmux, detectHarnesses, offerableProviders, staleAgents,
  type Problem, type HarnessStatus, type DetectEnv,
} from '../detect.js';
import {
  settingsPath, readSettings, writeSettings, installHook,
  hookInstalled, hookCommand, type HookScope,
} from '../settings.js';
import { cmdSync } from './sync.js';
import { multiselect, select, confirm, isInteractive, banner, CancelledError } from '../tui.js';

const OPENCODE_RANGE = '>=1.18.0 <2.0.0';

export interface Detection {
  tmux: { installed: boolean; version?: string; problems: Problem[] };
  harnesses: HarnessStatus[];
}

export type Detector = (env: DetectEnv) => Promise<Detection>;

/** Real environment probe. Tests inject a substitute so they stay hermetic. */
export const defaultDetector: Detector = async (env) => ({
  tmux: await detectTmux(),
  harnesses: await detectHarnesses(env),
});

export type ConfigScope = 'project' | 'global';

/**
 * Where a config is written for a scope. The read-side counterpart is
 * `configPath`, which resolves a precedence chain; this picks one location.
 */
export function configPathFor(scope: ConfigScope, cwd: string, home: string): string {
  return scope === 'global'
    ? join(home, GLOBAL_CONFIG_RELATIVE)
    : join(cwd, 'sonata.toml');
}

/**
 * Agents follow the config's scope. Keeping them together is the whole point:
 * `init` in $HOME used to write agents globally and config where only $HOME
 * could read it, producing agents that were offered everywhere and worked
 * nowhere.
 */
export function agentsDirFor(scope: ConfigScope, cwd: string, home: string): string {
  return scope === 'global'
    ? join(home, '.claude', 'agents')
    : join(cwd, '.claude', 'agents');
}

export interface InitOptions {
  cwd: string;
  home: string;
  packageRoot: string;
  /** Non-interactive overrides. When `yes` is set, no prompts are shown. */
  yes?: boolean;
  /** Picker keys, `harness/provider`. Non-interactive override. */
  providers?: string[];
  models?: string[];
  roles?: string[];
  scope?: HookScope | 'skip';
  /** Where the config and its agents are written. Defaults to `project`. */
  configScope?: ConfigScope;
  write?: (line: string) => void;
  detect?: Detector;
}

export interface InitResult {
  problems: Problem[];
  models: string[];
  roles: string[];
  scope: HookScope | 'skip';
  hookChanged: boolean;
  agentsWritten: string[];
  configPath: string;
  cancelled?: boolean;
}

function renderProblem(p: Problem): string {
  const icon = p.severity === 'error' ? '✗' : p.severity === 'warn' ? '!' : 'ℹ';
  const fix = p.fix ? `\n      ❯ ${p.fix}` : '';
  return `  ${icon} ${p.message}${fix}`;
}

export interface ConfigEntry { harness: string; id: string }

/**
 * Entries the wizard does not manage, and so must not delete.
 *
 * `init` overwrites sonata.toml wholesale. Codex models are added by hand —
 * the README says so — which makes the wizard the only thing that can destroy
 * them.
 */
export function carriedEntries(
  configText: string,
  managed: string[],
): Record<string, ConfigEntry> {
  let models: Record<string, ConfigEntry>;
  try {
    models = parseConfig(configText).models;
  } catch {
    return {};
  }

  const kept: Record<string, ConfigEntry> = {};
  for (const [key, entry] of Object.entries(models)) {
    if (!managed.includes(entry.harness)) kept[key] = entry;
  }
  return kept;
}

const TOML_ESCAPES: Record<string, string> = {
  '\\': '\\\\', '"': '\\"', '\b': '\\b', '\t': '\\t',
  '\n': '\\n', '\f': '\\f', '\r': '\\r',
};

/**
 * A TOML basic string, used for every key and value this file writes.
 *
 * An unquoted dotted key nests and corrupts the table, and a raw control
 * character makes the document unreadable. Both matter because carried
 * entries are user-authored: a hand-written id containing a newline once
 * produced a config that no longer parsed, destroying the very entry
 * carrying-forward exists to preserve.
 */
function tomlKey(key: string): string {
  // eslint-disable-next-line no-control-regex
  const escaped = key.replace(/[\\"\u0000-\u001f\u007f]/g, (ch) =>
    TOML_ESCAPES[ch] ?? `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `"${escaped}"`;
}

export function tomlFor(
  refs: ModelRef[],
  roles: string[],
  carried: Record<string, ConfigEntry>,
): string {
  const entries: [string, ConfigEntry][] = [
    ...refs.map((r): [string, ConfigEntry] =>
      [configKeyFor(r), { harness: r.harness, id: r.ref }]),
    ...Object.entries(carried),
  ];

  // TOML forbids two tables with the same name, and flattening is not
  // injective. cmdInit checks this first and reports it kindly; this guard
  // makes it impossible for any caller to emit a document that cannot be read
  // back.
  const clashes = duplicateKeys(entries.map(([k]) => k));
  if (clashes.length > 0) {
    throw new Error(
      `sonata: ${clashes.join(', ')} would name two different models. ` +
      'Rename the hand-written entry, or enable only one of the colliding refs.',
    );
  }

  const lines: string[] = [];
  for (const [key, entry] of entries) {
    lines.push(
      `[models.${tomlKey(key)}]`,
      `harness = ${tomlKey(entry.harness)}`,
      `id = ${tomlKey(entry.id)}`,
      '',
    );
  }
  lines.push(
    '[generate]',
    `roles = [${roles.map(tomlKey).join(', ')}]`,
    // Every one of these must go through tomlKey, not just the table header.
    // Carried keys are user-authored and can contain a quote; escaping the
    // header alone produced a config that no longer parsed, destroying the
    // hand-written entry this function exists to preserve.
    `models = [${entries.map(([k]) => tomlKey(k)).join(', ')}]`,
    '',
    '[run]',
    'tail_window_seconds = 20',
    'stall_timeout_seconds = 120',
    'run_timeout_seconds = 1800',
    '',
  );
  return lines.join('\n');
}

/**
 * Refs already enabled, for pre-ticking.
 *
 * Matching is on `(harness, id)` rather than on the config key: a key is a
 * name the user or an older sonata chose, while the ref states what was
 * actually meant. This is what lets a hand-written pi entry pre-tick despite
 * a key the wizard would never generate.
 *
 * An unparseable config pre-ticks nothing rather than throwing — `init` must
 * be able to repair a broken file, which is half its purpose.
 */
export function preTickedRefs(configText: string, refs: ModelRef[]): Set<string> {
  let models: Record<string, { harness: string; id: string }>;
  try {
    models = parseConfig(configText).models;
  } catch {
    return new Set();
  }

  const enabled = new Set<string>();
  for (const entry of Object.values(models)) {
    for (const ref of refs) {
      if (ref.harness === entry.harness && ref.ref === entry.id) enabled.add(ref.ref);
    }
  }
  return enabled;
}

/**
 * The config key is also the agent filename (`code-<key>.md`), so it cannot
 * contain `/`. The harness segment is load-bearing rather than decorative: pi
 * and opencode can serve the identical ref, and without it those two
 * selections would overwrite each other.
 */
export function configKeyFor(ref: ModelRef): string {
  return `${ref.harness}-${ref.ref}`.replace(/\//g, '-');
}

/**
 * Keys claimed more than once.
 *
 * Flattening is not injective, because provider names contain dashes too:
 * `opencode/go-x` and `opencode-go/x` both yield `opencode-go-x`. No pair in
 * the current catalogue collides, but it is served rather than static, so it
 * cannot be assumed away.
 */
export function duplicateKeys(keys: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const k of keys) {
    if (seen.has(k)) dupes.add(k);
    seen.add(k);
  }
  return [...dupes].sort();
}

export async function cmdInit(opts: InitOptions): Promise<InitResult> {
  const out = opts.write ?? ((l: string) => console.log(l));
  const interactive = !opts.yes && isInteractive();

  out('');
  // Decoration is for a person watching. Under --yes the output is being
  // scripted or logged, so it stays plain.
  out(interactive ? banner() : '  sonata init');
  out('');

  // ---- detect -----------------------------------------------------------
  const detect = opts.detect ?? defaultDetector;
  const { tmux, harnesses } = await detect({ home: opts.home, supportedVersions: OPENCODE_RANGE });
  const problems: Problem[] = [...tmux.problems, ...harnesses.flatMap((h) => h.problems)];

  out(tmux.installed ? `  ✓ tmux ${tmux.version}` : '  ✗ tmux not found');
  for (const h of harnesses) {
    out(h.installed
      ? `  ✓ ${h.name} ${h.version} · ${h.refs.length} models`
      : `  · ${h.name} not installed`);
  }
  out('');

  const allRefs = harnesses.flatMap((h) => h.refs);
  const authed = harnesses.flatMap((h) => h.authedProviders);
  const offered = offerableProviders(allRefs, authed);

  if (offered.length === 0) {
    problems.push({
      severity: 'error',
      message: 'no harness reported a usable model provider',
      fix: 'opencode auth login',
    });
  }

  const blocking = problems.filter((p) => p.severity === 'error');
  if (blocking.length > 0) {
    for (const p of problems) out(renderProblem(p));
    out('');
    out('  Fix the errors above, then run `sonata init` again.');
    return {
      problems, models: [], roles: [], scope: 'skip', hookChanged: false,
      agentsWritten: [], configPath: join(opts.cwd, 'sonata.toml'),
    };
  }
  for (const p of problems) out(renderProblem(p));

  let configScope: ConfigScope;
  if (opts.configScope) {
    configScope = opts.configScope;
  } else if (interactive) {
    out('');
    configScope = await select<ConfigScope>('Where should this config apply', [
      { value: 'project', label: 'This project only', hint: './sonata.toml + ./.claude/agents/' },
      { value: 'global', label: 'All projects', hint: '~/.config/sonata/ + ~/.claude/agents/' },
    ]);
  } else {
    configScope = 'project';
  }

  // Read the file that is about to be overwritten, not whichever one merely
  // resolves. Choosing `global` in a repo that has its own sonata.toml would
  // otherwise carry that repo's hand-written entries into the machine config
  // and pre-tick from a file the user is not editing — which is why the scope
  // is asked before anything is read.
  const configPathResolved = configPathFor(configScope, opts.cwd, opts.home);
  const configText = existsSync(configPathResolved)
    ? readFileSync(configPathResolved, 'utf8')
    : '';
  const enabled = preTickedRefs(configText, allRefs);

  // ---- choose providers -------------------------------------------------
  let providerKeys: string[];
  if (opts.providers) {
    providerKeys = opts.providers;
  } else if (interactive) {
    providerKeys = await multiselect(
      'Providers',
      offered.map((p) => ({
        value: p.key,
        label: `${p.harness} · ${p.provider}`,
        hint: `${p.count} models`,
        checked: allRefs.some((r) => `${r.harness}/${r.provider}` === p.key && enabled.has(r.ref)),
      })),
    );
  } else {
    providerKeys = offered
      .filter((p) => allRefs.some((r) => `${r.harness}/${r.provider}` === p.key && enabled.has(r.ref)))
      .map((p) => p.key);
  }

  const unknownProviders = providerKeys.filter((k) => !offered.some((p) => p.key === k));
  if (unknownProviders.length > 0) {
    throw new Error(
      `sonata init: no harness offers ${unknownProviders.join(', ')}. ` +
      `Available: ${offered.map((p) => p.key).join(', ')}`,
    );
  }

  const inScope = allRefs.filter((r) => providerKeys.includes(`${r.harness}/${r.provider}`));

  // ---- choose models ----------------------------------------------------
  let keys: string[];
  if (opts.models) {
    keys = opts.models;
  } else if (interactive) {
    keys = await multiselect(
      'Models to enable',
      inScope.map((r) => ({
        value: configKeyFor(r),
        label: r.ref,
        hint: r.name,
        checked: enabled.has(r.ref),
      })),
    );
  } else {
    keys = inScope.filter((r) => enabled.has(r.ref)).map(configKeyFor);
  }

  const byKey = new Map(inScope.map((r) => [configKeyFor(r), r]));
  const unknown = keys.filter((k) => !byKey.has(k));
  if (unknown.length > 0) {
    throw new Error(
      `sonata init: the selected providers do not offer ${unknown.join(', ')}. ` +
      `Available: ${[...byKey.keys()].join(', ')}`,
    );
  }
  if (keys.length === 0) {
    throw new Error('sonata init: no models selected — nothing to generate.');
  }

  const chosen = keys.map((k) => byKey.get(k)!);

  // ---- choose roles -----------------------------------------------------
  let roles: string[];
  if (opts.roles) {
    roles = opts.roles;
  } else if (interactive) {
    roles = await multiselect(
      'Roles to generate',
      KNOWN_ROLES.map((r) => ({ value: r as string, label: r, checked: true })),
    );
  } else {
    roles = [...KNOWN_ROLES];
  }

  const badRoles = roles.filter((r) => !KNOWN_ROLES.includes(r as never));
  if (badRoles.length > 0) {
    throw new Error(`sonata init: unknown role(s) ${badRoles.join(', ')}`);
  }
  if (roles.length === 0) {
    throw new Error('sonata init: no roles selected — nothing to generate.');
  }

  // ---- config scope -----------------------------------------------------

  // ---- hook scope -------------------------------------------------------
  const command = hookCommand(opts.packageRoot);
  const alreadyGlobal = hookInstalled(readSettings(settingsPath('global', opts.cwd, opts.home)), command);
  const alreadyProject = hookInstalled(readSettings(settingsPath('project', opts.cwd, opts.home)), command);

  let scope: HookScope | 'skip';
  if (opts.scope) {
    scope = opts.scope;
  } else if (alreadyGlobal || alreadyProject) {
    out('');
    out(`  ✓ permission hook already installed (${alreadyGlobal ? 'global' : 'project'})`);
    scope = 'skip';
  } else if (interactive) {
    out('');
    scope = await select<HookScope | 'skip'>('Install the permission hook', [
      { value: 'project', label: 'This project only', hint: 'no effect on your other repos' },
      { value: 'global', label: 'All projects', hint: 'adds ~40ms per Bash call everywhere' },
      { value: 'skip', label: 'Skip', hint: 'sonata assumes default mode' },
    ]);
  } else {
    scope = 'project';
  }

  // ---- confirm ----------------------------------------------------------
  out('');
  out('  Summary');
  out(`    models  ${chosen.map((r) => r.ref).join(', ')}`);
  out(`    roles   ${roles.join(', ')}`);
  out(`    agents  ${roles.length * keys.length} files in .claude/agents/`);
  out(`    hook    ${scope === 'skip' ? 'not installed' : `${scope} settings.json`}`);
  out(`    config  ${configPathResolved}`);
  out('');

  if (interactive && !(await confirm('Write these changes?', true))) {
    out('  Nothing written.');
    return {
      problems, models: keys, roles, scope, hookChanged: false,
      agentsWritten: [], configPath: configPathResolved, cancelled: true,
    };
  }

  // ---- write ------------------------------------------------------------
  const carried = carriedEntries(configText, ['opencode', 'pi']);
  const clashes = duplicateKeys([...keys, ...Object.keys(carried)]);
  if (clashes.length > 0) {
    throw new Error(
      `sonata init: ${clashes.join(', ')} would name two different models. ` +
      'Rename the hand-written entry, or enable only one of the colliding refs.',
    );
  }
  mkdirSync(dirname(configPathResolved), { recursive: true });
  writeFileSync(configPathResolved, tomlFor(chosen, roles, carried));
  out(`  ✓ wrote ${configPathResolved}`);

  let hookChanged = false;
  if (scope !== 'skip') {
    const path = settingsPath(scope, opts.cwd, opts.home);
    const result = installHook(readSettings(path), command);
    if (result.changed) writeSettings(path, result.settings);
    hookChanged = result.changed;
    out(result.changed ? `  ✓ installed hook in ${path}` : `  · hook already present in ${path}`);
  }

  const agentsDir = agentsDirFor(configScope, opts.cwd, opts.home);
  const agentsWritten = cmdSync({ cwd: opts.cwd, home: opts.home, agentsDir });
  out(`  ✓ generated ${agentsWritten.length} agents in ${agentsDir}`);

  const expected = roles.flatMap((r) => keys.map((k) => `${r}-${k}`));
  const stale = staleAgents(agentsDir, expected);
  if (stale.length > 0) {
    out('');
    out(`  ! ${stale.length} stale agent file(s) no longer in your config:`);
    for (const f of stale) out(`      ${f}`);
    out('      ❯ delete them by hand, or re-run after removing them');
  }

  out('');
  out('  Done. Restart Claude Code for the new agents to appear.');
  out('');

  return { problems, models: keys, roles, scope, hookChanged, agentsWritten, configPath: configPathResolved };
}

export function isCancellation(err: unknown): boolean {
  return err instanceof CancelledError;
}
