/**
 * Reading and safely amending Claude Code settings files.
 *
 * These files belong to the user and routinely contain unrelated hooks and
 * configuration. Every function here preserves unknown keys verbatim, and
 * installation is idempotent so re-running `sonata init` cannot accumulate
 * duplicate hook entries.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type HookScope = 'project' | 'global';

export interface HookCommand {
  type: 'command';
  command: string;
}

export interface HookEntry {
  matcher?: string;
  hooks: HookCommand[];
}

export type Settings = Record<string, unknown> & {
  hooks?: Record<string, HookEntry[]>;
};

export function settingsPath(scope: HookScope, cwd: string, home: string): string {
  return scope === 'global'
    ? join(home, '.claude', 'settings.json')
    : join(cwd, '.claude', 'settings.json');
}

export function readSettings(path: string): Settings {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf8').trim();
  if (raw.length === 0) return {};
  return JSON.parse(raw) as Settings;
}

/**
 * Writes settings, keeping a one-shot `.bak` of any pre-existing file. A bad
 * merge should always be recoverable by hand.
 */
export function writeSettings(path: string, settings: Settings): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) copyFileSync(path, `${path}.bak`);
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}

export function hookInstalled(settings: Settings, command: string, event = 'PreToolUse'): boolean {
  return (settings.hooks?.[event] ?? []).some((entry) =>
    entry.hooks.some((h) => h.command === command),
  );
}

/**
 * Adds the hook as its own matcher entry, leaving every existing entry — and
 * every unrelated top-level key — untouched. Returns `changed: false` when the
 * exact command is already present.
 */
export function installHook(
  settings: Settings,
  command: string,
  matcher = 'Bash',
  event = 'PreToolUse',
): { settings: Settings; changed: boolean } {
  if (hookInstalled(settings, command, event)) {
    return { settings, changed: false };
  }

  const next: Settings = { ...settings };
  const hooks: Record<string, HookEntry[]> = { ...(settings.hooks ?? {}) };
  const entries: HookEntry[] = [...(hooks[event] ?? [])];

  entries.push({ matcher, hooks: [{ type: 'command', command }] });
  hooks[event] = entries;
  next.hooks = hooks;

  return { settings: next, changed: true };
}

export function uninstallHook(
  settings: Settings,
  command: string,
  event = 'PreToolUse',
): { settings: Settings; changed: boolean } {
  const entries = settings.hooks?.[event];
  if (!entries) return { settings, changed: false };

  const pruned = entries
    .map((entry) => ({ ...entry, hooks: entry.hooks.filter((h) => h.command !== command) }))
    .filter((entry) => entry.hooks.length > 0);

  if (pruned.length === entries.length) return { settings, changed: false };

  const hooks = { ...settings.hooks };
  if (pruned.length === 0) delete hooks[event];
  else hooks[event] = pruned;

  const next: Settings = { ...settings, hooks };
  if (Object.keys(hooks).length === 0) delete next.hooks;
  return { settings: next, changed: true };
}

/** The command string sonata installs, pointing at this installation's hook. */
export function hookCommand(packageRoot: string): string {
  return `node ${JSON.stringify(join(packageRoot, 'hooks', 'capture-mode.mjs'))}`;
}
