# Tier Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace sonata's role×model×path agent surface (~50 agents + MCP) with 8 role×tier agents executed native-first through the router, with ranked-model fallback, a CLI harness fallback, and catalog-driven tier assignment.

**Architecture:** A unified `[models]` registry (native `gateway` route and/or `harness` fallback route per model) plus `[tiers]` ranked lists per role. Agent files carry a `sonata-<role>-<tier>` model alias the router resolves per request, retrying down the list on upstream failure. The MCP server is deleted; harness fallback becomes a blocking `sonata dispatch` CLI over Bash. Init's TUI gains a RankedSelect tier picker fed by a curated catalog with optional Artificial Analysis refresh.

**Tech Stack:** TypeScript (strict, NodeNext), Node 22+, vitest, Ink (init TUI), tmux (harness engine), LiteLLM (native upstreams).

**Spec:** `docs/superpowers/specs/2026-08-25-tier-routing-design.md`

## Global Constraints

- `npm run typecheck` and `npm test` must pass after every task. The suite runs keyless and offline; all gateway/AA interactions are fixtures.
- `sonata` on PATH runs `dist/`, not `src/` — run `npm run build` before any live check of CLI behaviour.
- Model keys and every TOML key/value are written through `tomlKey` (quoted, control chars escaped).
- `claude-`-prefixed model names/ids are refused in tier lists and `[models]` at parse time (`isAnthropicRoutedName` is the single definition).
- Credentials never appear in argv, logs, or conversation. AA keys go through the existing store (`sonata auth add artificialanalysis`); there is no `--key` flag anywhere.
- AA data is never shipped in the repo (free tier = internal use only, no redistribution). Curated fallback tables are our own judgement. Any screen or output showing AA-derived rankings prints: `Model rankings by Artificial Analysis — https://artificialanalysis.ai`.
- Commits are conventional (`feat:`, `fix:`, `docs:`, `refactor:`) and end with the Co-Authored-By + Claude-Session trailers used throughout this repo's history.
- Keep code comment density and idiom matching the surrounding file (this codebase explains *why*, heavily).
- Existing behaviour keeps working until the task that explicitly replaces it: tasks are ordered additive → flip → delete, so the tree is releasable after every task.

## File Structure

| File | Responsibility |
|---|---|
| `src/catalog.ts` (new) | Model-name normalization, curated capability table, AA cache loading, tier proposal. Pure; no network. |
| `src/config.ts` (modify) | Unified `[models]` entries (gateway and/or harness route), `[tiers]` parsing + validation, `resolveTierAlias`, `harnessModelFor`. |
| `src/native/router.ts` (modify) | `sonata-` alias resolution, per-candidate fallback with cooldown, `withModel` body rewrite, exhaustion 529. |
| `src/native/litellm.ts` (modify) | Unified gateway-routed models included in the LiteLLM model list. |
| `src/commands/serve.ts` (modify) | Builds the per-request tier resolver and passes it to the router. |
| `src/commands/sync.ts` (modify) | Generates role×tier agents; identical-list collapse; wrapper/per-model generation removed. |
| `src/commands/dispatch.ts` (new) | Blocking CLI dispatch over the harness engine with ranked fallback. |
| `src/settings.ts` (modify) | Allow-list entries become Bash patterns; MCP registration helpers deleted. |
| `src/mcp/` (delete) | Whole directory. |
| `src/commands/catalog.ts` (new) | `sonata catalog update` — AA fetch with user key, local cache, attribution. |
| `src/tui-ink/components/ranked-select-state.ts` (new) | Pure reducer: selection order = ranking. |
| `src/tui-ink/components/ranked-select.tsx` (new) | Ink component over the reducer. |
| `src/tui-ink/app.tsx` + `app-state.ts` (modify) | Tier-assignment screens replace same-models + per-role screens. |
| `src/commands/init.ts` (modify) | Tier proposal, migration of legacy configs, route-auto offer, skill install, MCP step removed. |
| `src/commands/route.ts` + `src/cli.ts` (modify) | `--global` scope. |
| `src/commands/doctor.ts` (modify) | Stale-MCP warning, tier/routing checks. |
| `skills/loop/SKILL.md` (new) | The loop-engineering skill. |

---

### Task 1: Catalog module

**Files:**
- Create: `src/catalog.ts`
- Test: `tests/catalog.test.ts`

**Interfaces:**
- Consumes: nothing (pure module).
- Produces:
  - `normalizeModelName(raw: string): string`
  - `interface CatalogEntry { capable: boolean; cheap: boolean; source: 'curated' | 'aa' | 'default' }`
  - `lookupModel(name: string, aa?: AaCatalog): CatalogEntry`
  - `interface AaCatalog { fetchedAt: string; models: Record<string, { codingIndex: number; blendedPriceUsd: number }> }`
  - `loadAaCatalog(home: string): AaCatalog | undefined` (reads `~/.config/sonata/catalog.json`)
  - `aaCatalogPath(home: string): string`
  - `interface TierProposal { simple: string[]; complex: string[] }`
  - `proposeTiers(modelKeys: string[], aa?: AaCatalog): TierProposal`
  - `AA_ATTRIBUTION` constant string
  - Threshold constants: `AA_CAPABLE_CODING_INDEX = 40`, `AA_CHEAP_BLENDED_PRICE_USD = 1.0`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/catalog.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  normalizeModelName, lookupModel, proposeTiers, loadAaCatalog, aaCatalogPath,
  type AaCatalog,
} from '../src/catalog.js';

describe('normalizeModelName', () => {
  it('strips harness/provider prefixes and date suffixes', () => {
    expect(normalizeModelName('anexto-deepseek-v4-flash-0731')).toBe('deepseek-v4-flash');
    expect(normalizeModelName('opencode-anexto-deepseek-v4-pro-0813')).toBe('deepseek-v4-pro');
    expect(normalizeModelName('openai/gpt-5.6-terra')).toBe('gpt-5.6-terra');
    expect(normalizeModelName('gpt-5.6-luna')).toBe('gpt-5.6-luna');
  });

  it('is idempotent', () => {
    expect(normalizeModelName(normalizeModelName('anexto-deepseek-v4-flash-0731')))
      .toBe('deepseek-v4-flash');
  });
});

describe('lookupModel', () => {
  it('classifies curated models without AA data', () => {
    expect(lookupModel('deepseek-v4-flash')).toMatchObject({ capable: true, cheap: true, source: 'curated' });
    expect(lookupModel('gpt-5.6-terra')).toMatchObject({ capable: true, cheap: false, source: 'curated' });
  });

  it('defaults unknown models to capable-not-cheap — never demote silently', () => {
    expect(lookupModel('mystery-model-9000')).toEqual({ capable: true, cheap: false, source: 'default' });
  });

  it('prefers AA data over the curated table when present', () => {
    const aa: AaCatalog = {
      fetchedAt: '2026-08-25T00:00:00Z',
      models: { 'deepseek-v4-flash': { codingIndex: 10, blendedPriceUsd: 0.2 } },
    };
    // AA says this model is below the capable threshold: not complex-eligible.
    expect(lookupModel('deepseek-v4-flash', aa)).toMatchObject({ capable: false, source: 'aa' });
  });
});

describe('proposeTiers', () => {
  it('splits keys into simple (cheap) and complex (capable), ranked', () => {
    const aa: AaCatalog = {
      fetchedAt: '2026-08-25T00:00:00Z',
      models: {
        'deepseek-v4-flash': { codingIndex: 45, blendedPriceUsd: 0.3 },
        'gpt-5.6-luna': { codingIndex: 42, blendedPriceUsd: 0.5 },
        'deepseek-v4-pro': { codingIndex: 60, blendedPriceUsd: 2.5 },
        'gpt-5.6-terra': { codingIndex: 70, blendedPriceUsd: 6.0 },
      },
    };
    const tiers = proposeTiers(
      ['deepseek-v4-flash', 'gpt-5.6-luna', 'deepseek-v4-pro', 'gpt-5.6-terra'], aa,
    );
    // simple = cheap AND capable, ranked by coding index desc
    expect(tiers.simple).toEqual(['deepseek-v4-flash', 'gpt-5.6-luna']);
    // complex = capable, ranked by index desc, price asc tie-break
    expect(tiers.complex[0]).toBe('gpt-5.6-terra');
    expect(tiers.complex).toContain('deepseek-v4-pro');
  });

  it('never returns an empty complex list when any model exists', () => {
    const tiers = proposeTiers(['mystery-model-9000']);
    expect(tiers.complex).toEqual(['mystery-model-9000']);
    // no cheap models: simple mirrors complex so the tier still resolves
    expect(tiers.simple).toEqual(['mystery-model-9000']);
  });
});

describe('loadAaCatalog', () => {
  it('reads the cache file and returns undefined when absent or corrupt', () => {
    const home = mkdtempSync(join(tmpdir(), 'sonata-catalog-'));
    expect(loadAaCatalog(home)).toBeUndefined();
    const path = aaCatalogPath(home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ fetchedAt: 'x', models: { m: { codingIndex: 1, blendedPriceUsd: 1 } } }));
    expect(loadAaCatalog(home)?.models.m.codingIndex).toBe(1);
    writeFileSync(path, '{ not json');
    expect(loadAaCatalog(home)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/catalog.test.ts`
Expected: FAIL — module `src/catalog.ts` does not exist.

- [ ] **Step 3: Implement `src/catalog.ts`**

```ts
/**
 * Which models are worth which work.
 *
 * Two data sources feed tier assignment: a small curated table (our own
 * judgement, shipped with sonata) and an optional Artificial Analysis cache
 * the *user* fetched with their own key (`sonata catalog update`). AA's free
 * tier licenses internal use only — no redistribution — so nothing derived
 * from AA data may ever be committed to this repository. The curated table is
 * deliberately hand-written from experience, not from AA numbers.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const AA_ATTRIBUTION =
  'Model rankings by Artificial Analysis — https://artificialanalysis.ai';

/** Coding Index at or above this ⇒ complex-eligible. Chosen so today's
 * mid-tier coders (deepseek-v4-flash class) sit just above the line. */
export const AA_CAPABLE_CODING_INDEX = 40;

/** Blended $/1M tokens at or below this ⇒ cheap enough for the simple tier. */
export const AA_CHEAP_BLENDED_PRICE_USD = 1.0;

export interface CatalogEntry {
  capable: boolean;
  cheap: boolean;
  source: 'curated' | 'aa' | 'default';
}

export interface AaCatalog {
  fetchedAt: string;
  models: Record<string, { codingIndex: number; blendedPriceUsd: number }>;
}

/**
 * Collapses the many spellings of one model to a single name: harness and
 * provider prefixes go (`opencode-anexto-…`, `openai/…`), and a trailing
 * MMDD date suffix goes (`-0731`). Idempotent, so a normalized name can be
 * normalized again safely.
 */
export function normalizeModelName(raw: string): string {
  let name = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw;
  const PREFIXES = ['opencode-', 'codex-', 'pi-', 'reasonix-', 'claude-harness-',
    'anexto-', 'openrouter-', 'openai-', 'google-', 'anthropic-'];
  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const p of PREFIXES) {
      if (name.startsWith(p) && name.length > p.length) { name = name.slice(p.length); stripped = true; }
    }
  }
  return name.replace(/-\d{4}$/, '');
}

/** Our own judgement, not AA data. Kept deliberately small: the default for
 * anything unlisted is capable-not-cheap, the direction that never silently
 * hands hard work to a weak model. */
const CURATED: Record<string, { capable: boolean; cheap: boolean }> = {
  'deepseek-v4-flash': { capable: true, cheap: true },
  'deepseek-v4-pro': { capable: true, cheap: false },
  'gpt-5.6-luna': { capable: true, cheap: true },
  'gpt-5.6-terra': { capable: true, cheap: false },
  'gpt-5.6-sol': { capable: true, cheap: false },
  'kimi-k3': { capable: true, cheap: true },
  'kimi-k3-free': { capable: false, cheap: true },
  'glm-5.3': { capable: true, cheap: true },
  'grok-4.6': { capable: true, cheap: false },
  'gemini-3.7-flash': { capable: true, cheap: true },
  'qwen3.8-max': { capable: true, cheap: false },
  'ox-alpha-free': { capable: false, cheap: true },
};

export function lookupModel(name: string, aa?: AaCatalog): CatalogEntry {
  const normalized = normalizeModelName(name);
  const scored = aa?.models[normalized];
  if (scored !== undefined) {
    return {
      capable: scored.codingIndex >= AA_CAPABLE_CODING_INDEX,
      cheap: scored.blendedPriceUsd <= AA_CHEAP_BLENDED_PRICE_USD,
      source: 'aa',
    };
  }
  const curated = CURATED[normalized];
  if (curated !== undefined) return { ...curated, source: 'curated' };
  return { capable: true, cheap: false, source: 'default' };
}

export interface TierProposal { simple: string[]; complex: string[] }

/** Rank for ordering within a tier: AA coding index when known, else a fixed
 * mid score so curated/default models interleave stably. */
function rank(key: string, aa?: AaCatalog): { index: number; price: number } {
  const scored = aa?.models[normalizeModelName(key)];
  return scored !== undefined
    ? { index: scored.codingIndex, price: scored.blendedPriceUsd }
    : { index: AA_CAPABLE_CODING_INDEX, price: AA_CHEAP_BLENDED_PRICE_USD };
}

export function proposeTiers(modelKeys: string[], aa?: AaCatalog): TierProposal {
  const byRank = (a: string, b: string) => {
    const ra = rank(a, aa); const rb = rank(b, aa);
    return rb.index - ra.index || ra.price - rb.price;
  };
  const complex = modelKeys.filter((k) => lookupModel(k, aa).capable).sort(byRank);
  const simple = modelKeys
    .filter((k) => { const e = lookupModel(k, aa); return e.capable && e.cheap; })
    .sort(byRank);
  // A tier must always resolve to something: with no capable model, everything
  // is complex-eligible; with no cheap-capable model, simple mirrors complex.
  const complexFinal = complex.length > 0 ? complex : [...modelKeys];
  const simpleFinal = simple.length > 0 ? simple : complexFinal;
  return { simple: simpleFinal, complex: complexFinal };
}

export function aaCatalogPath(home: string): string {
  return join(home, '.config', 'sonata', 'catalog.json');
}

export function loadAaCatalog(home: string): AaCatalog | undefined {
  const path = aaCatalogPath(home);
  if (!existsSync(path)) return undefined;
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8')) as AaCatalog;
    if (typeof doc.fetchedAt !== 'string' || typeof doc.models !== 'object' || doc.models === null) return undefined;
    return doc;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/catalog.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/catalog.ts tests/catalog.test.ts
git commit -m "feat(catalog): model normalization, curated table, tier proposal"
```

---

### Task 2: Config — unified `[models]` and `[tiers]`

**Files:**
- Modify: `src/config.ts` (types near line 19, `parseConfig` near line 125)
- Test: `tests/config.test.ts` (append a new `describe` block)

**Interfaces:**
- Consumes: existing `parseConfig`, `isAnthropicRoutedName`, `KNOWN_ROLES`.
- Produces (used by Tasks 3–6, 9, 10):
  - `interface UnifiedModelConfig { gateway?: string; id?: string; contextWindow?: number; harness?: string; harnessId?: string }`
  - `interface TierLists { simple: string[]; complex: string[] }`
  - `SonataConfig` gains `tiers?: Record<string, TierLists>` and `unifiedModels: Record<string, UnifiedModelConfig>`
  - `TIER_NAMES = ['simple', 'complex'] as const`
  - `interface TierRoute { key: string; native?: { gateway: string; id: string }; harness?: { harness: string; id: string } }`
  - `resolveTierAlias(config: SonataConfig, alias: string): { role: string; tier: string; routes: TierRoute[] } | undefined` — accepts `sonata-<role>-<tier>` and collapsed `sonata-<role>`
  - `harnessModelFor(config: SonataConfig, key: string): { harness: string; id: string } | undefined`

**Parsing rules (implement exactly):**
- A `[models]` entry **with `gateway`** is a unified entry: `id` required (string), `context_window` optional number (default 128000), `harness` optional (must be in `KNOWN_HARNESSES`), `harness_id` optional string defaulting to `` `${gateway}/${id}` `` when `harness` is set. Its `id` is refused if `isAnthropicRoutedName(id)`.
- A `[models]` entry **without `gateway`** keeps today's legacy validation verbatim (`harness` + `id`, provider-qualified rule); it is *also* exposed as a unified entry `{ harness, harnessId: id }` so `[tiers]` may reference it.
- `[tiers.<role>]` requires both `simple` and `complex` as arrays of strings; every entry must be a key of `[models]`; roles must be in `KNOWN_ROLES`. The model key itself is refused if `isAnthropicRoutedName(key)`.
- **Mixing refusal:** if `[tiers]` is present AND (`[generate]` is present or `raw.native?.generate` is present), throw: `` `sonata.toml: [tiers] replaces [generate.roles] and [generate.native] — run \`sonata init\` to migrate` ``.
- When `[tiers]` is absent, everything parses exactly as today (this task is purely additive; `tiers` stays `undefined`, `unifiedModels` still populated).

- [ ] **Step 1: Write the failing tests** (append to `tests/config.test.ts`)

```ts
describe('unified [models] and [tiers]', () => {
  const TIERED = `
[models."deepseek-v4-flash"]
gateway = "anexto"
id = "deepseek-v4-flash-0731"
harness = "opencode"

[models."gpt-5.6-terra"]
gateway = "openai"
id = "gpt-5.6-terra"

[models."kimi-harness-only"]
harness = "opencode"
id = "anexto/kimi-k3"

[tiers.code]
simple = ["deepseek-v4-flash"]
complex = ["gpt-5.6-terra", "deepseek-v4-flash"]

[tiers.explore]
simple = ["deepseek-v4-flash"]
complex = ["deepseek-v4-flash"]

[native.gateways."anexto"]
base_url = "http://gateway.example/v1"
[native.gateways."openai"]
base_url = "http://openai.example/v1"
`;

  it('parses unified models with native and harness routes', () => {
    const config = parseConfig(TIERED);
    expect(config.unifiedModels['deepseek-v4-flash']).toEqual({
      gateway: 'anexto', id: 'deepseek-v4-flash-0731', contextWindow: 128000,
      harness: 'opencode', harnessId: 'anexto/deepseek-v4-flash-0731',
    });
    expect(config.unifiedModels['kimi-harness-only']).toMatchObject({
      harness: 'opencode', harnessId: 'anexto/kimi-k3',
    });
    expect(config.tiers?.code.complex).toEqual(['gpt-5.6-terra', 'deepseek-v4-flash']);
  });

  it('resolveTierAlias returns ranked routes for sonata-<role>-<tier>', () => {
    const config = parseConfig(TIERED);
    const resolved = resolveTierAlias(config, 'sonata-code-complex');
    expect(resolved?.routes.map((r) => r.key)).toEqual(['gpt-5.6-terra', 'deepseek-v4-flash']);
    expect(resolved?.routes[1].native).toEqual({ gateway: 'anexto', id: 'deepseek-v4-flash-0731' });
    expect(resolved?.routes[1].harness).toEqual({ harness: 'opencode', id: 'anexto/deepseek-v4-flash-0731' });
  });

  it('resolveTierAlias accepts a collapsed sonata-<role> alias when the lists are identical', () => {
    const config = parseConfig(TIERED);
    expect(resolveTierAlias(config, 'sonata-explore')?.routes.map((r) => r.key))
      .toEqual(['deepseek-v4-flash']);
    expect(resolveTierAlias(config, 'sonata-nonsense')).toBeUndefined();
  });

  it('refuses a tier entry that names no [models] key', () => {
    expect(() => parseConfig(TIERED.replace('"deepseek-v4-flash"]\nsimple', '"deepseek-v4-flash"]\nsimple')
      .replace('simple = ["deepseek-v4-flash"]\ncomplex = ["gpt-5.6-terra", "deepseek-v4-flash"]',
        'simple = ["missing-model"]\ncomplex = ["gpt-5.6-terra"]')))
      .toThrow(/missing-model/);
  });

  it('refuses claude- ids in unified models and tier keys', () => {
    expect(() => parseConfig(TIERED.replace('id = "gpt-5.6-terra"', 'id = "claude-opus-5"')))
      .toThrow(/claude-/);
  });

  it('refuses mixing [tiers] with [generate]', () => {
    expect(() => parseConfig(`${TIERED}\n[generate.roles]\ncode = []\n`))
      .toThrow(/sonata init/);
  });

  it('harnessModelFor exposes the harness route for the dispatch CLI', () => {
    const config = parseConfig(TIERED);
    expect(harnessModelFor(config, 'deepseek-v4-flash'))
      .toEqual({ harness: 'opencode', id: 'anexto/deepseek-v4-flash-0731' });
    expect(harnessModelFor(config, 'gpt-5.6-terra')).toBeUndefined();
  });
});
```

Add `resolveTierAlias, harnessModelFor` to the file's import from `../src/config.js`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — new exports missing.

- [ ] **Step 3: Implement in `src/config.ts`**

Add types beside `ModelConfig` (line 19):

```ts
export const TIER_NAMES = ['simple', 'complex'] as const;

/**
 * One model, however it is reached. `gateway` is the native route (default
 * execution path, through the router); `harness` is the fallback route the
 * dispatch CLI uses when every native route is down. At least one must be
 * present — parseConfig enforces it.
 */
export interface UnifiedModelConfig {
  gateway?: string;
  id?: string;
  contextWindow?: number;
  harness?: string;
  harnessId?: string;
}

export interface TierLists { simple: string[]; complex: string[] }

export interface TierRoute {
  key: string;
  native?: { gateway: string; id: string };
  harness?: { harness: string; id: string };
}
```

Extend `SonataConfig` with `tiers?: Record<string, TierLists>` and `unifiedModels: Record<string, UnifiedModelConfig>`.

In `parseConfig`, inside the existing `[models]` loop, branch on `typeof d.gateway === 'string'` **before** the legacy `harness`/`id` validation: validate per the parsing rules above, push into a `unifiedModels` record, and `continue` (so legacy validation never sees gateway entries). After the loop, also mirror every legacy entry into `unifiedModels` as `{ harness: d.harness, harnessId: d.id }`. After the models section, parse `[tiers]` per the rules, then apply the mixing refusal. Include `unifiedModels` and `tiers` in the returned object (both branches — with and without `[native]`).

Append the two resolvers at the bottom of the file:

```ts
/**
 * Resolves a `sonata-<role>[-<tier>]` model alias to its ranked routes.
 * The collapsed form (`sonata-explore`) exists for roles whose two tier lists
 * are identical — sync generates a single agent for those, and its alias
 * omits the tier so the picker never shows a fake choice.
 */
export function resolveTierAlias(
  config: SonataConfig,
  alias: string,
): { role: string; tier: string; routes: TierRoute[] } | undefined {
  if (!alias.startsWith('sonata-') || config.tiers === undefined) return undefined;
  const rest = alias.slice('sonata-'.length);
  let role = rest; let tier: string = 'complex';
  for (const t of TIER_NAMES) {
    if (rest.endsWith(`-${t}`)) { role = rest.slice(0, -(t.length + 1)); tier = t; break; }
  }
  const lists = config.tiers[role];
  if (lists === undefined) return undefined;
  const keys = tier === 'simple' ? lists.simple : lists.complex;
  const routes = keys.map((key): TierRoute => {
    const m = config.unifiedModels[key];
    return {
      key,
      native: m?.gateway !== undefined && m.id !== undefined ? { gateway: m.gateway, id: m.id } : undefined,
      harness: m?.harness !== undefined && m.harnessId !== undefined ? { harness: m.harness, id: m.harnessId } : undefined,
    };
  });
  return { role, tier, routes };
}

/** The harness route for one model key, for the dispatch CLI. */
export function harnessModelFor(
  config: SonataConfig,
  key: string,
): { harness: string; id: string } | undefined {
  const m = config.unifiedModels[key];
  return m?.harness !== undefined && m.harnessId !== undefined
    ? { harness: m.harness, id: m.harnessId }
    : undefined;
}
```

- [ ] **Step 4: Run the full suite** — existing configs must be unaffected.

Run: `npx vitest run tests/config.test.ts && npm test`
Expected: PASS (new block + all existing tests).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat(config): unified [models] routes, [tiers] lists, tier alias resolution"
```

---

### Task 3: Router — tier resolution and native fallback

**Files:**
- Modify: `src/native/router.ts`
- Test: `tests/native/router.test.ts` (append)

**Interfaces:**
- Consumes: `TierRoute` from Task 2 (type-only; the resolver arrives as a dep).
- Produces:
  - `RouterDeps` gains `resolveTier?: (alias: string) => { role: string; tier: string; routes: TierRoute[] } | undefined` and `now?: () => number`
  - `withModel(body: Buffer, model: string): Buffer`
  - `clearCooldowns(): void` (test seam)
  - `TIER_COOLDOWN_MS = 60_000`
- Behaviour:
  - A request whose `model` starts with `sonata-` and resolves via `deps.resolveTier` tries each route with a `native` half, in order, skipping keys inside their cooldown window.
  - Per candidate: rewrite the body's `model` to the candidate `key` (LiteLLM's `model_name` — Task 4 guarantees this), then forward exactly as the litellm path does today (auth swap, `flattenSystemBlocks`).
  - A candidate *fails* when `fetch` throws, or the response status is ≥ 500 (including the existing empty-completion 500). On failure: log `` `router: <key> failed (<status|error>), trying next` ``, start its cooldown, try the next.
  - First response with status < 500 is returned to the client (streaming starts only here — retry is inherently pre-first-byte).
  - All candidates exhausted (or none native-routed): return 529 with body `{"type":"overloaded_error","message":"all native routes for <role>-<tier> failed; fall back with: sonata dispatch --tier <role>-<tier>"}` and log it.
  - Unresolvable `sonata-` alias (no resolver, or resolver returns undefined): 400 with body naming the alias and `sonata sync`.
  - The routing log line becomes `` `${method} ${url} model=${alias} -> ${key} -> litellm` `` on the tier path; non-tier requests keep today's line exactly.
  - Cooldown state: module-level `Map<string, number>` (key → expiry epoch ms), read through `deps.now ?? Date.now`... **but note `Date.now` is fine here — this is the router process, not a Workflow script.** `clearCooldowns()` empties it for tests.

- [ ] **Step 1: Write the failing tests** (append to `tests/native/router.test.ts`; follow the file's existing stub-fetch pattern — read its first test for the harness shape)

```ts
describe('tier alias routing', () => {
  const ROUTES = {
    role: 'code', tier: 'simple',
    routes: [
      { key: 'flash', native: { gateway: 'g', id: 'flash-1' } },
      { key: 'luna', native: { gateway: 'g', id: 'luna-1' } },
      { key: 'harness-only', harness: { harness: 'opencode', id: 'x/y' } },
    ],
  };
  const req = (model: string) => ({
    method: 'POST', url: '/v1/messages',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ model, messages: [] })),
  });

  beforeEach(() => clearCooldowns());

  it('rewrites the model to the first native candidate and forwards to litellm', async () => {
    const seen: string[] = [];
    const res = await routeRequest(req('sonata-code-simple'), {
      fetch: (async (_url: string, init: RequestInit) => {
        seen.push((JSON.parse(init.body as string) as { model: string }).model);
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch,
      litellmBase: 'http://litellm', litellmKey: 'k',
      resolveTier: () => ROUTES,
    });
    expect(res.status).toBe(200);
    expect(seen).toEqual(['flash']);
  });

  it('falls back to the next candidate on 5xx and cools the failure down', async () => {
    const seen: string[] = [];
    const deps = {
      fetch: (async (_url: string, init: RequestInit) => {
        const model = (JSON.parse(init.body as string) as { model: string }).model;
        seen.push(model);
        return new Response('{}', { status: model === 'flash' ? 503 : 200 });
      }) as unknown as typeof fetch,
      litellmBase: 'http://litellm', litellmKey: 'k',
      resolveTier: () => ROUTES,
    };
    expect((await routeRequest(req('sonata-code-simple'), deps)).status).toBe(200);
    expect(seen).toEqual(['flash', 'luna']);
    // second request inside the cooldown skips flash entirely
    await routeRequest(req('sonata-code-simple'), deps);
    expect(seen).toEqual(['flash', 'luna', 'luna']);
  });

  it('falls back when fetch throws (connect error)', async () => {
    const seen: string[] = [];
    const res = await routeRequest(req('sonata-code-simple'), {
      fetch: (async (_url: string, init: RequestInit) => {
        const model = (JSON.parse(init.body as string) as { model: string }).model;
        seen.push(model);
        if (model === 'flash') throw new Error('ECONNREFUSED');
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch,
      litellmBase: 'http://litellm', litellmKey: 'k',
      resolveTier: () => ROUTES,
    });
    expect(res.status).toBe(200);
    expect(seen).toEqual(['flash', 'luna']);
  });

  it('returns 529 naming the CLI fallback when every native route fails', async () => {
    const res = await routeRequest(req('sonata-code-simple'), {
      fetch: (async () => new Response('{}', { status: 503 })) as unknown as typeof fetch,
      litellmBase: 'http://litellm', litellmKey: 'k',
      resolveTier: () => ROUTES,
    });
    expect(res.status).toBe(529);
    expect((res.body as Buffer).toString()).toContain('sonata dispatch --tier code-simple');
  });

  it('returns 400 for an alias the config does not resolve', async () => {
    const res = await routeRequest(req('sonata-nope-simple'), {
      fetch: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
      litellmBase: 'http://litellm', litellmKey: 'k',
      resolveTier: () => undefined,
    });
    expect(res.status).toBe(400);
    expect((res.body as Buffer).toString()).toContain('sonata sync');
  });

  it('4xx from upstream is returned, not retried — our bug, not their outage', async () => {
    const seen: string[] = [];
    const res = await routeRequest(req('sonata-code-simple'), {
      fetch: (async (_url: string, init: RequestInit) => {
        seen.push((JSON.parse(init.body as string) as { model: string }).model);
        return new Response('bad request', { status: 400 });
      }) as unknown as typeof fetch,
      litellmBase: 'http://litellm', litellmKey: 'k',
      resolveTier: () => ROUTES,
    });
    expect(res.status).toBe(400);
    expect(seen).toEqual(['flash']);
  });

  it('logs the resolution step', async () => {
    const lines: string[] = [];
    await routeRequest(req('sonata-code-simple'), {
      fetch: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
      litellmBase: 'http://litellm', litellmKey: 'k',
      resolveTier: () => ROUTES,
      log: (l) => lines.push(l),
    });
    expect(lines.some((l) => l.includes('model=sonata-code-simple -> flash -> litellm'))).toBe(true);
  });
});

describe('withModel', () => {
  it('rewrites only the model field', () => {
    const out = JSON.parse(withModel(Buffer.from('{"model":"a","x":1}'), 'b').toString());
    expect(out).toEqual({ model: 'b', x: 1 });
  });
});
```

Add `withModel, clearCooldowns` to the test file's imports.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/native/router.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `src/native/router.ts`: add the dep fields; add `withModel` (parse, spread, replace `model`, re-serialize — return body unchanged on parse failure); add the module-level cooldown map + `clearCooldowns` + `TIER_COOLDOWN_MS`. In `routeRequest`, before the existing `isClaudeRequest` branch, handle the tier path:

```ts
const alias = requestedModel(req.body);
if (alias !== undefined && alias.startsWith('sonata-')) {
  const resolved = deps.resolveTier?.(alias);
  if (resolved === undefined) {
    return {
      status: 400,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ error: { type: 'invalid_request_error',
        message: `unknown sonata tier alias "${alias}" — run \`sonata sync\` and check [tiers] in sonata.toml` } })),
    };
  }
  const now = deps.now ?? Date.now;
  const candidates = resolved.routes.filter((r) => r.native !== undefined);
  for (const route of candidates) {
    const until = cooldowns.get(route.key);
    if (until !== undefined && until > now()) continue;
    // …forward with withModel(flattenSystemBlocks(req.body), route.key), litellm
    // auth headers as in the existing litellm branch; on fetch throw or
    // status >= 500: cooldowns.set(route.key, now() + TIER_COOLDOWN_MS), log,
    // continue; otherwise log the resolution line and return the response.
  }
  const label = `${resolved.role}-${resolved.tier}`;
  deps.log?.(`router: all native routes for ${label} failed`);
  return {
    status: 529,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ type: 'overloaded_error',
      message: `all native routes for ${label} failed; fall back with: sonata dispatch --tier ${label}` })),
  };
}
```

Extract the existing litellm-forwarding block (header swap + fetch + 500-rewrite) into a private `forwardToLitellm(body, headers, req, deps)` helper both paths share, so the tier loop and the plain path cannot drift.

- [ ] **Step 4: Run the router suite + full suite**

Run: `npx vitest run tests/native/router.test.ts && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/native/router.ts tests/native/router.test.ts
git commit -m "feat(router): resolve sonata tier aliases with ranked native fallback"
```

---

### Task 4: Serve and LiteLLM wiring for unified models

**Files:**
- Modify: `src/native/litellm.ts`, `src/commands/serve.ts`, `src/commands/code.ts` (only `nativeSessionEnv`)
- Test: `tests/native/litellm.test.ts`, `tests/commands/serve.test.ts` (append)

**Interfaces:**
- Consumes: `resolveTierAlias`, `UnifiedModelConfig` (Task 2); `RouterDeps.resolveTier` (Task 3).
- Produces: the LiteLLM model list includes every `[models]` entry with a `gateway` (its `model_name` is the **model key** — the exact string the router's `withModel` writes); `cmdServe` passes `resolveTier: (alias) => resolveTierAlias(loadConfig(cwd, home), alias) ` (config re-read per call, so tier edits apply without restart); `nativeSessionEnv` includes unified models' `contextWindow` in its min().

- [ ] **Step 1: Write failing tests** — in `tests/native/litellm.test.ts`, assert a config whose `[models."flash"]` has `gateway`/`id` produces a LiteLLM entry `model_name: 'flash'` with the gateway's wire mapping (follow the existing api-key gateway test in that file as the template). In `tests/commands/serve.test.ts`, assert the router deps `cmdServe` builds include a `resolveTier` function that resolves against a tiered fixture config written to the test cwd (use the `ServeDeps` seams the file's existing tests use).

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/native/litellm.test.ts tests/commands/serve.test.ts`.

- [ ] **Step 3: Implement.** In `litellm.ts`, where the model list is built from `config.native.models`, also iterate `config.unifiedModels`, skipping keys without `gateway` and keys already present from `native.models` (legacy native entries stay authoritative during migration). In `serve.ts`, add `resolveTier` to the router deps where `createRouterServer` is called. In `code.ts`'s `nativeSessionEnv`, extend the contextWindow min over `unifiedModels` entries that have one.

- [ ] **Step 4: Run** — the two files + `npm test`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/native/litellm.ts src/commands/serve.ts src/commands/code.ts tests/native/litellm.test.ts tests/commands/serve.test.ts
git commit -m "feat(serve): feed unified models to litellm and the tier resolver to the router"
```

---

### Task 5: Sync — role×tier agents

**Files:**
- Modify: `src/commands/sync.ts`
- Test: `tests/commands/sync.test.ts` (append)

**Interfaces:**
- Consumes: `config.tiers`, `TIER_NAMES`, `isReadOnlyRole`.
- Produces:
  - `tierAgentMarkdown(spec: { role: string; tier?: 'simple' | 'complex' }): string` — agent name `code-simple` (or bare `code` when collapsed), frontmatter `model: sonata-code-simple` (or `sonata-code`), read-only roles get `tools: Read, Grep, Glob`.
  - `cmdSync`: when `config.tiers` is set, generate **only** tier agents (wrapper and per-model native generation are skipped entirely); when unset, legacy generation runs unchanged. Identical `simple`/`complex` lists (element-wise) collapse to one agent.
- Agent description text (use verbatim, `<role blurb>` from the existing `ROLE_BLURB` map):

```
description: Runs <role blurb> on a ranked list of foreign models (<tier> tier), natively inside Claude Code's loop. Simple = mechanical, well-specified, contained work (single file, clear spec, bulk edits). Complex = cross-cutting, ambiguous, design-sensitive, or needs sustained reasoning. When unsure, use -complex. Requires a routed session (sonata code, or sonata route on/auto).
```

(The collapsed single-agent variant drops the two difficulty sentences and the `(<tier> tier)` parenthetical.)

- [ ] **Step 1: Write failing tests** — assert: a tiered config generates exactly `code-simple.md`, `code-complex.md`, and collapsed `explore.md` (for the identical-list role) and nothing else; frontmatter `model:` carries the alias; read-only role files carry the tools line; a legacy (non-tiered) config still generates today's files; tier agents land in `SyncResult.written` and superseded files in `stale`.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** — `tierAgentMarkdown` beside `nativeAgentMarkdown`; in `cmdSync`, branch on `config.tiers !== undefined` before the existing generation loops. Extend `expectedAgentNames` in `config.ts` to return tier agent names for tiered configs (it feeds the stale calculation).

- [ ] **Step 4: Run** — `npx vitest run tests/commands/sync.test.ts && npm test`.

- [ ] **Step 5: Commit**

```bash
git add src/commands/sync.ts src/config.ts tests/commands/sync.test.ts
git commit -m "feat(sync): generate role-by-tier agents carrying router aliases"
```

---

### Task 6: `sonata dispatch` — blocking CLI with ranked harness fallback

**Files:**
- Create: `src/commands/dispatch.ts`
- Modify: `src/cli.ts` (new command + USAGE line), `src/settings.ts` (`SONATA_TOOLS` values)
- Test: `tests/commands/dispatch.test.ts`, `tests/settings.test.ts` (adjust the allow-list expectations)

**Interfaces:**
- Consumes: `resolveTierAlias`, `harnessModelFor` (Task 2); `cmdRun(opts: RunOptions): Promise<RunResult>` where `RunOptions = { cwd, role, model, taskFile, rolesDir, sessionId }` and `model` is a **config model key**; `cmdWait(opts: WaitOptions): Promise<WaitResult>` where `WaitResult.state ∈ DONE|PAUSED|STALLED|RUNNING` and `WaitResult` carries `report?`, `degraded?`, `id`.
- Produces:
  - `interface DispatchOptions { cwd: string; home: string; tier?: string; model?: string; task: string; rolesDir: string; sessionId?: string }`
  - `interface DispatchAttempt { modelKey: string; state: string; degraded: boolean }`
  - `interface DispatchOutcome { id: string; state: string; report?: string; modelKey: string; attempts: DispatchAttempt[] }`
  - `cmdDispatch(opts: DispatchOptions, deps?: { run?: typeof cmdRun; wait?: typeof cmdWait }): Promise<DispatchOutcome>`
  - CLI: `sonata dispatch (--tier <role>-<tier> | --model <key>) [--task-file <path>] "<task text>"` — prints state, the model that ran, the report; `PAUSED` prints the prompt and `sonata approve <id>`; `RUNNING` prints `sonata wait <id>`.
- Behaviour:
  - `--tier code-simple` resolves via `resolveTierAlias(config, 'sonata-code-simple')`, filtered to routes with a `harness` half; `--model <key>` uses `harnessModelFor` for that single key. Neither/both → usage error.
  - For each candidate in order: write the task to `.sonata/tasks/<timestamp>.md` (create the dir), call `run`, then loop `wait` until a non-`RUNNING` state. **Move to the next candidate** when `run` throws, or the state is `DONE` with `degraded: true`, or `DONE` with an empty report. Otherwise return.
  - The outcome records every attempt so the printout can say `flash: degraded → luna: DONE`.
  - `cmdRun`'s model lookup today reads the legacy `config.models[key]` shape. Add one line to its lookup: fall back to `harnessModelFor(config, key)` (mapping `{harness, id}` onto the shape it already consumes) so unified keys dispatch without a legacy entry.
- `src/settings.ts`: replace the three MCP tool names in `SONATA_TOOLS` with `'Bash(sonata dispatch:*)', 'Bash(sonata wait:*)', 'Bash(sonata approve:*)'`. The constant's name and the `allowSonataTools`/`missingAllowEntries` machinery stay — only the values change. Update the doc comment: the classifier-instability story is unchanged, the tool surface moved from MCP to Bash.

- [ ] **Step 1: Write failing tests**

```ts
// tests/commands/dispatch.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdDispatch } from '../../src/commands/dispatch.js';

const TIERED = `
[models."flash"]
gateway = "g"
id = "flash-1"
harness = "opencode"

[models."terra"]
gateway = "g"
id = "terra-1"
harness = "opencode"

[tiers.code]
simple = ["flash", "terra"]
complex = ["terra"]

[native.gateways."g"]
base_url = "http://gateway.example/v1"
`;

let cwd: string; let home: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'sonata-dispatch-'));
  home = mkdtempSync(join(tmpdir(), 'sonata-dispatch-home-'));
  writeFileSync(join(cwd, 'sonata.toml'), TIERED);
});

const opts = () => ({ cwd, home, tier: 'code-simple', task: 'do the thing', rolesDir: '/roles' });

it('returns the first candidate result when it succeeds', async () => {
  const outcome = await cmdDispatch(opts(), {
    run: async (o) => { expect(o.model).toBe('flash'); return { id: 'r1', session: 's', interactive: false }; },
    wait: async () => ({ id: 'r1', state: 'DONE', report: 'did it', lines: [], degraded: false }) as never,
  });
  expect(outcome).toMatchObject({ id: 'r1', state: 'DONE', modelKey: 'flash', report: 'did it' });
  expect(outcome.attempts).toHaveLength(1);
});

it('falls through to the next candidate on a degraded finish', async () => {
  const ran: string[] = [];
  const outcome = await cmdDispatch(opts(), {
    run: async (o) => { ran.push(o.model); return { id: `r${ran.length}`, session: 's', interactive: false }; },
    wait: async (o) => (o.id === 'r1'
      ? { id: 'r1', state: 'DONE', report: '', degraded: true, lines: [] }
      : { id: 'r2', state: 'DONE', report: 'terra did it', degraded: false, lines: [] }) as never,
  });
  expect(ran).toEqual(['flash', 'terra']);
  expect(outcome.modelKey).toBe('terra');
  expect(outcome.attempts.map((a) => a.state)).toEqual(['DONE', 'DONE']);
});

it('falls through when the launch itself throws', async () => {
  const ran: string[] = [];
  const outcome = await cmdDispatch(opts(), {
    run: async (o) => {
      ran.push(o.model);
      if (o.model === 'flash') throw new Error('database is locked');
      return { id: 'r2', session: 's', interactive: false };
    },
    wait: async () => ({ id: 'r2', state: 'DONE', report: 'ok', degraded: false, lines: [] }) as never,
  });
  expect(ran).toEqual(['flash', 'terra']);
  expect(outcome.state).toBe('DONE');
});

it('returns PAUSED immediately — an approval is not a failure', async () => {
  const outcome = await cmdDispatch(opts(), {
    run: async () => ({ id: 'r1', session: 's', interactive: true }),
    wait: async () => ({ id: 'r1', state: 'PAUSED', lines: ['Allow?'], degraded: false }) as never,
  });
  expect(outcome.state).toBe('PAUSED');
  expect(outcome.attempts).toHaveLength(1);
});

it('reports the exhausted list when every candidate fails', async () => {
  const outcome = await cmdDispatch(opts(), {
    run: async () => { throw new Error('down'); },
    wait: async () => { throw new Error('unreachable'); },
  });
  expect(outcome.state).toBe('FAILED');
  expect(outcome.attempts).toHaveLength(2);
});

it('--model dispatches exactly one key and refuses a harness-less one', async () => {
  const outcome = await cmdDispatch({ ...opts(), tier: undefined, model: 'terra' }, {
    run: async (o) => { expect(o.model).toBe('terra'); return { id: 'r1', session: 's', interactive: false }; },
    wait: async () => ({ id: 'r1', state: 'DONE', report: 'ok', degraded: false, lines: [] }) as never,
  });
  expect(outcome.modelKey).toBe('terra');
  await expect(cmdDispatch({ ...opts(), tier: undefined, model: 'missing' }, {}))
    .rejects.toThrow(/missing/);
});
```

In `tests/settings.test.ts`, update every assertion that names `mcp__sonata__dispatch`/`wait`/`approve` to the three `Bash(sonata …:*)` strings.

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/commands/dispatch.test.ts tests/settings.test.ts`.

- [ ] **Step 3: Implement `src/commands/dispatch.ts`**, the `cmdRun` lookup fallback, the `SONATA_TOOLS` value swap, and the CLI wiring. In `cli.ts`, register `dispatch` next to `run` (parse `--tier`, `--model`, `--task-file`, positional task text; `--task-file` reads the file instead — mirrors how MCP callers passed larger tasks). The `state: 'FAILED'` outcome (all candidates failed) exits 1 with the attempts listed one per line.

- [ ] **Step 4: Run** — the two test files + `npm test`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/dispatch.ts src/commands/run.ts src/settings.ts src/cli.ts tests/commands/dispatch.test.ts tests/settings.test.ts
git commit -m "feat(dispatch): blocking CLI dispatch with ranked harness fallback"
```

---

### Task 7: Remove the MCP server

**Files:**
- Delete: `src/mcp/protocol.ts`, `src/mcp/server.ts`, `src/mcp/tools.ts`, `tests/mcp/` (whole directory)
- Modify: `src/cli.ts` (drop the `mcp` command + USAGE line), `src/settings.ts` (delete `registerMcp`, `mcpRegistered`, `mcpArgs`, `McpScope`, `Runner`/`RunResult` if now unused), `src/commands/init.ts` (delete the MCP registration step and its flags), `src/commands/doctor.ts` (replace the registration check), `src/commands/run.ts` (`exposesSonataTools` — keep: it warns that a repo `.mcp.json` hands dispatched models tools; reword its message to name stale registrations)
- Test: `tests/commands/doctor.test.ts`, `tests/commands/init.test.ts` (adjust)

**Interfaces:**
- Produces: `staleMcpRegistration(cwd: string, home: string): string | undefined` in `src/commands/doctor.ts` — returns a human line when `./.mcp.json` or `~/.claude.json` still registers a server named `sonata`, telling the user to run `claude mcp remove sonata` (check both scopes; read the files directly with the same tolerant JSON reading `mcpRegistered` used).
- Doctor emits it as a **warning** (`ok: true` with the removal command in `detail` — a stale registration wastes a connection attempt but breaks nothing).

Sequencing inside the task: first migrate the two pieces of `src/mcp/tools.ts` that outlive it — `truncateReport` and the task-file resolution — into `src/commands/dispatch.ts` (they are already exercised by Task 6's tests via the dispatch printout); then delete.

- [ ] **Step 1: Write the failing doctor test** — a cwd whose `.mcp.json` registers `sonata` produces the warning naming `claude mcp remove sonata`; a clean cwd produces no such check.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Delete and rewire.** `rm -r src/mcp tests/mcp`; remove the `cli.ts` branch (`if (command === 'mcp')`) and its dynamic import; remove `registerMcp`/`mcpRegistered`/`mcpArgs`/`McpScope` from `settings.ts` and the `init.ts` call site (`registerMcp(mcpScope, …)` around line 1030) plus every `--mcp-scope`-style flag and prompt feeding it; implement `staleMcpRegistration` and wire it into doctor in place of the old registration check.
- [ ] **Step 4: Run the full suite** — `npm run typecheck && npm test`. Expected: PASS with the MCP suites gone. Grep-gate: `/usr/bin/grep -rn "mcp__sonata\|runMcpStdio\|registerMcp" src/ tests/` returns nothing.
- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor!: remove the MCP server — dispatch is a CLI, agents are tier-native"
```

---

### Task 8: RankedSelect TUI primitive

**Files:**
- Create: `src/tui-ink/components/ranked-select-state.ts`, `src/tui-ink/components/ranked-select.tsx`
- Test: `tests/tui-ink/ranked-select-state.test.ts`

**Interfaces:**
- Produces:
  - `interface RsState { cursor: number; ranked: number[] }` — `ranked` holds item indices in priority order (position 0 = main model).
  - `type RsAction = { type: 'up' } | { type: 'down' } | { type: 'toggle' } | { type: 'moveUp' } | { type: 'moveDown' }`
  - `rsInitial(itemCount: number, initialRanked: number[]): RsState`
  - `rsReduce(state: RsState, action: RsAction, itemCount: number): RsState`
  - Component `<RankedSelect title items={{value,label}[]} initialRanked={string[]} footer? onSubmit={(ranked: string[]) => void} onBack onCancel />` — arrow keys move the cursor, space toggles (toggle-on appends to the end of the ranking; toggle-off removes), `[`/`]` move the item under the cursor up/down within the ranking, enter submits (refused while the ranking is empty), left arrow backs, esc cancels. Selected items render `1.`, `2.`… before their label; unselected render `·`. Follow `multi-select.tsx` for Ink structure and `multi-select-state.ts` for the pure-reducer split.

- [ ] **Step 1: Write the failing reducer tests**

```ts
// tests/tui-ink/ranked-select-state.test.ts
import { describe, it, expect } from 'vitest';
import { rsInitial, rsReduce } from '../../src/tui-ink/components/ranked-select-state.js';

describe('rsReduce', () => {
  it('toggle appends to the end of the ranking and removes on re-toggle', () => {
    let s = rsInitial(3, []);
    s = rsReduce({ ...s, cursor: 1 }, { type: 'toggle' }, 3);
    s = rsReduce({ ...s, cursor: 0 }, { type: 'toggle' }, 3);
    expect(s.ranked).toEqual([1, 0]);          // selection order = ranking
    s = rsReduce({ ...s, cursor: 1 }, { type: 'toggle' }, 3);
    expect(s.ranked).toEqual([0]);
  });

  it('moveUp/moveDown reposition the item under the cursor within the ranking', () => {
    let s = { cursor: 2, ranked: [0, 1, 2] };
    s = rsReduce(s, { type: 'moveUp' }, 3);
    expect(s.ranked).toEqual([0, 2, 1]);
    s = rsReduce(s, { type: 'moveUp' }, 3);
    expect(s.ranked).toEqual([2, 0, 1]);
    s = rsReduce(s, { type: 'moveUp' }, 3);   // already first: no-op
    expect(s.ranked).toEqual([2, 0, 1]);
    s = rsReduce(s, { type: 'moveDown' }, 3);
    expect(s.ranked).toEqual([0, 2, 1]);
  });

  it('move actions ignore an unselected cursor item', () => {
    const s = rsReduce({ cursor: 2, ranked: [0] }, { type: 'moveUp' }, 3);
    expect(s.ranked).toEqual([0]);
  });

  it('cursor movement clamps to the item count', () => {
    expect(rsReduce({ cursor: 0, ranked: [] }, { type: 'up' }, 3).cursor).toBe(0);
    expect(rsReduce({ cursor: 2, ranked: [] }, { type: 'down' }, 3).cursor).toBe(2);
  });

  it('rsInitial preserves a stored ranking order', () => {
    expect(rsInitial(4, [2, 0]).ranked).toEqual([2, 0]);
  });
});
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** the reducer, then the component over it (no test for the component itself — the reducer carries the behaviour, same as `multi-select`).
- [ ] **Step 4: Run** — the new file + `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add src/tui-ink/components/ranked-select-state.ts src/tui-ink/components/ranked-select.tsx tests/tui-ink/ranked-select-state.test.ts
git commit -m "feat(tui): RankedSelect — selection order is the ranking"
```

---

### Task 9: Init — tier assignment screens and config output

**Files:**
- Modify: `src/tui-ink/app.tsx`, `src/tui-ink/app-state.ts`, `src/tui-ink/types.ts`, `src/commands/init.ts`
- Test: `tests/commands/init.test.ts` (adjust + append), `tests/tui-ink/app-state.test.ts` (append)

**Interfaces:**
- Consumes: `proposeTiers`, `loadAaCatalog`, `AA_ATTRIBUTION` (Task 1), `RankedSelect` (Task 8), `TIER_NAMES` (Task 2).
- Produces: `InitState` gains `tiers?: Record<string, { simple: string[]; complex: string[] }>`; `cmdInit` writes `[models]` (unified entries) + `[tiers]` instead of `[generate.roles]`/`[generate.native]`.
- Wizard flow after the roles `MultiSelect` (replacing the "same models for every role?" choice and per-role `MultiSelect` screens at `app.tsx` step 4, the `roleIndex` loop):
  - For each selected role, **two sequential `RankedSelect` screens** (`key={role + '-simple'}`, `key={role + '-complex'}`), items = the selected model keys, `initialRanked` = the proposal from `proposeTiers(selectedKeys, loadAaCatalog(home))` — or, on re-init, the stored `[tiers]` order.
  - Each screen's `footer` is the catalog source line: when `loadAaCatalog` returned data, `` `rankings: Artificial Analysis (fetched <date>) — artificialanalysis.ai` ``; otherwise `` `rankings: built-in defaults — refresh with sonata catalog update` ``.
  - The confirm screen replaces its per-role model list with one line per role: `` `code: simple → flash (+1 backup) · complex → terra (+2 backups)` ``.
  - `--yes` (and any scripted path) accepts the whole proposal without rendering; `--roles` continues to select roles.
- Config writing in `cmdInit`: every selected model becomes a `[models]` entry — discovered native candidates keep `gateway`/`id`/`context_window`; harness-discovered models get `harness` + provider-qualified id as `harness_id` (with `gateway` too when the same upstream is BYOK/native-reachable); write `[tiers.<role>]` with the chosen order. All keys through `tomlKey`.

- [ ] **Step 1: Write the failing tests.** In `tests/commands/init.test.ts`, take the existing scripted-init test as template and assert: a `--yes` run against fixture-discovered models writes a `sonata.toml` whose parsed form has `tiers` for every selected role, tier lists ordered by the catalog proposal, and `parseConfig` accepts it round-trip. In `tests/tui-ink/app-state.test.ts`, assert `applyStep` stores a `{ role, tier, ranked }` payload into `state.tiers` without disturbing other roles.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** the state plumbing (`applyStep` case for the tier payload), the two-screen-per-role loop (mirror the existing `roleIndex` advance pattern: advance `tierIndex` over `roles.length * 2` screens), the confirm line, and the `cmdInit` TOML writer changes.
- [ ] **Step 4: Run** — `npx vitest run tests/commands/init.test.ts tests/tui-ink && npm test`. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add src/tui-ink src/commands/init.ts tests/commands/init.test.ts tests/tui-ink
git commit -m "feat(init): tier assignment screens with catalog-ranked proposals"
```

---

### Task 10: Legacy config migration

**Files:**
- Modify: `src/normalize.ts` (the migration function lives with the existing config-normalization code), `src/commands/init.ts` (invoke it), `src/commands/doctor.ts` (legacy-format warning)
- Test: `tests/normalize.test.ts` (append), `tests/commands/init.test.ts` (append)

**Interfaces:**
- Produces: `migrateLegacyConfig(config: SonataConfig): { models: Record<string, UnifiedModelConfig>; tiers: Record<string, TierLists> }`
- Rules:
  - Every `[native.models]` entry becomes a unified entry keyed by its existing key: `{ gateway, id, contextWindow }`.
  - Every legacy harness entry (`config.models`) becomes `{ harness, harnessId: id }` keyed by `normalizeModelName(key)` — **unless** a native entry already normalized to the same name, in which case its `harness`/`harnessId` are merged onto that entry (one model, two routes).
  - Key collisions after normalization that are *not* the same upstream model (different `id` tails) keep the original un-normalized key — never silently merge two different models.
  - `[generate.roles]` seeds `[tiers]`: for each role, both `simple` and `complex` get the role's migrated key list in order; `[generate.native]` keys are appended (deduplicated, native keys first — the native-first principle). No selection is lost; the user refines in the picker.
- `cmdInit` runs the migration when it loads a config that has `generate` data and no `tiers`, feeding the result into the wizard as the stored selections (so the tier screens open pre-ranked with the migrated lists). Doctor warns on a legacy config: `` `config predates [tiers] — run \`sonata init\` to migrate` ``.

- [ ] **Step 1: Write failing tests** — a fixture `SonataConfig` (build it via `parseConfig` on a legacy TOML string with two harness models, one native model of the same upstream as one harness model, and `[generate.roles]`+`[generate.native]`) migrates to: merged dual-route entry, harness-only entry, native-only entry; tiers seeded native-first; distinct-model collision keeps original keys. Init test: `cmdInit --yes` over a legacy config writes a tiered config that `parseConfig` accepts and whose tier lists contain every previously selected model.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — the two files + `npm test`.
- [ ] **Step 5: Commit**

```bash
git add src/normalize.ts src/commands/init.ts src/commands/doctor.ts tests/normalize.test.ts tests/commands/init.test.ts
git commit -m "feat(init): migrate legacy [generate] configs to [models]+[tiers]"
```

---

### Task 11: `sonata catalog update` — AA refresh

**Files:**
- Create: `src/commands/catalog.ts`, `tests/fixtures/aa/models.json`
- Modify: `src/cli.ts` (command + USAGE), `src/commands/auth.ts` (accept `artificialanalysis` as a storable gateway name — inspect how `cmdAuth` validates gateway names first; if it validates against `config.native.gateways`, add a carve-out constant `KEY_ONLY_GATEWAYS = ['artificialanalysis']`)
- Test: `tests/commands/catalog.test.ts`

**Interfaces:**
- Consumes: `aaCatalogPath`, `AA_ATTRIBUTION`, `normalizeModelName` (Task 1); `resolveKeyFromSource`/store read from `src/native/credentials.ts` (`writeSonataKey(home, 'artificialanalysis', key)` is how the key arrives — via `sonata auth add artificialanalysis`).
- Produces: `cmdCatalogUpdate(home: string, deps?: { fetch?: typeof fetch; now?: () => Date }): Promise<{ models: number; path: string; fetchedAt: string }>`
- Behaviour:
  - Reads the key from the sonata store for gateway `artificialanalysis`; missing → throw `` `sonata catalog update: no key stored — run \`sonata auth add artificialanalysis\` (free key at https://artificialanalysis.ai)` ``. The key goes in the `x-api-key` header, never argv or output.
  - `GET https://artificialanalysis.ai/api/v2/data/llms/models`. Non-200 → throw with status (401/403 named as "key rejected"). Response `data` array maps to the cache: for each entry take `entry.name`/`entry.slug` → `normalizeModelName`, `entry.evaluations.artificial_analysis_coding_index` → `codingIndex`, `entry.pricing.price_1m_blended_3_to_1` → `blendedPriceUsd` (skip entries missing either number).
  - Writes `AaCatalog` JSON to `aaCatalogPath(home)` (mkdir -p), `fetchedAt` from `deps.now`.
  - CLI prints the count, the path, and `AA_ATTRIBUTION` on its own line.
- Fixture: `tests/fixtures/aa/models.json` — hand-write a **synthetic** response (three models with the field paths above; invented numbers — a real capture would be AA data in the repo, which the license forbids). Note this provenance in a comment at the top of the test file, not the JSON (JSON has no comments).

- [ ] **Step 1: Write failing tests** — happy path against the fixture via a stub fetch (asserts cache file contents + normalized names + count), missing-key throw, 403 throw naming the key, malformed-body throw.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement + CLI wiring** (`sonata catalog update`; bare `sonata catalog` prints the cache's age and model count, or "no catalog — run sonata catalog update").
- [ ] **Step 4: Run** — new file + `npm test`.
- [ ] **Step 5: Commit**

```bash
git add src/commands/catalog.ts src/commands/auth.ts src/cli.ts tests/commands/catalog.test.ts tests/fixtures/aa/models.json
git commit -m "feat(catalog): sonata catalog update — user-keyed Artificial Analysis refresh"
```

---

### Task 12: `sonata route --global`

**Files:**
- Modify: `src/commands/route.ts`, `src/cli.ts`, `hooks/route-session.mjs`
- Test: `tests/commands/route.test.ts` (append), `tests/hooks/route-session.test.ts` (verify the silent no-config exit still holds — it already runs from a configless scratch dir)

**Interfaces:**
- Consumes: existing `cmdRoute`, `cmdRouteSession`, `routeSettingsFile`, `planRouteAuto`/`planRouteManual`, `readSettings`/`writeSettings`.
- Produces:
  - `routeSettingsFile(cwd: string, scope: 'project' | 'global', home: string): string` — project: `<cwd>/.claude/settings.local.json` (unchanged); global: `<home>/.claude/settings.json`.
  - `cmdRoute(action, opts)` gains `scope: 'project' | 'global'` (default `'project'`); CLI parses `--global` on `on|off|auto|manual|status`.
  - `routeStatus` gains a `scopes` report: `status` reads **both** files and prints which scope(s) carry env/hooks.
  - The session registry stays per-project regardless of scope (`<cwd>/.sonata/route-sessions.json`) — `cmdRouteSession` is unchanged except that `route on`/`off` invoked from the hooks keep writing the **project** settings file: routing state follows the session's project even when the *hooks* were installed globally. (Global auto = "hooks fire everywhere"; the env each session writes is still project-local, so an unrelated project's sessions never see another project's router.)
  - `hooks/route-session.mjs` already exits 0 with no CLI invocation when the payload carries no session id, and the CLI it invokes exits non-zero in a configless directory without touching anything — assert in the route tests that `cmdRouteSession('start', …)` in a cwd with no `sonata.toml` throws before any settings write (that throw is what the hook swallows machine-wide).
- Guards: the ownership tests (`isLocalhostUrl`, never clobber a foreign `ANTHROPIC_BASE_URL`) apply to the global file identically — they already live in `planRouteOn`/`planRouteOff`, which are scope-blind.

- [ ] **Step 1: Write failing tests** — `--global` on/off writes and cleans `<home>/.claude/settings.json` while leaving the project file alone; `auto --global` installs the hook pair there; `status` reports a global-only install; configless `cmdRouteSession` throws without writing; project-scope behaviour byte-identical to today (run the existing tests unmodified).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** (thread `scope` + `home` through; keep the existing two-arg `routeSettingsFile(cwd)` callers by defaulting the new parameters).
- [ ] **Step 4: Run** — route + hooks tests + `npm test`.
- [ ] **Step 5: Commit**

```bash
git add src/commands/route.ts src/cli.ts hooks/route-session.mjs tests/commands/route.test.ts
git commit -m "feat(route): --global scope for on|off|auto|manual|status"
```

---

### Task 13: Loop skill + init install + route offer

**Files:**
- Create: `skills/loop/SKILL.md`
- Modify: `src/commands/init.ts` (install step + route-auto offer), `src/commands/doctor.ts` (routing check for tiered configs)
- Test: `tests/commands/init.test.ts` (append)

**Interfaces:**
- Produces: init copies `skills/loop/SKILL.md` to `<cwd>/.claude/skills/sonata-loop/SKILL.md` (project scope; ask like the permission-hook step does, `--yes` accepts). After the hook-scope step, a routing step offers: `sonata route auto` (project) / `sonata route auto --global` / skip — using the retained non-Ink `select` prompt (stdin `ref()` discipline applies; see `src/tui.ts`). Skipping leaves a doctor warning for tiered configs: `` `tier agents need a routed session — run \`sonata route auto\`` ``.
- `skills/loop/SKILL.md` full content:

```markdown
---
name: sonata-loop
description: Use when building a feature end-to-end with sonata tier agents — plans the work, routes each task to a difficulty tier, gates every change behind review, and escalates tiers on repeated failure.
---

# Loop engineering with sonata tier agents

Run feature development as a loop over sonata's tier agents. You (the
orchestrating session) judge difficulty and drive the loop; the agents do the
work on foreign models. All of them require a routed session (`sonata route
auto`) — if a tier agent errors with "all native routes … failed", fall back
to `sonata dispatch --tier <role>-<tier>` in Bash.

## Difficulty heuristic

- **simple** — mechanical, well-specified, contained: single-file changes,
  bulk edits, scaffolding, test-writing against a clear spec.
- **complex** — cross-cutting, ambiguous, design-sensitive, or needs
  sustained reasoning: multi-file refactors, API design, debugging unknowns.
- When unsure, use `-complex`.

## The loop

1. **Plan.** Dispatch `plan-complex` with the feature description. Ask it for
   a numbered task list with per-task difficulty guesses.
2. **Route.** For each task, judge difficulty yourself (the plan's guess is
   advice, not binding) and dispatch `code-simple` or `code-complex` with a
   self-contained task description — name the files to touch and the files to
   leave alone; never say "see the plan".
3. **Gate.** After each task, dispatch `review-simple` on the diff. Findings →
   dispatch a fix at the same tier, then re-review.
   - **Escalation rule:** a task that fails review twice at `simple` re-runs
     at `complex` from scratch.
   - **Loop bound:** at most 3 fix iterations per task; then stop and surface
     the findings to the user.
4. **Final gate.** When every task passed, dispatch `review-complex` over the
   whole change. Findings loop back through step 3.

## When not to loop

A single contained change does not need the loop — dispatch one `code-*`
agent directly, review it yourself or with one `review-simple` pass, done.
```

- [ ] **Step 1: Write failing tests** — `cmdInit --yes` installs the skill file; the init summary names the routing choice; skipping routing yields the doctor warning on a tiered config.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — init + doctor tests + `npm test`.
- [ ] **Step 5: Commit**

```bash
git add skills/loop/SKILL.md src/commands/init.ts src/commands/doctor.ts tests/commands/init.test.ts
git commit -m "feat(skill): sonata-loop — tier-routed feature loop; init installs it"
```

---

### Task 14: Docs, doctor polish, release gate

**Files:**
- Modify: `README.md`, `CLAUDE.md`, `src/cli.ts` (final USAGE review), `package.json` (version)
- Test: none new — this is the release gate.

- [ ] **Step 1: Rewrite the docs for the new surface.** README: the architecture diagram drops the wrapper/MCP layer (Claude Code → tier agent → router → gateway; fallback lane → `sonata dispatch` → harness); the config example becomes `[models]`+`[tiers]`; the command table gains `dispatch`, `catalog update`, `route --global`, loses `mcp`; the agent list shows the 8 tier agents; the Remote Control paragraphs are already current. CLAUDE.md: update Project Overview, Architecture, Source layout (add `catalog.ts`, `commands/dispatch.ts`, `commands/catalog.ts`, `ranked-select*`; remove `mcp/`), Configuration (new tables + tier alias + mixing refusal + migration), Known Limitations (drop MCP-specific entries — progress notifications, dispatch windows; add the router-fallback and cooldown notes), Conventions (wrapper-agent rules become dispatch-CLI rules).
- [ ] **Step 2: Full gates.**

Run: `npm run typecheck && npm run build && npm test`
Expected: all green.

- [ ] **Step 3: Live smoke test** (needs a configured machine — skip cleanly if none): `sonata init --yes` in a scratch project with a real config, `sonata sync`, confirm the agent files carry aliases; `sonata serve` + one `curl` of the router with `{"model":"sonata-code-simple"}` and confirm the resolution log line; `sonata dispatch --model <key> "write ok to /tmp/x"` against the fake harness fixture if no real harness is authenticated.
- [ ] **Step 4: Version + release commit.** Bump `package.json` to `0.2.0`; commit `chore(release): v0.2.0` with a body summarizing: tier agents, native-first fallback, MCP removal, dispatch CLI, catalog, route --global, loop skill. Push.

---

## Self-Review (performed at write time)

- **Spec coverage:** §1 config → Tasks 2, 10; §2 agents → Task 5; §3 router → Tasks 3, 4; §4 CLI/MCP → Tasks 6, 7; §5 catalog → Tasks 1, 11; §6 init/TUI → Tasks 8, 9 (+13 route offer); §7 --global → Task 12; §8 loop skill → Task 13; §9 testing → distributed per task; §10 out-of-scope respected (no workflow runtime, no mid-stream failover — Task 3 retries only before returning a response).
- **Type consistency:** `TierRoute`/`resolveTierAlias` (Task 2) are consumed by Tasks 3, 4, 6 with identical signatures; `RsState.ranked` (Task 8) feeds Task 9's `initialRanked`; `SONATA_TOOLS` keeps its name across Tasks 6–7.
- **Known deviation from spec:** parseConfig refuses *mixing* `[tiers]` with legacy `[generate]` tables rather than refusing legacy-only configs outright — a legacy config still parses (with a doctor warning) until init migrates it, so users mid-upgrade are never bricked. The spec's "old tables are refused after migration" holds: a migrated config cannot re-grow them.
