/**
 * Reading and safely amending Claude Code settings files.
 *
 * These files belong to the user and routinely contain unrelated hooks and
 * configuration. Every function here preserves unknown keys verbatim, and
 * installation is idempotent so re-running `sonata init` cannot accumulate
 * duplicate hook entries.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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
  permissions?: { allow?: string[]; [k: string]: unknown };
};

/**
 * The three MCP tools a sonata wrapper is given.
 *
 * These must be on the allow list, not left to Claude Code's `auto` mode
 * classifier. The classifier judges each call separately and its decisions are
 * not stable across calls: on 2026-08-12 a wrapper had `run` allowed and `tail`
 * allowed twice, then denied twice mid-run — "Blocked by classifier" — which
 * left a foreign model writing to the repository with nothing able to observe
 * it. (`run` and `tail` were the tool names then; `dispatch` and `wait`
 * replaced them when polling did.)
 *
 * The shape of that failure changed but did not go away. `dispatch` both
 * executes and reads back, so it can no longer be permitted while the
 * read-back is blocked — but a denied `wait` still strands a paused run
 * unobserved, which is the same hazard with a smaller blast radius.
 */
export const SONATA_TOOLS = [
  'mcp__sonata__dispatch',
  'mcp__sonata__wait',
  'mcp__sonata__approve',
];

/** Which of the sonata tools are missing from `permissions.allow`. */
export function missingAllowEntries(settings: Settings): string[] {
  const allow = settings.permissions?.allow ?? [];
  return SONATA_TOOLS.filter((t) => !allow.includes(t));
}

/**
 * Adds the sonata tools to `permissions.allow`, preserving order and every
 * unrelated entry. Idempotent: re-running `sonata init` cannot duplicate them.
 */
export function allowSonataTools(settings: Settings): { settings: Settings; changed: boolean } {
  const missing = missingAllowEntries(settings);
  if (missing.length === 0) return { settings, changed: false };

  const permissions = { ...(settings.permissions ?? {}) };
  permissions.allow = [...(settings.permissions?.allow ?? []), ...missing];
  return { settings: { ...settings, permissions }, changed: true };
}

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

/**
 * Whether *some* sonata mode-capture hook is present, wherever it was installed
 * from. `hookInstalled` matches one exact command string, which is the right
 * check when installing; this is the right check when diagnosing, since a hook
 * installed by a different sonata checkout still does the job.
 */
export function modeHookPresent(settings: Settings, event = 'PreToolUse'): boolean {
  return (settings.hooks?.[event] ?? []).some((entry) =>
    entry.hooks.some((h) => h.command.includes('capture-mode.mjs')),
  );
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

  // A PreToolUse hook needs its `matcher` ("Bash"), but a SessionStart hook has
  // no matcher at all — writing `matcher: ""` would be noise in the file, so
  // omit the key entirely when none was supplied.
  const entry: HookEntry = matcher ? { matcher, hooks: [{ type: 'command', command }] }
    : { hooks: [{ type: 'command', command }] };
  entries.push(entry);
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

export type McpScope = 'project' | 'user';

/** How `claude mcp add` records a stdio server pointing at this install. */
function mcpArgs(packageRoot: string): string[] {
  return ['node', join(packageRoot, 'dist', 'cli.js'), 'mcp'];
}

/**
 * Whether Claude Code can already see a sonata server for this install.
 *
 * Reads the two places Claude Code actually keeps them: `./.mcp.json` for
 * project scope, and the top-level `mcpServers` of `~/.claude.json` for user
 * scope. An earlier version wrote `~/.claude/mcp.json`, which Claude Code
 * never reads — the registration was invisible everywhere except the one repo
 * that also had a project file, while `doctor` reported it healthy.
 */
export function mcpRegistered(
  scope: McpScope,
  cwd: string,
  home: string,
  packageRoot: string,
): boolean {
  const path = scope === 'user'
    ? join(home, '.claude.json')
    : join(cwd, '.mcp.json');
  if (!existsSync(path)) return false;

  let doc: { mcpServers?: Record<string, { args?: string[] }> };
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return false;
  }
  const want = mcpArgs(packageRoot).slice(1).join(' ');
  return (doc.mcpServers?.sonata?.args ?? []).join(' ') === want;
}

export interface RunResult { ok: boolean; output: string }
export type Runner = (cmd: string, args: string[]) => RunResult;

const defaultRunner: Runner = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return {
    ok: r.status === 0,
    output: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? r.error.message : ''}`,
  };
};

/**
 * Registers the server by asking Claude Code to do it.
 *
 * `~/.claude.json` is Claude Code's live state — a hundred keys of session and
 * project data that every running session writes. Read-modify-write from here
 * could silently drop a concurrent write, so the CLI that owns the file does
 * the writing. Sonata is useless without Claude Code, so requiring its binary
 * costs nothing.
 */
export function registerMcp(
  scope: McpScope,
  cwd: string,
  packageRoot: string,
  run: Runner = defaultRunner,
): { ok: boolean; changed: boolean; command: string } {
  const args = ['mcp', 'add', '--scope', scope, 'sonata', '--', ...mcpArgs(packageRoot)];
  const command = `claude ${args.join(' ')}`;
  const res = run('claude', args);

  // Re-registering is not a failure; it is the common case on a second init.
  if (!res.ok && /already exists/i.test(res.output)) {
    return { ok: true, changed: false, command };
  }
  return { ok: res.ok, changed: res.ok, command };
}
