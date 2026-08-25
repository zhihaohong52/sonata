import { describe, it, expect, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const HOOK = resolve('hooks/route-session.mjs');

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sonata-route-hook-')); });

/**
 * Runs the hook with `payload` on stdin, from a scratch directory with no
 * sonata config — the CLI it invokes must never reach this repository's own
 * settings, which a hook running in `process.cwd()` would happily route.
 */
async function invoke(phase: string, payload: string, extraArgs: string[] = []): Promise<number | null> {
  const child = spawn('node', [HOOK, phase, ...extraArgs], {
    cwd: dir,
    stdio: ['pipe', 'ignore', 'ignore'],
    env: { ...process.env, HOME: dir },
  });
  child.stdin.end(payload);
  return new Promise((res) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); res(-1); }, 20000);
    child.on('exit', (code) => { clearTimeout(timer); res(code); });
  });
}

describe('route-session lifecycle hook', () => {
  it('exits 0 without invoking the CLI when stdin carries no session id', async () => {
    expect(await invoke('start', JSON.stringify({ cwd: '/tmp' }))).toBe(0);
  });

  it('exits 0 on stdin that is not JSON at all', async () => {
    // A hook that throws breaks the session it exists to serve, so malformed
    // input has to be indistinguishable from no input.
    expect(await invoke('end', 'not json')).toBe(0);
  });

  it('exits 0 even when the CLI it invokes fails', async () => {
    // `route session-start` in a directory with no sonata config exits
    // non-zero; the hook must still report success to Claude Code.
    expect(await invoke('start', JSON.stringify({ session_id: 'x' }))).toBe(0);
  });

  it('forwards --global so the CLI routes at global scope, not project', async () => {
    // Without this, `route session-start` defaults to project scope
    // regardless of how `route auto --global` installed the hook — silently
    // routing a global session's settings into the project file instead of
    // the shared one.
    mkdirSync(join(dir, '.config', 'sonata'), { recursive: true });
    writeFileSync(join(dir, '.config', 'sonata', 'sonata.toml'), `
[native.models."deepseek"]
gateway = "g"
id = "deepseek-v4-flash"
context_window = 64000
[native.gateways."g"]
base_url = "http://gateway.example/v1"
`);
    expect(await invoke('start', JSON.stringify({ session_id: 'x' }), ['--global'])).toBe(0);
    expect(existsSync(join(dir, '.claude', 'settings.json'))).toBe(true);
    expect(existsSync(join(dir, '.claude', 'settings.local.json'))).toBe(false);
  });
});
