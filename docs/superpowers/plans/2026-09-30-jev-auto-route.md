# Auto-Routed Tiers (Jev) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in `<role>-auto` agents whose tier (simple / normal / complex) is chosen once per conversation by TypeSafe's Jev classifier, fail-open to the fallback tier.

**Architecture:** A pure module (`src/native/auto-route.ts`) owns task cleaning, the Jev request/answer, the policy and a decision store. The router gains one branch ahead of the existing tier path: for `sonata-<role>-auto` it gets (or makes) the conversation's decision, rewrites the alias to `sonata-<role>-<tier>`, and calls the unchanged `routeTierRequest`, which records `route`/`autoRoute` on the ledger row. Config, agent generation, guidance, usage and doctor each gain a small, separately tested piece.

**Tech Stack:** TypeScript (Node 22, ESM), vitest, global `fetch`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-30-jev-auto-route-design.md`

## Global Constraints

- No new npm dependency; Jev is called with `fetch` at `https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer <key>`.
- `[auto_route]` accepts exactly `classifier = "jev"` and optional `min_confidence` (number in `[0, 1]`, default `0.5`); anything else is refused by `parseConfig`.
- The TypeSafe key is stored under gateway name `typesafe` in sonata's key store (`sonata auth add typesafe`), read with `resolveKeyFromSource('typesafe', home, 'sonata')`, never logged, never in argv.
- Timeouts: `JEV_ATTEMPT_MS = 1500`, one retry, `JEV_DEADLINE_MS = 3000` overall.
- Task text: first user message, text blocks only, `<system-reminder>…</system-reminder>` removed, trimmed, capped at `TASK_CHAR_CAP = 8000` characters keeping the start.
- Fallback tier: `normal`, else `complex` when the role has no `normal`.
- Decision store bounds: `STICKY_TTL_MS` (2 h) and `STICKY_MAX_CONVERSATIONS` (1000) from `src/native/router.ts`.
- Never log task text. Log a classifier failure once per conversation.
- Tests need no network and no API key.
- `sonata` on PATH runs `dist/`: finish with `npm run build` and `npm link`.
- Run `npm test` and `npm run typecheck` (which includes `typecheck:tests`) before the PR.

## Review Focus

1. **`-auto` requested but `[auto_route]` absent** (agent file left over, config edited) — expect a typed 400 naming `[auto_route]` and `sonata sync`, not LiteLLM's "invalid model". Test in Task 3.
2. **A first message that is nothing but system reminders** (Claude Code injecting context with an empty prompt) — expect no Jev call and the fallback tier with outcome `failed`. Test in Task 2.
3. **Jev answers a tier the role does not have** (e.g. `normal` for a role without one) — expect outcome `invalid` and the fallback, never a 400 from `resolveTierAlias`. Test in Task 2.
4. **Two parallel first requests of one conversation** (Claude Code retrying) — expect one Jev call and one ledger `autoRoute` record. Test in Task 3.
5. **A budget-capped project** — expect the 429 before any Jev call (no classifier spend while capped). Test in Task 3.

---

### Task 1: `[auto_route]` config

**Files:**
- Modify: `src/config.ts` (the `SonataConfig` interface near line 236; `parseConfig` beside the `[budget]` block near line 539; the returned object near line 864)
- Modify: `src/init/toml.ts` (`nativeTomlFor`, new trailing parameter; emit beside `[budget]` near line 174)
- Modify: `src/init/plan.ts:252` (pass the scope's `autoRoute` through)
- Test: `tests/config-auto-route.test.ts` (create)

**Interfaces:**
- Produces: `export interface AutoRouteConfig { classifier: 'jev'; minConfidence: number }`, `SonataConfig.autoRoute?: AutoRouteConfig`, `export const AUTO_ROUTE_DEFAULT_MIN_CONFIDENCE = 0.5` (all in `src/config.ts`); `nativeTomlFor(..., gatewayOrder, existingAutoRoute?: SonataConfig['autoRoute'])`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/config-auto-route.test.ts
import { describe, it, expect } from 'vitest';
import { parseConfig, AUTO_ROUTE_DEFAULT_MIN_CONFIDENCE } from '../src/config.js';
import { nativeTomlFor } from '../src/init/toml.js';

const BASE = `
[models."m"]
gateway = "g"
id = "m-1"

[native.gateways."g"]
base_url = "https://g.example/v1"

[tiers.code]
simple = ["m"]
complex = ["m"]
`;

describe('[auto_route]', () => {
  it('is absent by default', () => {
    expect(parseConfig(BASE).autoRoute).toBeUndefined();
  });

  it('reads classifier and defaults min_confidence to 0.5', () => {
    const c = parseConfig(`[auto_route]\nclassifier = "jev"\n${BASE}`);
    expect(c.autoRoute).toEqual({ classifier: 'jev', minConfidence: AUTO_ROUTE_DEFAULT_MIN_CONFIDENCE });
    expect(AUTO_ROUTE_DEFAULT_MIN_CONFIDENCE).toBe(0.5);
  });

  it('reads an explicit min_confidence', () => {
    const c = parseConfig(`[auto_route]\nclassifier = "jev"\nmin_confidence = 0.3\n${BASE}`);
    expect(c.autoRoute?.minConfidence).toBe(0.3);
  });

  it.each([
    ['an unknown classifier', 'classifier = "gpt"'],
    ['a missing classifier', 'min_confidence = 0.5'],
    ['min_confidence above 1', 'classifier = "jev"\nmin_confidence = 1.5'],
    ['min_confidence below 0', 'classifier = "jev"\nmin_confidence = -0.1'],
    ['a string min_confidence', 'classifier = "jev"\nmin_confidence = "0.5"'],
    ['an unknown key', 'classifier = "jev"\nthreshold = 0.5'],
  ])('refuses %s', (_label, body) => {
    expect(() => parseConfig(`[auto_route]\n${body}\n${BASE}`)).toThrow(/\[auto_route\]/);
  });

  it('round-trips through nativeTomlFor', () => {
    const candidate = { key: 'g-m', gateway: 'g', id: 'm-1', baseUrl: 'https://g.example/v1', auth: 'api-key' as const };
    const toml = nativeTomlFor(
      { code: [candidate] }, {}, { code: { simple: ['g-m'], complex: ['g-m'] } },
      undefined, undefined, undefined, [], undefined, undefined, [],
      { classifier: 'jev', minConfidence: 0.4 },
    );
    expect(parseConfig(toml).autoRoute).toEqual({ classifier: 'jev', minConfidence: 0.4 });
  });

  it('writes nothing when absent', () => {
    const candidate = { key: 'g-m', gateway: 'g', id: 'm-1', baseUrl: 'https://g.example/v1', auth: 'api-key' as const };
    const toml = nativeTomlFor({ code: [candidate] }, {}, { code: { simple: ['g-m'], complex: ['g-m'] } });
    expect(toml).not.toContain('[auto_route]');
  });
});
```

Before running, open `src/init/toml.ts:75` and check the positional parameters between `selectedTiers` and `gatewayOrder`; if the count differs from the `undefined, undefined, undefined, [], undefined, undefined, []` sequence above, adjust the test call so `existingAutoRoute` lands in the new last position. Also check a `NativeCandidate` literal in `tests/init/toml.test.ts:49` and copy its exact field set if it differs from the one above.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/config-auto-route.test.ts`
Expected: FAIL (`AUTO_ROUTE_DEFAULT_MIN_CONFIDENCE` not exported / `autoRoute` undefined).

- [ ] **Step 3: Implement in `src/config.ts`**

Add after the `budget?:` field of `SonataConfig`:

```ts
  /**
   * Opt-in automatic tier choice for `<role>-auto` agents. Absent means off,
   * which is every existing config. See `src/native/auto-route.ts`.
   */
  autoRoute?: AutoRouteConfig;
```

Add near the top-level exports:

```ts
export const AUTO_ROUTE_DEFAULT_MIN_CONFIDENCE = 0.5;

export interface AutoRouteConfig {
  classifier: 'jev';
  /** Below this classifier confidence the fallback tier is used. */
  minConfidence: number;
}
```

In `parseConfig`, directly after the `[budget]` block:

```ts
  let autoRoute: AutoRouteConfig | undefined;
  if (raw.auto_route !== undefined) {
    const section = raw.auto_route as Record<string, unknown>;
    // Refused rather than ignored, like [budget]: a switch silently dropped
    // for a typo reads exactly like one that is working.
    for (const key of Object.keys(section)) {
      if (key !== 'classifier' && key !== 'min_confidence') {
        throw new Error(`sonata.toml: [auto_route] has unknown key "${key}" (known: classifier, min_confidence)`);
      }
    }
    if (section.classifier !== 'jev') {
      throw new Error(`sonata.toml: [auto_route] classifier must be "jev", got ${JSON.stringify(section.classifier)}`);
    }
    const min = section.min_confidence ?? AUTO_ROUTE_DEFAULT_MIN_CONFIDENCE;
    if (typeof min !== 'number' || !Number.isFinite(min) || min < 0 || min > 1) {
      throw new Error(`sonata.toml: [auto_route] min_confidence must be a number from 0 to 1, got ${JSON.stringify(min)}`);
    }
    autoRoute = { classifier: 'jev', minConfidence: min };
  }
```

Add `autoRoute,` to the returned object next to `budget,` (the tiered return near line 864). If the legacy-projection return path above it builds its own object, leave it — legacy configs never carry `[auto_route]` via init, and `parseConfig` still sets it on the main return.

- [ ] **Step 4: Implement in `src/init/toml.ts`**

Add a trailing parameter after `gatewayOrder`:

```ts
  /**
   * `[auto_route]`, carried forward by the same rule as `[budget]`: init is
   * the sole writer of the whole file, so a table it does not emit is deleted.
   */
  existingAutoRoute?: SonataConfig['autoRoute'],
```

Emit directly after the `[budget]` block:

```ts
  if (existingAutoRoute !== undefined) {
    lines.push('[auto_route]', `classifier = ${tomlKey(existingAutoRoute.classifier)}`,
      `min_confidence = ${existingAutoRoute.minConfidence}`, '');
  }
```

(`tomlKey` quotes a string; confirm with its definition in the same file.)

- [ ] **Step 5: Pass it through in `src/init/plan.ts:252`**

Append `configForScope?.autoRoute` as the final argument of the `nativeTomlFor(...)` call.

- [ ] **Step 6: Run tests**

Run: `npx vitest run tests/config-auto-route.test.ts tests/init/toml.test.ts tests/init/plan.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/config.ts src/init/toml.ts src/init/plan.ts tests/config-auto-route.test.ts
git commit -m "feat(config): [auto_route] with classifier and min_confidence, round-tripped by init"
```

---

### Task 2: Auto-route core (cleaning, Jev call, policy, decision store)

**Files:**
- Create: `src/native/auto-route.ts`
- Modify: `src/ledger.ts` (add `route` / `autoRoute` fields and the `AutoRouteRecord` type)
- Test: `tests/native/auto-route.test.ts` (create)

**Interfaces:**
- Consumes: `AutoRouteConfig` (Task 1); `Tier`, `TIER_NAMES` from `src/config.ts` (check the exact exported names with `/usr/bin/grep -n "export type Tier\|export const TIER_NAMES" src/config.ts`; if `Tier` lives elsewhere, import from there).
- Produces (all exported from `src/native/auto-route.ts`):
  - `autoRole(alias: string): string | undefined` — `'sonata-code-auto'` → `'code'`, else undefined.
  - `cleanTask(body: Buffer): string | undefined`
  - `TASK_CHAR_CAP = 8000`, `JEV_ENDPOINT`, `JEV_ATTEMPT_MS = 1500`, `JEV_DEADLINE_MS = 3000`
  - `fallbackTier(tiers: readonly Tier[]): Tier`
  - `interface ClassifierAnswer { choice: string; confidence: number; probabilities: Record<string, number>; classifierModel?: string; tokens?: { input: number; output: number } }`
  - `interface TierClassifier { name: 'jev'; classify(input: { role: string; task: string; tiers: readonly Tier[] }, signal: AbortSignal): Promise<ClassifierAnswer> }`
  - `jevRequestBody(input: { role: string; task: string; tiers: readonly Tier[] }): object`
  - `parseJevAnswer(json: unknown): ClassifierAnswer` (throws on a malformed body)
  - `jevClassifier(opts: { fetch: typeof fetch; key: () => string | undefined; attemptMs?: number; retries?: number }): TierClassifier`
  - `interface AutoDecision { tier: Tier; record: AutoRouteRecord }`
  - `decideTier(opts: { classifier: TierClassifier | undefined; role: string; body: Buffer; tiers: readonly Tier[]; minConfidence: number; now?: () => number; deadlineMs?: number }): Promise<AutoDecision>`
  - `class DecisionStore { constructor(ttlMs: number, max: number); get(key: string, at: number): AutoDecision | undefined; getOrCreate(key: string, at: number, make: () => Promise<AutoDecision>): Promise<{ decision: AutoDecision; fresh: boolean }>; clear(): void; size(): number }`
- Produces (in `src/ledger.ts`): `export interface AutoRouteRecord { classifier: 'jev'; classifierModel?: string; choice?: string; confidence?: number; probabilities?: Record<string, number>; outcome: 'accepted' | 'low-confidence' | 'invalid' | 'failed'; reason?: string; ms: number; tokens?: { input: number; output: number } }`; `LedgerRow.route?: 'auto' | 'manual'`; `LedgerRow.autoRoute?: AutoRouteRecord`.

- [ ] **Step 1: Add the ledger types (no behaviour yet)**

In `src/ledger.ts`, add above `export interface LedgerRow`:

```ts
/**
 * The classifier's decision for an auto-routed conversation, recorded on the
 * row of the request that made it. Raw values as received, so any later rule
 * (a different threshold, a target share) can be computed from history
 * without calling the classifier again.
 */
export interface AutoRouteRecord {
  classifier: 'jev';
  /** The classifier's own version, e.g. `jev-1.13.0`. */
  classifierModel?: string;
  choice?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
  outcome: 'accepted' | 'low-confidence' | 'invalid' | 'failed';
  /** Why a `failed` or `invalid` outcome happened. Never task text. */
  reason?: string;
  ms: number;
  tokens?: { input: number; output: number };
}
```

and inside `LedgerRow`, after `tier?: string;`:

```ts
  /** `auto` when the tier was chosen by the classifier, `manual` when the caller named it. Absent on rows written before auto-routing. */
  route?: 'auto' | 'manual';
  /** The decision itself, only on the row of the request that made it. */
  autoRoute?: AutoRouteRecord;
```

- [ ] **Step 2: Write the failing tests**

```ts
// tests/native/auto-route.test.ts
import { describe, it, expect, vi } from 'vitest';
import {
  autoRole, cleanTask, TASK_CHAR_CAP, fallbackTier, jevRequestBody, parseJevAnswer,
  jevClassifier, decideTier, DecisionStore, JEV_ENDPOINT, type TierClassifier,
} from '../../src/native/auto-route.js';

const body = (messages: unknown[]) => Buffer.from(JSON.stringify({ model: 'sonata-code-auto', messages }));
const ALL = ['simple', 'normal', 'complex'] as const;

const answer = (choice: string, confidence: number) => ({
  choice, confidence, probabilities: { simple: 0.1, normal: 0.2, complex: 0.7 },
  classifierModel: 'jev-1.13.0', tokens: { input: 300, output: 30 },
});
const fixed = (a: ReturnType<typeof answer>): TierClassifier => ({ name: 'jev', classify: async () => a });

describe('autoRole', () => {
  it('reads the role from an auto alias', () => {
    expect(autoRole('sonata-code-auto')).toBe('code');
    expect(autoRole('sonata-code-simple')).toBeUndefined();
    expect(autoRole('code-auto')).toBeUndefined();
    expect(autoRole('sonata--auto')).toBeUndefined();
  });
});

describe('cleanTask', () => {
  it('keeps text blocks of the first user message and drops reminders', () => {
    const task = cleanTask(body([{ role: 'user', content: [
      { type: 'text', text: '<system-reminder>\nCLAUDE.md stuff\n</system-reminder>' },
      { type: 'text', text: 'Rename foo to bar in src/a.ts' },
      { type: 'image', source: {} },
    ] }, { role: 'assistant', content: 'later turn' }]));
    expect(task).toBe('Rename foo to bar in src/a.ts');
  });

  it('accepts string content and strips inline reminders', () => {
    expect(cleanTask(body([{ role: 'user', content: 'Do X <system-reminder>secret</system-reminder> now' }]))).toBe('Do X  now');
  });

  it('returns undefined when only reminders remain', () => {
    expect(cleanTask(body([{ role: 'user', content: '<system-reminder>only</system-reminder>' }]))).toBeUndefined();
  });

  it('caps the text, keeping the start', () => {
    const long = 'a'.repeat(TASK_CHAR_CAP + 500);
    expect(cleanTask(body([{ role: 'user', content: long }]))?.length).toBe(TASK_CHAR_CAP);
  });

  it('returns undefined for an unparseable body or no user message', () => {
    expect(cleanTask(Buffer.from('not json'))).toBeUndefined();
    expect(cleanTask(body([]))).toBeUndefined();
  });
});

describe('fallbackTier', () => {
  it('is normal, else the next tier up', () => {
    expect(fallbackTier(ALL)).toBe('normal');
    expect(fallbackTier(['simple', 'complex'])).toBe('complex');
  });
});

describe('jevRequestBody', () => {
  it('offers only the role\'s tiers, in order, with state role and task', () => {
    const req = jevRequestBody({ role: 'code', task: 'T', tiers: ['simple', 'complex'] }) as any;
    expect(req.state).toEqual({ role: 'code', task: 'T' });
    expect(req.questions.tier.type).toBe('choice');
    expect(Object.keys(req.questions.tier.criteria)).toEqual(['simple', 'complex']);
    expect(JSON.stringify(req.questions.tier)).toMatch(/Size is not difficulty/);
  });
});

describe('parseJevAnswer', () => {
  it('reads the tier answer, model and usage', () => {
    const a = parseJevAnswer({
      model: 'jev-1.13.0',
      answers: { tier: { type: 'choice', choice: 'simple', probabilities: { simple: 0.88, normal: 0.12, complex: 0 }, confidence: 0.81 } },
      usage: { input_tokens: 318, output_tokens: 34 },
    });
    expect(a).toEqual({
      choice: 'simple', confidence: 0.81,
      probabilities: { simple: 0.88, normal: 0.12, complex: 0 },
      classifierModel: 'jev-1.13.0', tokens: { input: 318, output: 34 },
    });
  });

  it('throws on a malformed body', () => {
    expect(() => parseJevAnswer({ answers: {} })).toThrow();
    expect(() => parseJevAnswer({ answers: { tier: { choice: 1, confidence: 'x' } } })).toThrow();
  });
});

describe('decideTier', () => {
  const b = body([{ role: 'user', content: 'Rename foo' }]);

  it('accepts a confident, offered choice', async () => {
    const d = await decideTier({ classifier: fixed(answer('complex', 0.8)), role: 'code', body: b, tiers: ALL, minConfidence: 0.5 });
    expect(d.tier).toBe('complex');
    expect(d.record).toMatchObject({ classifier: 'jev', outcome: 'accepted', choice: 'complex', confidence: 0.8, classifierModel: 'jev-1.13.0' });
  });

  it('falls back below min_confidence', async () => {
    const d = await decideTier({ classifier: fixed(answer('simple', 0.3)), role: 'code', body: b, tiers: ALL, minConfidence: 0.5 });
    expect(d.tier).toBe('normal');
    expect(d.record.outcome).toBe('low-confidence');
    expect(d.record.choice).toBe('simple');
  });

  it('falls back on a tier the role does not have', async () => {
    const d = await decideTier({ classifier: fixed(answer('normal', 0.9)), role: 'code', body: b, tiers: ['simple', 'complex'], minConfidence: 0.5 });
    expect(d.tier).toBe('complex');
    expect(d.record.outcome).toBe('invalid');
  });

  it('falls back with outcome failed when there is no classifier (no key)', async () => {
    const d = await decideTier({ classifier: undefined, role: 'code', body: b, tiers: ALL, minConfidence: 0.5 });
    expect(d).toMatchObject({ tier: 'normal', record: { outcome: 'failed' } });
  });

  it('never calls the classifier for an empty task', async () => {
    const classify = vi.fn();
    const d = await decideTier({
      classifier: { name: 'jev', classify }, role: 'code',
      body: body([{ role: 'user', content: '<system-reminder>x</system-reminder>' }]), tiers: ALL, minConfidence: 0.5,
    });
    expect(classify).not.toHaveBeenCalled();
    expect(d).toMatchObject({ tier: 'normal', record: { outcome: 'failed', reason: 'empty task' } });
  });

  it('falls back when the classifier throws, recording the reason but not the task', async () => {
    const d = await decideTier({
      classifier: { name: 'jev', classify: async () => { throw new Error('HTTP 503'); } },
      role: 'code', body: b, tiers: ALL, minConfidence: 0.5,
    });
    expect(d).toMatchObject({ tier: 'normal', record: { outcome: 'failed', reason: 'HTTP 503' } });
    expect(JSON.stringify(d.record)).not.toContain('Rename foo');
  });

  it('falls back at the deadline when the classifier hangs', async () => {
    const started = Date.now();
    const d = await decideTier({
      classifier: { name: 'jev', classify: () => new Promise(() => {}) },
      role: 'code', body: b, tiers: ALL, minConfidence: 0.5, deadlineMs: 50,
    });
    expect(d.record.outcome).toBe('failed');
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('jevClassifier', () => {
  const ok = () => new Response(JSON.stringify({
    model: 'jev-1.13.0',
    answers: { tier: { type: 'choice', choice: 'normal', probabilities: { simple: 0.1, normal: 0.8, complex: 0.1 }, confidence: 0.7 } },
    usage: { input_tokens: 10, output_tokens: 2 },
  }), { status: 200 });

  it('posts to the System One endpoint with a bearer key', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const c = jevClassifier({ fetch: (async (url: string, init: RequestInit) => { calls.push({ url, init }); return ok(); }) as any, key: () => 'k-123' });
    const a = await c.classify({ role: 'code', task: 'T', tiers: ['simple', 'normal', 'complex'] }, new AbortController().signal);
    expect(a.choice).toBe('normal');
    expect(calls[0].url).toBe(JEV_ENDPOINT);
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer k-123');
  });

  it('throws without a key, without calling fetch', async () => {
    const f = vi.fn();
    const c = jevClassifier({ fetch: f as any, key: () => undefined });
    await expect(c.classify({ role: 'code', task: 'T', tiers: ['simple'] }, new AbortController().signal)).rejects.toThrow(/no TypeSafe key/);
    expect(f).not.toHaveBeenCalled();
  });

  it('retries once after a non-2xx, then succeeds', async () => {
    let n = 0;
    const c = jevClassifier({ fetch: (async () => (++n === 1 ? new Response('x', { status: 503 }) : ok())) as any, key: () => 'k' });
    await expect(c.classify({ role: 'code', task: 'T', tiers: ['simple', 'normal', 'complex'] }, new AbortController().signal)).resolves.toMatchObject({ choice: 'normal' });
    expect(n).toBe(2);
  });
});

describe('DecisionStore', () => {
  it('shares one in-flight decision between concurrent callers', async () => {
    const store = new DecisionStore(60_000, 10);
    let calls = 0;
    const make = async () => { calls += 1; await new Promise((r) => setTimeout(r, 10)); return { tier: 'simple' as const, record: { classifier: 'jev' as const, outcome: 'accepted' as const, ms: 1 } }; };
    const [a, b] = await Promise.all([store.getOrCreate('k', 0, make), store.getOrCreate('k', 0, make)]);
    expect(calls).toBe(1);
    expect([a.fresh, b.fresh].sort()).toEqual([false, true]);
    expect(store.get('k', 1)?.tier).toBe('simple');
  });

  it('expires by ttl and evicts beyond the cap', async () => {
    const store = new DecisionStore(100, 2);
    const d = { tier: 'normal' as const, record: { classifier: 'jev' as const, outcome: 'accepted' as const, ms: 1 } };
    await store.getOrCreate('a', 0, async () => d);
    expect(store.get('a', 50)).toBeDefined();
    expect(store.get('a', 200)).toBeUndefined();
    await store.getOrCreate('b', 0, async () => d);
    await store.getOrCreate('c', 0, async () => d);
    await store.getOrCreate('e', 0, async () => d);
    expect(store.size()).toBe(2);
  });

  it('does not keep a rejected creation', async () => {
    const store = new DecisionStore(60_000, 10);
    await expect(store.getOrCreate('k', 0, async () => { throw new Error('boom'); })).rejects.toThrow();
    expect(store.get('k', 1)).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/native/auto-route.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement `src/native/auto-route.ts`**

```ts
/**
 * Automatic tier choice for `sonata-<role>-auto`.
 *
 * Tier *selection* was sonata's weakest routing decision: the dispatching
 * model picks from a description, and one unsure of itself picks upward
 * (`complex` took 74% of tiered requests). This asks TypeSafe's System One
 * model Jev one Choice question, once per conversation, and hands the answer
 * to the unchanged tier path. See
 * docs/superpowers/specs/2026-09-30-jev-auto-route-design.md.
 *
 * Every failure is fail-open to the fallback tier: a classifier that is down,
 * unsure or unkeyed never does worse than today's default, and never blocks a
 * subagent past `JEV_DEADLINE_MS`.
 */
import type { Tier } from '../config.js';
import type { AutoRouteRecord } from '../ledger.js';

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_ATTEMPT_MS = 1_500;
export const JEV_DEADLINE_MS = 3_000;
export const TASK_CHAR_CAP = 8_000;

const AUTO_ALIAS = /^sonata-(.+)-auto$/;

/** The role an auto alias names, or undefined for any other model name. */
export function autoRole(alias: string): string | undefined {
  const match = AUTO_ALIAS.exec(alias);
  return match === null || match[1].length === 0 ? undefined : match[1];
}

const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/**
 * The task as the classifier may see it: the first user message's text only,
 * with Claude Code's injected context removed. Nothing else leaves the
 * machine — no system prompt, tool results, images or later turns.
 */
export function cleanTask(body: Buffer): string | undefined {
  let messages: unknown;
  try {
    messages = (JSON.parse(body.toString()) as { messages?: unknown }).messages;
  } catch {
    return undefined;
  }
  if (!Array.isArray(messages)) return undefined;
  const first = messages.find((m) => (m as { role?: unknown })?.role === 'user') as { content?: unknown } | undefined;
  if (first === undefined) return undefined;
  const parts = typeof first.content === 'string'
    ? [first.content]
    : Array.isArray(first.content)
      ? first.content
        .filter((b) => (b as { type?: unknown })?.type === 'text' && typeof (b as { text?: unknown }).text === 'string')
        .map((b) => (b as { text: string }).text)
      : [];
  const text = parts.join('\n').replace(REMINDER, '').trim();
  return text.length === 0 ? undefined : text.slice(0, TASK_CHAR_CAP);
}

/** `normal` when the role has one, else the next tier up. */
export function fallbackTier(tiers: readonly Tier[]): Tier {
  if (tiers.includes('normal')) return 'normal';
  if (tiers.includes('complex')) return 'complex';
  return tiers[0];
}

/** Same definitions the generated agent descriptions use, so Jev and a caller judge alike. */
const TIER_CRITERIA: Record<Tier, { what: string; not_for: string }> = {
  simple: {
    what: 'Specified closely enough that the change could be written without asking a question; typically one or two files and no interface change. A large mechanical change is simple.',
    not_for: 'Work that needs a design decision or reading the surrounding code to fit in.',
  },
  normal: {
    what: 'You know what to change but not exactly how; needs reading the surrounding code; may touch several files; what "done" means is not in question.',
    not_for: 'Open design choices, or an ambiguous definition of done.',
  },
  complex: {
    what: 'Needs a design decision affecting other components, or is ambiguous about what "done" means, so the first job is deciding what to build. A three-line change that decides an interface is complex.',
    not_for: 'Routine work with a clear implementation, however large.',
  },
};

/** The System One request: `state` plus one Choice named `tier`. */
export function jevRequestBody(input: { role: string; task: string; tiers: readonly Tier[] }): object {
  return {
    state: { role: input.role, task: input.task },
    questions: {
      tier: {
        type: 'choice',
        instructions: [
          'Pick the cheapest tier that can fully complete `task` in one pass, without being re-run at a higher tier.',
          '`role` is the kind of work (code, review, explore or plan). Size is not difficulty.',
        ],
        criteria: Object.fromEntries(input.tiers.map((tier) => [tier, TIER_CRITERIA[tier]])),
      },
    },
  };
}

export interface ClassifierAnswer {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
  classifierModel?: string;
  tokens?: { input: number; output: number };
}

export interface TierClassifier {
  name: 'jev';
  classify(input: { role: string; task: string; tiers: readonly Tier[] }, signal: AbortSignal): Promise<ClassifierAnswer>;
}

/** The `tier` answer out of a System One response. Throws on anything else. */
export function parseJevAnswer(json: unknown): ClassifierAnswer {
  const root = json as { model?: unknown; answers?: { tier?: unknown }; usage?: { input_tokens?: unknown; output_tokens?: unknown } };
  const tier = root?.answers?.tier as { choice?: unknown; confidence?: unknown; probabilities?: unknown } | undefined;
  if (tier === undefined || typeof tier.choice !== 'string' || typeof tier.confidence !== 'number'
    || tier.probabilities === null || typeof tier.probabilities !== 'object') {
    throw new Error('malformed classifier response');
  }
  const usage = root.usage;
  return {
    choice: tier.choice,
    confidence: tier.confidence,
    probabilities: tier.probabilities as Record<string, number>,
    ...(typeof root.model === 'string' ? { classifierModel: root.model } : {}),
    ...(typeof usage?.input_tokens === 'number' && typeof usage?.output_tokens === 'number'
      ? { tokens: { input: usage.input_tokens, output: usage.output_tokens } } : {}),
  };
}

/** Jev over plain `fetch`. The key is read per call, so `sonata auth add typesafe` needs no restart. */
export function jevClassifier(opts: {
  fetch: typeof fetch; key: () => string | undefined; attemptMs?: number; retries?: number;
}): TierClassifier {
  const attemptMs = opts.attemptMs ?? JEV_ATTEMPT_MS;
  const retries = opts.retries ?? 1;
  return {
    name: 'jev',
    async classify(input, signal) {
      const key = opts.key();
      if (key === undefined) throw new Error('no TypeSafe key — run `sonata auth add typesafe`');
      let last: unknown;
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        if (signal.aborted) break;
        try {
          const res = await opts.fetch(JEV_ENDPOINT, {
            method: 'POST',
            headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
            body: JSON.stringify(jevRequestBody(input)),
            signal: AbortSignal.any([signal, AbortSignal.timeout(attemptMs)]),
          });
          if (!res.ok) { last = new Error(`HTTP ${res.status}`); continue; }
          return parseJevAnswer(await res.json());
        } catch (error) {
          last = error;
        }
      }
      throw last instanceof Error ? last : new Error('classifier unavailable');
    },
  };
}

export interface AutoDecision { tier: Tier; record: AutoRouteRecord }

/** One decision: clean, ask, apply the policy. Never throws. */
export async function decideTier(opts: {
  classifier: TierClassifier | undefined;
  role: string;
  body: Buffer;
  tiers: readonly Tier[];
  minConfidence: number;
  now?: () => number;
  deadlineMs?: number;
}): Promise<AutoDecision> {
  const now = opts.now ?? Date.now;
  const started = now();
  const fallback = fallbackTier(opts.tiers);
  const failed = (reason: string): AutoDecision => ({
    tier: fallback, record: { classifier: 'jev', outcome: 'failed', reason, ms: now() - started },
  });
  if (opts.classifier === undefined) return failed('no classifier');
  const task = cleanTask(opts.body);
  if (task === undefined) return failed('empty task');

  const controller = new AbortController();
  const deadline = opts.deadlineMs ?? JEV_DEADLINE_MS;
  let timer: NodeJS.Timeout | undefined;
  let answer: ClassifierAnswer;
  try {
    answer = await Promise.race([
      opts.classifier.classify({ role: opts.role, task, tiers: opts.tiers }, controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error(`no answer within ${deadline}ms`)); }, deadline);
      }),
    ]);
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }

  const record: AutoRouteRecord = {
    classifier: 'jev',
    ...(answer.classifierModel === undefined ? {} : { classifierModel: answer.classifierModel }),
    choice: answer.choice,
    confidence: answer.confidence,
    probabilities: answer.probabilities,
    outcome: 'accepted',
    ms: now() - started,
    ...(answer.tokens === undefined ? {} : { tokens: answer.tokens }),
  };
  if (!(opts.tiers as readonly string[]).includes(answer.choice)) {
    return { tier: fallback, record: { ...record, outcome: 'invalid', reason: `not an offered tier: ${answer.choice}` } };
  }
  if (answer.confidence < opts.minConfidence) {
    return { tier: fallback, record: { ...record, outcome: 'low-confidence' } };
  }
  return { tier: answer.choice as Tier, record };
}

/**
 * Decisions by conversation key, bounded like the router's sticky map.
 * Concurrent first requests share one in-flight creation; a rejected
 * creation is not kept, so the next turn tries again.
 */
export class DecisionStore {
  private readonly done = new Map<string, { decision: AutoDecision; at: number }>();
  private readonly pending = new Map<string, Promise<AutoDecision>>();
  constructor(private readonly ttlMs: number, private readonly max: number) {}

  get(key: string, at: number): AutoDecision | undefined {
    const hit = this.done.get(key);
    if (hit === undefined) return undefined;
    if (at - hit.at > this.ttlMs) { this.done.delete(key); return undefined; }
    this.done.delete(key);
    this.done.set(key, { decision: hit.decision, at });
    return hit.decision;
  }

  async getOrCreate(key: string, at: number, make: () => Promise<AutoDecision>): Promise<{ decision: AutoDecision; fresh: boolean }> {
    const hit = this.get(key, at);
    if (hit !== undefined) return { decision: hit, fresh: false };
    const inFlight = this.pending.get(key);
    if (inFlight !== undefined) return { decision: await inFlight, fresh: false };
    const created = make();
    this.pending.set(key, created);
    try {
      const decision = await created;
      this.done.set(key, { decision, at });
      while (this.done.size > this.max) {
        const oldest = this.done.keys().next();
        if (oldest.done) break;
        this.done.delete(oldest.value);
      }
      return { decision, fresh: true };
    } finally {
      this.pending.delete(key);
    }
  }

  clear(): void { this.done.clear(); this.pending.clear(); }
  size(): number { return this.done.size; }
}
```

If `Tier` is not exported from `src/config.ts`, find it with `/usr/bin/grep -rn "export type Tier\b" src` and import from there. `AbortSignal.any` needs Node ≥ 20.3; the project requires Node 22.

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/native/auto-route.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/native/auto-route.ts src/ledger.ts tests/native/auto-route.test.ts
git commit -m "feat(auto-route): task cleaning, Jev Choice request, fail-open policy, decision store"
```

---

### Task 3: Router branch and ledger recording

**Files:**
- Modify: `src/native/router.ts` (`RouterDeps`; `RecordContext` near line 399; `withUsageRecording` emit near line 441; `routeTierRequest` signature at line 1620 and its four `tier: resolved.tier,` record contexts; `routeRequest` before the tier check near line 2150)
- Test: `tests/native/auto-route-router.test.ts` (create); `tests/ledger.test.ts` (add one case — confirm the file name with `ls tests | grep ledger`)

**Interfaces:**
- Consumes: `autoRole`, `decideTier`, `DecisionStore`, `TierClassifier`, `AutoDecision` (Task 2); `AutoRouteRecord` (Task 2, `src/ledger.ts`); `SonataConfig.autoRoute` (Task 1); `tiersCollapse`, `TIER_NAMES` from `src/config.ts`.
- Produces: `RouterDeps.classifier?: TierClassifier`; `export function clearAutoDecisions(): void` (test seam, in router.ts); ledger rows carry `route` and, on the deciding request, `autoRoute`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/native/auto-route-router.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { routeRequest, clearCooldowns, clearAutoDecisions } from '../../src/native/router.js';
import type { TierClassifier } from '../../src/native/auto-route.js';
import type { LedgerRow } from '../../src/ledger.js';

const TIERS = { code: { simple: ['s'], normal: ['n'], complex: ['c'] } };
const config = (auto = true) => ({
  tiers: TIERS,
  ...(auto ? { autoRoute: { classifier: 'jev' as const, minConfidence: 0.5 } } : {}),
}) as any;
const routesFor = (alias: string) => {
  const tier = alias.replace('sonata-code-', '');
  if (!['simple', 'normal', 'complex'].includes(tier)) return undefined;
  return { role: 'code', tier, routes: [{ key: tier[0], native: { gateway: 'g', id: `${tier}-1` } }] };
};
const req = (first = 'Rename foo to bar') => ({
  method: 'POST', url: '/v1/messages',
  headers: { 'content-type': 'application/json' },
  body: Buffer.from(JSON.stringify({ model: 'sonata-code-auto', messages: [{ role: 'user', content: first }] })),
});
const classifierSaying = (choice: string, confidence = 0.9) => {
  const calls: string[] = [];
  const c: TierClassifier = {
    name: 'jev',
    classify: async (input) => {
      calls.push(input.task);
      await new Promise((r) => setTimeout(r, 5));
      return { choice, confidence, probabilities: { [choice]: 1 }, classifierModel: 'jev-1.13.0' };
    },
  };
  return { c, calls };
};
function depsWith(classifier: TierClassifier | undefined, opts: { auto?: boolean; budget?: any } = {}) {
  const seen: string[] = [];
  const rows: LedgerRow[] = [];
  const deps = {
    fetch: (async (_url: string, init: RequestInit) => {
      seen.push((JSON.parse(init.body as string) as { model: string }).model);
      return new Response('{"usage":{"input_tokens":1,"output_tokens":1}}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch,
    litellmBase: 'http://litellm', litellmKey: 'k',
    resolveTenant: () => ({ id: 't', config: config(opts.auto ?? true) }),
    resolveTier: (alias: string) => routesFor(alias),
    classifier,
    recordUsage: (row: LedgerRow) => { rows.push(row); },
    ...(opts.budget === undefined ? {} : { budget: opts.budget }),
  };
  return { deps, seen, rows };
}

describe('sonata-<role>-auto routing', () => {
  beforeEach(() => { clearCooldowns(); clearAutoDecisions(); });

  it('routes to the tier the classifier chose, and records the decision', async () => {
    const { c } = classifierSaying('simple');
    const { deps, seen, rows } = depsWith(c);
    expect((await routeRequest(req(), deps as any)).status).toBe(200);
    expect(seen).toEqual(['t/s']);
    expect(rows[0]).toMatchObject({ alias: 'sonata-code-auto', tier: 'simple', route: 'auto', autoRoute: { outcome: 'accepted', choice: 'simple' } });
  });

  it('asks once per conversation; later turns carry route but no decision', async () => {
    const { c, calls } = classifierSaying('complex');
    const { deps, rows } = depsWith(c);
    await routeRequest(req(), deps as any);
    await routeRequest(req(), deps as any);
    expect(calls).toHaveLength(1);
    expect(rows[1].route).toBe('auto');
    expect(rows[1].autoRoute).toBeUndefined();
  });

  it('makes one call for concurrent first requests', async () => {
    const { c, calls } = classifierSaying('normal');
    const { deps, rows } = depsWith(c);
    await Promise.all([routeRequest(req(), deps as any), routeRequest(req(), deps as any)]);
    expect(calls).toHaveLength(1);
    expect(rows.filter((r) => r.autoRoute !== undefined)).toHaveLength(1);
  });

  it('falls back to normal with no classifier', async () => {
    const { deps, seen, rows } = depsWith(undefined);
    await routeRequest(req(), deps as any);
    expect(seen).toEqual(['t/n']);
    expect(rows[0].autoRoute?.outcome).toBe('failed');
  });

  it('answers a typed 400 when [auto_route] is off', async () => {
    const { c, calls } = classifierSaying('simple');
    const { deps } = depsWith(c, { auto: false });
    const res = await routeRequest(req(), deps as any);
    expect(res.status).toBe(400);
    expect(String(res.body)).toMatch(/\[auto_route\]/);
    expect(calls).toHaveLength(0);
  });

  it('refuses at the budget before asking the classifier', async () => {
    const { c, calls } = classifierSaying('simple');
    const { deps } = depsWith(c, { budget: () => [{ dailyUsd: 1, spentUsd: 5, path: '/x/sonata.toml' }] });
    const res = await routeRequest(req(), deps as any);
    expect(res.status).toBe(429);
    expect(calls).toHaveLength(0);
  });

  it('marks an explicit tier alias as a manual route', async () => {
    const { deps, rows } = depsWith(undefined);
    const body = Buffer.from(JSON.stringify({ model: 'sonata-code-simple', messages: [{ role: 'user', content: 'x' }] }));
    await routeRequest({ ...req(), body }, deps as any);
    expect(rows[0]).toMatchObject({ route: 'manual' });
    expect(rows[0].autoRoute).toBeUndefined();
  });
});
```

Before running: check the shape `deps.budget` returns by reading `budgetRefusal` in `src/budget.ts` (near line 95) and the `budget?:` field of `RouterDeps`; adjust the `budget:` stub in the test to that exact shape. Check how the router reads JSON usage for a buffered body (`usageFromJsonBody`) so the fake response yields a recorded row; if rows stay empty, copy the response shape from an existing `recordUsage` test in `tests/native/router.test.ts` (`/usr/bin/grep -n "recordUsage" tests/native/router.test.ts | head`).

Add to the ledger test file:

```ts
it('keeps a row carrying route and autoRoute through readRows', () => {
  // Reuse this file's existing helper for a temp home and a valid row; append
  // { ...validRow, route: 'auto', autoRoute: { classifier: 'jev', outcome: 'accepted', choice: 'simple', confidence: 0.8, probabilities: { simple: 0.9, normal: 0.1 }, ms: 300 } }
  // with appendRow, then assert readRows returns it with autoRoute intact.
});
```

Write that case concretely using the file's own helpers (find them with `/usr/bin/grep -n "appendRow\|function row\|const row" tests/ledger*.test.ts | head`).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/native/auto-route-router.test.ts`
Expected: FAIL (`clearAutoDecisions` not exported).

- [ ] **Step 3: Implement in `src/native/router.ts`**

Imports:

```ts
import { autoRole, decideTier, DecisionStore, type TierClassifier } from './auto-route.js';
import type { AutoRouteRecord } from '../ledger.js';
```

(add `tiersCollapse` and `TIER_NAMES` to the existing `../config.js` import).

`RouterDeps` — add:

```ts
  /** Chooses the tier for `sonata-<role>-auto`. Absent → every auto request takes the fallback tier. */
  classifier?: TierClassifier;
```

After the sticky-map helpers (after `stickyConversationCount`):

```ts
/** Auto-route decisions by conversation, bounded like the sticky map. */
const autoDecisions = new DecisionStore(STICKY_TTL_MS, STICKY_MAX_CONVERSATIONS);

/** Test seam. */
export function clearAutoDecisions(): void {
  autoDecisions.clear();
}
```

`RecordContext` — add:

```ts
  route?: 'auto' | 'manual';
  autoRoute?: AutoRouteRecord;
```

In `withUsageRecording`'s `deps.recordUsage?.({...})` object, after `tier: ctx.tier,`:

```ts
          ...(ctx.route === undefined ? {} : { route: ctx.route }),
          ...(ctx.autoRoute === undefined ? {} : { autoRoute: ctx.autoRoute }),
```

`routeTierRequest` — add a final parameter and a spread:

```ts
  unavailable: string | undefined,
  auto?: { alias: string; record?: AutoRouteRecord },
): Promise<RouterResponse> {
```

right after `resolved` is known (after the `if (resolved === undefined) {…}` block):

```ts
  // Recorded under the alias the caller asked for, so auto conversations stay
  // attributable; the decision rides only on the request that made it.
  const routeFields = auto === undefined
    ? { route: 'manual' as const }
    : { alias: auto.alias, route: 'auto' as const, ...(auto.record === undefined ? {} : { autoRoute: auto.record }) };
```

Then at each of the four record contexts in this function (find them with `/usr/bin/grep -n "tier: resolved.tier," src/native/router.ts`), add `...routeFields,` on the line after `tier: resolved.tier,`. It must come after any `alias` property in that literal so the auto alias wins.

In `routeRequest`, immediately before `if (alias !== undefined && alias.startsWith('sonata-') && deps.resolveTier?.(alias, tenant) !== undefined) {`:

```ts
  const auto = alias === undefined ? undefined : autoRole(alias);
  if (alias !== undefined && auto !== undefined) {
    const lists = tenant.config?.tiers?.[auto];
    const settings = tenant.config?.autoRoute;
    if (settings === undefined || lists === undefined || tiersCollapse(lists)) {
      const why = settings === undefined
        ? 'auto-routing is off for this project — add [auto_route] to sonata.toml and run `sonata sync`'
        : `role "${auto}" has no tiers to choose between — run \`sonata sync\``;
      deps.log?.(`router: refused model=${alias} — ${why}`);
      return { status: 400, headers: { 'content-type': 'application/json' }, body: anthropicErrorBody('invalid_request_error', `${alias}: ${why}`) };
    }
    const tiers = TIER_NAMES.filter((tier) => lists[tier] !== undefined);
    const conversation = conversationKey(req.body, tenant.id, alias);
    const make = () => decideTier({
      classifier: deps.classifier, role: auto, body: req.body, tiers, minConfidence: settings.minConfidence, now: deps.now,
    });
    const { decision, fresh } = conversation === undefined
      ? { decision: await make(), fresh: true }
      : await autoDecisions.getOrCreate(conversation, (deps.now ?? Date.now)(), make);
    if (fresh && decision.record.outcome !== 'accepted') {
      // Once per conversation, never with the task text.
      deps.log?.(`router: ${alias} → ${decision.tier} (${decision.record.outcome}${decision.record.reason === undefined ? '' : `: ${decision.record.reason}`})`);
    }
    return routeTierRequest(
      req, deps, `sonata-${auto}-${decision.tier}`, startedAt, session, tenant, unavailable,
      { alias, ...(fresh ? { record: decision.record } : {}) },
    );
  }
```

This sits after the budget refusal and the nameless-tool-call repair, so a capped project never spends a classifier call.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/native/auto-route-router.test.ts tests/native/router.test.ts tests/ledger*.test.ts`
Expected: PASS (existing router tests unaffected apart from rows now carrying `route: 'manual'`; if a snapshot or `toEqual` on a whole row fails for that reason, update that expectation to include `route: 'manual'`).

- [ ] **Step 5: Commit**

```bash
git add src/native/router.ts tests/native/auto-route-router.test.ts tests/ledger*.test.ts
git commit -m "feat(router): route sonata-<role>-auto through a once-per-conversation tier decision"
```

---

### Task 4: Serve wiring

**Files:**
- Modify: `src/commands/serve.ts` (the `createRouterServer({...})` deps near line 2619)
- Test: `tests/commands/serve.test.ts` (one case — confirm how existing cases read the deps passed to the router; `/usr/bin/grep -n "createRouterServer\|routerDeps" tests/commands/serve.test.ts | head`)

**Interfaces:**
- Consumes: `jevClassifier` (Task 2); `resolveKeyFromSource` from `src/native/credentials.ts`; `RouterDeps.classifier` (Task 3).
- Produces: a running router whose `classifier` reads the `typesafe` key per call.

- [ ] **Step 1: Write the failing test**

Following the file's existing pattern for inspecting router deps, assert that the deps handed to the router have `classifier?.name === 'jev'`. If the file has no seam exposing router deps, instead add this unit test to `tests/native/auto-route.test.ts`:

```ts
it('reads the key per call, so a key added later is picked up', async () => {
  let key: string | undefined;
  const f = vi.fn(async () => new Response(JSON.stringify({ answers: { tier: { choice: 'simple', confidence: 1, probabilities: { simple: 1 } } } }), { status: 200 }));
  const c = jevClassifier({ fetch: f as any, key: () => key });
  await expect(c.classify({ role: 'code', task: 'T', tiers: ['simple'] }, new AbortController().signal)).rejects.toThrow();
  key = 'k';
  await expect(c.classify({ role: 'code', task: 'T', tiers: ['simple'] }, new AbortController().signal)).resolves.toMatchObject({ choice: 'simple' });
});
```

- [ ] **Step 2: Run to verify failure (serve case) or pass (unit case, already implemented)**

Run: `npx vitest run tests/commands/serve.test.ts tests/native/auto-route.test.ts`

- [ ] **Step 3: Wire it**

In `src/commands/serve.ts` add imports:

```ts
import { jevClassifier } from '../native/auto-route.js';
import { resolveKeyFromSource } from '../native/credentials.js';
```

(skip the second if already imported), and in the `createRouterServer({...})` deps, after `resolveTier: ...`:

```ts
      // Always present: with no key it throws per call and the router falls
      // back, which is the documented off-by-default-key behaviour.
      classifier: jevClassifier({ fetch, key: () => resolveKeyFromSource('typesafe', opts.home, 'sonata') }),
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/commands/serve.test.ts tests/native/auto-route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/serve.ts tests/commands/serve.test.ts tests/native/auto-route.test.ts
git commit -m "feat(serve): give the router a Jev classifier keyed from sonata auth"
```

---

### Task 5: `<role>-auto` agents

**Files:**
- Modify: `src/config.ts` (`expectedAgentNames` near line 1113; new `autoAgentRoles`)
- Modify: `src/commands/sync.ts` (new `autoAgentMarkdown`; `plannedAgents` near line 626)
- Modify: `src/commands/agents.ts` (`AgentRow.auto`, `agentRows`, `renderAgents`)
- Test: `tests/commands/sync-auto.test.ts` (create); `tests/commands/route.test.ts` (one matcher case — confirm file with `ls tests/commands | grep route`)

**Interfaces:**
- Consumes: `SonataConfig.autoRoute` (Task 1); `tiersCollapse`, `TIER_NAMES`, `Tier`; `tierQualifiesForExtendedContext` from `src/extended-context.ts`; `SONATA_AGENT_MATCHER` from `src/commands/route.ts`.
- Produces: `export function autoAgentRoles(config: SonataConfig): string[]` (config.ts); `export function autoAgentMarkdown(spec: { role: string; extendedContext?: boolean; availableTiers: readonly Tier[]; planTiers: readonly Tier[] }): string` (sync.ts); `AgentRow.auto?: boolean`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/commands/sync-auto.test.ts
import { describe, it, expect } from 'vitest';
import { parseConfig, expectedAgentNames, autoAgentRoles } from '../../src/config.js';
import { plannedAgents } from '../../src/commands/sync.js';
import { agentRows, renderAgents } from '../../src/commands/agents.js';
import { SONATA_AGENT_MATCHER } from '../../src/commands/route.js';

const CONFIG = (auto: boolean) => parseConfig(`
${auto ? '[auto_route]\nclassifier = "jev"\n' : ''}
[models."a"]
gateway = "g"
id = "a-1"

[models."b"]
gateway = "g"
id = "b-1"

[native.gateways."g"]
base_url = "https://g.example/v1"

[tiers.code]
simple = ["a"]
normal = ["a", "b"]
complex = ["b"]

[tiers.explore]
simple = ["a"]
complex = ["a"]
`);

describe('<role>-auto agents', () => {
  it('exist only when [auto_route] is set, and not for collapsed roles', () => {
    expect(autoAgentRoles(CONFIG(false))).toEqual([]);
    expect(autoAgentRoles(CONFIG(true))).toEqual(['code']);
    expect(expectedAgentNames(CONFIG(true))).toContain('code-auto');
    expect(expectedAgentNames(CONFIG(true))).not.toContain('explore-auto');
  });

  it('are generated with the auto alias', () => {
    const agent = plannedAgents(CONFIG(true)).find((a) => a.name === 'code-auto');
    expect(agent?.content).toMatch(/^model: sonata-code-auto$/m);
    expect(agent?.content).toMatch(/chooses the tier/);
    expect(agent?.content).toMatch(/no `model` argument/i);
    expect(plannedAgents(CONFIG(false)).some((a) => a.name.endsWith('-auto'))).toBe(false);
  });

  it('appear in sonata agents, marked auto-routed', () => {
    const rows = agentRows(CONFIG(true));
    expect(rows.find((r) => r.agent === 'code-auto')).toMatchObject({ auto: true, role: 'code' });
    expect(renderAgents(rows).join('\n')).toMatch(/code-auto[\s\S]*auto-routed/);
  });

  it('are matched by the routing hook matcher', () => {
    expect(new RegExp(SONATA_AGENT_MATCHER).test('code-auto')).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/commands/sync-auto.test.ts`
Expected: FAIL (`autoAgentRoles` not exported).

- [ ] **Step 3: Implement**

`src/config.ts`, next to `tierAgentNames`:

```ts
/** Roles that get a `<role>-auto` agent: auto-routing on, and a real choice of tiers. */
export function autoAgentRoles(config: SonataConfig): string[] {
  if (config.autoRoute === undefined || config.tiers === undefined) return [];
  return Object.entries(config.tiers)
    .filter(([, lists]) => !tiersCollapse(lists))
    .map(([role]) => role);
}
```

and in `expectedAgentNames`, replace `if (config.tiers !== undefined) return tierAgentNames(config.tiers);` with:

```ts
  if (config.tiers !== undefined) {
    return [...tierAgentNames(config.tiers), ...autoAgentRoles(config).map((role) => `${role}-auto`)];
  }
```

`src/commands/sync.ts`, after `tierAgentMarkdown`:

```ts
/**
 * A `<role>-auto` agent: same role prompt, but the router chooses the tier
 * once per conversation (`src/native/auto-route.ts`). Its fan-out rule is the
 * `normal` one — the tier is not known when the prompt is written, and
 * `normal` may reach only `simple`, which is safe whichever tier is chosen.
 */
export function autoAgentMarkdown(spec: {
  role: string;
  extendedContext?: boolean;
  availableTiers: readonly Tier[];
  planTiers: readonly Tier[];
}): string {
  const blurb = ROLE_BLURB[spec.role] ?? spec.role;
  const alias = `sonata-${spec.role}-auto`;
  const model = spec.extendedContext === true ? `${alias}${EXTENDED_CONTEXT_SUFFIX}` : alias;
  const tools = toolsForRole(spec.role);
  const delegating = delegatingForRole(spec.role, spec.planTiers, 'normal', spec.availableTiers);
  const description = `Runs ${blurb} on a ranked list of foreign models, natively inside Claude Code's loop; sonata chooses the tier (${spec.availableTiers.join(', ')}) for each task. The default choice — use an explicit -${spec.availableTiers.join(' / -')} agent only when you know the tier better. ${NO_MODEL_ARG} Requires a routed session (sonata code, or sonata route on/auto).`;
  return `---
name: ${spec.role}-auto
description: ${description}
model: ${model}
${tools}---

This agent only works in a routed session (sonata code, or sonata route on/auto).

${NO_MODEL_ARG}

Sonata chooses the tier for this task once, from its first message, and keeps
it for the whole conversation. If the choice was too low and the work fails
review, re-run it on the explicit tier agent one step up.

${TIER_AGENT_MARKER} — edits here are overwritten on the next sync.

Focus on ${blurb}.${delegating}
`;
}
```

(The names `ROLE_BLURB`, `EXTENDED_CONTEXT_SUFFIX`, `toolsForRole`, `delegatingForRole`, `NO_MODEL_ARG` and `TIER_AGENT_MARKER` are the ones `tierAgentMarkdown` already uses in this file. If `delegatingForRole`'s third parameter is typed `Tier | undefined`, `'normal'` satisfies it.)

In `plannedAgents`, before `return out;`:

```ts
  for (const role of autoAgentRoles(config)) {
    const lists = config.tiers[role];
    const available = tiersOf(role);
    out.push({
      name: `${role}-auto`,
      content: autoAgentMarkdown({
        role,
        // Serves every present list, so it may claim only the window all of them honour.
        extendedContext: available.every((tier) => {
          const keys = lists[tier];
          return keys !== undefined && tierQualifiesForExtendedContext(config, keys);
        }),
        availableTiers: available,
        planTiers,
      }),
    });
  }
```

(add `autoAgentRoles` to the `../config.js` import).

`src/commands/agents.ts`: add `auto?: boolean;` to `AgentRow` (doc comment: "An auto-routed agent: sonata chooses the tier, so it has no ranking of its own."). At the end of `agentRows`, before `return rows;`:

```ts
  for (const role of autoAgentRoles(config)) {
    rows.push({ agent: `${role}-auto`, role, auto: true, models: [], extendedContext: false });
  }
```

In `renderAgents`, at the top of the loop body after the header line is pushed:

```ts
    if (row.auto === true) {
      lines.push('    (auto-routed: sonata chooses the tier per conversation — see the tier agents below/above for the models)');
      continue;
    }
```

This must come before the `row.models.length === 0` branch. Check that the interactive editor (`cmdAgents`) builds its rows from `[tiers]` and not from `agentRows`; if it iterates `agentRows`, skip rows with `auto === true` there.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/commands/sync-auto.test.ts tests/commands/sync.test.ts tests/commands/agents.test.ts tests/commands/doctor.test.ts`
Expected: PASS. (Confirm the exact test filenames with `ls tests/commands`.)

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/commands/sync.ts src/commands/agents.ts tests/commands/sync-auto.test.ts
git commit -m "feat(sync): generate <role>-auto agents when [auto_route] is set"
```

---

### Task 6: Guidance block

**Files:**
- Modify: `src/init/guidance.ts` (`guidanceBlock`)
- Modify: `src/init/plan.ts` (guidance plan carries `autoRoute: boolean`) and `src/init/apply.ts:145`
- Test: `tests/init/guidance.test.ts`

**Interfaces:**
- Consumes: `SonataConfig.autoRoute`.
- Produces: `guidanceBlock(opts?: { autoRoute?: boolean }): string`; `InitPlan.guidance.autoRoute?: boolean`.

- [ ] **Step 1: Write the failing tests** (append to `tests/init/guidance.test.ts`)

```ts
describe('guidanceBlock with auto-routing', () => {
  it('is unchanged when auto-routing is off', () => {
    expect(guidanceBlock({ autoRoute: false })).toBe(guidanceBlock());
    expect(guidanceBlock()).not.toMatch(/-auto/);
  });

  it('makes -auto the default when auto-routing is on', () => {
    const block = guidanceBlock({ autoRoute: true });
    expect(block).toMatch(/`code-auto`/);
    expect(block).toMatch(/default/i);
    expect(block.startsWith(GUIDANCE_BEGIN)).toBe(true);
    expect(block.trimEnd().endsWith(GUIDANCE_END)).toBe(true);
  });
});
```

(import `GUIDANCE_BEGIN`, `GUIDANCE_END` if the file does not already.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/init/guidance.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Change the signature to `export function guidanceBlock(opts: { autoRoute?: boolean } = {}): string` and, in the array, directly after the paragraph ending `'"done" is still ambiguous.',` and its following `''`, insert:

```ts
    ...(opts.autoRoute === true ? [
      '**Auto-routing is on:** prefer the `<role>-auto` agents (`code-auto`,',
      '`review-auto`, …). Sonata chooses the tier for each task; use an explicit',
      'tier agent only when you know the tier better than a classifier would.',
      '',
    ] : []),
```

In `src/init/plan.ts`, where the guidance part of the plan is built (`/usr/bin/grep -n "guidance" src/init/plan.ts`), add `autoRoute: configForScope?.autoRoute !== undefined` to that object and to its type. In `src/init/apply.ts:145`, call `guidanceBlock({ autoRoute: plan.guidance.autoRoute === true })`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/init/guidance.test.ts tests/init/apply.test.ts tests/init/plan.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/init/guidance.ts src/init/plan.ts src/init/apply.ts tests/init/guidance.test.ts
git commit -m "feat(init): guidance block prefers -auto agents when auto-routing is on"
```

---

### Task 7: `sonata usage --by route` and the decision summary

**Files:**
- Modify: `src/commands/usage.ts` (`UsageDimension`, `USAGE_DIMENSIONS`, the dimension switch near line 260, `UsageReport`, the aggregate near line 312, and the printed report)
- Test: `tests/commands/usage.test.ts` (confirm name with `ls tests/commands | grep usage`)

**Interfaces:**
- Consumes: `LedgerRow.route`, `LedgerRow.autoRoute` (Task 2).
- Produces: dimension `'route'`; `UsageReport.autoRoute?: { outcomes: Record<'accepted' | 'low-confidence' | 'invalid' | 'failed', number>; classifierTokens: { input: number; output: number } }`.

- [ ] **Step 1: Write the failing tests**

Using the file's existing row builder (find with `/usr/bin/grep -n "function row\|const row\|makeRow" tests/commands/usage.test.ts | head`), add:

```ts
it('groups by route: auto, manual, and unlabelled', () => {
  const rows = [
    row({ tier: 'simple', route: 'auto' }),
    row({ tier: 'complex', route: 'manual' }),
    row({ tier: 'complex' }),
  ];
  const report = aggregate(rows, 'route' /* adjust to the file's aggregate signature */);
  expect(report.buckets.map((b) => b.label).sort()).toEqual(['auto', 'manual', '—'].sort());
});

it('summarises classifier decisions and tokens, never pricing them', () => {
  const rows = [
    row({ route: 'auto', autoRoute: { classifier: 'jev', outcome: 'accepted', ms: 300, tokens: { input: 300, output: 30 } } }),
    row({ route: 'auto', autoRoute: { classifier: 'jev', outcome: 'low-confidence', ms: 280, tokens: { input: 310, output: 30 } } }),
    row({ route: 'auto', autoRoute: { classifier: 'jev', outcome: 'failed', ms: 3000 } }),
  ];
  const report = aggregate(rows, 'tier');
  expect(report.autoRoute).toEqual({
    outcomes: { accepted: 1, 'low-confidence': 1, invalid: 0, failed: 1 },
    classifierTokens: { input: 610, output: 60 },
  });
  expect(report.pricedTotalUsd).toBe(aggregate(rows.map(({ autoRoute: _, ...r }) => r), 'tier').pricedTotalUsd);
});
```

Rows with no `route` label as `—` (older rows, and harness rows). Match the exact `aggregate` call shape the file already uses; the assertions are what matters.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/commands/usage.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `UsageDimension`: add `'route'`; `USAGE_DIMENSIONS`: add `'route'` after `'tier'`.
- Dimension switch: `case 'route': return row.route ?? '—';`
- `UsageReport`: add

```ts
  /**
   * Auto-route decisions in the window and the classifier's own token volume.
   * Never priced and never folded into `pricedTotalUsd`: sonata knows no
   * TypeSafe rate, and unknown is never zero. Absent when no row carries one.
   */
  autoRoute?: { outcomes: Record<'accepted' | 'low-confidence' | 'invalid' | 'failed', number>; classifierTokens: { input: number; output: number } };
```

- In the aggregate loop (where `unpriced` is accumulated), add before the loop:

```ts
  let autoRoute: UsageReport['autoRoute'];
```

and inside it:

```ts
    if (row.autoRoute !== undefined) {
      autoRoute ??= { outcomes: { accepted: 0, 'low-confidence': 0, invalid: 0, failed: 0 }, classifierTokens: { input: 0, output: 0 } };
      autoRoute.outcomes[row.autoRoute.outcome] += 1;
      autoRoute.classifierTokens.input += row.autoRoute.tokens?.input ?? 0;
      autoRoute.classifierTokens.output += row.autoRoute.tokens?.output ?? 0;
    }
```

and add `...(autoRoute === undefined ? {} : { autoRoute }),` to the returned report.

- Printed report: find where `noPromptTokens` is printed (`/usr/bin/grep -rn "noPromptTokens" src/commands src/tui-ink | head`) and add beside it, in the same style:

```ts
  if (report.autoRoute !== undefined) {
    const o = report.autoRoute.outcomes;
    lines.push(`auto-route decisions: ${o.accepted} accepted, ${o['low-confidence']} low-confidence, ${o.invalid} invalid, ${o.failed} failed · classifier ${report.autoRoute.classifierTokens.input} in / ${report.autoRoute.classifierTokens.output} out tokens (not priced)`);
  }
```

(adapt `lines.push` to however that printer emits lines). If `--json` serialises the report object, `autoRoute` is included automatically.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/commands/usage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/usage.ts tests/commands/usage.test.ts
git commit -m "feat(usage): --by route, and auto-route decisions reported beside the priced total"
```

---

### Task 8: `sonata doctor` checks

**Files:**
- Modify: `src/commands/doctor.ts` (after the `agents` check near line 817)
- Test: `tests/commands/doctor.test.ts`

**Interfaces:**
- Consumes: `SonataConfig.autoRoute`, `autoAgentRoles` (Task 5), `resolveKeyFromSource`.
- Produces: doctor checks named `auto route`.

- [ ] **Step 1: Write the failing tests**

Using the file's existing harness for running `cmdDoctor` against a temp project (find with `/usr/bin/grep -n "cmdDoctor(" tests/commands/doctor.test.ts | head -3`), add three cases with a config containing `[auto_route]\nclassifier = "jev"` and a non-collapsed `[tiers.code]`:

```ts
it('warns when auto-routing is on without a TypeSafe key', async () => {
  // no ~/.config/sonata/keys.json entry for typesafe
  const { checks } = await runDoctor(/* config with [auto_route] */);
  expect(checks.find((c) => c.name === 'auto route' && /sonata auth add typesafe/.test(c.detail))).toBeDefined();
});

it('names sonata sync when a -auto agent file is missing', async () => {
  const { checks } = await runDoctor(/* same config, key present, no .claude/agents/code-auto.md */);
  expect(checks.find((c) => c.name === 'auto route' && /sonata sync/.test(c.detail) && /code-auto/.test(c.detail))).toBeDefined();
});

it('reports nothing about auto-routing when it is off', async () => {
  const { checks } = await runDoctor(/* config without [auto_route] */);
  expect(checks.some((c) => c.name === 'auto route')).toBe(false);
});
```

Replace `runDoctor` with the file's helper and write the key into the temp home's `.config/sonata/keys.json` using the same shape `cmdAuthAdd` writes (read `src/commands/auth.ts` for it, or call `cmdAuthAdd({ home, gateway: 'typesafe', key: 'k' })` directly).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/commands/doctor.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

After the `agents` check:

```ts
  if (config.autoRoute !== undefined) {
    // A warning, not an error: with no key every auto request still routes —
    // it just always takes the fallback tier, which is today's default.
    if (resolveKeyFromSource('typesafe', home, 'sonata') === undefined) {
      checks.push({ name: 'auto route', ok: false, detail: 'on, but no TypeSafe key — every -auto request takes the fallback tier. Run `sonata auth add typesafe`' });
    }
    const missing = autoAgentRoles(config)
      .map((role) => `${role}-auto`)
      .filter((name) => !existsSync(join(agentsDir, `${name}.md`)));
    checks.push(missing.length === 0
      ? { name: 'auto route', ok: true, detail: `on (jev, min_confidence ${config.autoRoute.minConfidence})` }
      : { name: 'auto route', ok: false, detail: `agent file(s) missing: ${missing.join(', ')} — run \`sonata sync\`` });
  }
```

Use the variable doctor already holds for the home directory (check the top of `cmdDoctor` for `opts.home ?? homedir()`), and add imports for `autoAgentRoles` and `resolveKeyFromSource` if absent. If doctor's `ok: false` makes the command exit non-zero and the key warning should not, look at how other advisory checks (e.g. `gateway pricing`) express a warning and use the same field.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/commands/doctor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/doctor.ts tests/commands/doctor.test.ts
git commit -m "feat(doctor): check the TypeSafe key and -auto agents when auto-routing is on"
```

---

### Task 9: Docs, changelog, full verification

**Files:**
- Modify: `docs/guide/security.md`, `docs/guide/configuration.md`, `docs/internals/configuration.md`, `docs/internals/native-path.md`, `CLAUDE.md`, `CHANGELOG.md`, `docs/superpowers/README.md`

- [ ] **Step 1: Write the docs**

- `docs/guide/security.md` — a paragraph: when `[auto_route]` is set, the first message of each `-auto` subagent task, with `<system-reminder>` blocks removed and capped at 8,000 characters, is sent to TypeSafe (`api.typesafe.ai`); nothing else is. Off unless written.
- `docs/guide/configuration.md` — the `[auto_route]` table, `sonata auth add typesafe`, the `-auto` agents, the fallback rule, and that `[budget]` does not bound classifier calls.
- `docs/internals/configuration.md` — the parse rules (refusals) and the round-trip through `nativeTomlFor`.
- `docs/internals/native-path.md` — the router branch: after budget and repair, before the tier path; decision store bounds; `route`/`autoRoute` on ledger rows; the 400 when off.
- `CLAUDE.md` — one line under *Native path*: "**Auto-routed tiers** (`[auto_route]`, `src/native/auto-route.ts`): `sonata-<role>-auto` gets one Jev tier decision per conversation, fail-open to `normal`; the chosen alias then takes the unchanged tier path."
- `CHANGELOG.md` under `## [Unreleased]` → `### Added`: the feature, opt-in, what is sent, fail-open, `sonata usage --by route`.
- `docs/superpowers/README.md` — change this spec's row to link the plan.

- [ ] **Step 2: Full verification**

Run: `npm run typecheck && npm test`
Expected: both pass. Then `npm run build && npm link` and `sonata --version`.

- [ ] **Step 3: Commit**

```bash
git add docs CLAUDE.md CHANGELOG.md
git commit -m "docs: auto-routed tiers — configuration, privacy, router branch"
```

- [ ] **Step 4: Live check (only if a TypeSafe key is stored)**

Run a one-off classification against the real endpoint with a sonata-shaped task, save the response body to `tests/fixtures/typesafe/choice-tier.json` (no key in it), add a `parseJevAnswer` test reading that fixture, and commit. Then, in a routed session in a project with `[auto_route]` set and `sonata sync` run, dispatch one `code-auto` task and confirm with `sonata usage --by route --json` that its first row carries `autoRoute`. Record latency in the spec's open questions.

- [ ] **Step 5: Open the PR**

Push the branch, open a PR describing the feature and what was verified, run `node scripts/pr-status.mjs <n>`, request the first review with `@coderabbitai review`, and keep `node scripts/pr-status.mjs <n> --watch=60 --until-change` running in the background.
