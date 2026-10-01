# Decision-Model Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `[auto_route]` takes one `base_url`; sonata lists the decision models that URL serves, scores them with JevBench, and asks the best one — or a pinned `model`.

**Architecture:** Four focused units. `src/decision-catalog.ts` fetches, caches and loads JevBench capability scores (beside the AA catalog). `src/native/decision-models.ts` is pure selection: parse a `/v1/models` listing, normalise ids, match scores, choose a model. `src/native/auto-route.ts`'s `decisionClassifier` becomes URL-based (endpoint, key by host, lazy model, loopback = $0). `serve` wires a cached lister + the catalog into `classifierFor`. Config, doctor and docs follow.

**Tech Stack:** TypeScript (Node 22, ESM), vitest, global `fetch`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-01-decision-model-selection-design.md` (amends `2026-09-30-jev-auto-route-design.md`).

## Global Constraints

- Branch `feat/auto-route-openrouter`; do not push, do not open a PR.
- `[auto_route]` keys: `classifier` (only `"jev"`), `base_url` (optional absolute `http`/`https` URL, default `https://api.typesafe.ai`, trailing `/` ignored), `model` (optional non-empty string), `min_confidence` (0–1, default 0.5). `provider` is removed.
- Decision endpoint: `<base_url>/v1/systemone`. Listing endpoint: `GET <base_url>/v1/models`.
- Key by host: `openrouter.ai` → `resolveKeys(['openrouter'], home)[0]?.key`; `api.typesafe.ai` → `resolveKeyFromSource('typesafe', home, 'sonata')`; any other host → `resolveKeyFromSource('auto-route', home, 'sonata')`, and no `Authorization` header when absent.
- JevBench URL pinned: `https://benchmarkheaven.com/api/jevbench/v1.5.4` (no "latest" endpoint exists; the root serves an older v1 document). Capability = mean of `axes.intelligence` and `axes.calibration`.
- Matching is exact after normalisation only — never fuzzy.
- Selection: pinned `model` → use it; else highest capability; exact tie → lower listed price (free lowest, unlisted last); unscored after all scored; nothing scored / no list → default (`~typesafe/jev-latest` for host `openrouter.ai`, otherwise no `model` field).
- Listing cache per URL: 1 h on success; a failed fetch is not retried for 5 min. Listing fetch timeout 3 s.
- Cost: `usage.cost` when present; else `$0` for loopback hosts (`localhost`, `127.0.0.0/8`, `::1`); else unpriced.
- Keep each file's layout, doc-comment density and single quotes; never run a formatter; never `git add` under `.superpowers/`.
- `npm run typecheck` and `npm test` pass before the branch is done; finish with `npm run build`.
- Version: 0.15.1 (changelog under `[Unreleased]`; the release itself is not part of this plan).

## Review Focus

1. **A 0.15.0 config (`classifier` + `min_confidence` only)** must keep calling `https://api.typesafe.ai/v1/systemone` with the TypeSafe key and write back byte-identically. Test in Task 1 and Task 4.
2. **A URL whose `/v1/models` is a chat-model list without decision entries** (e.g. an OpenAI-compatible LLM server) must select nothing and use the default, never a chat model. Test in Task 3.
3. **A key sent to the wrong host** — the OpenRouter key must never go to TypeSafe or a third-party URL. Test in Task 4.
4. **A stale or missing decision catalog** must not break routing: selection falls back to the default. Test in Task 3/5.
5. **An alias in the listing (`~typesafe/jev-latest`)** must not be chosen over the scored release it points at. Test in Task 3.

---

### Task 1: Config — `base_url` replaces `provider`

**Files:**
- Modify: `src/config.ts` (`AutoRouteProvider`, `OPENROUTER_DEFAULT_DECISION_MODEL`, `AutoRouteConfig` ~L193-212; the `[auto_route]` parse block ~L585-615)
- Modify: `src/init/toml.ts` (the `[auto_route]` emit ~L181-190)
- Test: `tests/config-auto-route.test.ts`

**Interfaces:**
- Produces: `export const DEFAULT_DECISION_BASE_URL = 'https://api.typesafe.ai'`; `export const OPENROUTER_DEFAULT_DECISION_MODEL = '~typesafe/jev-latest'` (kept); `AutoRouteConfig = { classifier: 'jev'; baseUrl: string; model?: string; minConfidence: number }` (`baseUrl` always set after parsing, normalised without trailing `/`). `AutoRouteProvider` and `provider` are deleted.

- [ ] **Step 1: Replace the provider tests with base_url tests.** In `tests/config-auto-route.test.ts`, delete the whole `describe('[auto_route] decision provider', …)` block and every `provider: 'typesafe'` in other expectations, then append:

```ts
describe('[auto_route] base_url and model', () => {
  it('defaults base_url to TypeSafe and leaves model unset', () => {
    const c = parseConfig(`[auto_route]\nclassifier = "jev"\n${BASE}`);
    expect(c.autoRoute).toEqual({ classifier: 'jev', baseUrl: 'https://api.typesafe.ai', minConfidence: 0.5 });
  });

  it('reads any http(s) base_url, without a trailing slash, and a pinned model', () => {
    const c = parseConfig(`[auto_route]\nclassifier = "jev"\nbase_url = "http://localhost:8000/"\nmodel = "bosun-v3.1-1.7b"\n${BASE}`);
    expect(c.autoRoute).toMatchObject({ baseUrl: 'http://localhost:8000', model: 'bosun-v3.1-1.7b' });
  });

  it.each([
    ['provider (removed)', 'classifier = "jev"\nprovider = "openrouter"'],
    ['a relative base_url', 'classifier = "jev"\nbase_url = "openrouter.ai/api"'],
    ['a non-http base_url', 'classifier = "jev"\nbase_url = "ftp://x.example"'],
    ['a non-string base_url', 'classifier = "jev"\nbase_url = 5'],
    ['an empty model', 'classifier = "jev"\nmodel = ""'],
  ])('refuses %s', (_label, body) => {
    expect(() => parseConfig(`[auto_route]\n${body}\n${BASE}`)).toThrow(/\[auto_route\]/);
  });

  const candidate = { key: 'g-m', gateway: 'g', id: 'm-1', contextWindow: 128000, baseUrl: 'https://g.example/v1', auth: 'api-key' as const };
  const write = (autoRoute: ReturnType<typeof parseConfig>['autoRoute']) => nativeTomlFor(
    { code: [candidate] }, {}, { code: { simple: ['g-m'], complex: ['g-m'] } },
    undefined, undefined, undefined, [], undefined, undefined, [], autoRoute,
  );

  it('round-trips base_url and model', () => {
    const c = parseConfig(`[auto_route]\nclassifier = "jev"\nbase_url = "https://openrouter.ai/api"\nmodel = "typesafe/jev-1.13"\n${BASE}`);
    expect(parseConfig(write(c.autoRoute)).autoRoute).toEqual(c.autoRoute);
  });

  it('writes a 0.15.0 config back without base_url or model', () => {
    const c = parseConfig(`[auto_route]\nclassifier = "jev"\nmin_confidence = 0.5\n${BASE}`);
    const toml = write(c.autoRoute);
    expect(toml).toContain('[auto_route]\nclassifier = "jev"\nmin_confidence = 0.5\n');
    expect(toml).not.toMatch(/^(base_url|model|provider) =/m);
  });
});
```

Update the earlier "reads classifier and defaults min_confidence" and "round-trips through nativeTomlFor" expectations to the new shape (`baseUrl: 'https://api.typesafe.ai'` instead of `provider: 'typesafe'`).

- [ ] **Step 2: Run** `npx vitest run tests/config-auto-route.test.ts` — expect FAIL.

- [ ] **Step 3: Implement in `src/config.ts`.** Replace `AutoRouteProvider`, the `provider` doc + field with:

```ts
/** Where the tier question is asked when `[auto_route]` names no `base_url`. */
export const DEFAULT_DECISION_BASE_URL = 'https://api.typesafe.ai';

/** The decision model OpenRouter is asked for when nothing better is selected. */
export const OPENROUTER_DEFAULT_DECISION_MODEL = '~typesafe/jev-latest';

export interface AutoRouteConfig {
  classifier: 'jev';
  /**
   * Any server speaking Jev's API: TypeSafe, OpenRouter (`https://openrouter.ai/api`)
   * or a self-hosted `jev-compatible-server`. Stored without a trailing slash.
   */
  baseUrl: string;
  /** A pinned decision model; absent means sonata selects the best one the URL lists. */
  model?: string;
  /** Below this classifier confidence the fallback tier is used. */
  minConfidence: number;
}
```

In the parse block: known keys become `classifier`, `base_url`, `model`, `min_confidence` (update the error text); delete the provider checks; add:

```ts
    const rawBase = section.base_url ?? DEFAULT_DECISION_BASE_URL;
    let baseUrl: string;
    try {
      if (typeof rawBase !== 'string') throw new Error('not a string');
      const url = new URL(rawBase);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('not http(s)');
      baseUrl = rawBase.replace(/\/+$/, '');
    } catch {
      throw new Error(`sonata.toml: [auto_route] base_url must be an absolute http(s) URL, got ${JSON.stringify(rawBase)}`);
    }
    const model = section.model;
    if (model !== undefined && (typeof model !== 'string' || model.trim() === '')) {
      throw new Error(`sonata.toml: [auto_route] model must be a non-empty string, got ${JSON.stringify(model)}`);
    }
```

and build `autoRoute = { classifier: 'jev', baseUrl, ...(model === undefined ? {} : { model }), minConfidence: min };`.

- [ ] **Step 4: Implement in `src/init/toml.ts`.** Replace the provider/model emission with:

```ts
    lines.push('[auto_route]', `classifier = ${tomlKey(existingAutoRoute.classifier)}`);
    // Only what the user set: the default URL writes nothing, so a file that
    // never named one round-trips unchanged.
    if (existingAutoRoute.baseUrl !== DEFAULT_DECISION_BASE_URL) lines.push(`base_url = ${tomlKey(existingAutoRoute.baseUrl)}`);
    if (existingAutoRoute.model !== undefined) lines.push(`model = ${tomlKey(existingAutoRoute.model)}`);
    lines.push(`min_confidence = ${existingAutoRoute.minConfidence}`, '');
```

(import `DEFAULT_DECISION_BASE_URL` from `../config.js`; a hand-built config object without `baseUrl` must not throw — treat `undefined` like the default.)

- [ ] **Step 5: Run** the config tests, then `npm run typecheck` (it will now fail in auto-route.ts / doctor.ts / serve.ts, which still reference `provider`; leave those for Tasks 4–6 but make the config tests pass).

- [ ] **Step 6: Commit** `feat(config): [auto_route] base_url replaces provider` (Co-Authored-By trailer). Typecheck errors elsewhere are expected until Task 4; note them in the commit body.

---

### Task 2: JevBench decision catalog

**Files:**
- Create: `src/decision-catalog.ts`
- Modify: `src/commands/catalog.ts` (`cmdCatalogUpdate`, its result type)
- Modify: `src/cli.ts` (`sonata catalog update` printing, ~L540-560)
- Test: `tests/decision-catalog.test.ts` (create); `tests/fixtures/jevbench/v1.5.4-sample.json` (create, hand-built)

**Interfaces:**
- Produces (`src/decision-catalog.ts`):
  - `export const JEVBENCH_URL = 'https://benchmarkheaven.com/api/jevbench/v1.5.4'`
  - `export const JEVBENCH_ATTRIBUTION = 'Decision-model scores by JevBench (Benchmark Heaven) — https://benchmarkheaven.com/jev-models'`
  - `export interface DecisionCatalogEntry { key: string; display: string; repo?: string; capability: number; usdPer1000?: number }`
  - `export interface DecisionCatalog { fetchedAt: string; revision: string; sourceSha256?: string; systems: DecisionCatalogEntry[] }`
  - `export function decisionCatalogPath(home: string): string` → `<home>/.config/sonata/decision-catalog.json`
  - `export function parseJevBench(json: unknown, fetchedAt: string): DecisionCatalog` (throws on a missing `systems` array)
  - `export function loadDecisionCatalog(home: string): DecisionCatalog | undefined` (undefined when absent/unparseable; drops entries without a finite capability)
  - `export async function updateDecisionCatalog(home: string, fetchFn: typeof fetch, deps: { now?: () => Date }): Promise<{ systems: number; path: string; fetchedAt: string; revision: string }>`
- `CatalogUpdateResult` gains `decisions: { systems; path; fetchedAt; revision } | CatalogUpdateFailure`.

- [ ] **Step 1: Write the fixture** `tests/fixtures/jevbench/v1.5.4-sample.json` (hand-built, not copied data):

```json
{
  "benchmark": "JevBench", "revision": "v1.5.4", "source_sha256": "abc123",
  "systems": [
    { "key": "jev-1.13.0", "display": "Jev 1.13.0 (TypeSafe AI)", "repo": "https://docs.typesafe.ai",
      "axes": { "intelligence": 72, "calibration": 88, "speed": 84, "cost": 55 },
      "cost": { "kind": "estimate", "usd_per_1000": 0.032 } },
    { "key": "kev-4b", "display": "kev 4B", "repo": "https://github.com/jaredpalmer/kev",
      "axes": { "intelligence": 40, "calibration": 70, "speed": 60, "cost": 60 },
      "cost": { "kind": "estimate", "usd_per_1000": 0.03 } },
    { "key": "winnow-12b", "display": "Winnow-12B Q8", "repo": "https://huggingface.co/EldanRing/Winnow-12B",
      "axes": { "intelligence": 74, "calibration": 84, "speed": 86, "cost": 57 } },
    { "key": "broken", "display": "No axes" }
  ]
}
```

- [ ] **Step 2: Write the failing tests** `tests/decision-catalog.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseJevBench, loadDecisionCatalog, updateDecisionCatalog, decisionCatalogPath, JEVBENCH_URL,
} from '../src/decision-catalog.js';

const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures/jevbench/v1.5.4-sample.json'), 'utf8'));

describe('parseJevBench', () => {
  it('keeps systems with both axes, capability = mean(intelligence, calibration)', () => {
    const c = parseJevBench(fixture, '2026-10-01T00:00:00.000Z');
    expect(c.revision).toBe('v1.5.4');
    expect(c.sourceSha256).toBe('abc123');
    expect(c.systems.map((s) => s.key)).toEqual(['jev-1.13.0', 'kev-4b', 'winnow-12b']);
    expect(c.systems[0]).toEqual({ key: 'jev-1.13.0', display: 'Jev 1.13.0 (TypeSafe AI)', repo: 'https://docs.typesafe.ai', capability: 80, usdPer1000: 0.032 });
    expect(c.systems[2].usdPer1000).toBeUndefined();
  });
  it('throws without a systems array', () => {
    expect(() => parseJevBench({ revision: 'x' }, 'now')).toThrow();
  });
});

describe('update and load', () => {
  it('fetches the pinned URL, writes the cache, and loads it back', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dc-'));
    const urls: string[] = [];
    const r = await updateDecisionCatalog(home, (async (url: string) => { urls.push(url); return new Response(JSON.stringify(fixture)); }) as any, { now: () => new Date('2026-10-01T00:00:00Z') });
    expect(urls).toEqual([JEVBENCH_URL]);
    expect(r).toMatchObject({ systems: 3, revision: 'v1.5.4', path: decisionCatalogPath(home) });
    expect(loadDecisionCatalog(home)?.systems).toHaveLength(3);
  });
  it('rejects a non-2xx response', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dc-'));
    await expect(updateDecisionCatalog(home, (async () => new Response('x', { status: 503 })) as any, {})).rejects.toThrow(/HTTP 503/);
  });
  it('loads nothing from an absent or corrupt cache', () => {
    const home = mkdtempSync(join(tmpdir(), 'dc-'));
    expect(loadDecisionCatalog(home)).toBeUndefined();
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(decisionCatalogPath(home), '{not json');
    expect(loadDecisionCatalog(home)).toBeUndefined();
  });
});
```

(If the test files use ESM `import.meta.url` rather than `__dirname`, follow `tests/catalog*.test.ts`'s way of reading `tests/fixtures/aa/`.)

- [ ] **Step 3: Run** `npx vitest run tests/decision-catalog.test.ts` — FAIL.

- [ ] **Step 4: Implement `src/decision-catalog.ts`.**

```ts
/**
 * JevBench scores for decision models, cached beside the AA catalog.
 *
 * Decision models (Jev and the open models that copy its API) are ranked by
 * JevBench rather than AA, which does not cover them. Pinned to one revision
 * because the site publishes no "latest" index — its root serves an older v1
 * document — so a new revision is adopted by changing JEVBENCH_URL, the way
 * the LiteLLM version is pinned. The data is not committed; tests use a
 * hand-built fixture.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const JEVBENCH_URL = 'https://benchmarkheaven.com/api/jevbench/v1.5.4';
export const JEVBENCH_ATTRIBUTION = 'Decision-model scores by JevBench (Benchmark Heaven) — https://benchmarkheaven.com/jev-models';
const FETCH_TIMEOUT_MS = 30_000;

export interface DecisionCatalogEntry { key: string; display: string; repo?: string; capability: number; usdPer1000?: number }
export interface DecisionCatalog { fetchedAt: string; revision: string; sourceSha256?: string; systems: DecisionCatalogEntry[] }

export function decisionCatalogPath(home: string): string {
  return join(home, '.config', 'sonata', 'decision-catalog.json');
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Capability is the mean of JevBench's intelligence and calibration axes —
 * its own "Capability" figure, which leaves speed and cost out so that cost
 * can only ever break a tie (the spec's quality-first rule).
 */
function entryOf(system: unknown): DecisionCatalogEntry | undefined {
  if (system === null || typeof system !== 'object') return undefined;
  const s = system as { key?: unknown; display?: unknown; repo?: unknown; axes?: { intelligence?: unknown; calibration?: unknown }; cost?: { usd_per_1000?: unknown } };
  if (typeof s.key !== 'string' || !finite(s.axes?.intelligence) || !finite(s.axes?.calibration)) return undefined;
  return {
    key: s.key,
    display: typeof s.display === 'string' ? s.display : s.key,
    ...(typeof s.repo === 'string' ? { repo: s.repo } : {}),
    capability: (s.axes.intelligence + s.axes.calibration) / 2,
    ...(finite(s.cost?.usd_per_1000) && s.cost.usd_per_1000 >= 0 ? { usdPer1000: s.cost.usd_per_1000 } : {}),
  };
}

export function parseJevBench(json: unknown, fetchedAt: string): DecisionCatalog {
  const doc = json as { revision?: unknown; source_sha256?: unknown; systems?: unknown };
  if (doc === null || typeof doc !== 'object' || !Array.isArray(doc.systems)) {
    throw new Error('malformed JevBench response (expected a systems array)');
  }
  return {
    fetchedAt,
    revision: typeof doc.revision === 'string' ? doc.revision : 'unknown',
    ...(typeof doc.source_sha256 === 'string' ? { sourceSha256: doc.source_sha256 } : {}),
    systems: doc.systems.map(entryOf).filter((e): e is DecisionCatalogEntry => e !== undefined),
  };
}

export function loadDecisionCatalog(home: string): DecisionCatalog | undefined {
  const path = decisionCatalogPath(home);
  if (!existsSync(path)) return undefined;
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8')) as DecisionCatalog;
    if (typeof doc.fetchedAt !== 'string' || !Array.isArray(doc.systems)) return undefined;
    const systems = doc.systems.filter((e) => e !== null && typeof e === 'object'
      && typeof e.key === 'string' && finite(e.capability));
    return { ...doc, systems };
  } catch {
    return undefined;
  }
}

export async function updateDecisionCatalog(
  home: string, fetchFn: typeof fetch, deps: { now?: () => Date },
): Promise<{ systems: number; path: string; fetchedAt: string; revision: string }> {
  const response = await fetchFn(JEVBENCH_URL, { redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`JevBench request failed (HTTP ${response.status})`);
  let json: unknown;
  try { json = await response.json(); } catch { throw new Error('malformed JevBench response body'); }
  const fetchedAt = (deps.now?.() ?? new Date()).toISOString();
  const catalog = parseJevBench(json, fetchedAt);
  const path = decisionCatalogPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o600 });
  return { systems: catalog.systems.length, path, fetchedAt, revision: catalog.revision };
}
```

- [ ] **Step 5: Wire into `cmdCatalogUpdate`** (`src/commands/catalog.ts`): add `outcome(updateDecisionCatalog(home, fetchFn, deps))` to the `Promise.all` and return `{ aa, modelsDev, decisions }`; add `decisions` to `CatalogUpdateResult`. In `src/cli.ts`'s `catalog update` branch, print, after models.dev:

```ts
      if ('error' in result.decisions) {
        console.error(`JevBench decision catalog not updated: ${result.decisions.error.message}`);
      } else {
        console.log(`decision catalog updated: ${result.decisions.systems} systems (JevBench ${result.decisions.revision})`);
        console.log(`  path: ${result.decisions.path}`);
        console.log(JEVBENCH_ATTRIBUTION);
      }
```

and include `'error' in result.decisions` in the exit-code condition. Existing `cmdCatalogUpdate` tests that stub `fetch` by URL may now see a third request — make their stubs answer `JEVBENCH_URL` with the fixture (or a 503 where the test only asserts AA/models.dev) and keep their assertions.

- [ ] **Step 6: Run** the new test file and `tests/commands/catalog*.test.ts`; commit `feat(catalog): cache JevBench decision-model scores`.

---

### Task 3: Selection — listing, matching, choosing

**Files:**
- Create: `src/native/decision-models.ts`
- Test: `tests/native/decision-models.test.ts` (create)

**Interfaces:**
- Consumes: `DecisionCatalog`, `DecisionCatalogEntry` (Task 2); `OPENROUTER_DEFAULT_DECISION_MODEL` (Task 1).
- Produces (`src/native/decision-models.ts`):
  - `export interface ListedDecisionModel { id: string; pricePerToken?: number }`
  - `export function parseModelListing(json: unknown): ListedDecisionModel[] | undefined` — TypeSafe `{models:[{id|name}]}`; OpenRouter `{data:[…]}` keeping only `architecture.output_modalities` ∋ `'decisions'`; anything else `undefined`.
  - `export function normalizeDecisionId(id: string): string`
  - `export function scoreFor(id: string, catalog: DecisionCatalog | undefined): DecisionCatalogEntry | undefined`
  - `export interface DecisionChoice { model: string | undefined; reason: string; ranked: Array<{ id: string; capability?: number }> }`
  - `export function chooseDecisionModel(opts: { baseUrl: string; pinned?: string; listed: ListedDecisionModel[] | undefined; catalog: DecisionCatalog | undefined }): DecisionChoice`
  - `export function defaultDecisionModel(baseUrl: string): string | undefined` — `OPENROUTER_DEFAULT_DECISION_MODEL` for host `openrouter.ai`, else `undefined`.
  - `export class ModelListCache { constructor(fetchFn: typeof fetch, opts?: { now?: () => number; ttlMs?: number; failureTtlMs?: number; timeoutMs?: number }); list(baseUrl: string, key: string | undefined): Promise<ListedDecisionModel[] | undefined> }` — TTL 1 h, failure TTL 5 min, timeout 3 s, one in-flight fetch per URL.

- [ ] **Step 1: Write the failing tests** `tests/native/decision-models.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import {
  parseModelListing, normalizeDecisionId, scoreFor, chooseDecisionModel, defaultDecisionModel, ModelListCache,
} from '../../src/native/decision-models.js';
import type { DecisionCatalog } from '../../src/decision-catalog.js';

const catalog: DecisionCatalog = {
  fetchedAt: '2026-10-01T00:00:00Z', revision: 'v1.5.4',
  systems: [
    { key: 'jev-1.13.0', display: 'Jev 1.13.0', repo: 'https://docs.typesafe.ai', capability: 80 },
    { key: 'kev-4b', display: 'kev 4B', repo: 'https://github.com/jaredpalmer/kev', capability: 55 },
    { key: 'winnow-12b', display: 'Winnow', repo: 'https://huggingface.co/EldanRing/Winnow-12B', capability: 79 },
    { key: 'free-a', display: 'Free A', capability: 60 },
    { key: 'paid-a', display: 'Paid A', capability: 60 },
  ],
};

describe('parseModelListing', () => {
  it('reads TypeSafe {models}', () => {
    expect(parseModelListing({ models: [{ id: 'jev-1.13' }, { name: 'jev-1.12' }] })).toEqual([{ id: 'jev-1.13' }, { id: 'jev-1.12' }]);
  });
  it('reads OpenRouter {data}, keeping only decision models with their price', () => {
    expect(parseModelListing({ data: [
      { id: 'typesafe/jev-1.13', architecture: { output_modalities: ['decisions'] }, pricing: { prompt: '0.000000042' } },
      { id: 'openai/gpt-x', architecture: { output_modalities: ['text'] }, pricing: { prompt: '0.000001' } },
      { id: 'respan/span-01-lite:free', architecture: { output_modalities: ['decisions'] }, pricing: { prompt: '0' } },
    ] })).toEqual([{ id: 'typesafe/jev-1.13', pricePerToken: 0.000000042 }, { id: 'respan/span-01-lite:free', pricePerToken: 0 }]);
  });
  it('treats a chat-only list as no decision models, and junk as no list', () => {
    expect(parseModelListing({ data: [{ id: 'llama', architecture: { output_modalities: ['text'] } }] })).toEqual([]);
    expect(parseModelListing({ object: 'list', data: [{ id: 'llama' }] })).toEqual([]);
    expect(parseModelListing('nope')).toBeUndefined();
    expect(parseModelListing({ something: 1 })).toBeUndefined();
  });
});

describe('normalizeDecisionId / scoreFor', () => {
  it('drops vendor, ~, :variant and a trailing .0', () => {
    expect(normalizeDecisionId('typesafe/jev-1.13')).toBe('jev-1.13');
    expect(normalizeDecisionId('jev-1.13.0')).toBe('jev-1.13');
    expect(normalizeDecisionId('respan/span-01-lite:free')).toBe('span-01-lite');
    expect(normalizeDecisionId('~typesafe/jev-latest')).toBe('jev-latest');
  });
  it('matches by key, then by the repo path tail, exactly', () => {
    expect(scoreFor('typesafe/jev-1.13', catalog)?.key).toBe('jev-1.13.0');
    expect(scoreFor('jaredpalmer/kev-4b', catalog)?.key).toBe('kev-4b');
    expect(scoreFor('EldanRing/Winnow-12B', catalog)?.key).toBe('winnow-12b');
    expect(scoreFor('~typesafe/jev-latest', catalog)).toBeUndefined();
    expect(scoreFor('kev-4', catalog)).toBeUndefined();
    expect(scoreFor('typesafe/jev-1.13', undefined)).toBeUndefined();
  });
});

describe('chooseDecisionModel', () => {
  const or = 'https://openrouter.ai/api';
  it('uses a pinned model without ranking', () => {
    expect(chooseDecisionModel({ baseUrl: or, pinned: 'x/y', listed: [{ id: 'typesafe/jev-1.13' }], catalog }))
      .toMatchObject({ model: 'x/y', reason: 'pinned' });
  });
  it('picks the highest capability, never an alias or an unscored model', () => {
    const c = chooseDecisionModel({ baseUrl: or, listed: [
      { id: '~typesafe/jev-latest' }, { id: 'inception/mercury-decide:free', pricePerToken: 0 },
      { id: 'jaredpalmer/kev-4b' }, { id: 'typesafe/jev-1.13' },
    ], catalog });
    expect(c.model).toBe('typesafe/jev-1.13');
    expect(c.ranked.map((r) => r.id)).toEqual(['typesafe/jev-1.13', 'jaredpalmer/kev-4b', '~typesafe/jev-latest', 'inception/mercury-decide:free']);
  });
  it('breaks an exact tie on price: free, then cheaper, then unlisted', () => {
    const c = chooseDecisionModel({ baseUrl: or, listed: [
      { id: 'v/paid-a', pricePerToken: 0.0000001 }, { id: 'v/free-a', pricePerToken: 0 },
    ], catalog });
    expect(c.model).toBe('v/free-a');
  });
  it('falls back to the URL default when nothing is listed or scored', () => {
    expect(chooseDecisionModel({ baseUrl: or, listed: undefined, catalog }).model).toBe('~typesafe/jev-latest');
    expect(chooseDecisionModel({ baseUrl: or, listed: [{ id: 'x/unknown' }], catalog }).model).toBe('~typesafe/jev-latest');
    expect(chooseDecisionModel({ baseUrl: 'http://localhost:8000', listed: undefined, catalog: undefined }).model).toBeUndefined();
    expect(chooseDecisionModel({ baseUrl: 'https://api.typesafe.ai', listed: [{ id: 'jev-1.13' }], catalog: undefined }).model).toBeUndefined();
  });
  it('knows the default per host', () => {
    expect(defaultDecisionModel('https://openrouter.ai/api')).toBe('~typesafe/jev-latest');
    expect(defaultDecisionModel('https://api.typesafe.ai')).toBeUndefined();
  });
});

describe('ModelListCache', () => {
  const listing = { data: [{ id: 'typesafe/jev-1.13', architecture: { output_modalities: ['decisions'] } }] };
  it('fetches <base>/v1/models once per hour per URL, with the key', async () => {
    let t = 0;
    const calls: Array<{ url: string; auth?: string }> = [];
    const cache = new ModelListCache((async (url: string, init: RequestInit) => {
      calls.push({ url, auth: (init.headers as Record<string, string>)?.authorization });
      return new Response(JSON.stringify(listing));
    }) as any, { now: () => t });
    expect(await cache.list('https://openrouter.ai/api', 'k')).toEqual([{ id: 'typesafe/jev-1.13' }]);
    t = 30 * 60_000; await cache.list('https://openrouter.ai/api', 'k');
    expect(calls).toEqual([{ url: 'https://openrouter.ai/api/v1/models', auth: 'Bearer k' }]);
    t = 61 * 60_000; await cache.list('https://openrouter.ai/api', 'k');
    expect(calls).toHaveLength(2);
  });
  it('remembers a failure for 5 minutes and sends no auth header without a key', async () => {
    let t = 0;
    const f = vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>)?.authorization).toBeUndefined();
      return new Response('nope', { status: 404 });
    });
    const cache = new ModelListCache(f as any, { now: () => t });
    expect(await cache.list('http://localhost:8000', undefined)).toBeUndefined();
    t = 4 * 60_000; await cache.list('http://localhost:8000', undefined);
    expect(f).toHaveBeenCalledTimes(1);
    t = 6 * 60_000; await cache.list('http://localhost:8000', undefined);
    expect(f).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement `src/native/decision-models.ts`.**

```ts
/**
 * Which decision model a URL serves best (spec 2026-10-01-decision-model-selection).
 *
 * A URL lists its decision models (`GET /v1/models`); JevBench scores them;
 * the highest capability wins and cost only breaks a tie. Matching is exact
 * after normalisation — a guessed match would rank a model on another
 * model's score, the failure the AA lookup rules exist to prevent.
 */
import type { DecisionCatalog, DecisionCatalogEntry } from '../decision-catalog.js';
import { OPENROUTER_DEFAULT_DECISION_MODEL } from '../config.js';

export interface ListedDecisionModel { id: string; pricePerToken?: number }

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A `/v1/models` body as decision models, or undefined when it is no list at all. */
export function parseModelListing(json: unknown): ListedDecisionModel[] | undefined {
  if (!isRecord(json)) return undefined;
  if (Array.isArray(json.models)) {
    return json.models.flatMap((m): ListedDecisionModel[] => {
      const id = isRecord(m) ? (typeof m.id === 'string' ? m.id : typeof m.name === 'string' ? m.name : undefined) : undefined;
      return id === undefined ? [] : [{ id }];
    });
  }
  if (Array.isArray(json.data)) {
    // OpenRouter-style: one list for every model, so only entries that say
    // they output decisions count — never a chat model.
    return json.data.flatMap((m): ListedDecisionModel[] => {
      if (!isRecord(m) || typeof m.id !== 'string') return [];
      const outputs = isRecord(m.architecture) ? m.architecture.output_modalities : undefined;
      if (!Array.isArray(outputs) || !outputs.includes('decisions')) return [];
      const price = isRecord(m.pricing) ? Number(m.pricing.prompt) : Number.NaN;
      return [{ id: m.id, ...(Number.isFinite(price) && price >= 0 ? { pricePerToken: price } : {}) }];
    });
  }
  return undefined;
}

/** Lower-case; drop `~`, a `vendor/` prefix, a `:variant`, and a trailing `.0`. */
export function normalizeDecisionId(id: string): string {
  return id.toLowerCase().replace(/^~/, '').replace(/^.*\//, '').replace(/:[^:]*$/, '').replace(/\.0$/, '');
}

const repoTail = (repo: string | undefined): string | undefined => repo?.replace(/\/+$/, '').split('/').pop();

export function scoreFor(id: string, catalog: DecisionCatalog | undefined): DecisionCatalogEntry | undefined {
  if (catalog === undefined) return undefined;
  const want = normalizeDecisionId(id);
  return catalog.systems.find((s) => normalizeDecisionId(s.key) === want)
    ?? catalog.systems.find((s) => {
      const tail = repoTail(s.repo);
      return tail !== undefined && normalizeDecisionId(tail) === want;
    });
}

export function defaultDecisionModel(baseUrl: string): string | undefined {
  try {
    return new URL(baseUrl).hostname === 'openrouter.ai' ? OPENROUTER_DEFAULT_DECISION_MODEL : undefined;
  } catch {
    return undefined;
  }
}

export interface DecisionChoice { model: string | undefined; reason: string; ranked: Array<{ id: string; capability?: number }> }

export function chooseDecisionModel(opts: {
  baseUrl: string; pinned?: string; listed: ListedDecisionModel[] | undefined; catalog: DecisionCatalog | undefined;
}): DecisionChoice {
  if (opts.pinned !== undefined) return { model: opts.pinned, reason: 'pinned', ranked: [] };
  const rows = (opts.listed ?? []).map((m, index) => ({ ...m, index, capability: scoreFor(m.id, opts.catalog)?.capability }));
  rows.sort((a, b) => {
    // Scored before unscored; then capability; then price (unlisted last); then listed order.
    if ((a.capability === undefined) !== (b.capability === undefined)) return a.capability === undefined ? 1 : -1;
    if (a.capability !== undefined && b.capability !== undefined && a.capability !== b.capability) return b.capability - a.capability;
    const pa = a.pricePerToken ?? Number.POSITIVE_INFINITY;
    const pb = b.pricePerToken ?? Number.POSITIVE_INFINITY;
    return pa !== pb ? pa - pb : a.index - b.index;
  });
  const ranked = rows.map((r) => ({ id: r.id, ...(r.capability === undefined ? {} : { capability: r.capability }) }));
  const best = rows[0];
  if (best !== undefined && best.capability !== undefined) {
    return { model: best.id, reason: `JevBench capability ${best.capability.toFixed(1)}`, ranked };
  }
  const why = opts.listed === undefined ? 'no model list' : opts.catalog === undefined ? 'no decision catalog' : 'no listed model is scored';
  return { model: defaultDecisionModel(opts.baseUrl), reason: `${why} — URL default`, ranked };
}

/** `GET <base>/v1/models`, cached per URL: 1 h on success, 5 min after a failure. */
export class ModelListCache {
  private readonly entries = new Map<string, { at: number; ok: boolean; listed?: ListedDecisionModel[] }>();
  private readonly pending = new Map<string, Promise<ListedDecisionModel[] | undefined>>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly failureTtlMs: number;
  private readonly timeoutMs: number;

  constructor(private readonly fetchFn: typeof fetch, opts: { now?: () => number; ttlMs?: number; failureTtlMs?: number; timeoutMs?: number } = {}) {
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? 60 * 60_000;
    this.failureTtlMs = opts.failureTtlMs ?? 5 * 60_000;
    this.timeoutMs = opts.timeoutMs ?? 3_000;
  }

  async list(baseUrl: string, key: string | undefined): Promise<ListedDecisionModel[] | undefined> {
    const hit = this.entries.get(baseUrl);
    if (hit !== undefined && this.now() - hit.at < (hit.ok ? this.ttlMs : this.failureTtlMs)) return hit.listed;
    const inFlight = this.pending.get(baseUrl);
    if (inFlight !== undefined) return inFlight;
    const fetching = this.fetchList(baseUrl, key);
    this.pending.set(baseUrl, fetching);
    try {
      return await fetching;
    } finally {
      this.pending.delete(baseUrl);
    }
  }

  private async fetchList(baseUrl: string, key: string | undefined): Promise<ListedDecisionModel[] | undefined> {
    let listed: ListedDecisionModel[] | undefined;
    try {
      const res = await this.fetchFn(`${baseUrl}/v1/models`, {
        headers: key === undefined ? {} : { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      listed = res.ok ? parseModelListing(await res.json()) : undefined;
    } catch {
      listed = undefined;
    }
    this.entries.set(baseUrl, { at: this.now(), ok: listed !== undefined, listed });
    return listed;
  }
}
```

- [ ] **Step 4: Run** `npx vitest run tests/native/decision-models.test.ts` — PASS.
- [ ] **Step 5: Commit** `feat(auto-route): list a URL's decision models and choose the best by JevBench`.

---

### Task 4: URL-based classifier and serve wiring

**Files:**
- Modify: `src/native/auto-route.ts` (`OPENROUTER_DECISIONS_ENDPOINT`, `decisionClassifier`, `jevClassifier` options)
- Modify: `src/native/router.ts` (only if `classifierFor`'s type needs `AutoRouteConfig`'s new shape — it already takes the settings object)
- Modify: `src/commands/serve.ts` (`classifierFor`)
- Test: `tests/native/auto-route.test.ts` (replace the provider-based `decisionClassifier` tests)

**Interfaces:**
- Consumes: `AutoRouteConfig` (Task 1); `ModelListCache`, `chooseDecisionModel` (Task 3); `loadDecisionCatalog` (Task 2).
- Produces:
  - `jevClassifier` options: `endpoint?: string; model?: string | (() => Promise<string | undefined>); keyHint?: string; loopbackFree?: boolean` — `model` may be lazy; when `loopbackFree` is true and the answer reports no cost, `costUsd: 0`.
  - `export function decisionKeyFor(baseUrl: string, keys: { openrouter: () => string | undefined; typesafe: () => string | undefined; other: () => string | undefined }): { key: string | undefined; hint: string }`
  - `export function isLoopbackUrl(baseUrl: string): boolean`
  - `export function decisionClassifier(settings: Pick<AutoRouteConfig, 'baseUrl'>, deps: { fetch: typeof fetch; key: () => string | undefined; keyHint: string; model: () => Promise<string | undefined> }): TierClassifier` — endpoint `${baseUrl}/v1/systemone`.
  - `OPENROUTER_DECISIONS_ENDPOINT` is deleted (OpenRouter is reached at `https://openrouter.ai/api/v1/systemone`).

- [ ] **Step 1: Replace the tests.** In `tests/native/auto-route.test.ts`, delete the `describe('decisionClassifier', …)` block and the `OPENROUTER_DECISIONS_ENDPOINT` import/usages (rewrite the "posts to OpenRouter's Decisions API" test to call `jevClassifier({ …, endpoint: 'https://openrouter.ai/api/v1/systemone', model: '~typesafe/jev-latest' })`), then append:

```ts
describe('URL-based decision classifier', () => {
  const ok = (usage?: Record<string, unknown>) => new Response(JSON.stringify({
    answers: { tier: { type: 'choice', choice: 'simple', confidence: 1, probabilities: { simple: 1 } } }, ...(usage ? { usage } : {}),
  }), { status: 200 });

  it('posts to <base_url>/v1/systemone with the lazily chosen model', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const c = decisionClassifier({ baseUrl: 'https://openrouter.ai/api' }, {
      fetch: (async (url: string, init: RequestInit) => { calls.push({ url, init }); return ok({ cost: 0.00002 }); }) as any,
      key: () => 'or', keyHint: 'sonata auth add openrouter', model: async () => 'typesafe/jev-1.13',
    });
    const a = await c.classify({ role: 'code', task: 'T', tiers: ['simple'] }, new AbortController().signal);
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/systemone');
    expect(JSON.parse(calls[0].init.body as string).model).toBe('typesafe/jev-1.13');
    expect(a.costUsd).toBe(0.00002);
  });

  it('sends no model field when none is chosen, and no auth header without a key', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const c = decisionClassifier({ baseUrl: 'http://localhost:8000' }, {
      fetch: (async (url: string, init: RequestInit) => { calls.push({ url, init }); return ok(); }) as any,
      key: () => undefined, keyHint: 'sonata auth add auto-route', model: async () => undefined,
    });
    const a = await c.classify({ role: 'code', task: 'T', tiers: ['simple'] }, new AbortController().signal);
    expect(JSON.parse(calls[0].init.body as string).model).toBeUndefined();
    expect((calls[0].init.headers as Record<string, string>).authorization).toBeUndefined();
    expect(a.costUsd).toBe(0);
  });

  it('leaves a non-loopback answer without a reported cost unpriced', async () => {
    const c = decisionClassifier({ baseUrl: 'https://decide.example.com' }, {
      fetch: (async () => ok()) as any, key: () => 'k', keyHint: 'h', model: async () => undefined,
    });
    expect((await c.classify({ role: 'code', task: 'T', tiers: ['simple'] }, new AbortController().signal)).costUsd).toBeUndefined();
  });

  it('picks the key by host and never sends the OpenRouter key elsewhere', () => {
    const keys = { openrouter: () => 'OR', typesafe: () => 'TS', other: () => 'OTHER' };
    expect(decisionKeyFor('https://openrouter.ai/api', keys)).toEqual({ key: 'OR', hint: 'sonata auth add openrouter' });
    expect(decisionKeyFor('https://api.typesafe.ai', keys)).toEqual({ key: 'TS', hint: 'sonata auth add typesafe' });
    expect(decisionKeyFor('http://localhost:8000', keys)).toEqual({ key: 'OTHER', hint: 'sonata auth add auto-route' });
    expect(decisionKeyFor('https://evil.example/openrouter.ai', keys).key).toBe('OTHER');
  });

  it('recognises loopback hosts', () => {
    expect(['http://localhost:8000', 'http://127.0.0.1:9', 'http://[::1]:8000'].every(isLoopbackUrl)).toBe(true);
    expect(isLoopbackUrl('https://openrouter.ai/api')).toBe(false);
  });
});
```

(import `decisionClassifier`, `decisionKeyFor`, `isLoopbackUrl`.) Without a key, `jevClassifier` currently throws "no classifier key"; for a URL whose key is optional it must instead send the request without `Authorization`. Add an option `keyRequired?: boolean` (default `true`) and pass `keyRequired: false` from `decisionClassifier` when the host is neither `openrouter.ai` nor `api.typesafe.ai`.

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement in `src/native/auto-route.ts`.** Delete `OPENROUTER_DECISIONS_ENDPOINT` and the provider-based `decisionClassifier`. Extend `jevClassifier`: `model` may be a function (await it per call, before the retry loop); `headers` include `authorization` only when a key is present; when `keyRequired !== false` and no key, throw as now; after a successful parse, if `opts.loopbackFree === true && answer.costUsd === undefined`, return `{ ...answer, costUsd: 0 }`. Add:

```ts
/** Whether a URL points at this machine — a decision model there costs nothing. */
export function isLoopbackUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
  } catch {
    return false;
  }
}

/** The key a decision URL needs, by host — a key is only ever sent to the host it belongs to. */
export function decisionKeyFor(
  baseUrl: string,
  keys: { openrouter: () => string | undefined; typesafe: () => string | undefined; other: () => string | undefined },
): { key: string | undefined; hint: string } {
  let host = '';
  try { host = new URL(baseUrl).hostname; } catch { /* other */ }
  if (host === 'openrouter.ai') return { key: keys.openrouter(), hint: 'sonata auth add openrouter' };
  if (host === 'api.typesafe.ai') return { key: keys.typesafe(), hint: 'sonata auth add typesafe' };
  return { key: keys.other(), hint: 'sonata auth add auto-route' };
}

/** The classifier for one `[auto_route]` URL; `model` is resolved per call. */
export function decisionClassifier(
  settings: Pick<AutoRouteConfig, 'baseUrl'>,
  deps: { fetch: typeof fetch; key: () => string | undefined; keyHint: string; model: () => Promise<string | undefined> },
): TierClassifier {
  let host = '';
  try { host = new URL(settings.baseUrl).hostname; } catch { /* treated as other */ }
  return jevClassifier({
    fetch: deps.fetch,
    key: deps.key,
    keyHint: deps.keyHint,
    keyRequired: host === 'openrouter.ai' || host === 'api.typesafe.ai',
    endpoint: `${settings.baseUrl}/v1/systemone`,
    model: deps.model,
    loopbackFree: isLoopbackUrl(settings.baseUrl),
  });
}
```

Remove the now-unused `AutoRouteProvider` import.

- [ ] **Step 4: Wire `serve`** (`src/commands/serve.ts`, the `classifierFor` block). Replace with:

```ts
      // One classifier per URL + pin; the model is chosen per call from the
      // URL's listed decision models and the cached JevBench scores, so a
      // `sonata catalog update` or a new model at the URL needs no restart.
      classifierFor: (settings) => {
        const id = `${settings.baseUrl}|${settings.model ?? ''}`;
        let classifier = decisionClassifiers.get(id);
        if (classifier === undefined) {
          const credential = () => decisionKeyFor(settings.baseUrl, {
            openrouter: () => resolveKeys(['openrouter'], opts.home)[0]?.key,
            typesafe: () => resolveKeyFromSource('typesafe', opts.home, 'sonata'),
            other: () => resolveKeyFromSource('auto-route', opts.home, 'sonata'),
          });
          classifier = decisionClassifier(settings, {
            fetch,
            key: () => credential().key,
            keyHint: credential().hint,
            model: async () => settings.model ?? chooseDecisionModel({
              baseUrl: settings.baseUrl,
              listed: await modelLists.list(settings.baseUrl, credential().key),
              catalog: loadDecisionCatalog(opts.home),
            }).model,
          });
          decisionClassifiers.set(id, classifier);
        }
        return classifier;
      },
```

with `const modelLists = new ModelListCache(fetch);` declared beside `decisionClassifiers`, and imports for `decisionClassifier`, `decisionKeyFor` (auto-route.js), `ModelListCache`, `chooseDecisionModel` (decision-models.js), `loadDecisionCatalog` (../decision-catalog.js). `keyHint` is a getter-free string: compute it once from `decisionKeyFor(settings.baseUrl, …).hint` at construction.

- [ ] **Step 5: Run** `npm run typecheck`, `npx vitest run tests/native tests/commands/serve.test.ts tests/config-auto-route.test.ts`. Add a router-level regression in `tests/native/auto-route-router.test.ts` only if the `classifierFor` test there references `provider` (update it to `{ classifier: 'jev', baseUrl: 'https://openrouter.ai/api', minConfidence: 0.5 }`).
- [ ] **Step 6: Commit** `feat(auto-route): one base_url — endpoint, key by host, best model per call, loopback is free`.

---

### Task 5: `sonata doctor`

**Files:**
- Modify: `src/commands/doctor.ts` (the `config.autoRoute` block ~L827-866)
- Test: `tests/commands/doctor.test.ts` (replace the provider test)

**Interfaces:**
- Consumes: `decisionKeyFor`, `isLoopbackUrl` (Task 4); `ModelListCache`, `chooseDecisionModel` (Task 3); `loadDecisionCatalog`, `decisionCatalogPath` (Task 2). `cmdDoctor` already takes `opts.fetch`? — check its options; if it has no fetch seam, add `fetch?: typeof fetch` to its opts (default global `fetch`) so tests stay offline.

- [ ] **Step 1: Tests** (replace `checks the OpenRouter key when the decision provider is openrouter`):

```ts
  it('names the key the base_url needs, by host', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'doc-auto-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-auto-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), AUTO.replace('classifier = "jev"\n', 'classifier = "jev"\nbase_url = "https://openrouter.ai/api"\n'));
    const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home, fetch: (async () => new Response('{}', { status: 404 })) as any });
    expect(checks.find((c) => c.name === 'auto route' && /sonata auth add openrouter/.test(c.detail))).toBeDefined();
  });

  it('reports the chosen decision model and its score', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'doc-auto-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-auto-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), AUTO.replace('classifier = "jev"\n', 'classifier = "jev"\nbase_url = "https://openrouter.ai/api"\n'));
    writeSonataKey(home, 'openrouter', 'or');
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(join(home, '.config', 'sonata', 'decision-catalog.json'), JSON.stringify({
      fetchedAt: new Date().toISOString(), revision: 'v1.5.4',
      systems: [{ key: 'jev-1.13.0', display: 'Jev', capability: 80 }, { key: 'kev-4b', display: 'kev', capability: 55 }],
    }));
    const listing = { data: [
      { id: 'typesafe/jev-1.13', architecture: { output_modalities: ['decisions'] } },
      { id: 'jaredpalmer/kev-4b', architecture: { output_modalities: ['decisions'] } },
    ] };
    const { checks } = await cmdDoctor({ ...NO_CLIENT, cwd, home, fetch: (async () => new Response(JSON.stringify(listing))) as any });
    const detail = checks.filter((c) => c.name === 'auto route').map((c) => c.detail).join('\n');
    expect(detail).toMatch(/typesafe\/jev-1\.13/);
    expect(detail).toMatch(/80\.0/);
    expect(detail).toMatch(/runner-up jaredpalmer\/kev-4b/);
  });
```

Keep the existing missing-key / missing-agent / non-sonata-file / off tests, adjusting only their key expectations (a default config names `sonata auth add typesafe`).

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement.** Replace the provider-specific key check with `decisionKeyFor(config.autoRoute.baseUrl, …)` (same three resolvers as serve; advisory `ok: true` when a required key — openrouter.ai or api.typesafe.ai host — is missing). Replace the final `on (…)` detail with the URL plus the choice: if `model` is pinned, `on (base_url …, pinned model …)`; else list with a fresh `new ModelListCache(fetchFn)` and `chooseDecisionModel`, then `on (base_url …, model <id> — <reason>; runner-up <id> <score>)` or `… — <reason>` when nothing is chosen. Add an advisory line when the decision catalog is absent (`run sonata catalog update`) and when it is older than `AA_CATALOG_MAX_AGE_DAYS`. Doctor makes at most this one listing call; never a decision call.
- [ ] **Step 4: Run** doctor tests; commit `feat(doctor): show the decision URL, its key and the model it selects`.

---

### Task 6: Docs, changelog, spec line, verification

**Files:** `docs/guide/configuration.md`, `docs/guide/security.md`, `docs/internals/configuration.md`, `docs/internals/native-path.md`, `CLAUDE.md` (the auto-routed-tiers bullet only), `CHANGELOG.md`, `docs/superpowers/specs/2026-10-01-decision-model-selection-design.md` (the "Ranking data" revision sentence), `docs/superpowers/README.md` (link this plan).

- [ ] **Step 1:** Rewrite the auto-route sections added on this branch for `provider` so they describe `base_url` (TypeSafe default, OpenRouter `https://openrouter.ai/api`, a local `jev-compatible-server`), optional `model` pin, selection by JevBench capability with price tie-break and unscored-last, key by host (`sonata auth add openrouter|typesafe|auto-route`), loopback = $0, `sonata catalog update` now also caching JevBench. Security: the task text goes to whatever `base_url` names; the OpenRouter key is only ever sent to `openrouter.ai`.
- [ ] **Step 2:** In the spec's "Ranking data", replace "The revision fetched is the latest the site publishes" with: "The revision is pinned (`v1.5.4`) in `JEVBENCH_URL`: the site publishes no latest-revision index (its root serves an older v1 document), so a new revision is adopted by changing the constant."
- [ ] **Step 3:** Replace the branch's `[Unreleased]` changelog entry (currently about `provider`) with one entry for this feature, version-agnostic.
- [ ] **Step 4:** `npm run typecheck && npm test` (a lone `tests/watchdog.test.ts` timing failure is a known flake — re-run that file alone to confirm), then `npm run build`.
- [ ] **Step 5:** Commit `docs: auto-route base_url and decision-model selection`.
