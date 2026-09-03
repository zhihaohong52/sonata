import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { budgetRefusal, spentTodayUsd, startOfUtcDay } from '../src/budget.js';
import { appendRow, type LedgerPrice, type LedgerRow } from '../src/ledger.js';
import { parseConfig } from '../src/config.js';
import { routeRequest, type RouterDeps } from '../src/native/router.js';

function row(ts: string, price: LedgerPrice): LedgerRow {
  return {
    ts,
    ms: 10,
    alias: 'sonata-code-simple',
    upstream: 'litellm',
    status: 200,
    complete: true,
    tokens: { input: 10, output: 10 },
    price,
    attempts: [],
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
});

describe('budgetRefusal', () => {
  it('is undefined when no cap is configured', () => {
    expect(budgetRefusal(undefined)).toBeUndefined();
  });

  it('is undefined under the cap', () => {
    expect(budgetRefusal({ dailyUsd: 5, spentUsd: 4.99 })).toBeUndefined();
  });

  it('refuses at the cap, not only past it', () => {
    // The next request's cost is unknown before it runs, so the only place to
    // stop is before forwarding the one that would cross the line.
    expect(budgetRefusal({ dailyUsd: 5, spentUsd: 5 })).toBeDefined();
  });

  it('names the cap, the spend, and the file to edit', () => {
    const message = budgetRefusal({ dailyUsd: 5, spentUsd: 6.5 })!;
    expect(message).toContain('$6.5000');
    expect(message).toContain('$5.00');
    expect(message).toContain('daily_usd');
    expect(message).toContain('sonata.toml');
  });

  it('states both limits it inherits', () => {
    // A refusal that overstates its own coverage is worse than none: the user
    // would believe dispatch spend and unpriced volume were capped too.
    const message = budgetRefusal({ dailyUsd: 1, spentUsd: 1 })!;
    expect(message).toContain('priced');
    expect(message).toContain('dispatch');
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
    const res = await routeRequest(req, deps({ budget: () => ({ dailyUsd: 10, spentUsd: 1 }) }));
    expect(res.status).toBe(200);
  });

  it('refuses over the cap with 429 and an Anthropic-shaped body', async () => {
    // Claude Code silently discards any error envelope but this one, which
    // would turn a deliberate cap into a generic unexplained failure.
    const res = await routeRequest(req, deps({ budget: () => ({ dailyUsd: 1, spentUsd: 2 }) }));
    expect(res.status).toBe(429);
    const parsed = JSON.parse(res.body.toString());
    expect(parsed.type).toBe('error');
    expect(parsed.error.type).toBe('rate_limit_error');
    expect(parsed.error.message).toContain('daily budget reached');
  });

  it('never reaches the upstream when refusing', async () => {
    let called = 0;
    const res = await routeRequest(req, deps({
      fetch: (async () => { called += 1; return new Response('{}', { status: 200 }); }) as unknown as typeof fetch,
      budget: () => ({ dailyUsd: 1, spentUsd: 5 }),
    }));
    expect(res.status).toBe(429);
    expect(called).toBe(0);
  });

  it('caps a tier request too, not only a direct one', async () => {
    // A cap enforced on one of the two branches is not a cap. The check sits
    // above both, so a tier alias cannot route around it.
    const tierReq = { ...req, body: Buffer.from(JSON.stringify({ model: 'sonata-code-simple' })) };
    const res = await routeRequest(tierReq, deps({
      budget: () => ({ dailyUsd: 1, spentUsd: 5 }),
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
    const d = deps({ budget: () => ({ dailyUsd: 10, spentUsd: spent }) });
    spent = 20;
    expect((await routeRequest(req, d)).status).toBe(429);
    spent = 1;
    expect((await routeRequest(req, d)).status).toBe(200);
  });
});
