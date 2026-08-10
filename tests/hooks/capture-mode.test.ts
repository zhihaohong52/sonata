import { describe, it, expect, beforeEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
