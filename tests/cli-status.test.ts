import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { isSonataRouter } from '../src/commands/serve.js';
import { readRows } from '../src/ledger.js';
import { summarizeRuns } from '../src/commands/runs.js';
import { cmdRoute, type RouteStatus } from '../src/commands/route.js';

// `main` reaches its boundaries through these modules; mock each so the CLI
// path can be exercised without a real config, router, ledger or run store.
vi.mock('../src/config.js', () => ({ loadConfig: vi.fn() }));
vi.mock('../src/commands/serve.js', () => ({
  cmdServe: vi.fn(),
  cmdRestart: vi.fn(),
  startServeDaemon: vi.fn(),
  isSonataRouter: vi.fn(),
}));
vi.mock('../src/ledger.js', () => ({ readRows: vi.fn() }));
vi.mock('../src/commands/runs.js', () => ({ summarizeRuns: vi.fn() }));
vi.mock('../src/commands/route.js', () => ({
  cmdRoute: vi.fn(),
  cmdRouteSession: vi.fn(),
  cmdRouteSubagent: vi.fn(),
}));

const loadConfigMock = vi.mocked(loadConfig);
const isSonataRouterMock = vi.mocked(isSonataRouter);
const readRowsMock = vi.mocked(readRows);
const summarizeRunsMock = vi.mocked(summarizeRuns);
const cmdRouteMock = vi.mocked(cmdRoute);

function cell(over: Record<string, unknown> = {}) {
  return {
    ts: '2026-08-27T12:00:00.000Z', alias: 'sonata-code-simple', key: 'flash',
    status: 200, tokens: { input: 100, output: 10 }, attempts: [], session: 'sess-a',
    ...over,
  } as never;
}

describe('sonata status CLI wiring', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('rejects an unrecognized flag', async () => {
    await expect(main(['status', '--sessionx', 'foo'])).rejects.toThrow();
  });

  it('defaults to the most recent session', async () => {
    loadConfigMock.mockReturnValue({ native: { ports: { router: 4100 } } } as never);
    isSonataRouterMock.mockResolvedValue(true);
    readRowsMock.mockReturnValue([
      cell({ ts: '2026-08-27T12:00:00.000Z', session: 'sess-a', key: 'flash' }),
      cell({ ts: '2026-08-27T13:00:00.000Z', session: 'sess-b', key: 'grok' }),
      cell({ ts: '2026-08-27T14:00:00.000Z', session: 'sess-b', key: 'grok' }),
    ] as never);

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(['status']);
    const all = spy.mock.calls.map(([l]) => String(l)).join('\n');
    expect(all).toContain('router: up on localhost:4100');
    expect(all).toContain('grok');
    expect(all).not.toContain('flash'); // sess-a's rows are not the newest session's
    expect(all).toContain('reach and routing state live in `sonata route status`');
  });

  it('--all keeps every session', async () => {
    loadConfigMock.mockReturnValue({ native: { ports: { router: 4100 } } } as never);
    isSonataRouterMock.mockResolvedValue(false);
    readRowsMock.mockReturnValue([
      cell({ session: 'sess-a', key: 'flash' }),
      cell({ session: 'sess-b', key: 'grok' }),
    ] as never);

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(['status', '--all']);
    const all = spy.mock.calls.map(([l]) => String(l)).join('\n');
    expect(all).toContain('flash');
    expect(all).toContain('grok');
  });

  it('--session narrows to that session', async () => {
    loadConfigMock.mockReturnValue({ native: { ports: { router: 4100 } } } as never);
    isSonataRouterMock.mockResolvedValue(false);
    readRowsMock.mockReturnValue([
      cell({ session: 'sess-a', key: 'flash' }),
      cell({ session: 'sess-b', key: 'grok' }),
    ] as never);

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(['status', '--session', 'sess-a']);
    const all = spy.mock.calls.map(([l]) => String(l)).join('\n');
    expect(all).toContain('flash');
    expect(all).not.toContain('grok');
  });
});

describe('sonata runs CLI wiring', () => {
  afterEach(() => vi.restoreAllMocks());

  it('prints --json as a parseable array', async () => {
    summarizeRunsMock.mockReturnValue([
      { id: 'abc123', state: 'DONE', degraded: false, role: 'code', model: 'm', report: true },
    ]);

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(['runs', '--json']);
    const out = spy.mock.calls.map(([l]) => String(l)).join('');
    const parsed = JSON.parse(out);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ id: 'abc123', state: 'DONE', report: true });
  });

  it('rejects an unrecognized flag', async () => {
    await expect(main(['runs', '--bogus'])).rejects.toThrow();
  });
});

describe('sonata route status cross-reference', () => {
  afterEach(() => vi.restoreAllMocks());

  it('points at `sonata status`', async () => {
    const status: RouteStatus = {
      on: false, auto: false, env: {}, hook: { installed: false },
      sessions: 0, port: undefined,
      scopes: {
        project: { on: false, auto: false, env: {}, hook: { installed: false } },
        global: { on: false, auto: false, env: {}, hook: { installed: false } },
      },
    };
    cmdRouteMock.mockResolvedValue(status);

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await main(['route', 'status']);
    expect(code).toBe(0);
    const all = spy.mock.calls.map(([l]) => String(l)).join('\n');
    expect(all).toContain('see `sonata status` for what the router has actually served recently');
  });
});