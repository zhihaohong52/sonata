/**
 * `sonata reset` — undo what `sonata init` wrote, and nothing else.
 *
 * Init scatters its output across five places: the config, the generated tier
 * agents, the loop skill, a block inside a `CLAUDE.md` sonata does not own,
 * and two settings files holding the routing env, four lifecycle hooks, the
 * permission hook and the tool allow-list. Undoing that by hand means knowing
 * all five, which is why the only reliable answer used to be "delete the repo
 * and start again".
 *
 * Three rules shape the whole command:
 *
 * - **It removes only what sonata wrote.** An agent file without sonata's
 *   marker is left alone; `permissions.allow` keeps every entry that is not
 *   sonata's; `CLAUDE.md` loses what is between the markers and not one byte
 *   more. A settings file is rewritten, never deleted — sonata is one writer
 *   of it among several.
 * - **It keeps everything that is expensive to recreate**: API keys, the usage
 *   ledger, the ranking catalogs, and the `.sonata/` run store. Those are not
 *   configuration, and a user resetting a bad setup should not lose their
 *   spend history or have to re-enter every key. The kept list is printed, so
 *   "reset" cannot be read as "removed everything".
 * - **It plans first, then applies.** The plan is a list of typed actions with
 *   a label each, so the confirmation names every path before anything is
 *   touched, and the set shown is exactly the set removed.
 */
import { existsSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GLOBAL_CONFIG_RELATIVE } from '../config.js';
import { isSonataAgent } from '../detect.js';
import { agentsDirFor, configPathFor } from '../init/helpers.js';
import { removeGuidance } from '../init/guidance.js';
import {
  readSettings, revokeSonataTools, settingsPath, uninstallHook, writeSettings, type Settings,
} from '../settings.js';
import { planRouteManual, planRouteOff, routeSessionsFile, routeSettingsFile, routeSubagentsFile } from './route.js';

export type ResetScope = 'project' | 'global';

export type ResetAction =
  | { kind: 'delete-file'; label: string; path: string }
  | { kind: 'delete-dir'; label: string; path: string }
  | { kind: 'delete-agents'; label: string; dir: string; files: string[] }
  | { kind: 'write-file'; label: string; path: string; content: string }
  | { kind: 'write-settings'; label: string; path: string; settings: Settings };

export interface ResetPlan {
  scope: ResetScope;
  actions: ResetAction[];
  /** What this deliberately does not touch, named so silence cannot be read as loss. */
  kept: string[];
  /** Things sonata declined to change, with the reason. Never fatal. */
  warnings: string[];
}

export interface ResetOptions {
  cwd: string;
  home: string;
  packageRoot: string;
  scope?: ResetScope;
}

/** The agent files in this directory that sonata generated. */
function sonataAgents(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .filter((f) => isSonataAgent(join(dir, f)))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Strip sonata out of one settings file.
 *
 * Every transform is by command *shape* rather than by this install's own
 * path: a user who ran `sonata init` from a different checkout — an npm
 * install now replaced by a clone, say — would otherwise have their hooks left
 * behind by the very command whose job is removing them. `planRouteOff` can
 * refuse (a non-localhost base URL it did not write), and that refusal must
 * not take the rest of the file down with it, so it is caught and reported.
 */
export function planSettingsReset(
  settings: Settings,
  packageRoot: string,
  scope: ResetScope,
): { settings: Settings; changed: boolean; warnings: string[] } {
  let next = settings;
  let changed = false;
  const warnings: string[] = [];

  try {
    const off = planRouteOff(next, packageRoot);
    next = off.settings;
    changed = changed || off.changed;
  } catch (err) {
    warnings.push(`left the routing env in place: ${(err as Error).message}`);
  }

  const manual = planRouteManual(next, packageRoot, scope);
  next = manual.settings;
  changed = changed || manual.changed;

  // The permission hook is found by the file it runs, not by this install's
  // absolute path, for the same reason `planRouteOff` finds its own that way.
  for (const [event, needle] of [
    ['PreToolUse', 'capture-mode.mjs'],
    ['SessionStart', 'ensure-serve.mjs'],
    ['SessionStart', 'route-session.mjs'],
    ['SessionEnd', 'route-session.mjs'],
    ['SubagentStart', 'route-subagent.mjs'],
    ['SubagentStop', 'route-subagent.mjs'],
  ] as const) {
    for (;;) {
      const command = (next.hooks?.[event] ?? [])
        .flatMap((entry) => entry.hooks)
        .find((h) => h.command.includes(needle))?.command;
      if (command === undefined) break;
      const removed = uninstallHook(next, command, event);
      next = removed.settings;
      changed = changed || removed.changed;
      // `uninstallHook` matches by exact command, so a second install's copy
      // of the same hook survives the first pass. Without this guard, a
      // no-op removal would also spin here forever.
      if (!removed.changed) break;
    }
  }

  const revoked = revokeSonataTools(next);
  next = revoked.settings;
  changed = changed || revoked.changed;

  return { settings: next, changed, warnings };
}

/**
 * What `sonata reset` would do, without doing any of it.
 *
 * Reads the filesystem — the plan has to name real paths — but writes nothing,
 * so it doubles as the dry run behind the confirmation prompt.
 */
export function planReset(opts: ResetOptions): ResetPlan {
  const scope: ResetScope = opts.scope ?? 'project';
  const { cwd, home, packageRoot } = opts;
  const base = scope === 'global' ? home : cwd;
  const actions: ResetAction[] = [];
  const warnings: string[] = [];

  const configPath = configPathFor(scope, cwd, home);
  if (existsSync(configPath)) {
    actions.push({ kind: 'delete-file', label: 'config', path: configPath });
  }

  const agentsDir = agentsDirFor(scope, cwd, home);
  const agents = sonataAgents(agentsDir);
  if (agents.length > 0) {
    actions.push({
      kind: 'delete-agents',
      label: `${agents.length} generated agent${agents.length === 1 ? '' : 's'}`,
      dir: agentsDir,
      files: agents,
    });
  }

  const skillDir = join(base, '.claude', 'skills', 'sonata-loop');
  if (existsSync(skillDir)) {
    actions.push({ kind: 'delete-dir', label: 'sonata-loop skill', path: skillDir });
  }

  // The CLAUDE.md block is the one artifact in a file sonata does not own, so
  // it is spliced out rather than the file being removed — and a file whose
  // markers do not pair up is left entirely alone, with the reason reported.
  const guidancePath = scope === 'global'
    ? join(home, '.claude', 'CLAUDE.md')
    : join(cwd, 'CLAUDE.md');
  if (existsSync(guidancePath)) {
    try {
      const existing = readFileSync(guidancePath, 'utf8');
      const without = removeGuidance(existing);
      if (without !== undefined) {
        actions.push({
          kind: 'write-file', label: 'the sonata block in CLAUDE.md', path: guidancePath, content: without,
        });
      }
    } catch (err) {
      warnings.push(`left ${guidancePath} unchanged: ${(err as Error).message}`);
    }
  }

  // Project scope writes routing into `settings.local.json` and the permission
  // hook into `settings.json`; global scope puts both in one file. Deduplicated
  // so the same file is never planned twice.
  const settingsFiles = [...new Set([
    routeSettingsFile(cwd, scope, home),
    settingsPath(scope, cwd, home),
  ])];
  for (const path of settingsFiles) {
    if (!existsSync(path)) continue;
    const current = readSettings(path);
    const stripped = planSettingsReset(current, packageRoot, scope);
    warnings.push(...stripped.warnings);
    if (stripped.changed) {
      actions.push({
        kind: 'write-settings', label: 'routing, hooks and the tool allow-list', path, settings: stripped.settings,
      });
    }
  }

  for (const path of [routeSessionsFile(cwd, scope, home), routeSubagentsFile(cwd, scope, home)]) {
    if (existsSync(path)) {
      actions.push({ kind: 'delete-file', label: 'routed-session registry', path });
    }
  }

  return {
    scope,
    actions,
    kept: [
      `gateway keys (${join(home, '.config', 'sonata', 'credentials')}) — \`sonata auth list\``,
      `the usage ledger (${join(home, '.config', 'sonata', 'usage')}) — \`sonata usage\``,
      'the ranking and pricing caches',
      scope === 'global'
        ? `any project's own sonata.toml`
        : `the machine config (${join(home, GLOBAL_CONFIG_RELATIVE)})`,
    ],
    warnings,
  };
}

/** The plan as the lines a user is asked to approve. */
export function describeReset(plan: ResetPlan): string[] {
  const lines: string[] = [];
  if (plan.actions.length === 0) {
    lines.push(`  nothing to remove — no sonata ${plan.scope} setup found`);
  } else {
    lines.push(`  sonata reset (${plan.scope}) will remove:`);
    for (const action of plan.actions) {
      lines.push(`    ${action.kind === 'write-settings' || action.kind === 'write-file' ? '~' : '-'} ${action.label}`);
      if (action.kind === 'delete-agents') {
        for (const f of action.files.slice(0, 5)) lines.push(`        ${join(action.dir, f)}`);
        if (action.files.length > 5) lines.push(`        … and ${action.files.length - 5} more`);
      } else {
        lines.push(`        ${action.path}`);
      }
    }
    lines.push('');
    lines.push('  it keeps:');
    for (const k of plan.kept) lines.push(`    · ${k}`);
  }
  for (const w of plan.warnings) lines.push(`    ! ${w}`);
  return lines;
}

/** Carry out a plan. Returns the paths actually changed. */
export function applyReset(plan: ResetPlan): string[] {
  const touched: string[] = [];
  for (const action of plan.actions) {
    switch (action.kind) {
      case 'delete-file':
        try { unlinkSync(action.path); touched.push(action.path); } catch { /* already gone */ }
        break;
      case 'delete-dir':
        rmSync(action.path, { recursive: true, force: true });
        touched.push(action.path);
        break;
      case 'delete-agents':
        for (const f of action.files) {
          const path = join(action.dir, f);
          try { unlinkSync(path); touched.push(path); } catch { /* already gone */ }
        }
        break;
      case 'write-file':
        writeFileSync(action.path, action.content);
        touched.push(action.path);
        break;
      case 'write-settings':
        writeSettings(action.path, action.settings);
        touched.push(action.path);
        break;
    }
  }
  return touched;
}

export interface ResetIo {
  out: (line: string) => void;
  /** Asked once, with the full plan already on screen. */
  confirm: (question: string) => Promise<boolean>;
}

export async function cmdReset(opts: ResetOptions & { yes?: boolean }, io: ResetIo): Promise<number> {
  const plan = planReset(opts);
  for (const line of describeReset(plan)) io.out(line);
  if (plan.actions.length === 0) return 0;

  io.out('');
  if (!opts.yes && !await io.confirm('Remove these?')) {
    io.out('  · nothing removed');
    return 1;
  }

  const touched = applyReset(plan);
  io.out(`  ✓ removed ${touched.length} path${touched.length === 1 ? '' : 's'}`);
  io.out('    ❯ run `sonata init` to set up again');
  return 0;
}
