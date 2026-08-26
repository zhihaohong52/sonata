import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdRun, ensureNativeServe, MAX_REPO_CONTEXT_CHARS, repoContext, exposesSonataTools } from '../../src/commands/run.js';
import { readMeta, runDir } from '../../src/store.js';
import { killSession, hasSession, capturePane } from '../../src/tmux.js';
import { readPermissionMode } from '../../src/mode.js';
import { startServeDaemon } from '../../src/commands/serve.js';

// Only `startServeDaemon` is stubbed — a real detached process would race the
// live :4100 router this session routes through. `isSonataRouter` and
// `sonataRouterConfigPath` are left real (spread from the module) so
// `vi.stubGlobal('fetch', …)` drives their identity checks, the same pattern
// route.test.ts uses.
vi.mock('../../src/commands/serve.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/commands/serve.js')>();
  return {
    ...actual,
    startServeDaemon: vi.fn(async () => ({ pid: 4242, port: 4100, logPath: '/tmp/sonata-test-daemon.log' })),
  };
});

let cwd: string;
let created: string[] = [];

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'sonata-run-'));
  mkdirSync(join(cwd, 'roles'), { recursive: true });
  writeFileSync(join(cwd, 'roles', 'code.md'), 'Do the work.');
  writeFileSync(join(cwd, 'sonata.toml'), `
[models.fake]
harness = "opencode"
id = "fake/fake"

[generate.roles]
code = ["fake"]
`);
});

afterEach(async () => {
  for (const s of created) await killSession(s);
  created = [];
});

describe('readPermissionMode', () => {
  it('defaults to the safest mode when no session file exists', () => {
    expect(readPermissionMode(cwd, 'missing')).toBe('default');
  });

  it('reads a written mode', () => {
    mkdirSync(join(cwd, '.sonata'), { recursive: true });
    writeFileSync(join(cwd, '.sonata', 'session-s1.json'),
      JSON.stringify({ permissionMode: 'bypassPermissions' }));
    expect(readPermissionMode(cwd, 's1')).toBe('bypassPermissions');
  });

  it('maps Claude Code `auto` onto acceptEdits', () => {
    // `auto` is Claude Code's current default mode: it runs lower-risk calls
    // without prompting. Treating it as `default` would claim the parent
    // prompts for everything, and would make every opencode dispatch refuse.
    mkdirSync(join(cwd, '.sonata'), { recursive: true });
    writeFileSync(join(cwd, '.sonata', 'session-s2.json'),
      JSON.stringify({ permissionMode: 'auto' }));
    expect(readPermissionMode(cwd, 's2')).toBe('acceptEdits');
  });

  it('still falls back to default for a genuinely unknown mode', () => {
    mkdirSync(join(cwd, '.sonata'), { recursive: true });
    writeFileSync(join(cwd, '.sonata', 'session-s3.json'),
      JSON.stringify({ permissionMode: 'someFutureMode' }));
    expect(readPermissionMode(cwd, 's3')).toBe('default');
  });
});

describe('cmdRun', () => {
  /** opencode refuses `default` mode, so a launch test must pick a mode it runs. */
  function sessionInMode(mode: string): string {
    mkdirSync(join(cwd, '.sonata'), { recursive: true });
    writeFileSync(join(cwd, '.sonata', 'session-run.json'),
      JSON.stringify({ permissionMode: mode }));
    return 'run';
  }

  it('creates a run, writes instructions and cmd.sh, and starts a live session', async () => {
    const taskFile = join(cwd, 'task.txt');
    writeFileSync(taskFile, 'Refactor the parser.');

    const res = await cmdRun({
      cwd, role: 'code', model: 'fake', taskFile,
      rolesDir: join(cwd, 'roles'), sessionId: sessionInMode('acceptEdits'),
    });
    created.push(res.session);

    const dir = runDir(cwd, res.id);
    expect(existsSync(join(dir, 'instructions.md'))).toBe(true);
    expect(existsSync(join(dir, 'cmd.sh'))).toBe(true);

    const instructions = readFileSync(join(dir, 'instructions.md'), 'utf8');
    expect(instructions).toContain('Refactor the parser.');
    expect(instructions).toContain(join(dir, 'report.md'));

    const meta = readMeta(cwd, res.id);
    expect(meta.harness).toBe('opencode');
    expect(meta.model).toBe('fake');
    expect(meta.mode).toBe('acceptEdits');

    expect(await hasSession(res.session)).toBe(true);
  });

  it('rejects an undefined model with an actionable message', async () => {
    const taskFile = join(cwd, 'task.txt');
    writeFileSync(taskFile, 'x');
    await expect(cmdRun({
      cwd, role: 'code', model: 'ghost', taskFile,
      rolesDir: join(cwd, 'roles'), sessionId: undefined,
    })).rejects.toThrow(/unknown model "ghost"/);
  });

  it('resolves a native-only unified model without a [tiers] table', async () => {
    writeFileSync(join(cwd, 'sonata.toml'), `
[models."solo-native"]
gateway = "g"
id = "solo-native-upstream"
context_window = 128000

[native.gateways."g"]
base_url = "http://gateway.example/v1"
`);
    writeFileSync(join(cwd, 'task.txt'), 'Use the native model.');
    const configPath = join(cwd, 'sonata.toml');
    let fetchCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) throw new Error('ECONNREFUSED');
      return new Response(JSON.stringify({ status: 'ok', sonata: true, configPath }));
    }) as unknown as typeof fetch);

    const res = await cmdRun({
      cwd, role: 'code', model: 'solo-native', taskFile: join(cwd, 'task.txt'),
      rolesDir: join(cwd, 'roles'), sessionId: sessionInMode('acceptEdits'),
    });
    created.push(res.session);
    expect(res.interactive).toBe(false);
    expect(vi.mocked(startServeDaemon)).toHaveBeenCalledTimes(1);
  });

  it('refuses an opencode dispatch when the mode is unknown', async () => {
    // No session file means no permission hook, and sonata assumes `default`.
    // opencode cannot honour that, so the dispatch must fail loudly rather
    // than silently run ungated.
    const taskFile = join(cwd, 'task.txt');
    writeFileSync(taskFile, 'x');
    await expect(cmdRun({
      cwd, role: 'code', model: 'fake', taskFile,
      rolesDir: join(cwd, 'roles'), sessionId: undefined,
    })).rejects.toThrow(/cannot ask for approval/i);
  });
});

describe('ensureNativeServe', () => {
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

  /** Writes a project config and returns the path `ensureNativeServe` should resolve to. */
  function writeNativeConfig(dir: string): string {
    const path = join(dir, 'sonata.toml');
    writeFileSync(path, NATIVE_TOML);
    return path;
  }

  function sonataHealthPayload(configPath: string): Response {
    return new Response(JSON.stringify({ status: 'ok', sonata: true, configPath }));
  }

  it('starts the daemon when no router is running, then passes the matching post-start check', async () => {
    const expectedConfigPath = writeNativeConfig(cwd);

    // Nothing listening at first (the initial probe throws like a refused
    // connect), but by the time the daemon's poll completes the freshly
    // started router reports THIS project's config — the post-start identity
    // check passes.
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('ECONNREFUSED');
      return sonataHealthPayload(expectedConfigPath);
    }) as unknown as typeof fetch);

    await expect(ensureNativeServe(cwd)).resolves.toBeUndefined();
    expect(vi.mocked(startServeDaemon)).toHaveBeenCalledTimes(1);
  });

  it('proceeds without starting a second daemon when the running router reports a matching config', async () => {
    const expectedConfigPath = writeNativeConfig(cwd);

    vi.stubGlobal('fetch', vi.fn(async () => sonataHealthPayload(expectedConfigPath)) as unknown as typeof fetch);

    await expect(ensureNativeServe(cwd)).resolves.toBeUndefined();
    expect(vi.mocked(startServeDaemon)).not.toHaveBeenCalled();
  });

  it('refuses a running router already serving a different config', async () => {
    writeNativeConfig(cwd);
    const otherCwd = mkdtempSync(join(tmpdir(), 'sonata-run-other-'));
    const otherConfigPath = writeNativeConfig(otherCwd);

    vi.stubGlobal('fetch', vi.fn(async () => sonataHealthPayload(otherConfigPath)) as unknown as typeof fetch);

    await expect(ensureNativeServe(cwd)).rejects.toThrow(/different sonata configuration/);
    expect(vi.mocked(startServeDaemon)).not.toHaveBeenCalled();
  });

  it('re-checks identity after the daemon starts, catching a racing project that won the port', async () => {
    writeNativeConfig(cwd);
    const otherCwd = mkdtempSync(join(tmpdir(), 'sonata-run-other-'));
    const otherConfigPath = writeNativeConfig(otherCwd);

    // The initial probe finds nothing listening (throws), the mocked daemon
    // spawn "succeeds", but the router that now answers reports the other
    // project's config — the post-start check must throw.
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('ECONNREFUSED');
      return sonataHealthPayload(otherConfigPath);
    }) as unknown as typeof fetch);

    await expect(ensureNativeServe(cwd)).rejects.toThrow(/different sonata configuration/);
    expect(vi.mocked(startServeDaemon)).toHaveBeenCalledTimes(1);
  });

  it('requires a [native] table, even though a [models] config exists', async () => {
    // The global beforeEach already wrote a `[models]`-only config to `cwd`;
    // without a [native] table the claude harness has no router port.
    await expect(ensureNativeServe(cwd)).rejects.toThrow(/\[native\] table/);
  });

  it('refuses a running router that reports no configPath at all', async () => {
    writeNativeConfig(cwd);

    // A sonata router that answers but does not name its configPath is
    // indistinguishable from a different project's router — reject it rather
    // than silently trust it.
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ status: 'ok', sonata: true })),
    ) as unknown as typeof fetch);

    await expect(ensureNativeServe(cwd)).rejects.toThrow(/did not report which sonata configuration/);
    expect(vi.mocked(startServeDaemon)).not.toHaveBeenCalled();
  });

  it('re-checks identity after the daemon starts, refusing a router that reports no configPath', async () => {
    writeNativeConfig(cwd);

    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('ECONNREFUSED');
      return new Response(JSON.stringify({ status: 'ok', sonata: true }));
    }) as unknown as typeof fetch);

    await expect(ensureNativeServe(cwd)).rejects.toThrow(/did not report which sonata configuration/);
    expect(vi.mocked(startServeDaemon)).toHaveBeenCalledTimes(1);
  });
});

describe('repoContext', () => {
  it('caps oversized repository instructions with a visible file marker', () => {
    writeFileSync(join(cwd, 'CLAUDE.md'), 'x'.repeat(MAX_REPO_CONTEXT_CHARS + 1_000));

    const context = repoContext(cwd);

    expect(context.length).toBeLessThanOrEqual(MAX_REPO_CONTEXT_CHARS);
    expect(context).toContain('[truncated: CLAUDE.md exceeded');
  });
});

describe('exposesSonataTools', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sonata-mcpjson-'));

  it('is false when the project has no .mcp.json', () => {
    expect(exposesSonataTools(dir)).toBe(false);
  });

  it('detects sonata by server name', () => {
    const d = mkdtempSync(join(tmpdir(), 'sonata-mcpjson-'));
    writeFileSync(join(d, '.mcp.json'), JSON.stringify({ mcpServers: { sonata: { command: 'node' } } }));
    expect(exposesSonataTools(d)).toBe(true);
  });

  it('detects sonata when it is registered under another name', () => {
    const d = mkdtempSync(join(tmpdir(), 'sonata-mcpjson-'));
    writeFileSync(join(d, '.mcp.json'), JSON.stringify({
      mcpServers: { helper: { command: 'node', args: ['/opt/sonata/dist/cli.js', 'mcp'] } },
    }));
    expect(exposesSonataTools(d)).toBe(true);
  });

  it('is false for unrelated servers', () => {
    const d = mkdtempSync(join(tmpdir(), 'sonata-mcpjson-'));
    writeFileSync(join(d, '.mcp.json'), JSON.stringify({
      mcpServers: { playwright: { command: 'npx', args: ['@playwright/mcp'] } },
    }));
    expect(exposesSonataTools(d)).toBe(false);
  });

  // Guessing "exposes nothing" would be the unsafe direction.
  it('assumes the worst when .mcp.json cannot be parsed', () => {
    const d = mkdtempSync(join(tmpdir(), 'sonata-mcpjson-'));
    writeFileSync(join(d, '.mcp.json'), '{ not json');
    expect(exposesSonataTools(d)).toBe(true);
  });
});
