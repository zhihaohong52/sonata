import { describe, it, expect, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Both `route auto` hooks resolve the CLI as `../dist/cli.js` relative to
 * themselves, so copying a hook into `<tmp>/hooks/` beside a scripted
 * `<tmp>/dist/cli.js` exercises the hook's own behaviour — what it does with
 * the CLI's exit code and stderr — without depending on a built `dist/`
 * (absent in CI at test time) or on the network.
 *
 * Why this exists: `sonata route session-start` refused, correctly, to route a
 * session through a router port another project's config already held — and
 * the hook ran it with stdio ignored and exited 0, so the refusal was invisible.
 * The session stayed unrouted, and every native tier dispatch died with
 * `model_not_found` at api.anthropic.com. Measured 2026-09-09 in a project whose
 * default router port was held by a sibling project's daemon.
 */
const FAKE_CLI = `
const fs = require('node:fs');
fs.writeFileSync(process.env.FAKE_ARGV_FILE, JSON.stringify(process.argv.slice(2)));
if (process.env.FAKE_STDERR) process.stderr.write(process.env.FAKE_STDERR);
if (process.env.FAKE_STDOUT) process.stdout.write(process.env.FAKE_STDOUT);
process.exit(Number(process.env.FAKE_EXIT ?? 0));
`;

let dir: string;
let argvFile: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sonata-route-hook-surface-'));
  mkdirSync(join(dir, 'hooks'));
  mkdirSync(join(dir, 'dist'));
  writeFileSync(join(dir, 'dist', 'cli.js'), FAKE_CLI);
  writeFileSync(join(dir, 'dist', 'package.json'), '{"type":"commonjs"}');
  for (const hook of ['route-session.mjs', 'route-subagent.mjs']) {
    copyFileSync(resolve('hooks', hook), join(dir, 'hooks', hook));
  }
  argvFile = join(dir, 'argv.json');
});

async function invoke(
  hook: string,
  args: string[],
  payload: string,
  fake: { exit?: number; stderr?: string; stdout?: string } = {},
): Promise<{ code: number | null; stdout: string }> {
  const child = spawn('node', [join(dir, 'hooks', hook), ...args], {
    cwd: dir,
    stdio: ['pipe', 'pipe', 'ignore'],
    env: {
      ...process.env,
      FAKE_ARGV_FILE: argvFile,
      FAKE_EXIT: String(fake.exit ?? 0),
      FAKE_STDERR: fake.stderr ?? '',
      FAKE_STDOUT: fake.stdout ?? '',
    },
  });
  const out: Buffer[] = [];
  child.stdout.on('data', (c) => out.push(c));
  child.stdin.end(payload);
  return new Promise((res) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); res({ code: -1, stdout: '' }); }, 20000);
    child.on('exit', (code) => { clearTimeout(timer); res({ code, stdout: Buffer.concat(out).toString() }); });
  });
}

const argv = () => JSON.parse(readFileSync(argvFile, 'utf8')) as string[];

describe('route-session hook — surfacing the CLI', () => {
  it('runs `route session-start --id <id>` and stays silent when it succeeds', async () => {
    const { code, stdout } = await invoke('route-session.mjs', ['start'], JSON.stringify({ session_id: 's1' }), { stdout: 'routing off; 1 session(s) routed\n' });
    expect(code).toBe(0);
    expect(argv()).toEqual(['route', 'session-start', '--id', 's1']);
    // The CLI's own stdout must not leak: on SessionStart plain stdout becomes
    // context for Claude, and "routing off" is not an instruction.
    expect(stdout.trim()).toBe('');
  });

  it('forwards --global', async () => {
    await invoke('route-session.mjs', ['end', '--global'], JSON.stringify({ session_id: 's1' }));
    expect(argv()).toEqual(['route', 'session-end', '--id', 's1', '--global']);
  });

  it('surfaces a refusal as a systemMessage, and still exits 0', async () => {
    const refusal = 'sonata: router on port 4100 predates multi-tenant routing — run `sonata restart`\n';
    const { code, stdout } = await invoke('route-session.mjs', ['start'], JSON.stringify({ session_id: 's1' }), { exit: 1, stderr: refusal });
    expect(code).toBe(0);
    const doc = JSON.parse(stdout) as { systemMessage: string };
    expect(doc.systemMessage).toContain('sonata route session-start failed');
    expect(doc.systemMessage).toContain('will not route');
    expect(doc.systemMessage).toContain('predates multi-tenant routing');
  });

  it('stays silent on a failure that says nothing', async () => {
    // Nothing to show is nothing to show: an empty stderr must not produce an
    // empty warning box.
    const { code, stdout } = await invoke('route-session.mjs', ['start'], JSON.stringify({ session_id: 's1' }), { exit: 1 });
    expect(code).toBe(0);
    expect(stdout.trim()).toBe('');
  });

  it('exits 0 without invoking the CLI when stdin carries no session id', async () => {
    const { code } = await invoke('route-session.mjs', ['start'], JSON.stringify({ cwd: '/tmp' }));
    expect(code).toBe(0);
    expect(existsSync(argvFile)).toBe(false);
  });
});

describe('route-subagent hook — surfacing the CLI', () => {
  it('runs `route subagent-start --id <id>` and stays silent when it succeeds', async () => {
    const { code, stdout } = await invoke('route-subagent.mjs', ['start'], JSON.stringify({ agent_id: 'a1' }), { stdout: 'routing on; 1 subagent(s) running\n' });
    expect(code).toBe(0);
    expect(argv()).toEqual(['route', 'subagent-start', '--id', 'a1']);
    expect(stdout.trim()).toBe('');
  });

  it('surfaces a refusal as a systemMessage, and still exits 0', async () => {
    const { code, stdout } = await invoke('route-subagent.mjs', ['stop', '--global'], JSON.stringify({ agent_id: 'a1' }), { exit: 1, stderr: 'sonata: boom\n' });
    expect(code).toBe(0);
    expect(argv()).toEqual(['route', 'subagent-stop', '--id', 'a1', '--global']);
    const doc = JSON.parse(stdout) as { systemMessage: string };
    expect(doc.systemMessage).toContain('sonata route subagent-stop failed');
    expect(doc.systemMessage).toContain('sonata: boom');
  });
});
