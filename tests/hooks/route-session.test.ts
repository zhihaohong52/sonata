import { describe, it, expect, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
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

  it('exits 0 when given --global, the same as without it', async () => {
    // The hook only forwards --global to the CLI when present; the resulting
    // scope-aware behavior (writing the shared settings file, resolving the
    // machine config) is covered directly against TS source in
    // route.test.ts (sessionHookCommand, planRouteAuto, cmdRouteSession),
    // since this file's job is only the hook's own argv/stdin handling —
    // its CLI invocation targets the built dist/cli.js, which does not exist
    // yet at the point in CI where this test runs (build happens after test).
    expect(await invoke('start', JSON.stringify({ session_id: 'x' }), ['--global'])).toBe(0);
  });
});
