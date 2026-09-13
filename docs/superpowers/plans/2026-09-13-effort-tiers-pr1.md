# Effort Tiers — PR 1: catalog, config, ranking, wizard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tier candidate can name a reasoning-effort level (`gpt-5.6-luna@xhigh`), `sonata init`/`sonata agents` rank the effort variants Artificial Analysis already publishes, and a bare candidate whose model has variants is refused at load.

**Architecture:** A candidate string is `<key>` or `<key>@<effort>`; `src/effort.ts` owns the enum and the split/join, with no imports, so `config.ts` and `catalog.ts` can both use it without a cycle. `sonata catalog update` records each AA row's `family` and `effort` from the parenthetical in its `name`; `catalog.ts` groups rows into families and expands a model key into its scored variants; `proposeTiers` ranks the expanded set with its existing rules. `parseConfig` validates the grammar and `resolveTierAlias` exposes `effort` on `TierRoute`; `loadConfig` (which has `home`) loads the catalog and refuses bare candidates with variants. Nothing in this PR sends the effort upstream — that is PR 2 (router) and PR 3 (adapters).

**Tech Stack:** TypeScript (Node 22, ESM, `.js` import specifiers), vitest, Ink (wizard), smol-toml.

**Spec:** `docs/superpowers/specs/2026-09-13-effort-tiers-design.md` — sections 1, 2, 3, 6 and the config/ranking parts of 7.

## Global Constraints

- Effort enum (the single definition, `src/effort.ts`): `none | minimal | low | medium | high | xhigh | max`, in that order.
- Candidate grammar: `<key>@<effort>`; split on the **last** `@`; an unknown or empty level is a parse error.
- AA's `name` parenthetical carries the level; `Non-reasoning` → `none`; a bare `Reasoning` and any non-level text → no effort. The **slug** (not the name) is the source of the family, with the effort suffix removed before `normalizeModelName`.
- `family`/`effort` are optional on cache entries; a cache without them loads and means "cannot check".
- Cooldowns, `tiersCollapse` and every `[models]` lookup key by the **bare key**; only ranking, labels and `TierRoute.effort` see the level.
- The refusal lives in `loadConfig`, `TenantRegistry.load` and `writeTiers` — never in `parseConfig`. With no catalog cache it is skipped.
- The `tests/fixtures/aa/` fixtures are synthetic and hand-invented (AA's licence forbids redistribution).
- Run tests with `npm test -- <file>` (vitest); typecheck with `npm run typecheck`. In a Claude Code tool shell where `node` recurses on `_nvm_lazy_load`, prefix commands with `unset -f node npm npx nvm corepack; . ~/.nvm/nvm.sh >/dev/null;`.
- `sonata` on PATH runs `dist/`: run `npm run build` before any manual check through the CLI.
- Commit messages end with the attribution lines the session provides.

---

## File map

| File | Responsibility in this PR |
|---|---|
| `src/effort.ts` (new) | `Effort`, `EFFORT_LEVELS`, `isEffort`, `splitCandidate`, `joinCandidate`, `parseAaEffort`, `aaEffortSuffix` |
| `src/commands/catalog.ts` | record `family`/`effort` per cached row |
| `src/catalog.ts` | `AaEntry.family/effort`, `catalogFamily`, effort-aware `aaEntryFor`/`scoreFor`/`lookupModel`, `expandCandidates`, `hasEffortVariants`, `unpinnedVariants`, `candidateLabel`, variant-aware `proposeTiers`, `unpinnedCandidates`, `assertEffortsPinned` |
| `src/config.ts` | candidate grammar in `parseConfig`, `TierRoute.effort`, refusal in `loadConfig` |
| `src/native/tenants.ts` | refusal in `load` |
| `src/extended-context.ts` | look up the bare key |
| `src/commands/doctor.ts` | split before coverage; "cannot check" line |
| `src/tui-ink/app.tsx`, `src/tui-ink/app-state.ts` | variant rows with score labels; expansion threaded through bulk-accept |
| `src/init/plan.ts`, `src/init/helpers.ts` | expanded valid keys, unpinned re-proposal, bare keys for `perRoleModels` |
| `src/commands/agents.ts` | variant rows, effort in the view, refusal before write |
| `docs/guide/configuration.md`, `CLAUDE.md`, `CHANGELOG.md`, `docs/HANDOFF.md` | grammar, design points, changelog, environment trap |

---

### Task 1: The effort module

**Files:**
- Create: `src/effort.ts`
- Test: `tests/effort.test.ts`

**Interfaces:**
- Produces:
  - `type Effort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'`
  - `const EFFORT_LEVELS: readonly Effort[]` (in that order)
  - `isEffort(value: string): value is Effort`
  - `splitCandidate(candidate: string): { key: string; effort?: Effort }` — throws on `key@` or `key@bogus`
  - `joinCandidate(key: string, effort?: Effort): string`
  - `parseAaEffort(name: string): Effort | undefined`
  - `aaEffortSuffix(effort: Effort): string` — `none` → `non-reasoning`, else the level

- [ ] **Step 1: Write the failing tests**

```ts
// tests/effort.test.ts
import { describe, it, expect } from 'vitest';
import {
  EFFORT_LEVELS, isEffort, splitCandidate, joinCandidate, parseAaEffort, aaEffortSuffix,
} from '../src/effort.js';

describe('EFFORT_LEVELS', () => {
  it('is the wire enum, weakest first', () => {
    expect(EFFORT_LEVELS).toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(isEffort('xhigh')).toBe(true);
    expect(isEffort('XHIGH')).toBe(false);
    expect(isEffort('turbo')).toBe(false);
  });
});

describe('splitCandidate / joinCandidate', () => {
  it('returns a bare key unchanged', () => {
    expect(splitCandidate('gpt-5.6-luna')).toEqual({ key: 'gpt-5.6-luna' });
  });
  it('splits on the last @', () => {
    expect(splitCandidate('gpt-5.6-luna@xhigh')).toEqual({ key: 'gpt-5.6-luna', effort: 'xhigh' });
  });
  it('refuses an empty or unknown level', () => {
    expect(() => splitCandidate('gpt-5.6-luna@')).toThrow(/effort level/);
    expect(() => splitCandidate('gpt-5.6-luna@turbo')).toThrow(/"turbo"/);
  });
  it('round-trips through join', () => {
    expect(joinCandidate('k', 'low')).toBe('k@low');
    expect(joinCandidate('k')).toBe('k');
    expect(splitCandidate(joinCandidate('k', 'max'))).toEqual({ key: 'k', effort: 'max' });
  });
});

describe('parseAaEffort', () => {
  // The vocabulary tallied over AA's 647 rows on 2026-09-13.
  it.each([
    ['GPT-5.6 Luna (max)', 'max'],
    ['GPT-5.6 Luna (xhigh)', 'xhigh'],
    ['GPT-5.6 Luna (high)', 'high'],
    ['GPT-5.6 Luna (medium)', 'medium'],
    ['GPT-5.6 Luna (low)', 'low'],
    ['Gemini 3.5 Flash (minimal)', 'minimal'],
    ['GPT-5.6 Luna (Non-reasoning)', 'none'],
    ['GPT-5.2 (Non-Reasoning)', 'none'],
    ['DeepSeek V4 Pro (Reasoning, Max Effort)', 'max'],
    ['DeepSeek V4 Pro (Reasoning, High Effort)', 'high'],
    ['Claude Opus 4.8 (Adaptive Reasoning, Xhigh Effort)', 'xhigh'],
    ['Claude Opus 4.8 (Adaptive Reasoning, Max Effort, Default Fallback)', 'max'],
    ['Claude Sonnet 4.8 (Non-reasoning, High Effort)', 'none'],
    ['Multiverse (high, based on gpt-oss-120b)', 'high'],
    ['Multiverse (max, based on GLM-5.2)', 'max'],
  ])('%s → %s', (name, effort) => {
    expect(parseAaEffort(name)).toBe(effort);
  });

  it.each([
    'Qwen3.8 Max (Reasoning)',
    "Gemini 2.0 Flash (Dec '24)",
    'Gemini 3.1 Flash Lite (Preview)',
    'Llama 5 (Vision)',
    'HyperCLOVA X (32B)',
    'GPT-4o (ChatGPT)',
    'Reka Core (V1)',
    'GPT-4 (0613)',
    'Motif (Beta)',
    'Gemma (experimental)',
    'GPT-5.6 Luna',
  ])('%s → no effort', (name) => {
    expect(parseAaEffort(name)).toBeUndefined();
  });

  it('does not read a level out of a model name', () => {
    // "Max" is part of this model's name, not a parenthetical level.
    expect(parseAaEffort('Qwen3.8 Max')).toBeUndefined();
  });
});

describe('aaEffortSuffix', () => {
  it('maps none to the slug spelling', () => {
    expect(aaEffortSuffix('none')).toBe('non-reasoning');
    expect(aaEffortSuffix('xhigh')).toBe('xhigh');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/effort.test.ts`
Expected: FAIL — `Cannot find module '../src/effort.js'`

- [ ] **Step 3: Write the module**

```ts
// src/effort.ts
/**
 * Reasoning-effort levels, and the candidate grammar that carries one.
 *
 * This module has no imports on purpose: `config.ts` needs the grammar to
 * validate a tier list and `catalog.ts` needs the enum to group AA rows, and
 * neither may import the other.
 *
 * The enum is the wire vocabulary — LiteLLM's `reasoning_effort` set plus
 * `max`, which AA publishes and OpenAI accepts — rather than a per-vendor
 * table. Which levels a *given model* has is answered by the catalog, never
 * here.
 */
export const EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export function isEffort(value: string): value is Effort {
  return (EFFORT_LEVELS as readonly string[]).includes(value);
}

/**
 * `<key>@<effort>` → its parts. Split on the *last* `@`: a model key is
 * `<harness>-<provider>-<model>` with slashes flattened to dashes, so `@`
 * never appears inside one today, and the last-`@` rule keeps that true if
 * one ever does.
 */
export function splitCandidate(candidate: string): { key: string; effort?: Effort } {
  const at = candidate.lastIndexOf('@');
  if (at < 0) return { key: candidate };
  const key = candidate.slice(0, at);
  const level = candidate.slice(at + 1);
  if (level === '') {
    throw new Error(`"${candidate}": an effort level follows "@" — one of ${EFFORT_LEVELS.join(', ')}`);
  }
  if (!isEffort(level)) {
    throw new Error(`"${candidate}": unknown effort level "${level}" — one of ${EFFORT_LEVELS.join(', ')}`);
  }
  return { key, effort: level };
}

export function joinCandidate(key: string, effort?: Effort): string {
  return effort === undefined ? key : `${key}@${effort}`;
}

/**
 * The level an Artificial Analysis row was evaluated at, read from the
 * trailing parenthetical of its display name: `GPT-5.6 Luna (max)`,
 * `DeepSeek V4 Pro (Reasoning, High Effort)`, `GPT-5.2 (Non-Reasoning)`.
 *
 * Only a token from the enum is read as a level; everything else AA puts in
 * that position — a date (`Dec '24`), `Preview`, `Vision`, `32B`, a bare
 * `Reasoning` — yields no effort. `Non-reasoning` is checked first because
 * Anthropic rows spell thinking-off as `Non-reasoning, High Effort`, where
 * the level word describes something sonata cannot set on a foreign model.
 */
export function parseAaEffort(name: string): Effort | undefined {
  const match = /\(([^)]*)\)\s*$/.exec(name);
  if (match === null) return undefined;
  const label = match[1].toLowerCase();
  if (/\bnon-reasoning\b/.test(label)) return 'none';
  const level = /\b(minimal|low|medium|high|xhigh|max)\b/.exec(label);
  return level === null ? undefined : (level[1] as Effort);
}

/** How the level is spelled at the end of an AA slug (`…-non-reasoning`). */
export function aaEffortSuffix(effort: Effort): string {
  return effort === 'none' ? 'non-reasoning' : effort;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- tests/effort.test.ts`
Expected: PASS (all)

- [ ] **Step 5: Commit**

```bash
git add src/effort.ts tests/effort.test.ts
git commit -m "feat(effort): the effort enum and the <key>@<effort> candidate grammar"
```

---

### Task 2: `sonata catalog update` records family and effort per row

**Files:**
- Create: `tests/fixtures/aa/effort-family.json`
- Modify: `src/catalog.ts` (`AaEntry`, `loadAaCatalog`)
- Modify: `src/commands/catalog.ts` (`modelName` → `modelIdentity`, the write loop)
- Test: `tests/commands/catalog.test.ts`, `tests/catalog.test.ts`

**Interfaces:**
- Consumes: `parseAaEffort`, `aaEffortSuffix`, `isEffort` from Task 1.
- Produces: `AaEntry` gains `family?: string; effort?: Effort` — both present only on rows whose name carried a level. `loadAaCatalog` drops an `effort` field that is not a known level (keeps the entry).

- [ ] **Step 1: Write the synthetic fixture**

```json
{
  "tier": "free",
  "intelligence_index_version": 4.1,
  "pagination": {"page": 1, "page_size": 200, "total_pages": 1, "has_more": false},
  "data": [
    {
      "name": "Acme Sprinter (max)",
      "slug": "acme/sprinter",
      "evaluations": {"artificial_analysis_coding_index": 70, "artificial_analysis_agentic_index": 42},
      "artificial_analysis_intelligence_index_cost": {"cost_per_task": {"total_cost": 0.18}},
      "pricing": {"price_1m_input_tokens": 0.3, "price_1m_output_tokens": 0.9}
    },
    {
      "name": "Acme Sprinter (high)",
      "slug": "acme/sprinter-high",
      "evaluations": {"artificial_analysis_coding_index": 60, "artificial_analysis_agentic_index": 35},
      "artificial_analysis_intelligence_index_cost": {"cost_per_task": {"total_cost": 0.044}},
      "pricing": {"price_1m_input_tokens": 0.3, "price_1m_output_tokens": 0.9}
    },
    {
      "name": "Acme Sprinter (low)",
      "slug": "acme/sprinter-low",
      "evaluations": {"artificial_analysis_coding_index": 40, "artificial_analysis_agentic_index": 18},
      "artificial_analysis_intelligence_index_cost": {"cost_per_task": {"total_cost": 0.01}},
      "pricing": {"price_1m_input_tokens": 0.3, "price_1m_output_tokens": 0.9}
    },
    {
      "name": "Acme Sprinter (Non-reasoning)",
      "slug": "acme/sprinter-non-reasoning",
      "evaluations": {"artificial_analysis_coding_index": 30, "artificial_analysis_agentic_index": 15},
      "pricing": {"price_1m_input_tokens": 0.3, "price_1m_output_tokens": 0.9}
    },
    {
      "name": "Acme Heavy (Reasoning, Max Effort)",
      "slug": "acme/heavy-0424",
      "evaluations": {"artificial_analysis_coding_index": 80, "artificial_analysis_agentic_index": 44},
      "artificial_analysis_intelligence_index_cost": {"cost_per_task": {"total_cost": 1.4}},
      "pricing": {"price_1m_input_tokens": 2, "price_1m_output_tokens": 8}
    },
    {
      "name": "Acme Heavy (Reasoning, High Effort)",
      "slug": "acme/heavy-0424-high",
      "evaluations": {"artificial_analysis_coding_index": 72, "artificial_analysis_agentic_index": 38},
      "artificial_analysis_intelligence_index_cost": {"cost_per_task": {"total_cost": 0.34}},
      "pricing": {"price_1m_input_tokens": 2, "price_1m_output_tokens": 8}
    },
    {
      "name": "Acme Plodder (Dec '24)",
      "slug": "acme/plodder",
      "evaluations": {"artificial_analysis_coding_index": 20},
      "pricing": {"price_1m_input_tokens": 0.1, "price_1m_output_tokens": 0.2}
    }
  ]
}
```

- [ ] **Step 2: Write the failing tests**

Append to `tests/commands/catalog.test.ts` (inside the file, after the existing `describe('cmdCatalogUpdate', …)` block; reuse its `home`, `cmdAuthAdd`, `response`/`isModelsDev` helpers exactly as the existing tests do — read the top of the file for their names):

```ts
const familyFixture = () => JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/aa/effort-family.json'), 'utf8'));

describe('cmdCatalogUpdate — effort variants', () => {
  it('records the family and effort of every row whose name carries a level', async () => {
    cmdAuthAdd({ home, gateway: 'artificialanalysis', key: 'synthetic-key' });
    await cmdCatalogUpdate(home, {
      fetch: async (input, init) => isModelsDev(input) ? response({}, 503) : response(familyFixture()),
    });
    const models = JSON.parse(readFileSync(aaCatalogPath(home), 'utf8')).models;
    // The default row: no suffix in the slug, level from the name.
    expect(models['sprinter']).toMatchObject({ family: 'sprinter', effort: 'max' });
    expect(models['sprinter-high']).toMatchObject({ family: 'sprinter', effort: 'high' });
    expect(models['sprinter-low']).toMatchObject({ family: 'sprinter', effort: 'low' });
    expect(models['sprinter-non-reasoning']).toMatchObject({ family: 'sprinter', effort: 'none' });
    // The suffix is removed from the slug *before* normalization, so the
    // trailing date is still trailing when normalizeModelName looks for it.
    expect(models['heavy']).toMatchObject({ family: 'heavy', effort: 'max' });
    expect(models['heavy-0424-high']).toMatchObject({ family: 'heavy', effort: 'high' });
    // A parenthetical that is not a level records nothing.
    expect(models['plodder']).not.toHaveProperty('family');
    expect(models['plodder']).not.toHaveProperty('effort');
  });
});
```

Append to `tests/catalog.test.ts` inside `describe('loadAaCatalog', …)` (use the same tmp-home pattern the neighbouring tests use):

```ts
  it('keeps family and effort, and drops an effort that is not a known level', () => {
    const home = mkdtempSync(join(tmpdir(), 'sonata-aa-'));
    const path = aaCatalogPath(home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      fetchedAt: '2026-09-13T00:00:00Z',
      models: {
        'sprinter': { codingIndex: 70, blendedPriceUsd: 0.45, family: 'sprinter', effort: 'max' },
        'sprinter-turbo': { codingIndex: 10, blendedPriceUsd: 0.45, family: 'sprinter', effort: 'turbo' },
      },
    }));
    const aa = loadAaCatalog(home)!;
    expect(aa.models['sprinter']).toMatchObject({ family: 'sprinter', effort: 'max' });
    expect(aa.models['sprinter-turbo']).toEqual({ codingIndex: 10, blendedPriceUsd: 0.45, family: 'sprinter' });
  });
```

(Add `aaCatalogPath` to that file's import from `../src/catalog.js` if it is not already imported.)

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -- tests/commands/catalog.test.ts tests/catalog.test.ts`
Expected: FAIL — `family`/`effort` absent from written entries; the unknown-level entry keeps `effort: 'turbo'`.

- [ ] **Step 4: Extend `AaEntry` and `loadAaCatalog` in `src/catalog.ts`**

Add the import at the top of `src/catalog.ts`:

```ts
import { isEffort, type Effort } from './effort.js';
```

Add to `AaEntry` after `costPerTask?: number;`:

```ts
  /**
   * The model this row is one effort level of, and which level. Read from
   * the parenthetical in AA's display name at `catalog update` — `GPT-5.6
   * Luna (max)` is slug `gpt-5-6-luna`, `… (low)` is `gpt-5-6-luna-low` —
   * so the unsuffixed default row is a member of its family too, and the
   * family knows which level its default is. Absent on a row whose name
   * carries no level, and on every row of a cache written before this was
   * recorded, which is the "cannot check" state `loadConfig` skips on.
   */
  family?: string;
  effort?: Effort;
```

In `loadAaCatalog`, inside the `for` loop, replace `models[name] = entry;` with:

```ts
        // An unknown level is a hand-edit or a foreign writer; the score is
        // still good, so keep the row and drop only the field.
        const { effort, ...rest } = entry as AaEntry;
        models[name] = effort !== undefined && isEffort(effort) ? { ...rest, effort } : rest;
```

and change the local type to `const models: Record<string, AaEntry> = {};`.

- [ ] **Step 5: Record family and effort in `src/commands/catalog.ts`**

Add the import:

```ts
import { parseAaEffort, aaEffortSuffix, type Effort } from '../effort.js';
```

Replace `modelName` with:

```ts
/**
 * The cache key for a row, plus which effort family it belongs to.
 *
 * The key is the normalized slug, as before. The family is the normalized
 * slug *with the effort suffix removed first*: `deepseek-v4-pro-0424-high`
 * loses `-high` and then `normalizeModelName` finds its trailing `-0424`,
 * so both it and the default row land in `deepseek-v4-pro`. Stripping after
 * normalizing would leave the date in the middle and split the family.
 * The level itself comes from the display name, which is the only place AA
 * states the *default* row's level.
 */
function modelIdentity(entry: Record<string, unknown>): { name: string; family?: string; effort?: Effort } | undefined {
  const slug = typeof entry.slug === 'string' && entry.slug.trim() !== '' ? entry.slug : undefined;
  const display = typeof entry.name === 'string' && entry.name.trim() !== '' ? entry.name : undefined;
  const source = slug ?? display;
  if (source === undefined) return undefined;
  const name = normalizeModelName(source);
  const effort = display === undefined ? undefined : parseAaEffort(display);
  if (effort === undefined) return { name };
  const suffix = `-${aaEffortSuffix(effort)}`;
  const base = source.endsWith(suffix) ? source.slice(0, -suffix.length) : source;
  return { name, family: normalizeModelName(base), effort };
}
```

In `updateAaCatalog`'s loop replace `const name = modelName(value);` with `const identity = modelIdentity(value);` and `const name = identity?.name;`, and extend the written entry:

```ts
    models[name] = {
      codingIndex: codingIndex ?? capability,
      blendedPriceUsd: blendedPriceUsd ?? price,
      ...(intelligenceIndex === undefined ? {} : { intelligenceIndex }),
      ...(agenticIndex === undefined ? {} : { agenticIndex }),
      ...(costPerTask === undefined ? {} : { costPerTask }),
      ...(identity?.family === undefined ? {} : { family: identity.family, effort: identity.effort }),
    };
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -- tests/commands/catalog.test.ts tests/catalog.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/catalog.ts src/commands/catalog.ts tests/fixtures/aa/effort-family.json tests/commands/catalog.test.ts tests/catalog.test.ts
git commit -m "feat(catalog): record each AA row's effort family and level"
```

---

### Task 3: Families, effort-aware lookup, and candidate expansion

**Files:**
- Modify: `src/catalog.ts`
- Test: `tests/catalog.test.ts`

**Interfaces:**
- Consumes: `splitCandidate`, `joinCandidate`, `EFFORT_LEVELS`, `Effort` from Task 1; `AaEntry.family/effort` from Task 2.
- Produces (all exported from `src/catalog.ts`):
  - `interface CatalogFamily { name: string; default?: Effort; variants: Map<Effort, AaEntry> }`
  - `catalogFamily(normalized: string, aa?: AaCatalog): CatalogFamily | undefined` — `undefined` unless ≥ 2 variants
  - `expandCandidates(keys: readonly string[], aa?: AaCatalog, providers?: readonly string[]): string[]`
  - `hasEffortVariants(key: string, aa?: AaCatalog, providers?: readonly string[]): boolean`
  - `unpinnedVariants(saved: readonly string[] | undefined, aa?: AaCatalog, providers?: readonly string[]): string[]`
  - `candidateLabel(candidate: string, aa?: AaCatalog, providers?: readonly string[]): string`
  - `scoreFor`, `lookupModel`, `catalogCoverage` accept a candidate string (bare or `@effort`)

- [ ] **Step 1: Write the failing tests**

Append to `tests/catalog.test.ts`:

```ts
import {
  catalogFamily, expandCandidates, hasEffortVariants, unpinnedVariants, candidateLabel,
} from '../src/catalog.js';

const FAMILY_AA: AaCatalog = {
  fetchedAt: '2026-09-13T00:00:00Z',
  models: {
    'gpt-5-6-luna': { codingIndex: 71, blendedPriceUsd: 0.45, agenticIndex: 42.7, costPerTask: 0.178, family: 'gpt-5-6-luna', effort: 'max' },
    'gpt-5-6-luna-xhigh': { codingIndex: 68, blendedPriceUsd: 0.45, agenticIndex: 39.5, costPerTask: 0.085, family: 'gpt-5-6-luna', effort: 'xhigh' },
    'gpt-5-6-luna-high': { codingIndex: 60, blendedPriceUsd: 0.45, agenticIndex: 35.6, costPerTask: 0.044, family: 'gpt-5-6-luna', effort: 'high' },
    'gpt-5-6-luna-low': { codingIndex: 44, blendedPriceUsd: 0.45, agenticIndex: 17.9, costPerTask: 0.0098, family: 'gpt-5-6-luna', effort: 'low' },
    'gpt-5-6-terra': { codingIndex: 78, blendedPriceUsd: 4.5, agenticIndex: 43.7, costPerTask: 1.399, family: 'gpt-5-6-terra', effort: 'max' },
    'gpt-5-6-terra-high': { codingIndex: 70, blendedPriceUsd: 4.5, agenticIndex: 37.6, costPerTask: 0.338, family: 'gpt-5-6-terra', effort: 'high' },
    'deepseek-v4-flash': { codingIndex: 65, blendedPriceUsd: 0.66, agenticIndex: 41.7, costPerTask: 0.22 },
    // A family of one: AA scored it at one level and named it. Not variants.
    'lonely': { codingIndex: 50, blendedPriceUsd: 1, family: 'lonely', effort: 'high' },
  },
};

describe('catalogFamily', () => {
  it('groups rows by family and knows the default level', () => {
    const fam = catalogFamily('gpt-5.6-luna', FAMILY_AA)!;
    expect(fam.name).toBe('gpt-5-6-luna');
    expect(fam.default).toBe('max');
    expect([...fam.variants.keys()]).toEqual(['low', 'high', 'xhigh', 'max']);
    expect(fam.variants.get('high')?.costPerTask).toBe(0.044);
  });
  it('is undefined for a model with fewer than two scored levels', () => {
    expect(catalogFamily('deepseek-v4-flash', FAMILY_AA)).toBeUndefined();
    expect(catalogFamily('lonely', FAMILY_AA)).toBeUndefined();
    expect(catalogFamily('gpt-5.6-luna', undefined)).toBeUndefined();
  });
  it('finds a family through the same spellings a score is found through', () => {
    // An OpenRouter-flattened ref still reaches its family.
    expect(catalogFamily('openai-gpt-5.6-luna', FAMILY_AA)?.name).toBe('gpt-5-6-luna');
  });
});

describe('expandCandidates', () => {
  it('expands a key with variants into one candidate per level, weakest first', () => {
    expect(expandCandidates(['gpt-5.6-luna', 'deepseek-v4-flash'], FAMILY_AA)).toEqual([
      'gpt-5.6-luna@low', 'gpt-5.6-luna@high', 'gpt-5.6-luna@xhigh', 'gpt-5.6-luna@max',
      'deepseek-v4-flash',
    ]);
  });
  it('is the identity without a catalog', () => {
    expect(expandCandidates(['gpt-5.6-luna'], undefined)).toEqual(['gpt-5.6-luna']);
  });
  it('leaves an already-pinned candidate alone', () => {
    expect(expandCandidates(['gpt-5.6-luna@high'], FAMILY_AA)).toEqual(['gpt-5.6-luna@high']);
  });
  it('recovers the id through configured gateway names', () => {
    expect(hasEffortVariants('codex-gpt-5.6-luna', FAMILY_AA, ['codex'])).toBe(true);
    expect(hasEffortVariants('deepseek-v4-flash', FAMILY_AA)).toBe(false);
  });
});

describe('unpinnedVariants', () => {
  it('expands only the bare saved keys that have variants', () => {
    expect(unpinnedVariants(['gpt-5.6-luna', 'deepseek-v4-flash', 'gpt-5.6-terra@high'], FAMILY_AA)).toEqual([
      'gpt-5.6-luna@low', 'gpt-5.6-luna@high', 'gpt-5.6-luna@xhigh', 'gpt-5.6-luna@max',
    ]);
    expect(unpinnedVariants(undefined, FAMILY_AA)).toEqual([]);
  });
});

describe('lookupModel / scoreFor with an effort', () => {
  it('scores a candidate at its own level', () => {
    expect(lookupModel('gpt-5.6-luna@low', FAMILY_AA)).toEqual({ capable: true, cheap: true, source: 'aa' });
    // 44 ≥ 40 keeps it capable; the bare row is the max row.
    expect(lookupModel('gpt-5.6-luna', FAMILY_AA).source).toBe('aa');
  });
  it('treats an effort on a model with no family as unscored', () => {
    // `lonely` is scored at one level only, so `@high` finds no family — and
    // it is not in the curated table, so it falls through to the default.
    expect(lookupModel('lonely@high', FAMILY_AA).source).toBe('default');
  });
});

describe('candidateLabel', () => {
  it('shows the level, the capability and the per-task cost', () => {
    expect(candidateLabel('gpt-5.6-luna@xhigh', FAMILY_AA)).toMatch(/^gpt-5\.6-luna @xhigh\s+39\.5\s+\$0\.085\/task$/);
    expect(candidateLabel('deepseek-v4-flash', FAMILY_AA)).toMatch(/^deepseek-v4-flash\s+41\.7\s+\$0\.220\/task$/);
  });
  it('aligns the numbers across rows', () => {
    const a = candidateLabel('gpt-5.6-luna@xhigh', FAMILY_AA);
    const b = candidateLabel('deepseek-v4-flash', FAMILY_AA);
    expect(a.indexOf('39.5')).toBe(b.indexOf('41.7'));
  });
  it('falls back to the per-1M rate, and to the bare key with no catalog', () => {
    expect(candidateLabel('lonely', FAMILY_AA)).toMatch(/^lonely\s+50\.0\s+\$1\.00\/1M$/);
    expect(candidateLabel('gpt-5.6-luna@max', undefined)).toBe('gpt-5.6-luna @max');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/catalog.test.ts`
Expected: FAIL — the new exports do not exist.

- [ ] **Step 3: Implement in `src/catalog.ts`**

Extend the import from `./effort.js`:

```ts
import { EFFORT_LEVELS, isEffort, joinCandidate, splitCandidate, type Effort } from './effort.js';
```

Below `aaEntryFor` add the family index and lookup:

```ts
export interface CatalogFamily {
  /** The family's catalog name (the default row's key). */
  name: string;
  /** The level AA evaluated the unsuffixed row at — absent if every row is suffixed. */
  default?: Effort;
  /** Every scored level, in `EFFORT_LEVELS` order. */
  variants: Map<Effort, AaEntry>;
}

/**
 * Rows grouped by family, built once per catalog object. A `WeakMap` keyed on
 * the catalog rather than a field on it, so a cache loaded from disk and a
 * catalog literal in a test are indexed the same way and neither is mutated.
 */
const familyIndex = new WeakMap<AaCatalog, Map<string, CatalogFamily>>();

function familiesOf(aa: AaCatalog): Map<string, CatalogFamily> {
  let index = familyIndex.get(aa);
  if (index !== undefined) return index;
  index = new Map();
  for (const [key, entry] of Object.entries(aa.models)) {
    if (entry.family === undefined || entry.effort === undefined) continue;
    let fam = index.get(entry.family);
    if (fam === undefined) {
      fam = { name: entry.family, variants: new Map() };
      index.set(entry.family, fam);
    }
    fam.variants.set(entry.effort, entry);
    if (key === entry.family) fam.default = entry.effort;
  }
  // Order every family's variants weakest-first so callers can rely on it.
  for (const fam of index.values()) {
    const ordered = new Map<Effort, AaEntry>();
    for (const level of EFFORT_LEVELS) {
      const entry = fam.variants.get(level);
      if (entry !== undefined) ordered.set(level, entry);
    }
    fam.variants = ordered;
  }
  familyIndex.set(aa, index);
  return index;
}

/**
 * The effort family a normalized model name belongs to, if the catalog scores
 * it at two or more levels. One scored level is a model, not a choice.
 *
 * Resolved through the same spellings `aaEntryFor` tries, so a name that finds
 * its score also finds its family.
 */
export function catalogFamily(normalized: string, aa?: AaCatalog): CatalogFamily | undefined {
  if (aa === undefined) return undefined;
  const families = familiesOf(aa);
  for (const name of aaLookupNames(normalized)) {
    for (const spelling of [name, aaMatchKey(name)]) {
      const entry = aa.models[spelling];
      const fam = entry?.family !== undefined ? families.get(entry.family) : families.get(spelling);
      if (fam !== undefined && fam.variants.size >= 2) return fam;
    }
  }
  return undefined;
}
```

Change `aaEntryFor` to take an optional effort:

```ts
/** The AA row for a normalized name, trying each spelling it may be filed
 *  under. With an effort, the family's row at that level — and nothing else:
 *  a level on a model the catalog does not score by level is unscored, never
 *  silently the bare row. */
function aaEntryFor(normalized: string, aa?: AaCatalog, effort?: Effort): AaEntry | undefined {
  if (aa === undefined) return undefined;
  if (effort !== undefined) return catalogFamily(normalized, aa)?.variants.get(effort);
  for (const name of aaLookupNames(normalized)) {
    const hit = aa.models[name] ?? aa.models[aaMatchKey(name)];
    if (hit !== undefined) return hit;
  }
  return undefined;
}
```

Change `lookupModel` and `scoreFor` to split a candidate:

```ts
export function lookupModel(name: string, aa?: AaCatalog, providers: readonly string[] = []): CatalogEntry {
  const { key, effort } = splitCandidate(name);
  const normalized = normalizeModelName(key, providers);
  const scored = aaEntryFor(normalized, aa, effort);
  if (scored !== undefined) {
    return {
      capable: scored.codingIndex >= AA_CAPABLE_CODING_INDEX,
      cheap: scored.blendedPriceUsd <= AA_CHEAP_BLENDED_PRICE_USD,
      source: 'aa',
    };
  }
  // A curated judgement is about the model, whichever level it runs at.
  const curated = CURATED[normalized];
  if (curated !== undefined) return { ...curated, source: 'curated' };
  return { capable: true, cheap: false, source: 'default' };
}

/** The AA row behind a candidate (`key` or `key@effort`), joined through the match key. */
function scoreFor(candidate: string, aa?: AaCatalog, providers: readonly string[] = []): AaEntry | undefined {
  const { key, effort } = splitCandidate(candidate);
  return aaEntryFor(normalizeModelName(key, providers), aa, effort);
}
```

Below `scoreFor` add the expansion helpers and the label:

```ts
/**
 * Each key as the candidates a ranking may choose between: one per scored
 * level for a model the catalog knows by level, the bare key otherwise. A
 * candidate that already names a level is passed through — the caller has
 * decided. Identity without a catalog, which is what keeps every existing
 * caller's behaviour unchanged until a catalog with families is present.
 */
export function expandCandidates(
  keys: readonly string[],
  aa?: AaCatalog,
  providers: readonly string[] = [],
): string[] {
  return keys.flatMap((candidate) => {
    const { key, effort } = splitCandidate(candidate);
    if (effort !== undefined) return [candidate];
    const fam = catalogFamily(normalizeModelName(key, providers), aa);
    return fam === undefined ? [candidate] : [...fam.variants.keys()].map((level) => joinCandidate(key, level));
  });
}

export function hasEffortVariants(key: string, aa?: AaCatalog, providers: readonly string[] = []): boolean {
  return expandCandidates([key], aa, providers).length > 1;
}

/**
 * The variants of every *bare* saved candidate whose model has effort levels.
 *
 * A config written before effort existed, or a legacy migration, holds bare
 * keys; once a catalog with families is present those keys are refused at
 * load, so the wizard must re-propose them rather than drop them. They are
 * handed to `reconcileTierList` as `added`, which inserts each at the rank
 * the proposal gives it — the same treatment as a model selected for the
 * first time, which is what a never-ranked level is.
 */
export function unpinnedVariants(
  saved: readonly string[] | undefined,
  aa?: AaCatalog,
  providers: readonly string[] = [],
): string[] {
  return (saved ?? []).flatMap((candidate) => {
    const { effort } = splitCandidate(candidate);
    if (effort !== undefined) return [];
    const expanded = expandCandidates([candidate], aa, providers);
    return expanded.length > 1 ? expanded : [];
  });
}

/**
 * A ranking row: `<key> @<effort>`, then the capability and the cost the
 * ranking actually sorts on, so a user comparing two rows sees the numbers
 * that ordered them. Per-task cost where AA costed the model, else the
 * per-1M blend — labelled, because the two are different units.
 */
export function candidateLabel(candidate: string, aa?: AaCatalog, providers: readonly string[] = []): string {
  const { key, effort } = splitCandidate(candidate);
  const head = effort === undefined ? key : `${key} @${effort}`;
  const entry = scoreFor(candidate, aa, providers);
  if (entry === undefined) return head;
  const cost = entry.costPerTask !== undefined
    ? `$${entry.costPerTask.toFixed(3)}/task`
    : `$${entry.blendedPriceUsd.toFixed(2)}/1M`;
  return `${head.padEnd(32)} ${capabilityOf(entry).toFixed(1).padStart(4)}  ${cost}`;
}
```

`catalogCoverage` already routes through `scoreFor`, so it accepts a candidate string with no change.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- tests/catalog.test.ts tests/effort.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/catalog.ts tests/catalog.test.ts
git commit -m "feat(catalog): effort families, effort-aware scoring, and candidate expansion"
```

---

### Task 4: `proposeTiers` ranks effort variants

**Files:**
- Modify: `src/catalog.ts` (`proposeTiers`, `rank`)
- Test: `tests/catalog.test.ts`

**Interfaces:**
- Consumes: `expandCandidates`, `splitCandidate`.
- Produces: `proposeTiers(modelKeys, aa, providers, avoided)` returns candidate strings; `avoided` still holds **bare keys**.

- [ ] **Step 1: Write the failing tests**

Append to `tests/catalog.test.ts` (reuse `FAMILY_AA` from Task 3):

```ts
describe('proposeTiers — effort variants', () => {
  it('ranks variants as candidates: complex by capability, simple by value above the floor', () => {
    const tiers = proposeTiers(['gpt-5.6-luna', 'gpt-5.6-terra', 'deepseek-v4-flash'], FAMILY_AA);
    // terra@max 43.7 edges luna@max 42.7 — within the 1.0 tie margin, so
    // price decides: luna@max ($0.178) beats terra@max ($1.399).
    expect(tiers.complex.slice(0, 3)).toEqual(['gpt-5.6-luna@max', 'gpt-5.6-terra@max', 'deepseek-v4-flash']);
    // Floor = 0.75 × 43.7 = 32.8: luna@high (35.6) clears it and leads on
    // value; luna@low (17.9) does not, whatever its cost.
    expect(tiers.simple[0]).toBe('gpt-5.6-luna@high');
    expect(tiers.simple).not.toContain('gpt-5.6-luna@low');
    expect(tiers.simple).toContain('gpt-5.6-luna@xhigh');
  });

  it('demotes every variant of an avoided model, by bare key', () => {
    const tiers = proposeTiers(['gpt-5.6-luna', 'deepseek-v4-flash'], FAMILY_AA, [], new Set(['gpt-5.6-luna']));
    expect(tiers.complex[0]).toBe('deepseek-v4-flash');
    expect(tiers.simple[0]).toBe('deepseek-v4-flash');
  });

  it('is unchanged for a catalog without families', () => {
    const aa: AaCatalog = {
      fetchedAt: '2026-08-25T00:00:00Z',
      models: {
        'cheap-and-good': { codingIndex: 58, blendedPriceUsd: 1, agenticIndex: 58, costPerTask: 0.09 },
        'top-and-dear': { codingIndex: 60, blendedPriceUsd: 1, agenticIndex: 60, costPerTask: 0.95 },
      },
    };
    expect(proposeTiers(['top-and-dear', 'cheap-and-good'], aa)).toEqual({
      complex: ['top-and-dear', 'cheap-and-good'],
      simple: ['cheap-and-good', 'top-and-dear'],
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/catalog.test.ts -t "effort variants"`
Expected: FAIL — `complex[0]` is `'gpt-5.6-luna'` (bare), no `@` candidates.

- [ ] **Step 3: Expand inside `proposeTiers`**

At the top of `proposeTiers`, before `const rankOf = …`, add:

```ts
  // Rank over every scored level of every selected model. A model AA scores
  // at several efforts is several candidates here — luna@high and luna@max
  // are different capability/cost points, and which one a tier wants is the
  // whole question. Identity without families, so a catalog-less run (and
  // every existing caller) sees exactly the keys it passed.
  const candidates = expandCandidates(modelKeys, aa, providers);
  const bareKey = (candidate: string): string => splitCandidate(candidate).key;
```

Then replace every later use of `modelKeys` in the function body with `candidates`, and make avoidance key on the bare key:

```ts
  const avoidance = (a: string, b: string) => Number(avoided.has(bareKey(a))) - Number(avoided.has(bareKey(b)));
  …
  const preferred = candidates.filter((k) => !avoided.has(bareKey(k)));
  const leaders = preferred.length > 0 ? preferred : candidates;
```

(`complex`, `simple`, `complexFinal` and `simpleFinal` all read `candidates` now; `rankOf`, `perTask`, `eligible`, `isCheap` already go through `scoreFor`/`lookupModel`, which split.)

- [ ] **Step 4: Run the whole catalog suite**

Run: `npm test -- tests/catalog.test.ts && npm run typecheck`
Expected: PASS — every pre-existing `proposeTiers` test still passes (their catalogs have no families).

- [ ] **Step 5: Commit**

```bash
git add src/catalog.ts tests/catalog.test.ts
git commit -m "feat(catalog): proposeTiers ranks effort variants as candidates"
```

---

### Task 5: Config grammar, `TierRoute.effort`, and the two writers

**Files:**
- Modify: `src/config.ts` (`parseConfig` tier validation, `TierRoute`, `resolveTierAlias`)
- Modify: `src/extended-context.ts` (`tierQualifiesForExtendedContext`)
- Test: `tests/config.test.ts`, `tests/init/toml.test.ts`, `tests/commands/replace-tiers.test.ts`, `tests/extended-context.test.ts`

**Interfaces:**
- Consumes: `splitCandidate` from Task 1.
- Produces: `TierRoute.effort?: Effort`; `config.tiers[role].simple` still holds the raw candidate strings (`key@effort`), so `tiersCollapse` compares `(key, effort)` for free.

- [ ] **Step 1: Write the failing tests**

Append to `tests/config.test.ts` inside `describe('unified [models] and [tiers]', …)`:

```ts
  it('accepts <key>@<effort> and exposes the level on the resolved route', () => {
    const config = parseConfig(TIERED.replace(
      'complex = ["gpt-5.6-terra", "deepseek-v4-flash"]',
      'complex = ["gpt-5.6-terra@xhigh", "deepseek-v4-flash", "gpt-5.6-terra@high"]',
    ));
    expect(config.tiers?.code.complex).toEqual(['gpt-5.6-terra@xhigh', 'deepseek-v4-flash', 'gpt-5.6-terra@high']);
    const routes = resolveTierAlias(config, 'sonata-code-complex')!.routes;
    expect(routes.map((r) => [r.key, r.effort])).toEqual([
      ['gpt-5.6-terra', 'xhigh'], ['deepseek-v4-flash', undefined], ['gpt-5.6-terra', 'high'],
    ]);
    // The route resolves the bare key, so the model's native half is found.
    expect(routes[0].native).toMatchObject({ gateway: 'openai', id: 'gpt-5.6-terra' });
  });

  it('refuses an unknown or empty effort level, naming the list', () => {
    expect(() => parseConfig(TIERED.replace('simple = ["deepseek-v4-flash"]', 'simple = ["deepseek-v4-flash@turbo"]')))
      .toThrow(/tiers\.code\.simple.*"turbo"/);
    expect(() => parseConfig(TIERED.replace('simple = ["deepseek-v4-flash"]', 'simple = ["deepseek-v4-flash@"]')))
      .toThrow(/tiers\.code\.simple/);
  });

  it('still refuses a level on a key that names no model', () => {
    expect(() => parseConfig(TIERED.replace('simple = ["deepseek-v4-flash"]', 'simple = ["ghost@high"]')))
      .toThrow(/unknown model "ghost"/);
  });

  it('does not collapse a role whose tiers differ only by effort', () => {
    const config = parseConfig(TIERED.replace(
      'complex = ["deepseek-v4-flash"]\n', 'complex = ["deepseek-v4-flash@high"]\n',
    ));
    expect(resolveTierAlias(config, 'sonata-explore')).toBeUndefined();
    expect(resolveTierAlias(config, 'sonata-explore-complex')!.routes[0].effort).toBe('high');
  });
```

(Add `resolveTierAlias` to that file's import from `../src/config.js` if absent.)

Append to `tests/init/toml.test.ts` inside `describe('nativeTomlFor', …)`:

```ts
  it('writes an effort-pinned tier candidate back verbatim', () => {
    const c = cand('acme', 'sprinter');
    const out = nativeTomlFor({ code: [c] }, {}, { code: { simple: ['acme-sprinter@high'], complex: ['acme-sprinter@max', 'acme-sprinter@high'] } });
    const cfg = parseConfig(out);
    expect(cfg.tiers?.code.simple).toEqual(['acme-sprinter@high']);
    expect(cfg.tiers?.code.complex).toEqual(['acme-sprinter@max', 'acme-sprinter@high']);
  });
```

(Check `nativeTomlFor`'s parameter order at `src/init/toml.ts:55-70` — `roleModels, credentialSources, selectedTiers, …` — and match it.)

Append to `tests/commands/replace-tiers.test.ts` inside `describe('replaceTiersBlock', …)` (the file's `config` constant is a `[tiers]`-bearing TOML string; read its keys and use one):

```ts
  it('writes effort-pinned candidates and they parse back', () => {
    const out = replaceTiersBlock(config, { code: { simple: ['acme-small@low'], complex: ['acme-big@max'] } });
    const cfg = parseConfig(out);
    expect(cfg.tiers?.code).toEqual({ simple: ['acme-small@low'], complex: ['acme-big@max'] });
  });
```

(Substitute the model keys the file's `config` actually defines.)

Append to `tests/extended-context.test.ts` a case for the bare-key lookup, using whatever config-building helper the file already has:

```ts
  it('resolves an effort-pinned candidate to its model', () => {
    // Build a config whose `big` model has a 1M window, then:
    expect(tierQualifiesForExtendedContext(config, ['big@xhigh'])).toBe(true);
    expect(tierQualifiesForExtendedContext(config, ['ghost@xhigh'])).toBe(false);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/config.test.ts tests/init/toml.test.ts tests/commands/replace-tiers.test.ts tests/extended-context.test.ts`
Expected: FAIL — `references unknown model "gpt-5.6-terra@xhigh"`.

- [ ] **Step 3: Validate the grammar in `parseConfig`**

Add to `src/config.ts` imports:

```ts
import { splitCandidate, type Effort } from './effort.js';
```

In the tier validation loop (`for (const key of keys) {` inside `for (const [tier, keys] of …)`), replace the body with:

```ts
        for (const candidate of keys) {
          // `<key>@<effort>`: the level is validated here, the key below.
          let key: string;
          try {
            ({ key } = splitCandidate(candidate));
          } catch (err) {
            throw new Error(`sonata.toml: tiers.${role}.${tier} ${(err as Error).message}`);
          }
          if (isAnthropicRoutedName(key)) {
            throw new Error(
              `sonata.toml: tiers.${role}.${tier} model "${key}" cannot use the ` +
              `"${ANTHROPIC_ROUTED_PREFIX}" prefix because the router routes it to Anthropic.`,
            );
          }
          if (!unifiedModels[key]) {
            throw new Error(
              `sonata.toml: tiers.${role}.${tier} references unknown model "${key}". ` +
              `Define [models."${key}"] first.`,
            );
          }
        }
```

- [ ] **Step 4: Expose the level on `TierRoute`**

```ts
export interface TierRoute {
  key: string;
  /** The reasoning-effort level this candidate is pinned to, if any. */
  effort?: Effort;
  native?: { gateway: string; id: string; transport?: Transport; baseUrl?: string };
  harness?: { harness: string; id: string };
}
```

In `resolveTierAlias`, change the map:

```ts
  const routes = keys.map((candidate): TierRoute => {
    const { key, effort } = splitCandidate(candidate);
    const model = config.unifiedModels[key];
    const gw = model?.gateway !== undefined ? config.native?.gateways?.[model.gateway] : undefined;
    return {
      key,
      ...(effort === undefined ? {} : { effort }),
      native: …unchanged…,
      harness: …unchanged…,
    };
  });
```

- [ ] **Step 5: Look up the bare key in `src/extended-context.ts`**

```ts
import { splitCandidate } from './effort.js';
…
  for (const candidate of keys) {
    const model = config.unifiedModels[splitCandidate(candidate).key];
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -- tests/config.test.ts tests/init/toml.test.ts tests/commands/replace-tiers.test.ts tests/extended-context.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/config.ts src/extended-context.ts tests/config.test.ts tests/init/toml.test.ts tests/commands/replace-tiers.test.ts tests/extended-context.test.ts
git commit -m "feat(config): <key>@<effort> tier candidates, with the level on TierRoute"
```

---

### Task 6: Refuse a bare candidate whose model has variants

**Files:**
- Modify: `src/catalog.ts` (`unpinnedCandidates`, `assertEffortsPinned`)
- Modify: `src/config.ts` (`loadConfig`)
- Modify: `src/native/tenants.ts` (`load`)
- Modify: `src/commands/agents.ts` (`writeTiers`)
- Test: `tests/catalog.test.ts`, `tests/config.test.ts`, `tests/native/tenants.test.ts` (or wherever `TenantRegistry` is tested — `grep -rl TenantRegistry tests`), `tests/commands/agents.test.ts`

**Interfaces:**
- Consumes: `catalogFamily`, `splitCandidate`, `SonataConfig` (type-only import in `catalog.ts`).
- Produces:
  - `unpinnedCandidates(config: Pick<SonataConfig, 'tiers' | 'unifiedModels' | 'native'>, aa?: AaCatalog): Array<{ role: string; tier: 'simple' | 'complex'; key: string; family: CatalogFamily }>`
  - `assertEffortsPinned(config, aa?): void` — throws an `Error` naming every unpinned candidate.

- [ ] **Step 1: Write the failing tests**

Append to `tests/catalog.test.ts`:

```ts
import { unpinnedCandidates, assertEffortsPinned } from '../src/catalog.js';
import { parseConfig } from '../src/config.js';

const PINNABLE = `
[models."luna"]
gateway = "codex"
id = "gpt-5.6-luna"
[models."flash"]
gateway = "deepseek"
id = "deepseek-v4-flash"
[native.gateways."codex"]
auth = "codex-oauth"
[native.gateways."deepseek"]
base_url = "https://api.deepseek.example/v1"
[tiers.code]
simple = ["luna", "flash"]
complex = ["luna@max", "flash"]
`;

describe('unpinnedCandidates / assertEffortsPinned', () => {
  it('names a bare candidate whose model the catalog scores at several levels', () => {
    const config = parseConfig(PINNABLE);
    const found = unpinnedCandidates(config, FAMILY_AA);
    expect(found.map((u) => [u.role, u.tier, u.key])).toEqual([['code', 'simple', 'luna']]);
    expect(found[0].family.default).toBe('max');
    expect(() => assertEffortsPinned(config, FAMILY_AA)).toThrow(
      /tiers\.code\.simple "luna".*levels low, high, xhigh, max.*default is max.*"luna@max".*sonata init/s,
    );
  });
  it('is silent with no catalog, and for a fully pinned config', () => {
    const config = parseConfig(PINNABLE);
    expect(() => assertEffortsPinned(config, undefined)).not.toThrow();
    const pinned = parseConfig(PINNABLE.replace('simple = ["luna", "flash"]', 'simple = ["luna@high", "flash"]'));
    expect(() => assertEffortsPinned(pinned, FAMILY_AA)).not.toThrow();
  });
  it('resolves the upstream id through the gateway name, not the config key', () => {
    // `[models."codex-gpt-5.6-luna"]` with id `gpt-5.6-luna` is the same model.
    const config = parseConfig(PINNABLE.replace(/"luna"/g, '"codex-gpt-5.6-luna"').replace(/"luna@max"/, '"codex-gpt-5.6-luna@max"'));
    expect(unpinnedCandidates(config, FAMILY_AA).map((u) => u.key)).toEqual(['codex-gpt-5.6-luna']);
  });
});
```

Append to `tests/config.test.ts`:

```ts
describe('loadConfig — effort pinning', () => {
  it('refuses a bare candidate with variants when a catalog is cached, and loads without one', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'sonata-cfg-'));
    const home = mkdtempSync(join(tmpdir(), 'sonata-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), [
      '[models."luna"]', 'gateway = "acme"', 'id = "gpt-5.6-luna"',
      '[native.gateways."acme"]', 'base_url = "https://acme.example/v1"',
      '[tiers.code]', 'simple = ["luna"]', 'complex = ["luna"]', '',
    ].join('\n'));
    expect(() => loadConfig(cwd, home)).not.toThrow();
    const catalog = aaCatalogPath(home);
    mkdirSync(dirname(catalog), { recursive: true });
    writeFileSync(catalog, JSON.stringify({
      fetchedAt: '2026-09-13T00:00:00Z',
      models: {
        'gpt-5-6-luna': { codingIndex: 71, blendedPriceUsd: 0.45, family: 'gpt-5-6-luna', effort: 'max' },
        'gpt-5-6-luna-high': { codingIndex: 60, blendedPriceUsd: 0.45, family: 'gpt-5-6-luna', effort: 'high' },
      },
    }));
    expect(() => loadConfig(cwd, home)).toThrow(/tiers\.code\.simple "luna"/);
  });
});
```

(Import `aaCatalogPath` from `../src/catalog.js` and the `node:fs`/`node:os`/`node:path` helpers as the file already does.)

In the `TenantRegistry` test file, add a case mirroring the `loadConfig` one: write the same project config and catalog under the registry's `home`, then `expect(() => registry.resolve({ project: cwd })).toThrow(/tiers\.code\.simple "luna"/)`. Follow the file's existing construction of `TenantRegistry` exactly.

Append to `tests/commands/agents.test.ts` inside `describe('writeTiers', …)`:

```ts
  it('refuses to write a bare candidate whose model has effort variants', () => {
    const catalog = aaCatalogPath(home);
    mkdirSync(dirname(catalog), { recursive: true });
    writeFileSync(catalog, JSON.stringify({
      fetchedAt: '2026-09-13T00:00:00Z',
      models: {
        'big': { codingIndex: 71, blendedPriceUsd: 0.45, family: 'big', effort: 'max' },
        'big-high': { codingIndex: 60, blendedPriceUsd: 0.45, family: 'big', effort: 'high' },
      },
    }));
    const before = readFileSync(join(cwd, 'sonata.toml'), 'utf8');
    expect(() => writeTiers({ cwd, home }, { code: { simple: ['acme-big'], complex: ['acme-big'] }, review: { simple: ['acme-big@high'], complex: ['acme-big@high'] } }))
      .toThrow(/tiers\.code\.simple "acme-big"/);
    expect(readFileSync(join(cwd, 'sonata.toml'), 'utf8')).toBe(before);
  });
```

(Import `aaCatalogPath` from `../../src/catalog.js` and `dirname` from `node:path`.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/catalog.test.ts tests/config.test.ts tests/commands/agents.test.ts`
Expected: FAIL — exports missing; `loadConfig` and `writeTiers` do not throw.

- [ ] **Step 3: Implement the check in `src/catalog.ts`**

Add a type-only import (no runtime cycle — `config.ts` will import `catalog.ts` at runtime, `catalog.ts` imports only the type):

```ts
import type { SonataConfig } from './config.js';
```

Append:

```ts
export interface UnpinnedCandidate {
  role: string;
  tier: 'simple' | 'complex';
  /** The bare config key as written in the tier list. */
  key: string;
  family: CatalogFamily;
}

/**
 * Every bare tier candidate whose model the catalog scores at two or more
 * effort levels. Such a candidate is ranked at the level of the unsuffixed
 * row (the model's default, usually its highest) and dispatched with no level
 * at all, so what the ranking promised and what runs are different models.
 *
 * The upstream id is resolved through `[models]` and normalized with the
 * gateway names, the same way `doctor`'s coverage check does it: a config
 * key is whatever the user named it, and AA files families under the model's
 * own name.
 */
export function unpinnedCandidates(
  config: Pick<SonataConfig, 'tiers' | 'unifiedModels' | 'native'>,
  aa?: AaCatalog,
): UnpinnedCandidate[] {
  if (aa === undefined || config.tiers === undefined) return [];
  const gateways = Object.keys(config.native?.gateways ?? {});
  const out: UnpinnedCandidate[] = [];
  for (const [role, lists] of Object.entries(config.tiers)) {
    for (const tier of ['simple', 'complex'] as const) {
      for (const candidate of lists[tier]) {
        const { key, effort } = splitCandidate(candidate);
        if (effort !== undefined) continue;
        const model = config.unifiedModels[key];
        const upstream = model?.id ?? model?.harnessId ?? key;
        const family = catalogFamily(normalizeModelName(upstream, gateways), aa);
        if (family !== undefined) out.push({ role, tier, key, family });
      }
    }
  }
  return out;
}

/**
 * The refusal `loadConfig`, the router's tenant loader and `sonata agents`
 * all apply. Not `parseConfig`: that is pure text-in/config-out and has no
 * catalog, and a machine with no catalog cache cannot know a family exists —
 * `sonata doctor` says so in that case rather than this silently passing.
 */
export function assertEffortsPinned(
  config: Pick<SonataConfig, 'tiers' | 'unifiedModels' | 'native'>,
  aa?: AaCatalog,
): void {
  const unpinned = unpinnedCandidates(config, aa);
  if (unpinned.length === 0) return;
  const lines = unpinned.map(({ role, tier, key, family }) => {
    const levels = [...family.variants.keys()].join(', ');
    const fallback = family.default ?? [...family.variants.keys()].at(-1)!;
    return `tiers.${role}.${tier} "${key}" names a model the catalog scores at levels ${levels}` +
      ` (its default is ${family.default ?? 'unstated'}) but pins none — it would be ranked at that default` +
      ` and run at the gateway's own. Write "${key}@${fallback}" (or another level).`;
  });
  throw new Error(`sonata.toml: ${lines.join('\n')}\nRun \`sonata init\` to re-rank every tier with effort levels.`);
}
```

- [ ] **Step 4: Call it from the three loaders**

`src/config.ts` — add `import { assertEffortsPinned, loadAaCatalog } from './catalog.js';` and change `loadConfig`:

```ts
export function loadConfig(cwd: string, home: string = homedir()): SonataConfig {
  const path = configPath(cwd, home);
  if (path === null) {
    throw new NoConfigError(…unchanged…);
  }
  const config = parseConfig(readFileSync(path, 'utf8'));
  // Every command that reads the config comes through here, so this is
  // where a config ranked at one effort and dispatched at another is caught
  // — with the catalog that can tell, which `parseConfig` does not have.
  assertEffortsPinned(config, loadAaCatalog(home));
  return config;
}
```

`src/native/tenants.ts` — add `import { assertEffortsPinned, loadAaCatalog } from '../catalog.js';` and:

```ts
  private load(path: string): SonataConfig {
    const config = parseConfig(readFileSync(path, 'utf8'));
    // The router re-reads a tenant per request through this path, not
    // `loadConfig`, so the refusal is repeated here; a config error is already
    // a 400 naming the message, which is exactly the surface it should have.
    assertEffortsPinned(config, loadAaCatalog(this.home));
    return config;
  }
```

`src/commands/agents.ts` — add `import { assertEffortsPinned, loadAaCatalog } from '../catalog.js';` and in `writeTiers` replace `parseConfig(next);` with:

```ts
  // Parsed back *and* checked before it is written: a file that will not
  // load leaves no working config at all.
  assertEffortsPinned(parseConfig(next), loadAaCatalog(opts.home));
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- tests/catalog.test.ts tests/config.test.ts tests/commands/agents.test.ts tests/native && npm run typecheck`
Expected: PASS; typecheck clean. If `typecheck` reports a circular-import problem, confirm `catalog.ts` imports `config.ts` with `import type` only.

- [ ] **Step 6: Commit**

```bash
git add src/catalog.ts src/config.ts src/native/tenants.ts src/commands/agents.ts tests/catalog.test.ts tests/config.test.ts tests/commands/agents.test.ts tests/native
git commit -m "feat(config): refuse a bare tier candidate whose model has effort variants"
```

---

### Task 7: `sonata doctor` — split before coverage, say when effort cannot be checked

**Files:**
- Modify: `src/commands/doctor.ts`
- Test: `tests/commands/doctor.test.ts`

**Interfaces:**
- Consumes: `splitCandidate`.

- [ ] **Step 1: Write the failing tests**

Find the existing `model rankings` tests in `tests/commands/doctor.test.ts` (`grep -n "model rankings" tests/commands/doctor.test.ts`) and add beside them, using the same config/home scaffolding those tests use:

```ts
  it('reports that effort levels cannot be checked when there is no catalog', async () => {
    // Same setup as the existing "no catalog" rankings test.
    const result = await cmdDoctor(opts);
    const check = result.checks.find((c) => c.name === 'model rankings')!;
    expect(check.detail).toMatch(/no catalog .* effort levels cannot be checked/);
  });

  it('scores an effort-pinned candidate by its bare key for coverage', async () => {
    // Config with `simple = ["big@high"]` and a catalog that scores `big`
    // (no families). Coverage must report nothing unscored: the key is
    // `big`, not `big@high`.
    const result = await cmdDoctor(opts);
    const check = result.checks.find((c) => c.name === 'model rankings')!;
    expect(check.detail).not.toMatch(/unscored/);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/commands/doctor.test.ts -t "effort"`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add `import { splitCandidate } from '../effort.js';`. In the `catalog === undefined` branch change the detail to:

```ts
        detail: 'no catalog — tiers ranked from built-in defaults, and effort levels cannot be checked; run `sonata catalog update`',
```

Change `upstream` to split first:

```ts
      const upstream = (candidate: string): string => {
        const { key } = splitCandidate(candidate);
        return config.native?.models?.[key]?.id ?? config.models?.[key]?.id ?? key;
      };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- tests/commands/doctor.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/doctor.ts tests/commands/doctor.test.ts
git commit -m "feat(doctor): coverage by bare key; name when effort cannot be checked"
```

---

### Task 8: The wizard ranks variant rows

**Files:**
- Modify: `src/tui-ink/app-state.ts` (`acceptRemainingTiers`)
- Modify: `src/tui-ink/app.tsx` (step 4)
- Modify: `src/init/plan.ts` (tiers block)
- Modify: `src/init/helpers.ts` (`deriveInitState.perRoleModels`)
- Test: `tests/tui-ink/app-state.test.ts`, `tests/init/plan.test.ts`, `tests/init/helpers.test.ts` (or wherever `deriveInitState` is tested — `grep -rl deriveInitState tests`)

**Interfaces:**
- Consumes: `expandCandidates`, `unpinnedVariants`, `candidateLabel`, `splitCandidate`.
- Produces: `acceptRemainingTiers(state, roles, fromIndex, proposal, allNativeKeys?, added?, expand?: (keys: string[]) => string[])`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/tui-ink/app-state.test.ts`:

```ts
describe('acceptRemainingTiers — effort variants', () => {
  it('seeds each remaining screen with the expanded candidates, exactly as the screen would', () => {
    const expand = (keys: string[]) => keys.flatMap((k) => (k === 'luna' ? ['luna@high', 'luna@max'] : [k]));
    const proposal = { simple: ['luna@high', 'flash', 'luna@max'], complex: ['luna@max', 'flash', 'luna@high'] };
    const state = { roles: ['code', 'review'], nativeKeys: ['luna', 'flash'] };
    const next = acceptRemainingTiers(state, ['code', 'review'], 0, proposal, ['luna', 'flash'], [], expand);
    expect(next.tiers?.code.simple).toEqual(['luna@high', 'flash', 'luna@max']);
    expect(next.tiers?.review.complex).toEqual(['luna@max', 'flash', 'luna@high']);
  });
});
```

Append to `tests/init/plan.test.ts` (needs a real home with a catalog, so use a temp dir):

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { aaCatalogPath } from '../../src/catalog.js';

describe('plan — effort variants', () => {
  const homeWithFamilies = () => {
    const home = mkdtempSync(join(tmpdir(), 'sonata-plan-home-'));
    const path = aaCatalogPath(home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      fetchedAt: '2026-09-13T00:00:00Z',
      models: {
        'fast': { codingIndex: 71, blendedPriceUsd: 0.45, agenticIndex: 42, costPerTask: 0.18, family: 'fast', effort: 'max' },
        'fast-high': { codingIndex: 60, blendedPriceUsd: 0.45, agenticIndex: 36, costPerTask: 0.04, family: 'fast', effort: 'high' },
        'slow': { codingIndex: 50, blendedPriceUsd: 2, agenticIndex: 30, costPerTask: 0.5 },
      },
    }));
    return home;
  };

  it('writes only pinned candidates for a model with variants, and the config loads', () => {
    const home = homeWithFamilies();
    const p = plan(env({ home }), { ...state, tiers: undefined }, noCredentials, { ...opts, home });
    const back = parseConfig(p.configToml);
    for (const c of [...back.tiers!.code.simple, ...back.tiers!.code.complex]) {
      if (c.startsWith('acme-fast')) expect(c).toMatch(/^acme-fast@(high|max)$/);
    }
    expect(back.tiers!.code.simple[0]).toBe('acme-fast@high');
    expect(back.tiers!.code.complex[0]).toBe('acme-fast@max');
  });

  it('re-proposes a saved bare candidate that now has variants instead of dropping it', () => {
    const home = homeWithFamilies();
    // A previous run saved `acme-fast` bare; `flaky-slow` is kept where it was.
    const saved = { code: { simple: ['flaky-slow', 'acme-fast'], complex: ['acme-fast', 'flaky-slow'] } };
    const p = plan(env({ home }), { ...state, tiers: saved }, noCredentials, { ...opts, home });
    const back = parseConfig(p.configToml);
    expect(back.tiers!.code.simple).not.toContain('acme-fast');
    expect(back.tiers!.code.simple).toEqual(expect.arrayContaining(['acme-fast@high', 'acme-fast@max', 'flaky-slow']));
    expect(back.tiers!.code.complex).toEqual(expect.arrayContaining(['acme-fast@max', 'acme-fast@high', 'flaky-slow']));
  });
});
```

(`env()` in that file sets `home: '/home/u'`; the `env({ home })` override and `{ ...opts, home }` point both at the temp home. `nativeKeys` there are `acme-fast`/`flaky-slow` with ids `fast`/`slow`; gateway names `acme`/`flaky-gw` are what let `normalizeModelName` recover `fast` from `acme-fast`.)

For `deriveInitState`, find its test file and add:

```ts
  it('lists each model once in perRoleModels, whatever effort levels the tiers pin', () => {
    // A config whose tiers hold `big@high` and `big@max`:
    const state = deriveInitState(config, 'project', offered);
    expect(state.perRoleModels?.code).toEqual(['big']);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/tui-ink/app-state.test.ts tests/init/plan.test.ts tests/init`
Expected: FAIL — `acceptRemainingTiers` ignores the 7th argument; `plan` writes `acme-fast` bare; `perRoleModels` holds `big@high`.

- [ ] **Step 3: `acceptRemainingTiers` takes an expansion**

In `src/tui-ink/app-state.ts`:

```ts
export function acceptRemainingTiers(
  state: InitState,
  roles: string[],
  fromIndex: number,
  proposal: { simple: string[]; complex: string[] },
  allNativeKeys: string[] = state.nativeKeys ?? [],
  added: readonly string[] = [],
  /**
   * How a model key becomes the candidates a screen offers — one per scored
   * effort level when the catalog has them. The screen applies it to its
   * items; bulk acceptance must apply the same one, or `A` and enter write
   * different configs from identical state.
   */
  expand: (keys: string[]) => string[] = (keys) => keys,
): InitState {
  let next = state;
  for (let index = Math.max(0, fromIndex); index < roles.length * 2; index++) {
    const role = roles[Math.floor(index / 2)];
    if (role === undefined) continue;
    const tier = index % 2 === 0 ? 'simple' : 'complex';
    next = applyStep(next, 4, {
      role,
      tier,
      ranked: seededRankingFor(
        next.tiers?.[role]?.[tier], proposal[tier], expand(next.nativeKeys ?? []), expand(allNativeKeys), added,
      ),
    });
  }
  return next;
}
```

- [ ] **Step 4: The tier screen in `src/tui-ink/app.tsx`**

Extend the import: `import { candidateLabel, expandCandidates, loadAaCatalog, proposeTiers, unpinnedVariants } from '../catalog.js';`

In `case 4`, after `const proposal = …`, define the expansion and widen `addedKeys`:

```ts
      const expand = (keys: string[]) => expandCandidates(keys, catalog, gateways);
      …
      const saved = state.tiers?.[role]?.[tier];
      // Deduplicated: `reconcileTierList` inserts every `added` entry it does
      // not already hold, so a level named twice would be inserted twice.
      const addedKeys = [...new Set([
        ...expand((state.nativeKeys ?? []).filter((key) => !baselineNativeKeys.includes(key))),
        // A bare key saved before effort existed is about to be refused at
        // load; re-propose its levels rather than let the screen drop it.
        ...unpinnedVariants(saved, catalog, gateways),
      ])];
      const initialRanked = initialRankedFor(saved, proposal[tier], addedKeys);
```

Change the items and the bulk-accept call:

```tsx
        items={tierPickerKeys(expand(state.nativeKeys ?? []), initialRanked, expand(known.map((c) => c.key)))
          .map((candidate) => ({ value: candidate, label: candidateLabel(candidate, catalog, gateways) }))}
        …
              setState((current) => acceptRemainingTiers(
                applyStep(current, 4, { role, tier, ranked }),
                roles, tierIndex + 1, proposal,
                known.map((c) => c.key),
                addedKeys,
                expand,
              ));
```

(Keep the existing comments on `known` and `addedKeys`; `expand` is applied to `known` inside `acceptRemainingTiers` now, so pass the bare keys as before.)

- [ ] **Step 5: The plan's tiers block in `src/init/plan.ts`**

Extend the import: `import { expandCandidates, loadAaCatalog, proposeTiers, unpinnedVariants } from '../catalog.js';`

Replace the tiers block:

```ts
  const catalog = loadAaCatalog(opts.home);
  const gatewayNames = gatewayNamesOf(nativeByKey);
  const expand = (keys: string[]) => expandCandidates(keys, catalog, gatewayNames);
  // Valid candidates are the *expanded* keys: a bare key for a model the
  // catalog scores by level is exactly what `loadConfig` refuses, so it must
  // not survive as "kept" here either.
  const validTierKeys = new Set(expand([...nativeKeys, ...Object.keys(migratedModels)]));
  const addedKeys = expand(nativeKeys.filter((key) => !savedNativeKeys.includes(key)));
  const tiers = Object.fromEntries(roles.map((role) => {
    const proposal = proposeTiers(nativeKeys, catalog, gatewayNames, avoidedKeysOf(nativeByKey, avoidGateways));
    const saved = state.tiers?.[role] ?? configForScope?.tiers?.[role];
    // A saved bare key with variants is re-proposed as its levels, at the
    // rank the proposal gives each — the same treatment as a new model.
    // Deduplicated, because `reconcileTierList` inserts each `added` entry
    // it does not already hold and would insert a repeated one twice.
    const added = (tier: 'simple' | 'complex') =>
      [...new Set([...addedKeys, ...unpinnedVariants(saved?.[tier], catalog, gatewayNames)])];
    return [role, {
      simple: reconcileTierList(saved?.simple, validTierKeys, proposal.simple, added('simple')),
      complex: reconcileTierList(saved?.complex, validTierKeys, proposal.complex, added('complex')),
    }];
  }));
```

- [ ] **Step 6: Bare keys in `deriveInitState` (`src/init/helpers.ts`)**

Add `import { splitCandidate } from '../effort.js';` and change `perRoleModels`:

```ts
        config.tiers
          ? [...new Set([...models.simple, ...models.complex].map((candidate) => splitCandidate(candidate).key))]
          : [...models],
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test -- tests/tui-ink tests/init && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 8: Manual check of the screen**

Run: `npm run build && sonata init` in a scratch directory with a catalog present (`sonata catalog update` first if `~/.config/sonata/catalog.json` predates Task 2 — the family fields are only written by the new code). On a tier screen, confirm rows read like `gpt-5.6-luna @xhigh   39.5  $0.085/task`, `[`/`]` reorder them, and `A` then `sonata agents --list` shows `@` candidates. Cancel before the confirm step if you do not want the config written.

- [ ] **Step 9: Commit**

```bash
git add src/tui-ink/app-state.ts src/tui-ink/app.tsx src/init/plan.ts src/init/helpers.ts tests/tui-ink/app-state.test.ts tests/init
git commit -m "feat(init): rank effort variants in the tier screens and write pinned candidates"
```

---

### Task 9: `sonata agents` shows and edits variants

**Files:**
- Modify: `src/commands/agents.ts`
- Test: `tests/commands/agents.test.ts`

**Interfaces:**
- Consumes: `expandCandidates`, `candidateLabel`, `loadAaCatalog`, `splitCandidate`.
- Produces: `AgentModelRow.effort?: Effort`; `rankableCandidates(config: SonataConfig, aa?: AaCatalog): string[]`; `itemLabel(config, candidate, aa?)`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/commands/agents.test.ts` (the file's `toml` defines `acme-big`, `acme-small`, `kimi`):

```ts
import { rankableCandidates } from '../../src/commands/agents.js';

describe('agents — effort variants', () => {
  const withEffort = toml.replace('simple = ["acme-small", "acme-big"]', 'simple = ["acme-small", "acme-big@high"]');
  const familyCatalog = {
    fetchedAt: '2026-09-13T00:00:00Z',
    models: {
      'big': { codingIndex: 71, blendedPriceUsd: 0.45, agenticIndex: 42, costPerTask: 0.18, family: 'big', effort: 'max' },
      'big-high': { codingIndex: 60, blendedPriceUsd: 0.45, agenticIndex: 36, costPerTask: 0.04, family: 'big', effort: 'high' },
    },
  };

  it('resolves a pinned candidate to its model and carries the level', () => {
    const rows = agentRows(parseConfig(withEffort));
    const codeSimple = rows.find((r) => r.agent === 'code-simple')!;
    expect(codeSimple.models[1]).toMatchObject({ key: 'acme-big@high', effort: 'high', route: 'native', id: 'big' });
    expect(renderAgents([codeSimple]).join('\n')).toMatch(/2\. acme-big@high\s+acme\/big/);
  });

  it('offers every scored level of a model as an editor item', () => {
    const config = parseConfig(toml);
    expect(rankableCandidates(config, familyCatalog as never)).toEqual(['acme-big@high', 'acme-big@max', 'acme-small', 'kimi']);
    expect(rankableCandidates(config, undefined)).toEqual(['acme-big', 'acme-small', 'kimi']);
    expect(itemLabel(config, 'acme-big@high', familyCatalog as never)).toMatch(/^acme-big @high\s+36\.0\s+\$0\.040\/task\s+acme\/big/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/commands/agents.test.ts -t "effort"`
Expected: FAIL — `modelRow` reports `acme-big@high` as `missing`; `rankableCandidates` does not exist.

- [ ] **Step 3: Implement**

Imports in `src/commands/agents.ts`:

```ts
import { assertEffortsPinned, candidateLabel, expandCandidates, loadAaCatalog, type AaCatalog } from '../catalog.js';
import { splitCandidate, type Effort } from '../effort.js';
```

`AgentModelRow` gains `effort?: Effort;` after `key`. `modelRow`:

```ts
function modelRow(config: SonataConfig, candidate: string): AgentModelRow {
  const { key, effort } = splitCandidate(candidate);
  const model = config.unifiedModels[key];
  const base = effort === undefined ? { key: candidate } : { key: candidate, effort };
  if (model === undefined) return { ...base, route: 'missing' };
  const native = model.gateway !== undefined;
  const harness = model.harness !== undefined;
  return {
    ...base,
    route: native && harness ? 'both' : native ? 'native' : harness ? 'harness' : 'missing',
    gateway: model.gateway ?? model.harness,
    id: model.id ?? model.harnessId,
    contextWindow: model.contextWindow,
  };
}
```

Add beside `rankableKeys`:

```ts
/**
 * Every candidate the editor may rank: each rankable key, expanded into its
 * scored effort levels where the catalog has them. The same expansion the
 * wizard's tier screens apply, so the two editors offer the same rows.
 */
export function rankableCandidates(config: SonataConfig, aa?: AaCatalog): string[] {
  return expandCandidates(rankableKeys(config), aa, Object.keys(config.native?.gateways ?? {}));
}
```

`itemLabel`:

```ts
export function itemLabel(config: SonataConfig, candidate: string, aa?: AaCatalog): string {
  const row = modelRow(config, candidate);
  const scored = candidateLabel(candidate, aa, Object.keys(config.native?.gateways ?? {}));
  return row.route === 'missing'
    ? `${scored}  (names no model)`
    : `${scored.padEnd(50)} ${row.gateway}/${row.id}  ${windowLabel(row.contextWindow)}`;
}
```

In `cmdAgents`, build items with the catalog:

```ts
  const catalog = loadAaCatalog(opts.home);
  const next = await io.edit({
    config,
    initialTiers: config.tiers,
    items: rankableCandidates(config, catalog).map((candidate) => ({ value: candidate, label: itemLabel(config, candidate, catalog) })),
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- tests/commands/agents.test.ts && npm run typecheck`
Expected: PASS. Adjust the `padEnd` width in `itemLabel` only if the regex in the test fails on spacing.

- [ ] **Step 5: Commit**

```bash
git add src/commands/agents.ts tests/commands/agents.test.ts
git commit -m "feat(agents): show and rank effort variants"
```

---

### Task 10: Full suite, docs, changelog, handoff

**Files:**
- Modify: `docs/guide/configuration.md`, `CLAUDE.md`, `CHANGELOG.md`, `docs/HANDOFF.md`, `docs/superpowers/README.md`

- [ ] **Step 1: Run everything**

Run: `npm test && npm run typecheck && npm run build`
Expected: all green. Fix anything that fails before touching docs; a test that broke in a file this plan did not name is a real regression, not noise.

- [ ] **Step 2: `docs/guide/configuration.md`**

After the paragraph beginning "Each role chooses its own ranked model list", add:

```markdown
A tier candidate may pin a reasoning-effort level: `"gpt-5.6-luna@xhigh"`.
The level is one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`,
`max`, and it belongs to the *slot*, not the model — the same model may sit
in `simple` at `high` and in `complex` at `max`. `sonata init` ranks every
level Artificial Analysis has scored for a model as its own row, because for
the current generation the level is often the larger lever: GPT-5.6 Luna at
`max` out-scores GPT-5.6 Terra at every level below `max`, at an eighth of
the cost per task.

**A bare candidate whose model the catalog scores at several levels is
refused when the config loads.** Ranked bare, it is scored at the model's
default row (usually its highest level) and dispatched with no level at all,
so what the ranking promised and what runs are different models. The error
names the candidate, its levels and its default; `sonata init` re-ranks
every tier with levels. With no catalog cache the check cannot run, and
`sonata doctor` says so.
```

- [ ] **Step 3: `CLAUDE.md`**

In the "Key design points" list, after the `SIMPLE_CAPABILITY_FLOOR`/admission bullets, add one bullet:

```markdown
- **A tier candidate can pin a reasoning-effort level (`<key>@<effort>`), and the catalog ranks the levels as candidates.** AA publishes one row per level and names the level in the parenthetical of each row's `name` (`GPT-5.6 Luna (max)` is slug `gpt-5-6-luna`; `… (low)` is `gpt-5-6-luna-low`), so `catalog update` records a `family` and `effort` per row — the *slug* minus the level suffix, stripped before `normalizeModelName` so a trailing date is still trailing — and the unsuffixed default row knows its own level. `src/effort.ts` is the one definition of the enum and the split; `catalogFamily`/`expandCandidates` (`src/catalog.ts`) turn a key into its scored variants, and `proposeTiers` ranks the expanded set with its existing rules. Only ranking, labels and `TierRoute.effort` see the level: cooldowns, `tiersCollapse` and every `[models]` lookup key by the bare key, so a model that failed at `@xhigh` is skipped at `@high` too. **A bare candidate whose model has variants is refused at load** — by `loadConfig`, `TenantRegistry.load` and `sonata agents`' write, never by `parseConfig`, which has no catalog; with no catalog cache the check is skipped and `doctor` says so. The wizard treats such a saved key as newly added, re-proposing its levels rather than dropping it. The level is not yet sent upstream: that is the router (PR 2) and the adapters (PR 3), per `docs/superpowers/specs/2026-09-13-effort-tiers-design.md`.
```

Also add `effort.ts` to the "Source layout" tree:

```text
├── effort.ts             the reasoning-effort enum, the <key>@<effort> candidate grammar, and AA's parenthetical parser — no imports, so config.ts and catalog.ts both use it
```

- [ ] **Step 4: `CHANGELOG.md` under `## [Unreleased]`**

```markdown
### Added
- **Effort-level tier candidates** (`"gpt-5.6-luna@xhigh"`). `sonata catalog
  update` now records which reasoning-effort level each Artificial Analysis
  row was scored at, `sonata init` and `sonata agents` rank every scored
  level of a model as its own candidate, and `[tiers]` lists may pin one.
  Measured on the current catalog, GPT-5.6 Luna at `max` out-scores GPT-5.6
  Terra at every level below `max` at an eighth of the cost per task —
  a comparison the ranking could not previously express.

### Changed
- **A bare tier candidate whose model the catalog scores at several levels
  is refused when the config loads.** It was ranked at the model's default
  (usually highest) level and dispatched at the gateway's own, so the
  ranking and the dispatch described different models. The error names the
  candidate and its levels; `sonata init` re-ranks with levels. The check
  needs a catalog cache; without one it is skipped and `sonata doctor` says
  so. The pinned level is not yet sent upstream — that lands with the router
  and adapter follow-ups.
```

- [ ] **Step 5: `docs/HANDOFF.md`**

In the environment-traps section add:

```markdown
- **Claude Code's Bash-tool shell drops single-underscore zsh functions from
  its snapshot.** A `~/.zshrc` stub like `node() { _nvm_lazy_load; node "$@"; }`
  survives the snapshot but `_nvm_lazy_load` does not, so every `node`/`npm`
  in a tool shell prints `command not found: _nvm_lazy_load` and recurses to
  `FUNCNEST`. Fixed 2026-09-13 by renaming the helper to `nvm_lazy_load`;
  keep the lazy loading itself (it saves ~650 ms per shell, which the tmux
  panes `npm test` spawns pay). Within an already-broken session, prefix
  commands with `unset -f node npm npx nvm corepack; . ~/.nvm/nvm.sh >/dev/null;`.
```

And under open follow-ups, note PR 2 (router injection + ledger) and PR 3 (adapters, gated on real-binary probes) with a pointer to the spec.

- [ ] **Step 6: Design index**

In `docs/superpowers/README.md`, change the effort-tiers row's plan cell from `— **queued**, plan next` to `[plan](plans/2026-09-13-effort-tiers-pr1.md) (PR 1 of 3)`.

- [ ] **Step 7: Commit**

```bash
git add docs/guide/configuration.md CLAUDE.md CHANGELOG.md docs/HANDOFF.md docs/superpowers/README.md
git commit -m "docs: effort-level tier candidates (PR 1), and the shell-snapshot trap"
```

- [ ] **Step 8: Open the PR**

Per CLAUDE.md this touches config parsing and ranking, so it goes through a PR. Branch `effort-tiers-pr1`; `gh pr create` with a body summarising: the grammar, the catalog fields, the refusal and its three call sites, the wizard change, and that nothing is sent upstream yet. Then `node scripts/pr-status.mjs --watch` until CI, threads and the bot verdict are clean.

---

## Self-review (done while writing)

**Spec coverage.** §1 catalog → Tasks 2–3. §2 grammar/`TierRoute`/`tiersCollapse`/round-trip/refusal in `loadConfig` → Tasks 5–6 (`tiersCollapse` needs no code: it compares the raw strings, and Task 5 tests that differing efforts do not collapse). §3 ranking/`RankedSelect`/`seededRankingFor`/`tierPickerKeys`/`agents` → Tasks 4, 8, 9. §6 doctor/init re-proposal/docs → Tasks 7, 8, 10. §7's config/ranking tests are inside each task. `sonata dispatch --model <key>@<effort>` (§2) is deliberately **not** in this PR: accepting the grammar while ignoring the level is the silent-mismatch the spec forbids, so it lands in PR 3 with the adapters. `sonata sync` needs no change (Task 5's `extended-context` split covers its one lookup).

**Placeholders.** Three test steps say "using the file's existing scaffolding" (doctor, tenants, `deriveInitState`) because those files' fixtures are large and the executor must read them; the assertion code is given in full each time.

**Type consistency.** `Effort` and `splitCandidate` come from `src/effort.ts` everywhere; `catalogFamily` returns `CatalogFamily` with `variants: Map<Effort, AaEntry>` in Tasks 3 and 6; `expandCandidates(keys, aa, providers)` argument order is the same in Tasks 3, 4, 8, 9; `acceptRemainingTiers`' new 7th parameter is `expand` in Task 8's implementation and test.
