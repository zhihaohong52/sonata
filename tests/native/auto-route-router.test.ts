import { describe, it, expect, beforeEach } from 'vitest';
import { routeRequest, clearCooldowns, clearAutoDecisions } from '../../src/native/router.js';
import type { TierClassifier } from '../../src/native/auto-route.js';
import type { LedgerRow } from '../../src/ledger.js';

const TIERS = { code: { simple: ['s'], normal: ['n'], complex: ['c'] } };
const config = (auto = true) => ({ tiers: TIERS, ...(auto ? { autoRoute: { classifier: 'jev' as const, minConfidence: 0.5 } } : {}) }) as any;
const routesFor = (alias: string) => { const tier = alias.replace('sonata-code-', ''); if (!['simple', 'normal', 'complex'].includes(tier)) return undefined; return { role: 'code', tier, routes: [{ key: tier[0], native: { gateway: 'g', id: `${tier}-1` } }] }; };
const req = (first = 'Rename foo to bar') => ({ method: 'POST', url: '/v1/messages', headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ model: 'sonata-code-auto', messages: [{ role: 'user', content: first }] })) });
const classifierSaying = (choice: string, confidence = 0.9) => { const calls: string[] = []; const c: TierClassifier = { name: 'jev', classify: async (input) => { calls.push(input.task); await new Promise((r) => setTimeout(r, 5)); return { choice, confidence, probabilities: { [choice]: 1 }, classifierModel: 'jev-1.13.0' }; } }; return { c, calls }; };
function depsWith(classifier: TierClassifier | undefined, opts: { auto?: boolean; budget?: any } = {}) { const seen: string[] = []; const rows: LedgerRow[] = []; const deps = { fetch: (async (_url: string, init: RequestInit) => { seen.push((JSON.parse(init.body as string) as { model: string }).model); return new Response('{"usage":{"input_tokens":1,"output_tokens":1}}', { status: 200, headers: { 'content-type': 'application/json' } }); }) as unknown as typeof fetch, litellmBase: 'http://litellm', litellmKey: 'k', resolveTenant: () => ({ id: 't', config: config(opts.auto ?? true) }), resolveTier: (alias: string) => routesFor(alias), classifier, recordUsage: (row: LedgerRow) => { rows.push(row); }, ...(opts.budget === undefined ? {} : { budget: opts.budget }), }; return { deps, seen, rows }; }

async function routed(req: any, deps: any): Promise<any> { const res = await routeRequest(req, deps); if (res.body && typeof res.body !== 'string' && Symbol.asyncIterator in Object(res.body)) { for await (const _chunk of res.body) { /* drain */ } } return res; }

describe('sonata-<role>-auto routing', () => {
  beforeEach(() => { clearCooldowns(); clearAutoDecisions(); });
  it('routes to the tier the classifier chose, and records the decision', async () => { const { c } = classifierSaying('simple'); const { deps, seen, rows } = depsWith(c); expect((await routed(req(), deps as any)).status).toBe(200); expect(seen).toEqual(['t/s']); expect(rows[0]).toMatchObject({ alias: 'sonata-code-auto', tier: 'simple', route: 'auto', autoRoute: { outcome: 'accepted', choice: 'simple' } }); });
  it('asks once per conversation; later turns carry route but no decision', async () => { const { c, calls } = classifierSaying('complex'); const { deps, rows } = depsWith(c); await routed(req(), deps as any); await routed(req(), deps as any); expect(calls).toHaveLength(1); expect(rows[1].route).toBe('auto'); expect(rows[1].autoRoute).toBeUndefined(); });
  it('makes one call for concurrent first requests', async () => { const { c, calls } = classifierSaying('normal'); const { deps, rows } = depsWith(c); await Promise.all([routed(req(), deps as any), routed(req(), deps as any)]); expect(calls).toHaveLength(1); expect(rows.filter((r) => r.autoRoute !== undefined)).toHaveLength(1); });
  it('falls back to normal with no classifier', async () => { const { deps, seen, rows } = depsWith(undefined); await routed(req(), deps as any); expect(seen).toEqual(['t/n']); expect(rows[0].autoRoute?.outcome).toBe('failed'); });
  it('answers a typed 400 when [auto_route] is off', async () => { const { c, calls } = classifierSaying('simple'); const { deps } = depsWith(c, { auto: false }); const res = await routed(req(), deps as any); expect(res.status).toBe(400); expect(String(res.body)).toMatch(/\[auto_route\]/); expect(calls).toHaveLength(0); });
  it('refuses at the budget before asking the classifier', async () => { const { c, calls } = classifierSaying('simple'); const { deps } = depsWith(c, { budget: () => [{ dailyUsd: 1, spentUsd: 5, configPath: '/x/sonata.toml' }] }); const res = await routed(req(), deps as any); expect(res.status).toBe(429); expect(calls).toHaveLength(0); });
  it('refuses a collapsed auto role with a sync hint without asking the classifier', async () => {
    const { c, calls } = classifierSaying('simple');
    const { deps } = depsWith(c);
    deps.resolveTenant = () => ({
      id: 't',
      config: { ...config(), tiers: { code: { simple: ['s'], normal: ['s'], complex: ['s'] } } },
    });
    const res = await routed(req(), deps as any);
    expect(res.status).toBe(400);
    expect(String(res.body)).toMatch(/sonata sync/);
    expect(calls).toHaveLength(0);
  });

  it('routes an auto body with unparseable messages as a fallback rather than throwing', async () => {
    const { c, calls } = classifierSaying('simple');
    const { deps, seen, rows } = depsWith(c);
    const badBody = Buffer.from(JSON.stringify({ model: 'sonata-code-auto', messages: 'not an array' }));
    const res = await routed({ ...req(), body: badBody }, deps as any);
    expect(res.status).toBe(200);
    expect(seen).toEqual(['t/n']);
    expect(rows[0]).toMatchObject({ route: 'auto', autoRoute: { outcome: 'failed', reason: 'empty task' } });
    expect(calls).toHaveLength(0);
  });

  it('does not label a bare model key as an auto or manual route', async () => {
    const { deps, rows } = depsWith(undefined);
    const bare = Buffer.from(JSON.stringify({ model: 'plain', messages: [{ role: 'user', content: 'x' }] }));
    await routed({ ...req(), body: bare }, deps as any);
    expect(Object.hasOwn(rows[0], 'route')).toBe(false);
  });

  it('marks an explicit tier alias as a manual route', async () => { const { deps, rows } = depsWith(undefined); const body = Buffer.from(JSON.stringify({ model: 'sonata-code-simple', messages: [{ role: 'user', content: 'x' }] })); await routed({ ...req(), body }, deps as any); expect(rows[0]).toMatchObject({ route: 'manual' }); expect(rows[0].autoRoute).toBeUndefined(); });
});
