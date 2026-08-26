import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EventEmitter } from 'node:events';
import type { spawn as spawnType } from 'node:child_process';

import { execClaude, planCode, defaultEnsureServe } from '../../src/commands/code.js';
import { startServeDaemon } from '../../src/commands/serve.js';

// `startServeDaemon` is stubbed — a real detached process would race the live
// :4100 router. `isSonataRouter` and `sonataRouterConfigPath` are left real
// (spread from the module) so `vi.stubGlobal('fetch', …)` drives their identity
// checks, the same pattern run.test.ts uses.
vi.mock('../../src/commands/serve.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/commands/serve.js')>();
  return {
    ...actual,
    startServeDaemon: vi.fn(async () => ({ pid: 4242, port: 4100, logPath: '/tmp/sonata-test-daemon.log' })),
  };
});

let cwd: string;
let home: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'sonata-code-cwd-'));
  home = mkdtempSync(join(tmpdir(), 'sonata-code-home-'));
});

describe('planCode', () => {
  it('sets the router URL and minimum native context window', () => {
    writeFileSync(join(cwd, 'sonata.toml'), `
[native.models."large"]
gateway = "g"
id = "large-model"
context_window = 128000
[native.models."small"]
gateway = "g"
id = "small-model"
context_window = 32000
[native.gateways."g"]
base_url = "http://gateway.example/v1"
`);

    const plan = planCode({ cwd, home, passthrough: ['--model', 'sonnet'] });
    expect(plan.env.ANTHROPIC_BASE_URL).toBe('http://localhost:4100');
    expect(plan.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('32000');
  });

  it('omits the context variable when no native models exist', () => {
    writeFileSync(join(cwd, 'sonata.toml'), `
[native.gateways."g"]
base_url = "http://gateway.example/v1"
`);

    expect(planCode({ cwd, home, passthrough: [] }).env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined();
  });

  it('includes passthrough args and explains the Remote Control limitation', () => {
    writeFileSync(join(cwd, 'sonata.toml'), '[native]\n');
    const plan = planCode({ cwd, home, passthrough: ['--verbose', '--model', 'sonnet'] });

    expect(plan.argv).toEqual(['claude', '--verbose', '--model', 'sonnet']);
    expect(plan.banner).toMatch(/Remote Control unavailable/i);
  });
});

describe('execClaude', () => {
  /** A stand-in for the spawned child, driven by the test. */
  function fakeChild(): EventEmitter & { spawn: typeof spawnType } {
    const child = new EventEmitter();
    return Object.assign(child, {
      spawn: (() => child) as unknown as typeof spawnType,
    });
  }

  it('does not settle while claude is running', async () => {
    // The regression: an earlier version threw on the line after spawn, on the
    // theory that the exit handler made it unreachable. That handler fires a
    // tick later, so the throw always won — `sonata code` printed its banner
    // and then "failed to start claude", every time, while claude was starting
    // perfectly well.
    const { spawn: fake } = fakeChild();
    let settled = false;
    void execClaude(['claude'], { ANTHROPIC_BASE_URL: 'http://localhost:4100' }, { spawn: fake })
      .then(() => { settled = true; }, () => { settled = true; });

    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
  });

  it('relays claude\'s exit code', async () => {
    const child = fakeChild();
    const codes: number[] = [];
    void execClaude(['claude'], {}, { spawn: child.spawn, exit: (code) => { codes.push(code); } });

    child.emit('exit', 3, null);
    expect(codes).toEqual([3]);
  });

  it('re-raises the signal claude died from', async () => {
    const child = fakeChild();
    const signals: string[] = [];
    void execClaude(['claude'], {}, {
      spawn: child.spawn,
      exit: () => {},
      signal: (sig) => { signals.push(sig); },
    });

    child.emit('exit', null, 'SIGINT');
    expect(signals).toEqual(['SIGINT']);
  });

  it('explains a missing claude binary, and how to route by hand', async () => {
    const child = fakeChild();
    const promise = execClaude(['claude'], { ANTHROPIC_BASE_URL: 'http://localhost:4100' }, { spawn: child.spawn });

    const enoent: NodeJS.ErrnoException = new Error('spawn claude ENOENT');
    enoent.code = 'ENOENT';
    child.emit('error', enoent);

    await expect(promise).rejects.toThrow(/not on PATH.*ANTHROPIC_BASE_URL=http:\/\/localhost:4100/s);
  });

  it('passes any other spawn error through unchanged', async () => {
    const child = fakeChild();
    const promise = execClaude(['claude'], {}, { spawn: child.spawn });

    child.emit('error', new Error('EACCES: permission denied'));
    await expect(promise).rejects.toThrow(/permission denied/);
  });
});

describe('defaultEnsureServe', () => {
  const NATIVE_TOML = `
[native.models."deepseek"]
gateway = "g"
id = "deepseek-v4-flash"
context_window = 64000
[native.gateways."g"]
base_url = "http://gateway.example/v1"
`;

  beforeEach(() => {
    vi.mocked(startServeDaemon).mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Writes a project config and returns the path `defaultEnsureServe` should resolve to. */
  function writeNativeConfig(dir: string): string {
    const path = join(dir, 'sonata.toml');
    writeFileSync(path, NATIVE_TOML);
    return path;
  }

  function sonataHealthPayload(configPath?: string): Response {
    return new Response(JSON.stringify(
      configPath === undefined
        ? { status: 'ok', sonata: true }
        : { status: 'ok', sonata: true, configPath },
    ));
  }

  it('proceeds when the running router reports a matching config', async () => {
    const expectedConfigPath = writeNativeConfig(cwd);

    vi.stubGlobal('fetch', vi.fn(async () => sonataHealthPayload(expectedConfigPath)) as unknown as typeof fetch);

    await expect(defaultEnsureServe(cwd, home)).resolves.toBe(4100);
    expect(vi.mocked(startServeDaemon)).not.toHaveBeenCalled();
  });

  it('refuses a running router already serving a different config', async () => {
    writeNativeConfig(cwd);
    const otherCwd = mkdtempSync(join(tmpdir(), 'sonata-code-other-'));
    const otherConfigPath = writeNativeConfig(otherCwd);

    vi.stubGlobal('fetch', vi.fn(async () => sonataHealthPayload(otherConfigPath)) as unknown as typeof fetch);

    await expect(defaultEnsureServe(cwd, home)).rejects.toThrow(/different sonata configuration/);
    expect(vi.mocked(startServeDaemon)).not.toHaveBeenCalled();
  });

  it('refuses a running router that reports no configPath at all', async () => {
    writeNativeConfig(cwd);

    vi.stubGlobal('fetch', vi.fn(async () => sonataHealthPayload()) as unknown as typeof fetch);

    await expect(defaultEnsureServe(cwd, home)).rejects.toThrow(/did not report which sonata configuration/);
    expect(vi.mocked(startServeDaemon)).not.toHaveBeenCalled();
  });

  it('starts the daemon when no router is running, then passes the matching post-start check', async () => {
    const expectedConfigPath = writeNativeConfig(cwd);

    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('ECONNREFUSED');
      return sonataHealthPayload(expectedConfigPath);
    }) as unknown as typeof fetch);

    await expect(defaultEnsureServe(cwd, home)).resolves.toBe(4100);
    expect(vi.mocked(startServeDaemon)).toHaveBeenCalledTimes(1);
  });

  it('re-checks identity after the daemon starts, catching a racing project that won the port', async () => {
    writeNativeConfig(cwd);
    const otherCwd = mkdtempSync(join(tmpdir(), 'sonata-code-other-'));
    const otherConfigPath = writeNativeConfig(otherCwd);

    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('ECONNREFUSED');
      return sonataHealthPayload(otherConfigPath);
    }) as unknown as typeof fetch);

    await expect(defaultEnsureServe(cwd, home)).rejects.toThrow(/different sonata configuration/);
    expect(vi.mocked(startServeDaemon)).toHaveBeenCalledTimes(1);
  });

  it('re-checks identity after the daemon starts, refusing a router that reports no configPath', async () => {
    writeNativeConfig(cwd);

    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('ECONNREFUSED');
      return sonataHealthPayload();
    }) as unknown as typeof fetch);

    await expect(defaultEnsureServe(cwd, home)).rejects.toThrow(/did not report which sonata configuration/);
    expect(vi.mocked(startServeDaemon)).toHaveBeenCalledTimes(1);
  });
});
