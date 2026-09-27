import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { budgetRefusal, dispatchBudgetStatuses, spentTodayUsd, startOfUtcDay, unreadableMachineBudget, type BudgetStatus } from '../src/budget.js';
import { appendRow, type LedgerPrice, type LedgerRow } from '../src/ledger.js';
import { GLOBAL_CONFIG_RELATIVE, parseConfig } from '../src/config.js';
import { routeRequest, type RouterDeps } from '../src/native/router.js';

function row(ts: string, price: LedgerPrice, over: Partial<LedgerRow> = {}): LedgerRow {
  return {
    ts,
    ms: 10,
    alias: 'sonata-code-simple',
    upstream: 'litellm',
    status: 200,
    complete: true,
    tokens: { input: 10, output: 10, cacheRead: 0, cacheCreation: 0 },
    price,
    attempts: [],
    ...over,
  };
}

describe('spentTodayUsd', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sonata-budget-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const noon = Date.parse('2026-09-03T12:00:00.000Z');

  it('is zero with no ledger at all', () => {
    expect(spentTodayUsd(home, noon)).toBe(0);
  });

  it('sums priced rows from the current UTC day', () => {
    appendRow(home, row('2026-09-03T01:00:00.000Z', { source: 'model', totalUsd: 0.25 }));
    appendRow(home, row('2026-09-03T02:00:00.000Z', { source: 'gateway', totalUsd: 0.75 }));
    expect(spentTodayUsd(home, noon)).toBeCloseTo(1.0, 10);
  });

  it('counts a real zero price, which a free tier produces', () => {
    // `source: 'none'` is the unpriced marker; a totalUsd of 0 is a price.
    appendRow(home, row('2026-09-03T01:00:00.000Z', { source: 'model', totalUsd: 0 }));
    expect(spentTodayUsd(home, noon)).toBe(0);
  });

  it('excludes covered work from spend and budget refusals', () => {
    appendRow(home, row('2026-09-03T01:00:00.000Z', { source: 'covered', totalUsd: 999 }));
    expect(spentTodayUsd(home, noon)).toBe(0);
    expect(budgetRefusal([{ dailyUsd: 0.01, spentUsd: spentTodayUsd(home, noon), configPath: '/test/sonata.toml' }])).toBeUndefined();
  });

  it('never folds unpriced rows in as zero-cost spend', () => {
    // The honesty constraint: unpriced is spend of unknown size, not spend of
    // no size. It is excluded from the total rather than counted as 0, which
    // is why real spending can exceed a cap — a limitation the refusal states
    // out loud instead of hiding.
    appendRow(home, row('2026-09-03T01:00:00.000Z', { source: 'none' }));
    appendRow(home, row('2026-09-03T02:00:00.000Z', { source: 'model', totalUsd: 0.5 }));
    expect(spentTodayUsd(home, noon)).toBeCloseTo(0.5, 10);
  });

  it('ignores yesterday', () => {
    appendRow(home, row('2026-09-02T23:59:59.000Z', { source: 'model', totalUsd: 99 }));
    appendRow(home, row('2026-09-03T00:00:01.000Z', { source: 'model', totalUsd: 1 }));
    expect(spentTodayUsd(home, noon)).toBeCloseTo(1, 10);
  });

  it('cuts the day on UTC midnight', () => {
    expect(startOfUtcDay(noon)).toBe(Date.parse('2026-09-03T00:00:00.000Z'));
  });

  it('filters to one tenant when asked, and counts everything when not', () => {
    appendRow(home, row('2026-09-03T03:00:00.000Z', { source: 'model', totalUsd: 1 }, { project: '/p/a', tenant: 't1' }));
    appendRow(home, row('2026-09-03T04:00:00.000Z', { source: 'model', totalUsd: 2 }, { project: '/p/b', tenant: 't2' }));
    expect(spentTodayUsd(home, noon, { tenant: 't1' })).toBe(1);
    expect(spentTodayUsd(home, noon)).toBe(3);
  });

  it('sums one project entered under two cwd spellings as one tenant', () => {
    // The defect: a project cap keyed on the raw cwd string gave a repository
    // one bucket per directory spelling — `daily_usd = 25` became 25 per
    // spelling. One `sonata.toml` is one tenant however it was reached.
    appendRow(home, row('2026-09-03T03:00:00.000Z', { source: 'model', totalUsd: 1 }, { project: '/repo', tenant: 't1' }));
    appendRow(home, row('2026-09-03T04:00:00.000Z', { source: 'model', totalUsd: 2 }, { project: '/repo/sub', tenant: 't1' }));
    appendRow(home, row('2026-09-03T05:00:00.000Z', { source: 'model', totalUsd: 4 }, { project: '/link/to/repo', tenant: 't1' }));
    expect(spentTodayUsd(home, noon, { tenant: 't1' })).toBe(7);
  });
});

describe('budgetRefusal — several caps', () => {
  it("refuses on the first cap reached and names that cap's file", () => {
    const msg = budgetRefusal([
      { dailyUsd: 10, spentUsd: 1, configPath: '/p/a/sonata.toml' },
      { dailyUsd: 2, spentUsd: 2, configPath: '/home/u/.config/sonata/sonata.toml' },
    ]);
    expect(msg).toContain('/home/u/.config/sonata/sonata.toml');
    expect(msg).toContain('$2.0000 of $2.00');
  });

  it('is undefined when every cap has room, or there are none', () => {
    expect(budgetRefusal([{ dailyUsd: 10, spentUsd: 1, configPath: '/x' }])).toBeUndefined();
    expect(budgetRefusal([])).toBeUndefined();
    expect(budgetRefusal(undefined)).toBeUndefined();
  });
});

describe('budgetRefusal', () => {
  it('is undefined when no cap is configured', () => {
    expect(budgetRefusal(undefined)).toBeUndefined();
  });

  it('is undefined under the cap', () => {
    expect(budgetRefusal([{ dailyUsd: 5, spentUsd: 4.99, configPath: '/test/sonata.toml' }])).toBeUndefined();
  });

  it('refuses at the cap, not only past it', () => {
    // The next request's cost is unknown before it runs, so the only place to
    // stop is before forwarding the one that would cross the line.
    expect(budgetRefusal([{ dailyUsd: 5, spentUsd: 5, configPath: '/test/sonata.toml' }])).toBeDefined();
  });

  it('names the cap, the spend, and the file to edit', () => {
    const message = budgetRefusal([{ dailyUsd: 5, spentUsd: 6.5, configPath: '/test/sonata.toml' }])!;
    expect(message).toContain('$6.5000');
    expect(message).toContain('$5.00');
    expect(message).toContain('daily_usd');
    expect(message).toContain('sonata.toml');
  });

  it('states both limits it inherits', () => {
    // A refusal that overstates its own coverage is worse than none: the user
    // would believe dispatch spend and unpriced volume were capped too.
    const message = budgetRefusal([{ dailyUsd: 1, spentUsd: 1, configPath: '/test/sonata.toml' }])!;
    expect(message).toContain('priced');
    expect(message).toContain('dispatch');
  });

  it('refuses an unreadable cap by name, before any spend comparison', () => {
    // A cap that cannot be read must not read as "no cap". `spentUsd <
    // dailyUsd` here on purpose — the unreadable check has to fire first, or
    // a broken file whose (lost) cap had room would read as room that exists.
    const status: BudgetStatus = {
      dailyUsd: 5, spentUsd: 0, configPath: '/m/sonata.toml', unreadable: 'Unexpected token',
    };
    expect(budgetRefusal([status])).toBe(
      'sonata budget cannot be checked: /m/sonata.toml sets [budget] but will not load ' +
      '(Unexpected token). Fix the file to continue — sonata refuses rather than spend without the cap.',
    );
  });
});

/** Broken TOML (an unterminated table header) that still carries a real `[budget]` line. */
const BROKEN_WITH_BUDGET = '[budget]\ndaily_usd = 5\n[native.gateways\n';
const BROKEN_WITHOUT_BUDGET = '[native.gateways\n';

function writeMachineAt(home: string, toml: string): void {
  mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
  writeFileSync(join(home, GLOBAL_CONFIG_RELATIVE), toml);
}

describe('unreadableMachineBudget', () => {
  let home: string;
  const machinePath = () => join(home, GLOBAL_CONFIG_RELATIVE);

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sonata-budget-home-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('returns a refusing status for a machine config that will not load and had a [budget] table', () => {
    writeMachineAt(home, BROKEN_WITH_BUDGET);
    const status = unreadableMachineBudget(home);
    expect(status).toMatchObject({ dailyUsd: 0, spentUsd: 0, configPath: machinePath() });
    expect(status?.unreadable).toBeTruthy();
    expect(budgetRefusal([status!])).toContain(machinePath());
    expect(budgetRefusal([status!])).toContain('sets [budget] but will not load');
    expect(budgetRefusal([status!])).toContain(status!.unreadable!);
  });

  it('leaves a broken machine config with no [budget] table alone — it had no cap to lose', () => {
    // A file that never set a cap must not start refusing everything just
    // because it is broken: that trades one silent failure for an outage
    // nobody asked for.
    writeMachineAt(home, BROKEN_WITHOUT_BUDGET);
    expect(unreadableMachineBudget(home)).toBeUndefined();
  });

  it('counts [budget] only as a table header on its own line', () => {
    writeMachineAt(home, '# [budget]\n[native.gateways\n');
    expect(unreadableMachineBudget(home)).toBeUndefined();
  });

  it('leaves a loadable machine config to the ordinary cap path', () => {
    writeMachineAt(home, '[budget]\ndaily_usd = 5\n');
    expect(unreadableMachineBudget(home)).toBeUndefined();
  });

  it('says nothing when there is no machine config at all', () => {
    expect(unreadableMachineBudget(home)).toBeUndefined();
  });
});

describe('dispatchBudgetStatuses', () => {
  let home: string;
  let cwd: string;
  const machinePath = () => join(home, GLOBAL_CONFIG_RELATIVE);

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sonata-budget-home-'));
    cwd = mkdtempSync(join(tmpdir(), 'sonata-budget-cwd-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it('includes the unreadable machine status when the machine config had a cap to lose', () => {
    writeMachineAt(home, BROKEN_WITH_BUDGET);
    const statuses = dispatchBudgetStatuses(cwd, home);
    expect(statuses).toHaveLength(1);
    expect(statuses?.[0]).toMatchObject({ dailyUsd: 0, spentUsd: 0, configPath: machinePath() });
    expect(statuses?.[0].unreadable).toBeTruthy();
    expect(budgetRefusal(statuses)).toContain('sets [budget] but will not load');
    expect(budgetRefusal(statuses)).toContain(machinePath());
  });

  it('keeps a project cap alongside the unreadable machine status', () => {
    writeFileSync(join(cwd, 'sonata.toml'), '[budget]\ndaily_usd = 2\n');
    writeMachineAt(home, BROKEN_WITH_BUDGET);
    const statuses = dispatchBudgetStatuses(cwd, home);
    expect(statuses?.map((s) => s.dailyUsd)).toEqual([2, 0]);
    expect(statuses?.[1].unreadable).toBeTruthy();
  });

  it('says nothing extra when the machine config is broken but had no cap to lose', () => {
    writeMachineAt(home, BROKEN_WITHOUT_BUDGET);
    expect(dispatchBudgetStatuses(cwd, home)).toBeUndefined();
  });
});

describe('[budget] parsing', () => {
  const base = '[models."m"]\ngateway = "g"\nid = "x"\n\n[native.gateways."g"]\nbase_url = "https://g.example/v1"\n';

  it('is absent by default, which leaves every existing config uncapped', () => {
    expect(parseConfig(base).budget).toBeUndefined();
  });

  it('reads a positive daily_usd', () => {
    expect(parseConfig(`${base}\n[budget]\ndaily_usd = 12.5\n`).budget).toEqual({ dailyUsd: 12.5 });
  });

  it('refuses a non-numeric daily_usd', () => {
    // Refused rather than ignored: a dropped cap looks exactly like a working
    // one, since a cap's only visible effect is a refusal that has not
    // happened yet.
    expect(() => parseConfig(`${base}\n[budget]\ndaily_usd = "10"\n`))
      .toThrow(/daily_usd must be a positive number/);
  });

  it('refuses zero and negative caps', () => {
    expect(() => parseConfig(`${base}\n[budget]\ndaily_usd = 0\n`)).toThrow(/positive number/);
    expect(() => parseConfig(`${base}\n[budget]\ndaily_usd = -1\n`)).toThrow(/positive number/);
  });
});

describe('router budget enforcement', () => {
  const body = Buffer.from(JSON.stringify({ model: 'claude-sonnet-5' }));
  const req = { method: 'POST', url: '/v1/messages', headers: {}, body };

  function deps(over: Partial<RouterDeps>): RouterDeps {
    return {
      fetch: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
      litellmBase: 'http://litellm.test',
      litellmKey: 'k',
      anthropicBase: 'http://anthropic.test',
      ...over,
    };
  }

  it('forwards when no cap is configured', async () => {
    const res = await routeRequest(req, deps({ budget: () => undefined }));
    expect(res.status).toBe(200);
  });

  it('forwards under the cap', async () => {
    const res = await routeRequest(req, deps({ budget: () => [{ dailyUsd: 10, spentUsd: 1, configPath: '/test/sonata.toml' }] }));
    expect(res.status).toBe(200);
  });

  it('refuses over the cap with 429 and an Anthropic-shaped body', async () => {
    // Claude Code silently discards any error envelope but this one, which
    // would turn a deliberate cap into a generic unexplained failure.
    const res = await routeRequest(req, deps({ budget: () => [{ dailyUsd: 1, spentUsd: 2, configPath: '/test/sonata.toml' }] }));
    expect(res.status).toBe(429);
    const parsed = JSON.parse(res.body.toString());
    expect(parsed.type).toBe('error');
    expect(parsed.error.type).toBe('rate_limit_error');
    expect(parsed.error.message).toContain('daily budget reached');
  });

  it('refuses with 429 when the cap is unreadable, naming the file and the load error', async () => {
    const res = await routeRequest(req, deps({
      budget: () => [{ dailyUsd: 0, spentUsd: 0, configPath: '/m/sonata.toml', unreadable: 'Unexpected token' }],
    }));
    expect(res.status).toBe(429);
    const parsed = JSON.parse(res.body.toString());
    expect(parsed.error.type).toBe('rate_limit_error');
    expect(parsed.error.message).toContain('sets [budget] but will not load');
    expect(parsed.error.message).toContain('/m/sonata.toml');
    expect(parsed.error.message).toContain('Unexpected token');
  });

  it('never reaches the upstream when refusing', async () => {
    let called = 0;
    const res = await routeRequest(req, deps({
      fetch: (async () => { called += 1; return new Response('{}', { status: 200 }); }) as unknown as typeof fetch,
      budget: () => [{ dailyUsd: 1, spentUsd: 5, configPath: '/test/sonata.toml' }],
    }));
    expect(res.status).toBe(429);
    expect(called).toBe(0);
  });

  it('caps a tier request too, not only a direct one', async () => {
    // A cap enforced on one of the two branches is not a cap. The check sits
    // above both, so a tier alias cannot route around it.
    const tierReq = { ...req, body: Buffer.from(JSON.stringify({ model: 'sonata-code-simple' })) };
    const res = await routeRequest(tierReq, deps({
      budget: () => [{ dailyUsd: 1, spentUsd: 5, configPath: '/test/sonata.toml' }],
      resolveTier: () => ({
        role: 'code',
        tier: 'simple',
        routes: [{ key: 'm', native: { gateway: 'g', id: 'x' } }],
      }),
    }));
    expect(res.status).toBe(429);
  });

  it('re-reads the cap per request, so raising it frees the router', async () => {
    // Without this a user who raised the cap would have to run `sonata
    // restart` to be believed, and would reasonably read that as a bug.
    let spent = 5;
    const d = deps({ budget: () => [{ dailyUsd: 10, spentUsd: spent, configPath: '/test/sonata.toml' }] });
    spent = 20;
    expect((await routeRequest(req, d)).status).toBe(429);
    spent = 1;
    expect((await routeRequest(req, d)).status).toBe(200);
  });
});
