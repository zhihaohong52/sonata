import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  settingsPath, readSettings, writeSettings, installHook,
  uninstallHook, hookInstalled, hookCommand, type Settings,
} from '../src/settings.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sonata-settings-')); });

// Mirrors the user's real global settings: an unrelated hook plus other keys.
const EXISTING: Settings = {
  model: 'opus',
  permissions: { allow: ['Bash'] },
  hooks: {
    PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook claude' }] },
    ],
  },
};

describe('settingsPath', () => {
  it('resolves the global path', () => {
    expect(settingsPath('global', '/repo', '/home/u')).toBe('/home/u/.claude/settings.json');
  });

  it('resolves the project path', () => {
    expect(settingsPath('project', '/repo', '/home/u')).toBe('/repo/.claude/settings.json');
  });
});

describe('installHook', () => {
  it('preserves unrelated top-level keys and existing hooks', () => {
    const { settings, changed } = installHook(EXISTING, 'node /p/hooks/capture-mode.mjs');
    expect(changed).toBe(true);
    expect(settings.model).toBe('opus');
    expect(settings.permissions).toEqual({ allow: ['Bash'] });

    const entries = settings.hooks!.PreToolUse;
    expect(entries).toHaveLength(2);
    expect(entries[0].hooks[0].command).toBe('rtk hook claude');
    expect(entries[1].hooks[0].command).toBe('node /p/hooks/capture-mode.mjs');
  });

  it('does not mutate the input', () => {
    const before = JSON.stringify(EXISTING);
    installHook(EXISTING, 'node /p/hooks/capture-mode.mjs');
    expect(JSON.stringify(EXISTING)).toBe(before);
  });

  it('is idempotent', () => {
    const once = installHook(EXISTING, 'cmd').settings;
    const twice = installHook(once, 'cmd');
    expect(twice.changed).toBe(false);
    expect(twice.settings.hooks!.PreToolUse).toHaveLength(2);
  });

  it('works from empty settings', () => {
    const { settings } = installHook({}, 'cmd');
    expect(settings.hooks!.PreToolUse).toHaveLength(1);
    expect(settings.hooks!.PreToolUse[0].matcher).toBe('Bash');
  });
});

describe('uninstallHook', () => {
  it('removes only sonata and leaves the rest intact', () => {
    const installed = installHook(EXISTING, 'cmd').settings;
    const { settings, changed } = uninstallHook(installed, 'cmd');
    expect(changed).toBe(true);
    expect(settings.hooks!.PreToolUse).toHaveLength(1);
    expect(settings.hooks!.PreToolUse[0].hooks[0].command).toBe('rtk hook claude');
  });

  it('reports no change when absent', () => {
    expect(uninstallHook(EXISTING, 'nope').changed).toBe(false);
  });

  it('drops the hooks key entirely when it empties', () => {
    const only = installHook({}, 'cmd').settings;
    expect(uninstallHook(only, 'cmd').settings.hooks).toBeUndefined();
  });
});

describe('read/write round trip', () => {
  it('creates the directory, backs up, and preserves foreign keys', () => {
    const path = join(dir, '.claude', 'settings.json');
    writeSettings(path, EXISTING);
    expect(existsSync(`${path}.bak`)).toBe(false); // nothing to back up first time

    const loaded = readSettings(path);
    const { settings } = installHook(loaded, 'cmd');
    writeSettings(path, settings);

    expect(existsSync(`${path}.bak`)).toBe(true);
    expect(JSON.parse(readFileSync(`${path}.bak`, 'utf8')).hooks.PreToolUse).toHaveLength(1);
    expect(readSettings(path).hooks!.PreToolUse).toHaveLength(2);
    expect(readSettings(path).model).toBe('opus');
  });

  it('treats a missing or empty file as empty settings', () => {
    expect(readSettings(join(dir, 'nope.json'))).toEqual({});
    const empty = join(dir, 'empty.json');
    writeFileSync(empty, '   ');
    expect(readSettings(empty)).toEqual({});
  });
});

describe('hookCommand', () => {
  it('points at the installed hook and quotes the path', () => {
    expect(hookCommand('/opt/sonata')).toBe('node "/opt/sonata/hooks/capture-mode.mjs"');
  });
});

describe('hookInstalled', () => {
  it('detects presence and absence', () => {
    expect(hookInstalled(EXISTING, 'rtk hook claude')).toBe(true);
    expect(hookInstalled(EXISTING, 'cmd')).toBe(false);
  });
});
