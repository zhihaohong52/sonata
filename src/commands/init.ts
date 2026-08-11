/**
 * `sonata init` — first-run onboarding and repair.
 *
 * Interactive by default; every choice also has a flag so the command works in
 * CI and scripts. Nothing is written until the user confirms the summary.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KNOWN_ROLES, parseConfig } from '../config.js';
import type { ModelRef } from '../types.js';
import {
  detectTmux, detectOpenCode, staleAgents,
  type Problem, type OpenCodeModel, type HarnessStatus, type DetectEnv,
} from '../detect.js';
import {
  settingsPath, readSettings, writeSettings, installHook,
  hookInstalled, hookCommand, type HookScope,
} from '../settings.js';
import { cmdSync } from './sync.js';
import { multiselect, select, confirm, isInteractive, CancelledError } from '../tui.js';

const OPENCODE_RANGE = '>=1.18.0 <2.0.0';

export interface Detection {
  tmux: { installed: boolean; version?: string; problems: Problem[] };
  oc: HarnessStatus;
}

export type Detector = (env: DetectEnv) => Promise<Detection>;

/** Real environment probe. Tests inject a substitute so they stay hermetic. */
export const defaultDetector: Detector = async (env) => ({
  tmux: await detectTmux(),
  oc: await detectOpenCode(env),
});

export interface InitOptions {
  cwd: string;
  home: string;
  packageRoot: string;
  /** Non-interactive overrides. When `yes` is set, no prompts are shown. */
  yes?: boolean;
  models?: string[];
  roles?: string[];
  scope?: HookScope | 'skip';
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

/**
 * Model ids carry version dots — `grok-4.5`, `gpt-5.6-sol` — and a dot is TOML's
 * key separator, so a bare `[models.grok-4.5]` nests as models → "grok-4" → "5"
 * and stops describing the model it names. Quoting makes it one literal key.
 */
function tomlKey(id: string): string {
  return `"${id.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function tomlFor(models: OpenCodeModel[], chosen: string[], roles: string[]): string {
  const lines: string[] = [];
  for (const id of chosen) {
    const m = models.find((x) => x.id === id);
    lines.push(`[models.${tomlKey(id)}]`, 'harness = "opencode"', `id = "${m?.id ?? id}"`, '');
  }
  lines.push(
    '[generate]',
    `roles = [${roles.map((r) => `"${r}"`).join(', ')}]`,
    `models = [${chosen.map((m) => `"${m}"`).join(', ')}]`,
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
  out('  sonata init');
  out('');

  // ---- detect -----------------------------------------------------------
  const detect = opts.detect ?? defaultDetector;
  const { tmux, oc } = await detect({ home: opts.home, supportedVersions: OPENCODE_RANGE });
  const problems: Problem[] = [...tmux.problems, ...oc.problems];

  out(tmux.installed ? `  ✓ tmux ${tmux.version}` : '  ✗ tmux not found');
  out(oc.installed
    ? `  ✓ opencode ${oc.version} · ${oc.models.length} models · ${oc.authedProviders.length} authed provider(s)`
    : '  ✗ opencode not found');
  out('');

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

  // ---- choose models ----------------------------------------------------
  const configText = existsSync(join(opts.cwd, 'sonata.toml'))
    ? readFileSync(join(opts.cwd, 'sonata.toml'), 'utf8')
    : '';
  const preTicked = new Set<string>(preTickedRefs(configText, []));
  let models: string[];

  if (opts.models) {
    models = opts.models;
  } else if (interactive) {
    models = await multiselect(
      'Models to enable',
      oc.models.map((m) => ({
        value: m.id,
        label: m.id,
        hint: m.name,
        checked: preTicked.has(m.id),
      })),
    );
  } else {
    models = [...preTicked];
  }

  const unknown = models.filter((m) => !oc.models.some((x) => x.id === m));
  if (unknown.length > 0) {
    throw new Error(
      `sonata init: opencode does not offer ${unknown.join(', ')}. ` +
      `Available: ${oc.models.map((m) => m.id).join(', ')}`,
    );
  }
  if (models.length === 0) {
    throw new Error('sonata init: no models selected — nothing to generate.');
  }

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
  const configPath = join(opts.cwd, 'sonata.toml');
  out('');
  out('  Summary');
  out(`    models  ${models.join(', ')}`);
  out(`    roles   ${roles.join(', ')}`);
  out(`    agents  ${roles.length * models.length} files in .claude/agents/`);
  out(`    hook    ${scope === 'skip' ? 'not installed' : `${scope} settings.json`}`);
  out(`    config  ${configPath}`);
  out('');

  if (interactive && !(await confirm('Write these changes?', true))) {
    out('  Nothing written.');
    return {
      problems, models, roles, scope, hookChanged: false,
      agentsWritten: [], configPath, cancelled: true,
    };
  }

  // ---- write ------------------------------------------------------------
  writeFileSync(configPath, tomlFor(oc.models, models, roles));
  out(`  ✓ wrote ${configPath}`);

  let hookChanged = false;
  if (scope !== 'skip') {
    const path = settingsPath(scope, opts.cwd, opts.home);
    const result = installHook(readSettings(path), command);
    if (result.changed) writeSettings(path, result.settings);
    hookChanged = result.changed;
    out(result.changed ? `  ✓ installed hook in ${path}` : `  · hook already present in ${path}`);
  }

  const agentsDir = join(opts.cwd, '.claude', 'agents');
  const agentsWritten = cmdSync({ cwd: opts.cwd, agentsDir });
  out(`  ✓ generated ${agentsWritten.length} agents in ${agentsDir}`);

  const expected = roles.flatMap((r) => models.map((m) => `${r}-${m}`));
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

  return { problems, models, roles, scope, hookChanged, agentsWritten, configPath };
}

export function isCancellation(err: unknown): boolean {
  return err instanceof CancelledError;
}
