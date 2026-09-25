import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { UsageResult } from '../src/adapters/types.js';
import { dispatchBudgetStatuses, spentTodayUsd } from '../src/budget.js';
import { BudgetRefusedError, cmdDispatch } from '../src/commands/dispatch.js';
import { loadConfig } from '../src/config.js';
import { priceHarnessRun, readRecordedUsage, recordHarnessUsage } from '../src/harness-usage.js';
import { readRows } from '../src/ledger.js';
import { canonicalConfigPath, tenantId } from '../src/native/tenants.js';
import type { RunMeta } from '../src/types.js';

let home: string;
let cwd: string;
const START = '2026-09-25T04:00:00.000Z';
const END = Date.parse('2026-09-25T04:10:00.000Z');

const CONFIG = `
[models."kimi"]
harness = "opencode"
id = "openrouter/kimi-k3"

[models."priced"]
harness = "opencode"
id = "openrouter/priced"

[models."priced".price]
input = 1.0
output = 2.0
`;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'sonata-hu-home-')));
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'sonata-hu-cwd-')));
  writeFileSync(join(cwd, 'sonata.toml'), CONFIG);
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function finishedRun(model = 'kimi'): RunMeta {
  const meta: RunMeta = {
    id: 'r1', role: 'code', model, harness: 'opencode', mode: 'acceptEdits', interactive: false,
    session: 'sonata-r1', cwd, startedAt: START, harnessModelId: `openrouter/${model === 'kimi' ? 'kimi-k3' : model}`,
  };
  const dir = join(cwd, '.sonata', 'runs', 'r1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'exit'), '0');
  utimesSync(join(dir, 'exit'), new Date(END), new Date(END));
  return meta;
}

const observed = (costUsd?: number): UsageResult => ({
  kind: 'observed',
  session: 'ses_1',
  records: [
    { ts: START, tokens: { input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0 }, ...(costUsd === undefined ? {} : { costUsd }) },
    { ts: START, tokens: { input: 0, output: 1_000_000, cacheRead: 0, cacheCreation: 0 }, ...(costUsd === undefined ? {} : { costUsd }) },
  ],
});

function record(result: UsageResult, meta = finishedRun()) {
  let calls = 0;
  const adapter = { usage: () => { calls += 1; return result; } };
  const out = recordHarnessUsage({ cwd, home, meta, config: loadConfig(cwd, home), adapter, modelsDev: undefined });
  return { out, calls: () => calls, adapter, meta };
}

describe('recordHarnessUsage', () => {
  it('appends one ledger row per run, attributed to the project, and counts toward spend', () => {
    const { out } = record(observed(0.75));
    expect(out).toMatchObject({ kind: 'observed', price: { source: 'harness', totalUsd: 1.5 } });
    const rows = readRows(home, 0, END + 1000);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      upstream: 'harness', harness: 'opencode', run: 'r1', key: 'kimi', session: 'ses_1', project: cwd,
      tenant: tenantId(canonicalConfigPath(join(cwd, 'sonata.toml'))),
      tokens: { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheCreation: 0 },
    });
    // Round-trips through the ledger's validation into the budget sum — a new
    // price source missing from the allow-list would silently read as $0 here.
    expect(spentTodayUsd(home, END + 1000)).toBeCloseTo(1.5);
    expect(spentTodayUsd(home, END + 1000, { tenant: rows[0]!.tenant })).toBeCloseTo(1.5);
  });

  it('records a run once, however many times it is tailed', () => {
    const first = record(observed(0.75));
    const again = recordHarnessUsage({
      cwd, home, meta: first.meta, config: loadConfig(cwd, home), adapter: first.adapter, modelsDev: undefined,
    });
    expect(first.calls()).toBe(1);
    expect(again).toEqual(first.out);
    expect(readRows(home, 0, END + 1000)).toHaveLength(1);
  });

  it('writes no row for an unobservable or router-counted run, and says why', () => {
    record({ kind: 'unobservable', reason: '2 opencode sessions ran here' });
    expect(readRows(home, 0, END + 1000)).toHaveLength(0);
    expect(readRecordedUsage(cwd, 'r1')).toEqual({ kind: 'unobservable', reason: '2 opencode sessions ran here' });
  });

  it('writes an unpriced row rather than a free one when no cost is known', () => {
    record(observed());
    const [row] = readRows(home, 0, END + 1000);
    expect(row!.price).toEqual({ source: 'none' });
    expect(spentTodayUsd(home, END + 1000)).toBe(0);
  });

  it('survives a reader that throws', () => {
    const meta = finishedRun();
    const out = recordHarnessUsage({
      cwd, home, meta, config: loadConfig(cwd, home), modelsDev: undefined,
      adapter: { usage: () => { throw new Error('boom'); } },
    });
    expect(out.kind).toBe('unobservable');
    expect(existsSync(join(cwd, '.sonata', 'runs', 'r1', 'usage.json'))).toBe(true);
  });
});

describe('priceHarnessRun', () => {
  const tokens = { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheCreation: 0 };
  const records = [{ ts: START, tokens, costUsd: 9 }];

  it('prefers the config\'s own rate over the harness\'s number', () => {
    const price = priceHarnessRun(loadConfig(cwd, home), { model: 'priced', harness: 'opencode' }, tokens, records, new Date(END), undefined);
    expect(price).toEqual({ source: 'model', totalUsd: 3 });
  });

  it('uses the harness cost only when every record carries one', () => {
    const config = loadConfig(cwd, home);
    const meta = { model: 'kimi', harness: 'opencode', harnessModelId: 'openrouter/kimi-k3' };
    expect(priceHarnessRun(config, meta, tokens, records, new Date(END), undefined)).toEqual({ source: 'harness', totalUsd: 9 });
    expect(priceHarnessRun(config, meta, tokens, [...records, { ts: START, tokens }], new Date(END), undefined))
      .toEqual({ source: 'none' });
  });

  it('falls back to models.dev under the provider the harness id names', () => {
    const modelsDev = { fetchedAt: START, providers: { openrouter: { 'kimi-k3': { input: 0.5, output: 1 } } } };
    const price = priceHarnessRun(
      loadConfig(cwd, home), { model: 'kimi', harness: 'opencode', harnessModelId: 'openrouter/kimi-k3' },
      tokens, [{ ts: START, tokens }], new Date(END), modelsDev,
    );
    expect(price).toMatchObject({ source: 'models-dev', totalUsd: 1.5 });
  });
});

describe('dispatch budget', () => {
  it('names the project cap and the machine cap, each with its own spend', () => {
    writeFileSync(join(cwd, 'sonata.toml'), `${CONFIG}\n[budget]\ndaily_usd = 1\n`);
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(join(home, '.config', 'sonata', 'sonata.toml'), `${CONFIG}\n[budget]\ndaily_usd = 5\n`);
    record(observed(0.75));
    const statuses = dispatchBudgetStatuses(cwd, home, END + 1000);
    expect(statuses?.map((s) => [s.dailyUsd, Number(s.spentUsd.toFixed(2))])).toEqual([[1, 1.5], [5, 1.5]]);
  });

  it('refuses before launching anything once a cap is reached', async () => {
    writeFileSync(join(cwd, 'sonata.toml'), `${CONFIG}\n[budget]\ndaily_usd = 1\n`);
    record(observed(0.75));
    let launched = false;
    await expect(cmdDispatch(
      { cwd, home, model: 'kimi', task: 't', rolesDir: '/roles' },
      { run: async () => { launched = true; throw new Error('unreachable'); } },
    )).rejects.toBeInstanceOf(BudgetRefusedError);
    expect(launched).toBe(false);
  });
});
