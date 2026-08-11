import { describe, it, expect, beforeEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readPermissionMode } from '../../src/mode.js';

const run = promisify(execFile);
let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'sonata-hook-'));
  // The hook is installed globally and fires on every Bash call, so it only
  // acts in projects that actually use sonata.
  writeFileSync(join(cwd, 'sonata.toml'), '');
});

async function invoke(payload: unknown): Promise<void> {
  const child = execFile('node', ['hooks/capture-mode.mjs'], { cwd: process.cwd(), env: { ...process.env, SONATA_CWD: cwd } });
  child.stdin!.end(JSON.stringify(payload));
  await new Promise((resolve) => child.on('close', resolve));
}

/** Same, with both the working directory and the home directory injected. */
async function invokeIn(dir: string, home: string, payload: unknown): Promise<void> {
  const child = execFile('node', ['hooks/capture-mode.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, SONATA_CWD: dir, SONATA_HOME: home },
  });
  child.stdin!.end(JSON.stringify(payload));
  await new Promise((resolve) => child.on('close', resolve));
}

describe('capture-mode hook', () => {
  it('writes the permission mode for the session', async () => {
    await invoke({ session_id: 's1', permission_mode: 'acceptEdits' });
    const path = join(cwd, '.sonata', 'session-s1.json');
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8')).permissionMode).toBe('acceptEdits');
  });

  it('overwrites on a mid-session mode change', async () => {
    await invoke({ session_id: 's1', permission_mode: 'default' });
    await invoke({ session_id: 's1', permission_mode: 'bypassPermissions' });
    const path = join(cwd, '.sonata', 'session-s1.json');
    expect(JSON.parse(readFileSync(path, 'utf8')).permissionMode).toBe('bypassPermissions');
  });

  it('exits silently when the payload has no session id', async () => {
    await invoke({ permission_mode: 'default' });
    expect(existsSync(join(cwd, '.sonata'))).toBe(false);
  });

  it('does nothing in a project that does not use sonata', async () => {
    const stranger = mkdtempSync(join(tmpdir(), 'not-sonata-'));
    const child = execFile('node', ['hooks/capture-mode.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, SONATA_CWD: stranger },
    });
    child.stdin!.end(JSON.stringify({ session_id: 's1', permission_mode: 'acceptEdits' }));
    await new Promise((resolve) => child.on('close', resolve));
    expect(existsSync(join(stranger, '.sonata'))).toBe(false);
  });

  it('acts once .sonata exists even without sonata.toml', async () => {
    const { mkdirSync } = await import('node:fs');
    const adopted = mkdtempSync(join(tmpdir(), 'adopted-'));
    mkdirSync(join(adopted, '.sonata'), { recursive: true });
    const child = execFile('node', ['hooks/capture-mode.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, SONATA_CWD: adopted },
    });
    child.stdin!.end(JSON.stringify({ session_id: 's9', permission_mode: 'plan' }));
    await new Promise((resolve) => child.on('close', resolve));
    const path = join(adopted, '.sonata', 'session-s9.json');
    expect(JSON.parse(readFileSync(path, 'utf8')).permissionMode).toBe('plan');
  });
});

describe('capture-mode — machine-level config', () => {
  // A repo that relies only on ~/.config/sonata/sonata.toml has no local
  // sonata.toml and no .sonata/, so the hook used to skip it entirely: no mode
  // was captured, sonata assumed `default`, and every opencode or pi dispatch
  // refused. Writing into the repo instead would litter .sonata/ into every
  // directory on the machine, which is exactly what usesSonata() guards.
  it('records the mode beside the machine config when the repo has none', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'sonata-bare-'));
    const home = mkdtempSync(join(tmpdir(), 'sonata-home-'));
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(join(home, '.config', 'sonata', 'sonata.toml'), '');

    await invokeIn(bare, home, { session_id: 'sess-1', permission_mode: 'acceptEdits' });

    const machine = join(home, '.config', 'sonata', 'session-sess-1.json');
    expect(existsSync(machine)).toBe(true);
    expect(JSON.parse(readFileSync(machine, 'utf8')).permissionMode).toBe('acceptEdits');
    expect(existsSync(join(bare, '.sonata'))).toBe(false);
  });

  it('still prefers the repo when it has its own config', async () => {
    const local = mkdtempSync(join(tmpdir(), 'sonata-local-'));
    const home = mkdtempSync(join(tmpdir(), 'sonata-home-'));
    writeFileSync(join(local, 'sonata.toml'), '');
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(join(home, '.config', 'sonata', 'sonata.toml'), '');

    await invokeIn(local, home, { session_id: 'sess-2', permission_mode: 'plan' });

    expect(existsSync(join(local, '.sonata', 'session-sess-2.json'))).toBe(true);
    expect(existsSync(join(home, '.config', 'sonata', 'session-sess-2.json'))).toBe(false);
  });

  it('stays out of a directory with no sonata anywhere', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'sonata-none-'));
    const home = mkdtempSync(join(tmpdir(), 'sonata-home-'));

    await invokeIn(bare, home, { session_id: 'sess-3', permission_mode: 'acceptEdits' });

    expect(existsSync(join(bare, '.sonata'))).toBe(false);
  });
});

describe('readPermissionMode — machine-level session file', () => {
  it('reads the mode beside the machine config when the repo has none', () => {
    const bare = mkdtempSync(join(tmpdir(), 'sonata-bare-'));
    const home = mkdtempSync(join(tmpdir(), 'sonata-home-'));
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(
      join(home, '.config', 'sonata', 'session-abc.json'),
      JSON.stringify({ permissionMode: 'acceptEdits' }),
    );
    expect(readPermissionMode(bare, 'abc', home)).toBe('acceptEdits');
  });

  it('prefers the project session file over the machine one', () => {
    const local = mkdtempSync(join(tmpdir(), 'sonata-local-'));
    const home = mkdtempSync(join(tmpdir(), 'sonata-home-'));
    mkdirSync(join(local, '.sonata'), { recursive: true });
    writeFileSync(join(local, '.sonata', 'session-abc.json'), JSON.stringify({ permissionMode: 'plan' }));
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(
      join(home, '.config', 'sonata', 'session-abc.json'),
      JSON.stringify({ permissionMode: 'bypassPermissions' }),
    );
    expect(readPermissionMode(local, 'abc', home)).toBe('plan');
  });

  it('falls back to default when neither exists', () => {
    const bare = mkdtempSync(join(tmpdir(), 'sonata-bare-'));
    const home = mkdtempSync(join(tmpdir(), 'sonata-home-'));
    expect(readPermissionMode(bare, 'abc', home)).toBe('default');
  });
});
