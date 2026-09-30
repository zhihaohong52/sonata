import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { aggregate, cmdUsage, parseDuration, parseUsageFlags, projectResolver } from '../../src/commands/usage.js';
import { appendRow, type LedgerRow } from '../../src/ledger.js';

function row(over: Partial<LedgerRow> = {}): LedgerRow {
  return {
    ts: '2026-08-27T12:00:00.000Z', ms: 5,
    alias: 'sonata-code-simple', role: 'code', tier: 'simple',
    key: 'flash', gateway: 'acme', upstream: 'litellm',
    status: 200, complete: true, session: 's1',
    tokens: { input: 100, output: 10, cacheRead: 0, cacheCreation: 0 },
    price: { source: 'model', totalUsd: 0.5 }, attempts: [],
    ...over,
  };
}

// The only evidence a pinned level was actually applied is cost moving with
// it — `drop_params: true` means a provider without an effort control drops
// the field silently — so the level has to be a dimension you can group spend
// by, not merely a field on a row.
describe('aggregate --by effort', () => {
  it('groups rows by the level the router sent', () => {
    const report = aggregate([
      row({ key: 'luna', effort: 'xhigh', price: { source: 'model', totalUsd: 1 } }),
      row({ key: 'luna', effort: 'xhigh', price: { source: 'model', totalUsd: 2 } }),
      row({ key: 'luna', effort: 'low', price: { source: 'model', totalUsd: 0.25 } }),
    ], 'effort', {});
    expect(report.buckets.map((b) => [b.label, b.costUsd])).toEqual([
      ['xhigh', 3], ['low', 0.25],
    ]);
  });

  it('labels a bare candidate rather than dropping it', () => {
    // A request sent with no level is not an absence of data — it is the
    // no-level baseline the pinned rows must be compared against.
    const report = aggregate([row({ key: 'flash' })], 'effort', {});
    expect(report.buckets.map((b) => b.label)).toEqual(['none sent']);
  });
});

describe('parseDuration', () => {
  it('parses days, hours and minutes', () => {
    expect(parseDuration('7d')).toBe(7 * 24 * 3600 * 1000);
    expect(parseDuration('12h')).toBe(12 * 3600 * 1000);
    expect(parseDuration('30m')).toBe(30 * 60 * 1000);
  });
  it('rejects nonsense', () => {
    expect(() => parseDuration('soon')).toThrow(/duration/i);
  });
  it('rejects a duration that overflows to Infinity', () => {
    // 306 nines parses as a finite Number (1e306) but multiplies past Number.MAX_VALUE.
    expect(() => parseDuration('9'.repeat(306) + 'd')).toThrow(/duration/i);
  });
});

describe('aggregate', () => {
  it('groups by model and sums tokens and cost', () => {
    const report = aggregate([row(), row()], 'model', {});
    expect(report.buckets).toHaveLength(1);
    expect(report.buckets[0]).toMatchObject({ label: 'flash', requests: 2, input: 200, output: 20, costUsd: 1 });
    expect(report.pricedTotalUsd).toBe(1);
  });

  // Issue #30: the router has always written a failed candidate into the row's
  // `attempts`, and nothing read it. A candidate that failed on every attempt
  // therefore had no row of its own in any breakdown — `sonata usage` showed
  // the serving model and no trace of the one that killed the agent.
  it('surfaces candidates a request fell past, which appear in no model row', () => {
    const report = aggregate([
      row({ attempts: [{ key: 'deepseek-flash', status: 400 }] }),
      row({ attempts: [{ key: 'deepseek-flash', status: 503 }, { key: 'luna', status: 429 }] }),
    ], 'model', {});

    // The served model is still the only bucket: an attempt is not a request.
    expect(report.buckets.map((b) => b.label)).toEqual(['flash']);
    expect(report.buckets[0].requests).toBe(2);

    expect(report.failedAttempts).toEqual([
      { key: 'deepseek-flash', count: 2, statuses: [400, 503] },
      { key: 'luna', count: 1, statuses: [429] },
    ]);
  });

  it('reports no failed attempts when every request was served first time', () => {
    expect(aggregate([row(), row()], 'model', {}).failedAttempts).toEqual([]);
  });

  it('keeps unpriced volume out of the total and counts it separately', () => {
    const report = aggregate([row(), row({ price: { source: 'none' } })], 'model', {});
    expect(report.pricedTotalUsd).toBe(0.5);
    expect(report.unpriced).toMatchObject({ requests: 1, input: 100, output: 10 });
    expect(report.buckets[0].unpricedRequests).toBe(1);
  });

  it('reports covered work separately from priced totals', () => {
    const report = aggregate([
      row(),
      row({ price: { source: 'covered', totalUsd: 2 } }),
    ], 'model', {});
    expect(report.pricedTotalUsd).toBe(0.5);
    expect(report.covered).toEqual({ requests: 1, totalUsd: 2 });
    // costUsd is spend and excludes covered, so the cost column agrees with
    // `priced total`. Blending them left ` ~` as the only signal, and a flag
    // cannot say how much: $167.10 with $0.000000 covered rendered the same
    // as $10.34 with all of it covered.
    expect(report.buckets[0]).toMatchObject({ costUsd: 0.5, coveredUsd: 2, coveredRequests: 1 });
  });

  it('counts a known-zero rate as priced, not unpriced', () => {
    const report = aggregate([row({ price: { source: 'gateway', totalUsd: 0 } })], 'model', {});
    // The row must be counted at all (a $0 charge that went missing read the
    // same as a free tier until these two assertions discriminate it).
    expect(report.buckets[0]).toMatchObject({ requests: 1, unpricedRequests: 0, costUsd: 0 });
    expect(report.unpriced.requests).toBe(0);
    expect(report.pricedTotalUsd).toBe(0);
  });

  it('groups by route: auto, manual, and unlabelled', () => {
    const rows = [
      row({ tier: 'simple', route: 'auto' }),
      row({ tier: 'complex', route: 'manual' }),
      row({ tier: 'complex' }),
    ];
    const report = aggregate(rows, 'route', {});
    expect(report.buckets.map((b) => b.label).sort()).toEqual(['auto', 'manual', '—'].sort());
  });

  it('summarises classifier decisions and tokens, never pricing them', () => {
    const rows = [
      row({ route: 'auto', autoRoute: { classifier: 'jev', outcome: 'accepted', ms: 300, tokens: { input: 300, output: 30 } } }),
      row({ route: 'auto', autoRoute: { classifier: 'jev', outcome: 'low-confidence', ms: 280, tokens: { input: 310, output: 30 } } }),
      row({ route: 'auto', autoRoute: { classifier: 'jev', outcome: 'failed', ms: 3000 } }),
    ];
    const report = aggregate(rows, 'tier', {});
    expect(report.autoRoute).toEqual({
      outcomes: { accepted: 1, 'low-confidence': 1, invalid: 0, failed: 1 },
      classifierTokens: { input: 610, output: 60 },
    });
    expect(report.pricedTotalUsd).toBe(aggregate(rows.map(({ autoRoute: _, ...r }) => r), 'tier', {}).pricedTotalUsd);
  });

  it('groups by role, tier and gateway', () => {
    expect(aggregate([row()], 'role', {}).buckets[0].label).toBe('code');
    expect(aggregate([row()], 'tier', {}).buckets[0].label).toBe('simple');
    expect(aggregate([row()], 'gateway', {}).buckets[0].label).toBe('acme');
  });

  it('groups by project using the session map', () => {
    const sessions = { s1: { session: 's1', cwd: '/repo/a', started: '2026-08-27T10:00:00.000Z' } };
    expect(aggregate([row()], 'project', sessions).buckets[0].label).toBe('/repo/a');
  });

  it("groups by the row's own project before falling back to the session join", () => {
    const rows = [
      row({ project: '/p/a', session: 's1' }),
      row({ session: 's2' }),
    ];
    const report = aggregate(rows, 'project', { s2: { session: 's2', cwd: '/p/b', started: '' } });
    expect(report.buckets.map((b) => b.label).sort()).toEqual(['/p/a', '/p/b']);
  });

  it('labels a session with no map entry as unknown rather than dropping it', () => {
    const report = aggregate([row({ session: 'ghost' })], 'project', {});
    expect(report.buckets[0].label).toBe('unknown');
    expect(report.buckets[0].requests).toBe(1);
  });

  it('groups anthropic rows by their model, so the baseline is comparable', () => {
    const report = aggregate(
      [row(), row({ upstream: 'anthropic', key: undefined, alias: 'claude-sonnet-5', role: undefined, tier: undefined })],
      'model',
      {},
    );
    expect(report.buckets.map((b) => b.label).sort()).toEqual(['claude-sonnet-5', 'flash']);
  });

  it('sorts buckets by cost descending', () => {
    const report = aggregate(
      [row({ key: 'cheap', price: { source: 'model', totalUsd: 0.1 } }), row({ key: 'dear', price: { source: 'model', totalUsd: 9 } })],
      'model',
      {},
    );
    expect(report.buckets.map((b) => b.label)).toEqual(['dear', 'cheap']);
  });

  it('returns an empty report for no rows', () => {
    expect(aggregate([], 'model', {})).toMatchObject({ buckets: [], pricedTotalUsd: 0 });
  });
});
describe('spend and covered are separate columns, and the cost column sums to the total', () => {
  it('never folds covered work into costUsd', () => {
    const report = aggregate([
      row({ key: 'a', price: { source: 'models-dev', totalUsd: 1 } }),
      row({ key: 'b', price: { source: 'covered', totalUsd: 100 } }),
    ], 'model', {});
    const summed = report.buckets.reduce((total, bucket) => total + bucket.costUsd, 0);
    // The invariant that was broken: summing the cost column disagreed with
    // the report's own `priced total` whenever any covered row existed.
    expect(summed).toBeCloseTo(report.pricedTotalUsd, 10);
    expect(report.covered.totalUsd).toBe(100);
  });

  it('keeps a covered-only bucket at the top rather than sinking it to zero cost', () => {
    const report = aggregate([
      row({ key: 'small-spend', price: { source: 'models-dev', totalUsd: 1 } }),
      row({ key: 'big-covered', price: { source: 'covered', totalUsd: 100 } }),
    ], 'model', {});
    // Ordering is by total value; a bucket that is entirely subscription work
    // is still the largest thing in the report.
    expect(report.buckets[0].label).toBe('big-covered');
    expect(report.buckets[0].costUsd).toBe(0);
    expect(report.buckets[0].coveredUsd).toBe(100);
  });
});

describe('project grouping resolves a worktree to its main checkout', () => {
  // The mismatch this fixes: `[budget] daily_usd` pools a worktree with its
  // main checkout (they share one resolved config), while the report listed
  // them separately — so a cap could refuse at a number appearing nowhere on
  // screen. Grouping is computed at report time via configPath, not read from
  // the row's `tenant`: only 2,871 of 24,774 rows on the development machine
  // carry a tenant id, so tenant grouping would bucket 88% as "unknown".
  const MINIMAL = `
[models."m"]
harness = "codex"
id = "gpt-5.6-sol"

[generate.roles]
code = ["m"]
`;
  let home: string;
  let main: string;
  let worktree: string;

  beforeEach(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'usage-wt-')));
    home = join(root, 'home');
    main = join(root, 'main');
    mkdirSync(home, { recursive: true });
    mkdirSync(main, { recursive: true });
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
      cwd, stdio: 'pipe',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
    git(main, 'init', '-q', '.');
    git(main, 'config', 'user.email', 'a@b.test');
    git(main, 'config', 'user.name', 'a');
    writeFileSync(join(main, 'f'), 'x\n');
    git(main, 'add', 'f');
    git(main, 'commit', '-qm', 'x');
    writeFileSync(join(main, 'sonata.toml'), MINIMAL);
    worktree = join(root, 'wt');
    git(main, 'worktree', 'add', '-q', worktree, '-b', 'wt');
  });

  it('labels a worktree row with the main checkout', () => {
    expect(projectResolver(home)(worktree)).toBe(main);
  });

  it('pools worktree and main-checkout rows into one bucket', () => {
    const report = aggregate([
      row({ project: main, price: { source: 'models-dev', totalUsd: 1 } }),
      row({ project: worktree, price: { source: 'models-dev', totalUsd: 2 } }),
    ], 'project', {}, projectResolver(home));
    expect(report.buckets).toHaveLength(1);
    expect(report.buckets[0]).toMatchObject({ label: main, costUsd: 3, requests: 2 });
  });

  // A deleted worktree cannot be resolved, and inventing a parent from the
  // path shape would be a guess. Keep what was recorded.
  it('keeps the recorded path for a directory that no longer exists', () => {
    const gone = join(main, 'never-existed');
    expect(projectResolver(home)(gone)).toBe(gone);
  });

  // `--project` is documented as "any directory inside it", but configPath
  // checks only the directory itself, so a subdirectory labelled as itself
  // and matched no row — an empty report with no error.
  describe('cmdUsage --project names the project by any directory inside it', () => {
    const requests = (report: { buckets: { requests: number }[] }) =>
      report.buckets.reduce((sum, bucket) => sum + bucket.requests, 0);
    const recent = () => new Date(Date.now() - 60_000).toISOString();

    beforeEach(() => {
      appendRow(home, row({ ts: recent(), project: main, price: { source: 'models-dev', totalUsd: 1 } }));
      appendRow(home, row({ ts: recent(), project: '/elsewhere', price: { source: 'models-dev', totalUsd: 2 } }));
    });

    it('selects the project from a nested subdirectory of the main checkout', async () => {
      const deep = join(main, 'src', 'deep');
      mkdirSync(deep, { recursive: true });
      const report = await cmdUsage({ home, since: '1d', by: 'project', project: deep, json: true });
      expect(requests(report)).toBe(1);
      expect(report.buckets[0]?.label).toBe(main);
    });

    it('selects the project from a subdirectory of a linked worktree', async () => {
      const sub = join(worktree, 'sub');
      mkdirSync(sub, { recursive: true });
      const report = await cmdUsage({ home, since: '1d', by: 'project', project: sub, json: true });
      expect(requests(report)).toBe(1);
    });

    it('keeps today\'s behaviour for a directory with no project above it', async () => {
      const lone = realpathSync(mkdtempSync(join(tmpdir(), 'usage-lone-')));
      appendRow(home, row({ ts: recent(), project: lone, price: { source: 'models-dev', totalUsd: 4 } }));
      const report = await cmdUsage({ home, since: '1d', by: 'project', project: lone, json: true });
      expect(requests(report)).toBe(1);
      expect(report.buckets[0]?.label).toBe(lone);
    });
  });
});

describe('cmdUsage --project — subdirectory rows, $HOME and deleted directories', () => {
  // Rows are labelled by their exact recorded cwd, while `--project` walked up
  // to the enclosing project: a row recorded at <repo>/sub was then selectable
  // by no argument at all. A stray ~/sonata.toml made every unconfigured
  // directory under $HOME resolve to $HOME itself.
  let home: string;
  let repo: string;
  let sub: string;
  let other: string;
  const recent = () => new Date(Date.now() - 60_000).toISOString();
  const pick = async (project: string) => {
    const report = await cmdUsage({ home, since: '1d', by: 'project', project, json: true });
    return report.buckets.reduce((sum, bucket) => sum + bucket.requests, 0);
  };

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'usage-scope-home-')));
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(join(home, '.config', 'sonata', 'sonata.toml'), MINIMAL);
    repo = join(home, 'repo');
    sub = join(repo, 'sub');
    other = join(home, 'other');
    mkdirSync(sub, { recursive: true });
    mkdirSync(other);
    writeFileSync(join(repo, 'sonata.toml'), MINIMAL);
    for (const project of [repo, sub, other]) appendRow(home, row({ ts: recent(), project }));
  });
  const MINIMAL = 'schema_version = 1\n';

  it('selects a row recorded in a subdirectory, by the subdirectory or by the project', async () => {
    expect(await pick(repo)).toBe(2);
    expect(await pick(sub)).toBe(2);
    expect(await pick(other)).toBe(1);
  });

  it('never resolves to $HOME itself, even with a stray ~/sonata.toml', async () => {
    writeFileSync(join(home, 'sonata.toml'), MINIMAL);
    expect(await pick(other)).toBe(1);
    expect(await pick(repo)).toBe(2);
    expect(await pick(sub)).toBe(2);
  });

  it('keeps a nested project out of its parent, and its parent out of it', async () => {
    // A nested sonata.toml is a different project. Selecting by path prefix
    // alone folded ~/repo/packages/app's rows into ~/repo.
    const app = join(repo, 'packages', 'app');
    const appSrc = join(app, 'src');
    mkdirSync(appSrc, { recursive: true });
    writeFileSync(join(app, 'sonata.toml'), MINIMAL);
    appendRow(home, row({ ts: recent(), project: app }));
    appendRow(home, row({ ts: recent(), project: appSrc }));
    // repo + repo/sub, not app or app/src.
    expect(await pick(repo)).toBe(2);
    // app + app/src, not repo.
    expect(await pick(app)).toBe(2);
    expect(await pick(appSrc)).toBe(2);
    // A plain subdirectory of repo still counts for repo.
    expect(await pick(sub)).toBe(2);
  });

  it('keeps a deleted directory as recorded rather than walking to its parent', async () => {
    const gone = join(repo, 'gone');
    mkdirSync(gone);
    appendRow(home, row({ ts: recent(), project: gone }));
    rmSync(gone, { recursive: true });
    expect(await pick(gone)).toBe(1);
  });
});

describe('aggregate — completed streams that reported no prompt tokens', () => {
  // Measured 2026-09-18: `openrouter-z-ai-glm-5.3-flash` recorded 0 prompt
  // tokens on 77 of 77 COMPLETED 200 streams, while OpenRouter's own API
  // returns `prompt_tokens` for that model in a plain stream. The count is
  // lost in translation upstream of sonata, so the request is priced on output
  // alone — and at this traffic's ~240:1 prompt:output ratio that understates
  // spend by about two orders of magnitude. `[budget]` counts priced spend, so
  // the cap cannot see it either.
  //
  // Sonata cannot invent the tokens. It can refuse to present the result as
  // complete, which is the same honesty rule unpriced volume already follows:
  // a total that treats "unknown" as zero is worse than no total.
  const zero = { input: 0, output: 7, cacheRead: 0, cacheCreation: 0 };

  it('counts a completed row with output but no prompt tokens', () => {
    const report = aggregate([row({ tokens: zero })], 'model', {});
    expect(report.noPromptTokens.requests).toBe(1);
    expect(report.noPromptTokens.output).toBe(7);
  });

  it('does not count a row whose prompt tokens arrived as cache reads', () => {
    // Anthropic puts most prompt tokens in `cacheRead`; counting only `input`
    // would flag almost every healthy Claude request. That mistake was made
    // once while diagnosing this and inverted the conclusion entirely.
    const cached = { input: 0, output: 7, cacheRead: 4096, cacheCreation: 0 };
    expect(aggregate([row({ tokens: cached })], 'model', {}).noPromptTokens.requests).toBe(0);
  });

  it('ignores an incomplete stream, which is expected to report nothing', () => {
    // An aborted stream never delivers usage. That is ordinary, and flagging
    // it would bury the real signal: most zero-prompt rows in a real ledger
    // are incomplete ones.
    expect(aggregate([row({ tokens: zero, complete: false })], 'model', {}).noPromptTokens.requests).toBe(0);
  });

  it('ignores a row that produced no output either', () => {
    // Nothing was generated, so nothing was under-counted.
    const nothing = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    expect(aggregate([row({ tokens: nothing })], 'model', {}).noPromptTokens.requests).toBe(0);
  });
});

describe('parseUsageFlags', () => {
  it('defaults to a week by model', () => {
    expect(parseUsageFlags([])).toMatchObject({ by: 'model', since: '7d', json: false });
  });
  it('refuses a bad --by or --since before any screen opens', () => {
    expect(() => parseUsageFlags(['--by', 'colour'])).toThrow(/--by must be one of/);
    expect(() => parseUsageFlags(['--since', 'soon'])).toThrow(/duration/);
    expect(() => parseUsageFlags(['--sincee', '1d'])).toThrow();
  });
});
