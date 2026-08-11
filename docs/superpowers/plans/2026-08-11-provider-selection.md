# Provider Selection for OpenCode and Pi — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user choose which provider's copy of a model to enable, for both opencode and pi, and dispatch to the provider they chose.

**Architecture:** Both harnesses already speak `provider/model`. Each catalogue is read from its own CLI (`opencode models`, `pi --list-models`) and normalised into a single `ModelRef`. `init` gains a provider step before the model step; the config key becomes harness-qualified so the same ref under two harnesses cannot collide. All parsing is pure and unit-tested; only detection shells out.

**Tech Stack:** TypeScript (strict, ESM), Node ≥22, vitest, smol-toml. Zero new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-11-provider-selection-design.md`

## Status

**Tasks 1-12: complete.** Implemented 2026-08-11, eleven of them dispatched to
`deepseek-v4-flash` through sonata itself. Task 7 was landed first, out of
order, because sonata could not dispatch anything until its adapter stopped
hardcoding the provider — it could not implement its own fix.

| Task | Commit |
|---|---|
| 7 (bootstrap) | `283f16b` |
| 1 | `18d6fcd` |
| 2 | `fbce943` |
| 3 | `b57735a` |
| 4 | `660a156` |
| 5 | `c7cfd61` |
| 6 | `76a9e00` |
| 8 | `286ae9e` |
| 9 | `11c16fc` |
| 10 | `c7408a1` |
| 11 | `c3720d6` |
| 12 | `12be635`, `77a18c0` |

Two defects found after the fact and fixed: `tomlFor` escaped its TOML table
header but not `generate.models` (`07d003d`, found by an independent review
run), and a read-only opencode run was judged degraded for a report it cannot
write (`10a17e3`, found by dogfooding).

**Task 13: partially done.** The opencode half is verified — `sonata init` was
driven end to end, interactively and via flags, and `parseOpenCodeRefs` was run
over a live 496-ref catalogue. The pi half is **not** done: pi is not installed
on this machine, so `parsePiRefs` remains written against a fixture composed
from memory rather than captured output.

Task 12 had to be split in two after failing twice as a single run; see
[`docs/dispatching-work-through-sonata.md`](../../dispatching-work-through-sonata.md)
for why, and for what else dispatching this plan taught.

## Global Constraints

- ESM: every relative import ends in `.js`, even from `.ts` sources.
- Strict TypeScript. `npx tsc --noEmit` must pass at every commit.
- Full suite green at every commit: `npx vitest run`.
- No new runtime dependencies. `smol-toml` is the only one.
- Pure parsing lives apart from process execution — the house pattern stated at the top of `src/detect.ts`.
- TOML table keys are always quoted: `[models."<key>"]`. An unquoted dotted key nests and silently corrupts the config.
- A ref splits on the **first** `/` only. `openrouter/deepseek/deepseek-v4-flash` is provider `openrouter`, id `deepseek/deepseek-v4-flash`.
- Every commit message ends with these two trailers:
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_0119sDQT9AWqPyL87rHHtkFN
  ```
- Commit on `main` and `git push origin main` when the plan completes.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/types.ts` | Shared types with no imports — the cycle-free home for `ModelRef` | Modify |
| `src/detect.ts` | Catalogue fetching, opencode ref parsing, provider grouping | Modify |
| `src/adapters/pi.ts` | Pi table parsing (lives beside `countModelRows`), dispatch | Modify |
| `src/adapters/opencode.ts` | Dispatch — drop the hardcoded provider prefix | Modify |
| `src/config.ts` | Harness-aware id validation | Modify |
| `src/commands/init.ts` | Key derivation, collision check, pre-ticking, config merge, two-step flow | Modify |
| `src/tui.ts` | Viewport windowing and type-to-filter for multiselect | Modify |
| `src/cli.ts` | `--providers` flag, usage text | Modify |
| `README.md` | Pi section points at the wizard; codex section notes survival | Modify |

`ModelRef` must live in `src/types.ts`: `detect.ts` imports `checkVersion` from `commands/doctor.js`, which imports `adapters/index.js`. Putting `ModelRef` in `detect.ts` and importing it from `adapters/pi.ts` would create a cycle. `src/types.ts` imports nothing.

---

### Task 1: `ModelRef` and the opencode catalogue parser

**Files:**
- Modify: `src/types.ts`
- Modify: `src/detect.ts`
- Test: `tests/init.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ModelRef { harness: 'opencode' | 'pi'; provider: string; id: string; ref: string; name?: string }` in `src/types.ts`; `parseOpenCodeRefs(stdout: string): ModelRef[]` exported from `src/detect.ts`.

- [ ] **Step 1: Write the failing test**

Append to `tests/init.test.ts`:

```ts
describe('parseOpenCodeRefs', () => {
  it('splits a ref on the first slash only', () => {
    // The model id may itself contain slashes; only the provider is delimited.
    expect(parseOpenCodeRefs('openrouter/deepseek/deepseek-v4-flash\n')).toEqual([
      {
        harness: 'opencode',
        provider: 'openrouter',
        id: 'deepseek/deepseek-v4-flash',
        ref: 'openrouter/deepseek/deepseek-v4-flash',
      },
    ]);
  });

  it('reads every line of a listing', () => {
    const out = ['opencode-go/deepseek-v4-flash', 'openrouter/deepseek-v4-flash'].join('\n');
    expect(parseOpenCodeRefs(out).map((r) => r.provider)).toEqual(['opencode-go', 'openrouter']);
  });

  it('ignores blanks and lines that are not refs', () => {
    expect(parseOpenCodeRefs('')).toEqual([]);
    expect(parseOpenCodeRefs('\n   \n')).toEqual([]);
    expect(parseOpenCodeRefs('noslash\n')).toEqual([]);
    expect(parseOpenCodeRefs('/leading\n')).toEqual([]);
    expect(parseOpenCodeRefs('trailing/\n')).toEqual([]);
  });
});
```

Add `parseOpenCodeRefs` to the existing `../src/detect.js` import at the top of the file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/init.test.ts -t parseOpenCodeRefs`
Expected: FAIL — `parseOpenCodeRefs is not a function`.

- [ ] **Step 3: Add the type**

In `src/types.ts`, append:

```ts
export type ProviderHarness = 'opencode' | 'pi';

/**
 * One `provider/model` pair a harness can actually run.
 *
 * `ref` is what reaches `-m` / `--model` verbatim. `id` may itself contain
 * slashes — openrouter nests an org segment — so it is never re-split.
 */
export interface ModelRef {
  harness: ProviderHarness;
  provider: string;
  id: string;
  ref: string;
  name?: string;
}
```

- [ ] **Step 4: Write the parser**

In `src/detect.ts`, add the import `import type { ModelRef } from './types.js';` and:

```ts
/**
 * Parses `opencode models`, which prints one `provider/model` ref per line —
 * exactly the string `-m` accepts.
 */
export function parseOpenCodeRefs(stdout: string): ModelRef[] {
  const out: ModelRef[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    const slash = line.indexOf('/');
    // A ref needs a non-empty provider and a non-empty id either side.
    if (slash <= 0 || slash === line.length - 1) continue;
    out.push({
      harness: 'opencode',
      provider: line.slice(0, slash),
      id: line.slice(slash + 1),
      ref: line,
    });
  }
  return out;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/init.test.ts -t parseOpenCodeRefs`
Expected: PASS (3 tests).

- [ ] **Step 6: Typecheck and commit**

```bash
npx tsc --noEmit && npx vitest run
git add src/types.ts src/detect.ts tests/init.test.ts
git commit -m "$(cat <<'EOF'
feat: parse the opencode catalogue into provider-qualified refs

`opencode models` lists every provider/model pair opencode can run,
which is the string -m accepts. Splitting on the first slash only keeps
openrouter's nested ids intact.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0119sDQT9AWqPyL87rHHtkFN
EOF
)"
```

---

### Task 2: The pi catalogue parser

Pi's listing is a whitespace-aligned table whose first row is a header. `countModelRows` already encodes the header rule; it becomes a caller of the new parser so the rule exists once.

**Files:**
- Modify: `src/adapters/pi.ts:90-104`
- Test: `tests/adapters/pi.test.ts`

**Interfaces:**
- Consumes: `ModelRef` from `src/types.ts` (Task 1).
- Produces: `parsePiRefs(stdout: string): ModelRef[]` exported from `src/adapters/pi.ts`. `countModelRows(stdout: string): number` keeps its signature.

- [ ] **Step 1: Write the failing test**

In `tests/adapters/pi.test.ts`, add `parsePiRefs` to the `../../src/adapters/pi.js` import and append:

```ts
describe('parsePiRefs', () => {
  const HEADER = 'provider     model              context  max-out  thinking  images';

  it('joins the provider and model columns into a ref', () => {
    const out = [HEADER, 'opencode-go  deepseek-v4-flash  1M  384K  yes  no'].join('\n');
    expect(parsePiRefs(out)).toEqual([
      {
        harness: 'pi',
        provider: 'opencode-go',
        id: 'deepseek-v4-flash',
        ref: 'opencode-go/deepseek-v4-flash',
      },
    ]);
  });

  it('never treats the header as a model', () => {
    expect(parsePiRefs(`${HEADER}\n`)).toEqual([]);
  });

  it('ignores blanks and rows too short to carry a model', () => {
    expect(parsePiRefs('')).toEqual([]);
    expect(parsePiRefs('\n  \n')).toEqual([]);
    // The real format is unverified; a malformed row must be skipped, not
    // parsed into a ref with an undefined id.
    expect(parsePiRefs(`${HEADER}\nopencode-go\n`)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/adapters/pi.test.ts -t parsePiRefs`
Expected: FAIL — `parsePiRefs is not a function`.

- [ ] **Step 3: Write the parser and re-express `countModelRows`**

In `src/adapters/pi.ts`, add `import type { ModelRef } from '../types.js';` and replace the existing `countModelRows` (currently lines 90-104, including its docblock) with:

```ts
/**
 * The listing always starts with a `provider  model  context ...` header, so
 * "output is non-empty" is not evidence that any model exists — the header
 * alone would report a broken install as healthy.
 */
const PI_HEADER = /^provider\s+model\b/;

/**
 * Parses `pi --list-models`, a whitespace-aligned table whose first two
 * columns are the provider and the model. Rows with fewer than two columns are
 * skipped rather than parsed: the exact format is unverified against a real
 * install, so a malformed row must not become a ref with an undefined id.
 */
export function parsePiRefs(stdout: string): ModelRef[] {
  const out: ModelRef[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (line.length === 0 || PI_HEADER.test(line)) continue;
    const cols = line.split(/\s+/);
    if (cols.length < 2) continue;
    const [provider, id] = cols;
    out.push({ harness: 'pi', provider, id, ref: `${provider}/${id}` });
  }
  return out;
}

/** Counts real model rows, for the health check. */
export function countModelRows(stdout: string): number {
  return parsePiRefs(stdout).length;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/adapters/pi.test.ts`
Expected: PASS — both `parsePiRefs` and the pre-existing `countModelRows` describe blocks.

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit && npx vitest run
git add src/adapters/pi.ts tests/adapters/pi.test.ts
git commit -m "$(cat <<'EOF'
feat: parse the pi model table into refs

countModelRows already encoded the header rule; it now calls the parser
so the rule lives in one place. Short rows are skipped rather than
parsed, because the table format is not yet verified against a real pi
install.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0119sDQT9AWqPyL87rHHtkFN
EOF
)"
```

---

### Task 3: Grouping refs into offerable providers

OpenCode's picker is filtered by `auth.json` plus the free `opencode` tier. Pi is not filtered: `pi --list-models` already lists only usable models, which is what `piHealth` relies on.

**Files:**
- Modify: `src/detect.ts`
- Test: `tests/init.test.ts`

**Interfaces:**
- Consumes: `ModelRef` (Task 1).
- Produces: `ProviderSummary { harness: ProviderHarness; provider: string; count: number; key: string }` and `offerableProviders(refs: ModelRef[], authed: string[]): ProviderSummary[]`, both from `src/detect.ts`. `key` is `` `${harness}/${provider}` `` and identifies a row in the picker.

- [ ] **Step 1: Write the failing test**

Append to `tests/init.test.ts`:

```ts
describe('offerableProviders', () => {
  const refs = [
    { harness: 'opencode' as const, provider: 'openrouter', id: 'a', ref: 'openrouter/a' },
    { harness: 'opencode' as const, provider: 'openrouter', id: 'b', ref: 'openrouter/b' },
    { harness: 'opencode' as const, provider: 'agnes', id: 'c', ref: 'agnes/c' },
    { harness: 'opencode' as const, provider: 'opencode', id: 'free', ref: 'opencode/free' },
    { harness: 'pi' as const, provider: 'openrouter', id: 'a', ref: 'openrouter/a' },
  ];

  it('drops opencode providers with no auth entry', () => {
    const got = offerableProviders(refs, ['openrouter']);
    expect(got.some((p) => p.provider === 'agnes')).toBe(false);
  });

  it('keeps the free opencode tier, which needs no auth entry', () => {
    const got = offerableProviders(refs, ['openrouter']);
    expect(got.find((p) => p.harness === 'opencode' && p.provider === 'opencode')?.count).toBe(1);
  });

  it('never applies the auth filter to pi, which lists only usable models', () => {
    // `openrouter` is authed here, but pi must be offered even when it is not.
    const got = offerableProviders(refs, []);
    expect(got.map((p) => p.key)).toEqual(['pi/openrouter']);
  });

  it('keeps one provider under two harnesses as two rows', () => {
    const got = offerableProviders(refs, ['openrouter']);
    expect(got.filter((p) => p.provider === 'openrouter').map((p) => p.key).sort())
      .toEqual(['opencode/openrouter', 'pi/openrouter']);
  });

  it('counts the models behind each row', () => {
    const got = offerableProviders(refs, ['openrouter']);
    expect(got.find((p) => p.key === 'opencode/openrouter')?.count).toBe(2);
  });
});
```

Add `offerableProviders` to the `../src/detect.js` import.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/init.test.ts -t offerableProviders`
Expected: FAIL — `offerableProviders is not a function`.

- [ ] **Step 3: Write the implementation**

In `src/detect.ts`:

```ts
import type { ModelRef, ProviderHarness } from './types.js';

export interface ProviderSummary {
  harness: ProviderHarness;
  provider: string;
  count: number;
  /** `harness/provider` — identifies a picker row. */
  key: string;
}

/**
 * OpenCode's free tier needs no auth entry, so it is offered alongside the
 * authenticated providers.
 */
const FREE_OPENCODE_PROVIDERS = ['opencode'];

/**
 * Groups refs into picker rows.
 *
 * The auth filter applies to opencode only. `pi --list-models` lists just the
 * models pi can actually run — that is what piHealth relies on when it treats
 * an empty list as "no usable provider" — so filtering pi by an auth file
 * would invent a concept pi does not have.
 */
export function offerableProviders(refs: ModelRef[], authed: string[]): ProviderSummary[] {
  const allowed = new Set([...authed, ...FREE_OPENCODE_PROVIDERS]);
  const counts = new Map<string, ProviderSummary>();

  for (const ref of refs) {
    if (ref.harness === 'opencode' && !allowed.has(ref.provider)) continue;
    const key = `${ref.harness}/${ref.provider}`;
    const seen = counts.get(key);
    if (seen) seen.count += 1;
    else counts.set(key, { harness: ref.harness, provider: ref.provider, count: 1, key });
  }

  return [...counts.values()].sort((a, b) => a.key.localeCompare(b.key));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/init.test.ts -t offerableProviders`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit && npx vitest run
git add src/detect.ts tests/init.test.ts
git commit -m "$(cat <<'EOF'
feat: group model refs into offerable providers

The auth filter applies to opencode only, plus its free tier. Pi lists
only usable models already, so filtering it by an auth file would invent
a concept pi does not have.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0119sDQT9AWqPyL87rHHtkFN
EOF
)"
```

---

### Task 4: Config keys and collision detection

**Files:**
- Modify: `src/commands/init.ts`
- Test: `tests/init.test.ts`

**Interfaces:**
- Consumes: `ModelRef` (Task 1).
- Produces: `configKeyFor(ref: ModelRef): string` and `duplicateKeys(keys: string[]): string[]` (returns keys appearing more than once, sorted), both exported from `src/commands/init.ts`.

- [ ] **Step 1: Write the failing test**

Append to `tests/init.test.ts`:

```ts
describe('configKeyFor', () => {
  const ref = (harness: 'opencode' | 'pi', provider: string, id: string) =>
    ({ harness, provider, id, ref: `${provider}/${id}` });

  it('qualifies the key with the harness', () => {
    expect(configKeyFor(ref('opencode', 'openrouter', 'deepseek-v4-flash')))
      .toBe('opencode-openrouter-deepseek-v4-flash');
  });

  it('flattens a nested openrouter id', () => {
    expect(configKeyFor(ref('opencode', 'openrouter', 'deepseek/deepseek-v4-flash')))
      .toBe('opencode-openrouter-deepseek-deepseek-v4-flash');
  });

  it('separates the same ref served by two harnesses', () => {
    const a = configKeyFor(ref('opencode', 'opencode-go', 'deepseek-v4-flash'));
    const b = configKeyFor(ref('pi', 'opencode-go', 'deepseek-v4-flash'));
    expect(a).not.toBe(b);
  });
});

describe('duplicateKeys', () => {
  it('finds two refs that flatten alike', () => {
    // Provider names contain dashes too, so flattening is not injective.
    const a = configKeyFor({ harness: 'opencode', provider: 'opencode', id: 'go-x', ref: 'opencode/go-x' });
    const b = configKeyFor({ harness: 'opencode', provider: 'opencode-go', id: 'x', ref: 'opencode-go/x' });
    expect(a).toBe(b);
    expect(duplicateKeys([a, b])).toEqual([a]);
  });

  it('is empty when every key is distinct', () => {
    expect(duplicateKeys(['a', 'b', 'c'])).toEqual([]);
  });

  it('reports each colliding key once', () => {
    expect(duplicateKeys(['a', 'a', 'a', 'b'])).toEqual(['a']);
  });
});
```

Add `configKeyFor, duplicateKeys` to the `../src/commands/init.js` import.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/init.test.ts -t configKeyFor`
Expected: FAIL — `configKeyFor is not a function`.

- [ ] **Step 3: Write the implementation**

In `src/commands/init.ts`:

```ts
import type { ModelRef } from '../types.js';

/**
 * The config key is also the agent filename (`code-<key>.md`), so it cannot
 * contain `/`. The harness segment is load-bearing rather than decorative: pi
 * and opencode can serve the identical ref, and without it those two
 * selections would overwrite each other.
 */
export function configKeyFor(ref: ModelRef): string {
  return `${ref.harness}-${ref.ref}`.replace(/\//g, '-');
}

/**
 * Keys claimed more than once.
 *
 * Flattening is not injective, because provider names contain dashes too:
 * `opencode/go-x` and `opencode-go/x` both yield `opencode-go-x`. No pair in
 * the current catalogue collides, but it is served rather than static, so it
 * cannot be assumed away.
 */
export function duplicateKeys(keys: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const k of keys) {
    if (seen.has(k)) dupes.add(k);
    seen.add(k);
  }
  return [...dupes].sort();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/init.test.ts -t "configKeyFor|duplicateKeys"`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit && npx vitest run
git add src/commands/init.ts tests/init.test.ts
git commit -m "$(cat <<'EOF'
feat: harness-qualified config keys, with a collision check

Flattening provider/model is not injective — opencode/go-x and
opencode-go/x both yield opencode-go-x — so the keys about to be written
are checked for duplicates rather than assumed distinct.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0119sDQT9AWqPyL87rHHtkFN
EOF
)"
```

---

### Task 5: Pre-ticking on `(harness, id)`

The current `existingModels` regexes `[models.<key>]` out of the file. That cannot survive a key-scheme change and answers the wrong question: what a user enabled is a ref, not a name. Matching on the ref makes hand-written pi entries pre-tick correctly despite keys the wizard would never generate.

**Files:**
- Modify: `src/commands/init.ts:86-95` (replaces `existingModels`)
- Test: `tests/init.test.ts`

**Interfaces:**
- Consumes: `ModelRef` (Task 1), `parseConfig` from `src/config.js`.
- Produces: `preTickedRefs(configText: string, refs: ModelRef[]): Set<string>` from `src/commands/init.ts`, returning the set of `ref.ref` values already enabled. `existingModels` is deleted.

- [ ] **Step 1: Write the failing test**

Append to `tests/init.test.ts`:

```ts
describe('preTickedRefs', () => {
  const refs = [
    { harness: 'opencode' as const, provider: 'openrouter', id: 'deepseek-v4-flash', ref: 'openrouter/deepseek-v4-flash' },
    { harness: 'pi' as const, provider: 'opencode-go', id: 'deepseek-v4-flash', ref: 'opencode-go/deepseek-v4-flash' },
  ];

  it('recognises a hand-written pi entry from its ref, not its key', () => {
    // The README tells users to name this entry `pi-deepseek`; the wizard
    // would never generate that key, but the ref says exactly what was meant.
    const toml = `
[models."pi-deepseek"]
harness = "pi"
id = "opencode-go/deepseek-v4-flash"

[generate]
roles = ["code"]
models = ["pi-deepseek"]
`;
    expect(preTickedRefs(toml, refs)).toEqual(new Set(['opencode-go/deepseek-v4-flash']));
  });

  it('matches the harness too, so one ref under two harnesses stays distinct', () => {
    const toml = `
[models."opencode-opencode-go-deepseek-v4-flash"]
harness = "opencode"
id = "opencode-go/deepseek-v4-flash"

[generate]
roles = ["code"]
models = ["opencode-opencode-go-deepseek-v4-flash"]
`;
    // The only catalogue ref with that id is pi's, so nothing pre-ticks.
    expect(preTickedRefs(toml, refs)).toEqual(new Set());
  });

  it('pre-ticks nothing for a bare id, which names no provider', () => {
    const toml = `
[models."kimi-k3"]
harness = "opencode"
id = "kimi-k3"

[generate]
roles = ["code"]
models = ["kimi-k3"]
`;
    expect(preTickedRefs(toml, refs)).toEqual(new Set());
  });

  it('is empty for an unparseable or empty config', () => {
    expect(preTickedRefs('', refs)).toEqual(new Set());
    expect(preTickedRefs('not toml at all {{{', refs)).toEqual(new Set());
  });
});
```

Add `preTickedRefs` to the `../src/commands/init.js` import.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/init.test.ts -t preTickedRefs`
Expected: FAIL — `preTickedRefs is not a function`.

- [ ] **Step 3: Write the implementation**

In `src/commands/init.ts`, delete `existingModels` entirely and add:

```ts
import { KNOWN_ROLES, parseConfig } from '../config.js';

/**
 * Refs already enabled, for pre-ticking.
 *
 * Matching is on `(harness, id)` rather than on the config key: a key is a
 * name the user or an older sonata chose, while the ref states what was
 * actually meant. This is what lets a hand-written pi entry pre-tick despite
 * a key the wizard would never generate.
 *
 * An unparseable config pre-ticks nothing rather than throwing — `init` must
 * be able to repair a broken file, which is half its purpose.
 */
export function preTickedRefs(configText: string, refs: ModelRef[]): Set<string> {
  let models: Record<string, { harness: string; id: string }>;
  try {
    models = parseConfig(configText).models;
  } catch {
    return new Set();
  }

  const enabled = new Set<string>();
  for (const entry of Object.values(models)) {
    for (const ref of refs) {
      if (ref.harness === entry.harness && ref.ref === entry.id) enabled.add(ref.ref);
    }
  }
  return enabled;
}
```

Note the call site in `cmdInit` still references `existingModels`; Task 12 rewrites that block. To keep this commit green, replace the line

```ts
const preTicked = new Set(existingModels(opts.cwd));
```

with

```ts
const configText = existsSync(join(opts.cwd, 'sonata.toml'))
  ? readFileSync(join(opts.cwd, 'sonata.toml'), 'utf8')
  : '';
const preTicked = new Set<string>(preTickedRefs(configText, []));
```

This is a deliberate stub — with no refs yet plumbed through, nothing pre-ticks — and Task 12 supplies the real ref list.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run`
Expected: PASS. The pre-existing `cmdInit` test `pre-selects a dotted model id already in sonata.toml` will now FAIL, because pre-ticking no longer matches bare ids. Delete that test — Task 12 replaces it with a ref-based equivalent — and record the deletion in the commit message.

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit && npx vitest run
git add src/commands/init.ts tests/init.test.ts
git commit -m "$(cat <<'EOF'
feat: pre-tick models by ref instead of by config key

A key is a name; a ref is what was meant. Matching on (harness, id) lets
a hand-written pi entry pre-tick despite a key the wizard would never
generate, and survives the key-scheme change.

Drops the bare-id pre-ticking test: a bare id names no provider, so
there is no ref it can honestly claim to be. Task 12 adds the ref-based
replacement.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0119sDQT9AWqPyL87rHHtkFN
EOF
)"
```

---

### Task 6: Preserving hand-written entries across a re-run

`cmdInit` writes `writeFileSync(configPath, tomlFor(...))` — a wholesale overwrite that destroys the codex entries the README instructs users to add. Codex stays hand-written after this change, so the wizard becomes the only thing that can delete it.

**Files:**
- Modify: `src/commands/init.ts:66-84` (`tomlFor`)
- Test: `tests/init.test.ts`

**Interfaces:**
- Consumes: `configKeyFor` (Task 4), `parseConfig`.
- Produces: `carriedEntries(configText: string, managed: string[]): Record<string, { harness: string; id: string }>` — entries whose harness the wizard does not manage. `tomlFor(refs: ModelRef[], roles: string[], carried: Record<string, { harness: string; id: string }>): string`.

- [ ] **Step 1: Write the failing test**

Append to `tests/init.test.ts`:

```ts
describe('carriedEntries', () => {
  const toml = `
[models."gpt-5-6-sol"]
harness = "codex"
id = "gpt-5.6-sol"

[models."opencode-openrouter-kimi-k3"]
harness = "opencode"
id = "openrouter/kimi-k3"

[generate]
roles = ["code"]
models = ["gpt-5-6-sol", "opencode-openrouter-kimi-k3"]
`;

  it('keeps entries whose harness the wizard does not manage', () => {
    expect(carriedEntries(toml, ['opencode', 'pi'])).toEqual({
      'gpt-5-6-sol': { harness: 'codex', id: 'gpt-5.6-sol' },
    });
  });

  it('drops entries the wizard is about to rewrite', () => {
    expect(carriedEntries(toml, ['opencode', 'pi'])['opencode-openrouter-kimi-k3']).toBeUndefined();
  });

  it('is empty for an unparseable config', () => {
    expect(carriedEntries('not toml {{{', ['opencode'])).toEqual({});
  });
});

describe('tomlFor', () => {
  const refs = [{
    harness: 'opencode' as const, provider: 'openrouter',
    id: 'grok-4.5', ref: 'openrouter/grok-4.5',
  }];

  it('writes quoted keys and the ref verbatim', () => {
    const out = tomlFor(refs, ['code'], {});
    expect(out).toContain('[models."opencode-openrouter-grok-4.5"]');
    expect(out).toContain('harness = "opencode"');
    expect(out).toContain('id = "openrouter/grok-4.5"');
  });

  it('carries a hand-written entry through, in generate.models too', () => {
    const out = tomlFor(refs, ['code'], { 'gpt-5-6-sol': { harness: 'codex', id: 'gpt-5.6-sol' } });
    expect(out).toContain('[models."gpt-5-6-sol"]');
    expect(out).toContain('harness = "codex"');
    expect(out).toContain('"gpt-5-6-sol"');
    // Both the generated and the carried model are generated.
    const parsed = parseConfig(out);
    expect(parsed.generate.models.sort())
      .toEqual(['gpt-5-6-sol', 'opencode-openrouter-grok-4.5']);
  });
});
```

Add `carriedEntries, tomlFor` to the `../src/commands/init.js` import, and `parseConfig` to the `../src/config.js` import.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/init.test.ts -t "carriedEntries|tomlFor"`
Expected: FAIL — `carriedEntries is not a function`.

- [ ] **Step 3: Write the implementation**

In `src/commands/init.ts`, replace `tomlFor` with:

```ts
export interface ConfigEntry { harness: string; id: string }

/**
 * Entries the wizard does not manage, and so must not delete.
 *
 * `init` overwrites sonata.toml wholesale. Codex models are added by hand —
 * the README says so — which makes the wizard the only thing that can destroy
 * them.
 */
export function carriedEntries(
  configText: string,
  managed: string[],
): Record<string, ConfigEntry> {
  let models: Record<string, ConfigEntry>;
  try {
    models = parseConfig(configText).models;
  } catch {
    return {};
  }

  const kept: Record<string, ConfigEntry> = {};
  for (const [key, entry] of Object.entries(models)) {
    if (!managed.includes(entry.harness)) kept[key] = entry;
  }
  return kept;
}

/** A TOML basic-string key. An unquoted dotted key nests and corrupts the table. */
function tomlKey(key: string): string {
  return `"${key.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function tomlFor(
  refs: ModelRef[],
  roles: string[],
  carried: Record<string, ConfigEntry>,
): string {
  const entries: [string, ConfigEntry][] = [
    ...refs.map((r): [string, ConfigEntry] =>
      [configKeyFor(r), { harness: r.harness, id: r.ref }]),
    ...Object.entries(carried),
  ];

  const lines: string[] = [];
  for (const [key, entry] of entries) {
    lines.push(`[models.${tomlKey(key)}]`, `harness = "${entry.harness}"`, `id = "${entry.id}"`, '');
  }
  lines.push(
    '[generate]',
    `roles = [${roles.map((r) => `"${r}"`).join(', ')}]`,
    `models = [${entries.map(([k]) => `"${k}"`).join(', ')}]`,
    '',
    '[run]',
    'tail_window_seconds = 20',
    'stall_timeout_seconds = 120',
    'run_timeout_seconds = 1800',
    '',
  );
  return lines.join('\n');
}
```

The old `tomlKey(id)` helper added in the dotted-key fix is superseded by this one; there must be exactly one definition.

Update the single call site in `cmdInit` to keep this commit green:

```ts
writeFileSync(configPath, tomlFor([], roles, {}));
```

Task 12 supplies the real refs and carried entries.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/init.test.ts -t "carriedEntries|tomlFor"`
Expected: PASS (5 tests).

Other `cmdInit` tests asserting written config content will fail against the empty-ref stub. Mark them `it.skip` with the comment `// Re-enabled in Task 12, once refs are plumbed through cmdInit.` and re-enable them there.

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit && npx vitest run
git add src/commands/init.ts tests/init.test.ts
git commit -m "$(cat <<'EOF'
fix: stop init deleting hand-written model entries

init overwrites sonata.toml wholesale, so re-running the wizard
destroyed the codex entries the README tells users to add. Entries whose
harness the wizard does not manage are now carried through, into
generate.models as well.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0119sDQT9AWqPyL87rHHtkFN
EOF
)"
```

---

### Task 7: Dispatch to the chosen provider

**Files:**
- Modify: `src/adapters/opencode.ts:51`
- Test: `tests/adapters/opencode.test.ts`

**Interfaces:**
- Consumes: `PlanInput.modelId`, which now holds a full ref.
- Produces: no new exports. `-m` receives `modelId` verbatim.

- [ ] **Step 1: Write the failing test**

In `tests/adapters/opencode.test.ts`, change the shared fixture at line 9 from
`modelId: 'deepseek-v4-flash'` to `modelId: 'openrouter/deepseek-v4-flash'`, then append:

```ts
describe('opencodeAdapter.plan — provider routing', () => {
  it('passes the ref to -m verbatim, with no hardcoded provider', () => {
    // The adapter used to prefix `opencode/`, which sent every run to the free
    // tier regardless of the provider the user chose.
    const p = opencodeAdapter.plan({ ...base, mode: 'acceptEdits' });
    expect(p.script).toContain('-m openrouter/deepseek-v4-flash');
    expect(p.script).not.toContain('-m opencode/openrouter/deepseek-v4-flash');
  });

  it('routes a nested openrouter ref unchanged', () => {
    const p = opencodeAdapter.plan({
      ...base, modelId: 'openrouter/deepseek/deepseek-v4-flash', mode: 'acceptEdits',
    });
    expect(p.script).toContain('-m openrouter/deepseek/deepseek-v4-flash');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/adapters/opencode.test.ts -t "provider routing"`
Expected: FAIL — script contains `-m opencode/openrouter/deepseek-v4-flash`.

- [ ] **Step 3: Remove the hardcoded prefix**

In `src/adapters/opencode.ts`, replace line 51:

```ts
  const flags = ['run', `--agent ${agent}`, `-m ${input.modelId}`, '--interactive'];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/adapters/opencode.test.ts`
Expected: PASS, including the pre-existing assertions now reading the ref-shaped fixture.

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit && npx vitest run
git add src/adapters/opencode.ts tests/adapters/opencode.test.ts
git commit -m "$(cat <<'EOF'
fix: dispatch opencode runs to the chosen provider

The adapter hardcoded `-m opencode/<id>`, so every run went to provider
`opencode` whatever the user selected. That provider serves only free
models, so none of the configured ids existed under it and opencode
dispatch was dead for anyone off the free tier.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0119sDQT9AWqPyL87rHHtkFN
EOF
)"
```

---

### Task 8: Harness-aware id validation

Opencode and pi need a ref; codex needs a bare id. Validating globally would break every codex entry.

**Files:**
- Modify: `src/config.ts:33-46`
- Modify: `tests/e2e.test.ts:24`, `tests/commands/run.test.ts:18`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: `KNOWN_HARNESSES`.
- Produces: no new exports; `parseConfig` throws on a slash-less id for `opencode` or `pi`.

- [ ] **Step 1: Write the failing test**

Append to `tests/config.test.ts`:

```ts
describe('parseConfig — provider-qualified ids', () => {
  const cfg = (harness: string, id: string) => `
[models."m"]
harness = "${harness}"
id = "${id}"

[generate]
roles = ["code"]
models = ["m"]
`;

  it('rejects a bare id on opencode, which needs provider/model', () => {
    expect(() => parseConfig(cfg('opencode', 'kimi-k3')))
      .toThrow(/needs a provider.*sonata init/s);
  });

  it('rejects a bare id on pi for the same reason', () => {
    expect(() => parseConfig(cfg('pi', 'kimi-k3'))).toThrow(/needs a provider/);
  });

  it('accepts a ref', () => {
    expect(parseConfig(cfg('opencode', 'openrouter/kimi-k3')).models.m.id).toBe('openrouter/kimi-k3');
  });

  it('accepts a bare codex id, which has no provider dimension', () => {
    expect(parseConfig(cfg('codex', 'gpt-5.6-sol')).models.m.id).toBe('gpt-5.6-sol');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config.test.ts -t "provider-qualified"`
Expected: FAIL — no error thrown for the bare opencode id.

- [ ] **Step 3: Add the validation**

In `src/config.ts`, inside the `for` loop over models, after the `KNOWN_HARNESSES` check:

```ts
    // Opencode and pi address models as provider/model; codex takes a bare id,
    // so this cannot be a global rule.
    if ((d.harness === 'opencode' || d.harness === 'pi') && !d.id.includes('/')) {
      throw new Error(
        `sonata.toml: model "${name}" needs a provider — ${d.harness} takes ` +
        `ids in provider/model form, not "${d.id}". Re-run \`sonata init\` to ` +
        'choose a provider.',
      );
    }
```

- [ ] **Step 4: Update the fixtures that carry bare ids**

In `tests/e2e.test.ts` line 24 and `tests/commands/run.test.ts` line 18, change

```
id = "fake"
```

to

```
id = "fake/fake"
```

In `tests/e2e.test.ts`, `writeConfig` is also called with `harness = 'codex'`; a codex entry must keep a bare id. Change the `id` line to interpolate:

```ts
id = "${harness === 'codex' ? 'fake' : 'fake/fake'}"
```

Check for any other fixture the suite reports.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS. Any remaining failure names a fixture with a bare opencode or pi id; give it a ref.

- [ ] **Step 6: Typecheck and commit**

```bash
npx tsc --noEmit && npx vitest run
git add src/config.ts tests/config.test.ts tests/e2e.test.ts tests/commands/run.test.ts
git commit -m "$(cat <<'EOF'
feat: require provider-qualified ids for opencode and pi

A bare id would reach the harness as `-m kimi-k3`, which is not a valid
ref. Auto-prefixing was rejected: that is exactly the behaviour that
silently sent every model to the wrong provider, and it fails later and
more confusingly than failing here.

Codex is the opposite case and keeps bare ids, so the rule is per
harness rather than global.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0119sDQT9AWqPyL87rHHtkFN
EOF
)"
```

---

### Task 9: A viewport for the list widget

`renderList` draws every choice and redraws with `ESC[<n>A`. Openrouter alone offers 341 models, which overflows the screen and corrupts the redraw.

**Files:**
- Modify: `src/tui.ts:103-123`
- Test: `tests/tui.test.ts`

**Interfaces:**
- Consumes: `ListState`, `Choice<T>`.
- Produces: `Window { start: number; end: number; above: number; below: number }`, `viewport(cursor: number, total: number, height: number): Window`, and `listHeight(rows?: number): number`, all from `src/tui.ts`. `renderList` gains a fifth parameter `height = 15`.

- [ ] **Step 1: Write the failing test**

Append to `tests/tui.test.ts`:

```ts
describe('viewport', () => {
  it('shows the top of the list when the cursor is at the top', () => {
    expect(viewport(0, 100, 10)).toEqual({ start: 0, end: 10, above: 0, below: 90 });
  });

  it('shows the bottom when the cursor is at the end', () => {
    expect(viewport(99, 100, 10)).toEqual({ start: 90, end: 100, above: 90, below: 0 });
  });

  it('centres the cursor in the middle of a long list', () => {
    const w = viewport(50, 100, 10);
    expect(w.start).toBe(45);
    expect(w.end).toBe(55);
  });

  it('shows everything when the list is shorter than the window', () => {
    expect(viewport(1, 3, 10)).toEqual({ start: 0, end: 3, above: 0, below: 0 });
  });

  it('handles an empty list without going out of range', () => {
    expect(viewport(0, 0, 10)).toEqual({ start: 0, end: 0, above: 0, below: 0 });
  });
});

describe('listHeight', () => {
  it('leaves room for the title, filter, counts and hint', () => {
    expect(listHeight(30)).toBe(15);
    expect(listHeight(20)).toBe(12);
  });

  it('never returns less than three rows', () => {
    expect(listHeight(5)).toBe(3);
  });
});

describe('renderList — windowing', () => {
  const many: Choice<number>[] = Array.from({ length: 50 }, (_, i) => ({ value: i, label: `m${i}` }));

  it('draws only the window, with overflow counts', () => {
    const out = renderList('Pick', many, initialState(many), true, 5);
    expect(out).toContain('m0');
    expect(out).not.toContain('m40');
    expect(out).toContain('↓ 45 more');
  });

  it('keeps the block short enough to redraw', () => {
    // The redraw moves the cursor up by the block height; a block taller than
    // the terminal cannot be redrawn correctly.
    const out = renderList('Pick', many, initialState(many), true, 5);
    expect(out.split('\n').length).toBeLessThan(15);
  });
});
```

Add `viewport, listHeight` to the `../src/tui.js` import.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tui.test.ts -t viewport`
Expected: FAIL — `viewport is not a function`.

- [ ] **Step 3: Write the implementation**

In `src/tui.ts`:

```ts
export interface Window {
  start: number;
  end: number;
  above: number;
  below: number;
}

/**
 * The slice of a list to draw, centred on the cursor.
 *
 * Drawing every choice is not an option: the redraw moves the terminal cursor
 * up by the block height, so a block taller than the screen corrupts it, and
 * one provider alone offers 341 models.
 */
export function viewport(cursor: number, total: number, height: number): Window {
  if (total === 0) return { start: 0, end: 0, above: 0, below: 0 };
  const h = Math.min(Math.max(3, height), total);
  let start = cursor - Math.floor(h / 2);
  if (start < 0) start = 0;
  if (start + h > total) start = total - h;
  const end = start + h;
  return { start, end, above: start, below: total - end };
}

/** Rows available for choices, after the title, filter, counts and hint. */
export function listHeight(rows: number = process.stdout.rows ?? 24): number {
  return Math.max(3, Math.min(15, rows - 8));
}
```

Then rewrite `renderList`:

```ts
export function renderList<T>(
  title: string,
  choices: Choice<T>[],
  state: ListState,
  multi: boolean,
  height = 15,
): string {
  const win = viewport(state.cursor, choices.length, height);
  const lines: string[] = [`  ${title}`, ''];

  if (win.above > 0) lines.push(`    ↑ ${win.above} more`);
  for (let i = win.start; i < win.end; i++) {
    const choice = choices[i];
    const pointer = i === state.cursor ? '❯' : ' ';
    const mark = multi ? (state.checked.has(i) ? '◉' : '○') : '';
    const hint = choice.hint ? `  · ${choice.hint}` : '';
    const label = choice.disabled ? `${choice.label} (unavailable)` : choice.label;
    lines.push(`  ${pointer} ${mark} ${label}${hint}`.replace(/\s+$/, ''));
  }
  if (win.below > 0) lines.push(`    ↓ ${win.below} more`);

  lines.push('');
  lines.push(multi ? '  space toggle · enter confirm · esc cancel'
                   : '  ↑↓ move · enter select · esc cancel');
  return lines.join('\n');
}
```

In `runList`, pass the height so real terminals get a real window:

```ts
  const height = listHeight();
  const draw = (first: boolean): void => {
    const body = renderList(title, choices, state, multi, height);
    if (!first) stdout.write(`\u001b[${body.split('\n').length}A`);
    stdout.write(`${body}\n`);
  };
```

The redraw must also clear each line, because the block height now changes as overflow counts appear and disappear:

```ts
    stdout.write(`${body.split('\n').map((l) => `\u001b[2K${l}`).join('\n')}\n`);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/tui.test.ts`
Expected: PASS, including the pre-existing `renderList` tests — the default height of 15 leaves their 1-3 item lists fully visible.

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit && npx vitest run
git add src/tui.ts tests/tui.test.ts
git commit -m "$(cat <<'EOF'
feat: window long lists instead of drawing every choice

The redraw moves the terminal cursor up by the block height, so a list
taller than the screen corrupts the display. One provider offers 341
models, so this is the normal case rather than an edge case.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0119sDQT9AWqPyL87rHHtkFN
EOF
)"
```

---

### Task 10: Type-to-filter in the multiselect

Letters become filter text, so `j`/`k` stop navigating in multiselect lists. `select` keeps them: those lists are three items long and typing has nothing to narrow. Space still toggles — no provider or model ref contains a space, so the filter never needs one.

**Files:**
- Modify: `src/tui.ts` (`Key`, `parseKey`, `ListState`, `initialState`, `reduce`, `renderList`, `runList`)
- Test: `tests/tui.test.ts`

**Interfaces:**
- Consumes: `viewport` (Task 9).
- Produces:
  - `ListKey = { kind: 'up' | 'down' | 'space' | 'enter' | 'cancel' | 'backspace' | 'ignore' } | { kind: 'char'; value: string }`
  - `parseKey(seq: string, filterable: boolean): ListKey` — replaces the string-returning version.
  - `visibleIndices<T>(choices: Choice<T>[], filter: string): number[]`
  - `ListState` gains `filter: string`; `cursor` now indexes the **filtered view**, while `checked` holds **original** indices.
  - `reduce<T>(state, key: ListKey, choices, multi)` — unchanged name, new key type.

- [ ] **Step 1: Write the failing test**

Append to `tests/tui.test.ts`:

```ts
describe('parseKey — filterable lists', () => {
  it('treats letters as filter text when filtering is on', () => {
    expect(parseKey('j', true)).toEqual({ kind: 'char', value: 'j' });
    expect(parseKey('k', true)).toEqual({ kind: 'char', value: 'k' });
  });

  it('keeps vim keys when filtering is off', () => {
    expect(parseKey('j', false)).toEqual({ kind: 'down' });
    expect(parseKey('k', false)).toEqual({ kind: 'up' });
  });

  it('keeps space as a toggle, since no ref contains a space', () => {
    expect(parseKey(' ', true)).toEqual({ kind: 'space' });
  });

  it('maps arrows, enter, cancel and backspace in both modes', () => {
    expect(parseKey('\u001b[A', true)).toEqual({ kind: 'up' });
    expect(parseKey('\u001b[B', true)).toEqual({ kind: 'down' });
    expect(parseKey('\r', true)).toEqual({ kind: 'enter' });
    expect(parseKey('\u001b', true)).toEqual({ kind: 'cancel' });
    expect(parseKey('\u007f', true)).toEqual({ kind: 'backspace' });
  });
});

describe('visibleIndices', () => {
  const choices: Choice<string>[] = [
    { value: 'a', label: 'openrouter/deepseek-v4-flash' },
    { value: 'b', label: 'openrouter/kimi-k3' },
    { value: 'c', label: 'openrouter/deepseek/deepseek-v4-pro' },
  ];

  it('returns every index when the filter is empty', () => {
    expect(visibleIndices(choices, '')).toEqual([0, 1, 2]);
  });

  it('matches a substring, case-insensitively', () => {
    expect(visibleIndices(choices, 'DEEPSEEK')).toEqual([0, 2]);
  });

  it('returns nothing when nothing matches', () => {
    expect(visibleIndices(choices, 'zzz')).toEqual([]);
  });
});

describe('reduce — filtering', () => {
  const choices: Choice<string>[] = [
    { value: 'a', label: 'openrouter/deepseek-v4-flash' },
    { value: 'b', label: 'openrouter/kimi-k3' },
    { value: 'c', label: 'openrouter/deepseek/deepseek-v4-pro' },
  ];
  const type = (s: ListState, text: string) =>
    [...text].reduce((acc, ch) => reduce(acc, { kind: 'char', value: ch }, choices, true), s);

  it('narrows the list as the user types', () => {
    const s = type(initialState(choices), 'kimi');
    expect(visibleIndices(choices, s.filter)).toEqual([1]);
  });

  it('widens again on backspace', () => {
    let s = type(initialState(choices), 'kimi');
    s = reduce(s, { kind: 'backspace' }, choices, true);
    expect(s.filter).toBe('kim');
  });

  it('keeps a checked model checked after it is filtered away', () => {
    // checked holds original indices, so a filter change cannot disturb it.
    let s = reduce(initialState(choices), { kind: 'space' }, choices, true); // checks index 0
    s = type(s, 'kimi');
    expect(s.checked.has(0)).toBe(true);
    s = reduce(s, { kind: 'enter' }, choices, true);
    expect([...s.checked].sort()).toEqual([0]);
  });

  it('toggles the model under the cursor in the filtered view, not the raw list', () => {
    let s = type(initialState(choices), 'kimi'); // view is [1]
    s = reduce(s, { kind: 'space' }, choices, true);
    expect(s.checked.has(1)).toBe(true);
    expect(s.checked.has(0)).toBe(false);
  });

  it('confirms what is checked even when the filter matches nothing', () => {
    let s = reduce(initialState(choices), { kind: 'space' }, choices, true);
    s = type(s, 'zzz');
    s = reduce(s, { kind: 'enter' }, choices, true);
    expect(s.done).toBe(true);
    expect([...s.checked]).toEqual([0]);
  });

  it('ignores filter keys in single-select mode', () => {
    const s = reduce(initialState(choices), { kind: 'char', value: 'z' }, choices, false);
    expect(s.filter).toBe('');
  });
});
```

Add `visibleIndices` and `type ListState` to the `../src/tui.js` import.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tui.test.ts -t "filterable lists"`
Expected: FAIL — `parseKey('j', true)` returns the string `'down'`, not an object.

- [ ] **Step 3: Replace `Key` with `ListKey` and rewrite `parseKey`**

In `src/tui.ts`, replace the `Key` type and `parseKey`:

```ts
export type ListKey =
  | { kind: 'up' } | { kind: 'down' } | { kind: 'space' }
  | { kind: 'enter' } | { kind: 'cancel' }
  | { kind: 'backspace' } | { kind: 'ignore' }
  | { kind: 'char'; value: string };

/**
 * `filterable` decides what a letter means. In a filterable list it is text;
 * in a plain list it is vim navigation. The lists that filter are the long
 * ones, where typing is the only practical way to reach an entry.
 */
export function parseKey(seq: string, filterable: boolean): ListKey {
  switch (seq) {
    case '\u001b[A': return { kind: 'up' };
    case '\u001b[B': return { kind: 'down' };
    // Space toggles even while filtering: no provider or model ref contains
    // one, so the filter never needs a space.
    case ' ': return { kind: 'space' };
    case '\r': case '\n': return { kind: 'enter' };
    case '\u0003': case '\u001b': return { kind: 'cancel' };
    case '\u007f': case '\b': return { kind: 'backspace' };
    default: break;
  }
  if (!filterable) {
    if (seq === 'k') return { kind: 'up' };
    if (seq === 'j') return { kind: 'down' };
    return { kind: 'ignore' };
  }
  // eslint-disable-next-line no-control-regex
  if (seq.length > 0 && !/[\u0000-\u001f\u007f]/.test(seq)) {
    return { kind: 'char', value: seq };
  }
  return { kind: 'ignore' };
}
```

- [ ] **Step 4: Add filtering to the state and reducer**

```ts
export interface ListState {
  /** Index into the *filtered* view. */
  cursor: number;
  /** *Original* choice indices, so a filter change cannot disturb a selection. */
  checked: Set<number>;
  filter: string;
  done: boolean;
  cancelled: boolean;
}

export function visibleIndices<T>(choices: Choice<T>[], filter: string): number[] {
  const q = filter.trim().toLowerCase();
  const out: number[] = [];
  choices.forEach((c, i) => {
    if (q.length === 0 || c.label.toLowerCase().includes(q)) out.push(i);
  });
  return out;
}
```

`initialState` gains `filter: ''`, and its cursor is the position of the first enabled choice **within the unfiltered view**, which is the same index it computes today.

Replace `move` and `reduce`:

```ts
/** Moves within the filtered view, skipping disabled entries. Wraps. */
function move<T>(choices: Choice<T>[], view: number[], from: number, delta: number): number {
  const n = view.length;
  if (n === 0) return 0;
  let i = from;
  for (let step = 0; step < n; step++) {
    i = (i + delta + n) % n;
    if (!choices[view[i]].disabled) return i;
  }
  return from;
}

function withFilter<T>(state: ListState, choices: Choice<T>[], filter: string): ListState {
  const view = visibleIndices(choices, filter);
  return { ...state, filter, cursor: view.length === 0 ? 0 : Math.min(state.cursor, view.length - 1) };
}

export function reduce<T>(
  state: ListState,
  key: ListKey,
  choices: Choice<T>[],
  multi: boolean,
): ListState {
  const view = visibleIndices(choices, state.filter);
  const under = view[state.cursor];

  switch (key.kind) {
    case 'up':
      return { ...state, cursor: move(choices, view, state.cursor, -1) };
    case 'down':
      return { ...state, cursor: move(choices, view, state.cursor, +1) };
    case 'space': {
      if (!multi || under === undefined || choices[under].disabled) return state;
      const checked = new Set(state.checked);
      if (checked.has(under)) checked.delete(under);
      else checked.add(under);
      return { ...state, checked };
    }
    case 'enter': {
      if (multi) return { ...state, done: true };
      if (under === undefined || choices[under].disabled) return state;
      return { ...state, checked: new Set([under]), done: true };
    }
    case 'char':
      return multi ? withFilter(state, choices, state.filter + key.value) : state;
    case 'backspace':
      return multi ? withFilter(state, choices, state.filter.slice(0, -1)) : state;
    case 'cancel':
      return { ...state, cancelled: true, done: true };
    default:
      return state;
  }
}
```

- [ ] **Step 5: Render the filter and the counts**

In `renderList`, window over the filtered view and show the filter line for multiselect:

```ts
  const view = visibleIndices(choices, state.filter);
  const win = viewport(state.cursor, view.length, height);
  const lines: string[] = [`  ${title}`, ''];
  if (multi) lines.push(`  filter: ${state.filter}█`, '');

  if (win.above > 0) lines.push(`    ↑ ${win.above} more`);
  for (let i = win.start; i < win.end; i++) {
    const orig = view[i];
    const choice = choices[orig];
    const pointer = i === state.cursor ? '❯' : ' ';
    const mark = multi ? (state.checked.has(orig) ? '◉' : '○') : '';
    const hint = choice.hint ? `  · ${choice.hint}` : '';
    const label = choice.disabled ? `${choice.label} (unavailable)` : choice.label;
    lines.push(`  ${pointer} ${mark} ${label}${hint}`.replace(/\s+$/, ''));
  }
  if (win.below > 0) lines.push(`    ↓ ${win.below} more`);

  lines.push('');
  lines.push(multi
    ? `  ${view.length} of ${choices.length} · space toggle · type to filter · enter confirm · esc cancel`
    : '  ↑↓ move · enter select · esc cancel');
  return lines.join('\n');
```

In `runList`, pass `multi` as the `filterable` argument:

```ts
    state = reduce(state, parseKey(chunk, multi), choices, multi);
```

Finally, `[...state.checked]` in `runList` already maps original indices to values, which stays correct.

- [ ] **Step 6: Update the pre-existing key and reducer tests**

The `parseKey` and `reduce` describe blocks at the top of `tests/tui.test.ts` pass string keys. Update them: `parseKey('\u001b[A')` becomes `parseKey('\u001b[A', false)` and asserts `{ kind: 'up' }`; `reduce(s, 'up', CHOICES, true)` becomes `reduce(s, { kind: 'up' }, CHOICES, true)`. The `renderList` assertions are unaffected except that multiselect output now also contains a `filter:` line.

- [ ] **Step 7: Run the full suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 8: Typecheck and commit**

```bash
npx tsc --noEmit && npx vitest run
git add src/tui.ts tests/tui.test.ts
git commit -m "$(cat <<'EOF'
feat: type-to-filter for multiselect lists

341 models in one list cannot be reached by arrow keys. Letters now type
into a filter, which costs j/k navigation in multiselect; select keeps
them, since a three-item list has nothing to narrow. Space still
toggles, because no ref contains a space.

checked holds original indices, so filtering can never disturb a
selection the user already made.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0119sDQT9AWqPyL87rHHtkFN
EOF
)"
```

---

### Task 11: Fetching both catalogues

**Files:**
- Modify: `src/detect.ts:114-190`
- Test: `tests/init.test.ts`

**Interfaces:**
- Consumes: `parseOpenCodeRefs` (Task 1), `parsePiRefs` (Task 2), `parseOpenCodeModels` (kept, for display names).
- Produces: `HarnessStatus.models: OpenCodeModel[]` is replaced by `HarnessStatus.refs: ModelRef[]`. New `detectPi(env: DetectEnv): Promise<HarnessStatus>`. New `detectHarnesses(env: DetectEnv): Promise<HarnessStatus[]>` returning both, absent harnesses included with `installed: false` and no problems.

- [ ] **Step 1: Write the failing test**

Append to `tests/init.test.ts`:

```ts
describe('HarnessStatus.refs', () => {
  it('carries refs rather than bare model ids', async () => {
    // Detection shells out, so this asserts the shape the fakes must satisfy.
    const status = {
      name: 'opencode', installed: true, supported: true,
      refs: parseOpenCodeRefs('openrouter/kimi-k3\n'),
      authedProviders: ['openrouter'], problems: [],
    };
    expect(status.refs[0].ref).toBe('openrouter/kimi-k3');
  });
});
```

This is a shape guard rather than a behaviour test; the behaviour is covered by `cmdInit` in Task 12 through the injected detector.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc --noEmit`
Expected: FAIL once `refs` replaces `models` in the interface and call sites still say `models`. Use the typecheck as the failing signal here — this task is a type-level change with no new runtime branch of its own.

- [ ] **Step 3: Reshape `HarnessStatus` and add the catalogue fetch**

In `src/detect.ts`:

```ts
export interface HarnessStatus {
  name: string;
  installed: boolean;
  version?: string;
  supported: boolean;
  binPath?: string;
  refs: ModelRef[];
  authedProviders: string[];
  problems: Problem[];
}
```

In `detectOpenCode`, replace the `opencode.json` model read with a catalogue fetch, keeping the config read only for display names:

```ts
  const listing = await tryRun('opencode', ['models'], { ...process.env, PATH: path });
  const refs = listing === null ? [] : parseOpenCodeRefs(listing);

  // The CLI emits no display names; the config has them for custom providers.
  const configPath = join(env.home, '.config', 'opencode', 'opencode.json');
  const named = existsSync(configPath)
    ? parseOpenCodeModels(readFileSync(configPath, 'utf8'))
    : [];
  for (const ref of refs) {
    ref.name = named.find((m) => m.provider === ref.provider && m.id === ref.id)?.name;
  }

  const authPath = join(env.home, '.local', 'share', 'opencode', 'auth.json');
  const authedProviders = existsSync(authPath)
    ? parseAuthedProviders(readFileSync(authPath, 'utf8'))
    : [];

  if (refs.length === 0) {
    problems.push({
      severity: 'error',
      message: 'opencode reported no models',
      fix: 'opencode auth login',
    });
  }
```

Delete the `authedProviders.length === 0` branch: an unauthed install now simply offers only the free tier, which `offerableProviders` already handles.

Add pi detection:

```ts
import { parsePiRefs } from './adapters/pi.js';

export async function detectPi(env: DetectEnv): Promise<HarnessStatus> {
  const path = `${join(env.home, '.local', 'bin')}:${process.env.PATH ?? ''}`;
  const version = await tryRun('pi', ['--version'], { ...process.env, PATH: path });

  // Absence is not an error. A machine with only opencode is normal.
  if (version === null) {
    return { name: 'pi', installed: false, supported: false, refs: [], authedProviders: [], problems: [] };
  }

  // Pi can block when a provider is unreachable, and doctor must never hang.
  const listing = await tryRun('pi', ['--list-models'], { ...process.env, PATH: path });
  const problems: Problem[] = [];
  if (listing === null) {
    problems.push({
      severity: 'warn',
      message: 'pi is installed but did not list any models',
      fix: 'pi auth check --provider <name>',
    });
  }

  return {
    name: 'pi',
    installed: true,
    version,
    supported: true,
    refs: listing === null ? [] : parsePiRefs(listing),
    authedProviders: [],
    problems,
  };
}

export async function detectHarnesses(env: DetectEnv): Promise<HarnessStatus[]> {
  return Promise.all([detectOpenCode(env), detectPi(env)]);
}
```

`tryRun` already swallows failures and returns `null`, so no new timeout plumbing is needed for `--version`. For `--list-models`, pass a timeout so a hung provider cannot stall `init`:

```ts
async function tryRunLimited(cmd: string, args: string[], env: NodeJS.ProcessEnv, ms: number): Promise<string | null> {
  try {
    const { stdout } = await run(cmd, args, { env, timeout: ms });
    return stdout.trim();
  } catch {
    return null;
  }
}
```

Use `tryRunLimited('pi', ['--list-models'], { ...process.env, PATH: path }, 5_000)`.

- [ ] **Step 4: Fix every call site the typechecker names**

`npx tsc --noEmit` will list them. Expect `src/commands/init.ts` (`oc.models`) and any doctor or test double constructing a `HarnessStatus`. Rename `models:` to `refs:` and supply refs.

- [ ] **Step 5: Run the full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/detect.ts src/adapters/pi.ts tests/init.test.ts
git commit -m "$(cat <<'EOF'
feat: read both harness catalogues from their CLIs

opencode.json declares only custom providers, so config parsing saw 31
of 496 models — everything behind a built-in provider was invisible.
`opencode models` and `pi --list-models` report what each harness can
actually run. The config is still read, but only for display names.

An absent harness contributes no providers and is not an error.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0119sDQT9AWqPyL87rHHtkFN
EOF
)"
```

---

### Task 12: The two-step `init` flow

**Files:**
- Modify: `src/commands/init.ts` (`Detection`, `defaultDetector`, `InitOptions`, `cmdInit`)
- Modify: `src/cli.ts:25-30, 45-70`
- Modify: `README.md:103-122`
- Test: `tests/init.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `Detection { tmux: {...}; harnesses: HarnessStatus[] }`. `InitOptions` gains `providers?: string[]` (picker keys, `harness/provider`). `InitResult.models` holds config keys, as today.

- [ ] **Step 1: Write the failing test**

Re-enable the tests skipped in Task 6, updating them for refs, and append:

```ts
describe('cmdInit — provider selection', () => {
  const detect = async () => ({
    tmux: { installed: true, version: '3.7b', problems: [] },
    harnesses: [
      {
        name: 'opencode', installed: true, version: '1.18.16', supported: true,
        refs: parseOpenCodeRefs('openrouter/grok-4.5\nopencode-go/grok-4.5\n'),
        authedProviders: ['openrouter', 'opencode-go'], problems: [],
      },
      {
        name: 'pi', installed: true, version: '0.84.0', supported: true,
        refs: parsePiRefs('provider  model\nopencode-go  grok-4.5\n'),
        authedProviders: [], problems: [],
      },
    ],
  });

  it('enables the chosen provider\'s copy and writes the ref', async () => {
    const res = await cmdInit({
      cwd, home, packageRoot: '/pkg', yes: true, detect,
      providers: ['opencode/openrouter'], models: ['opencode-openrouter-grok-4.5'],
      roles: ['code'], scope: 'skip', write,
    });

    expect(res.models).toEqual(['opencode-openrouter-grok-4.5']);
    const cfg = parseConfig(readFileSync(join(cwd, 'sonata.toml'), 'utf8'));
    expect(cfg.models['opencode-openrouter-grok-4.5'].id).toBe('openrouter/grok-4.5');
  });

  it('keeps the same model from two harnesses as two entries', async () => {
    await cmdInit({
      cwd, home, packageRoot: '/pkg', yes: true, detect,
      providers: ['opencode/opencode-go', 'pi/opencode-go'],
      models: ['opencode-opencode-go-grok-4.5', 'pi-opencode-go-grok-4.5'],
      roles: ['code'], scope: 'skip', write,
    });

    const cfg = parseConfig(readFileSync(join(cwd, 'sonata.toml'), 'utf8'));
    expect(cfg.models['opencode-opencode-go-grok-4.5'].harness).toBe('opencode');
    expect(cfg.models['pi-opencode-go-grok-4.5'].harness).toBe('pi');
  });

  it('carries a hand-written codex entry through a re-run', async () => {
    writeFileSync(join(cwd, 'sonata.toml'), `
[models."gpt-5-6-sol"]
harness = "codex"
id = "gpt-5.6-sol"

[generate]
roles = ["code"]
models = ["gpt-5-6-sol"]
`);
    await cmdInit({
      cwd, home, packageRoot: '/pkg', yes: true, detect,
      providers: ['opencode/openrouter'], models: ['opencode-openrouter-grok-4.5'],
      roles: ['code'], scope: 'skip', write,
    });

    const cfg = parseConfig(readFileSync(join(cwd, 'sonata.toml'), 'utf8'));
    expect(cfg.models['gpt-5-6-sol'].id).toBe('gpt-5.6-sol');
    expect(cfg.generate.models).toContain('gpt-5-6-sol');
  });

  it('pre-selects an enabled ref on a re-run', async () => {
    const args = {
      cwd, home, packageRoot: '/pkg', yes: true, detect,
      roles: ['code'], scope: 'skip' as const, write,
    };
    await cmdInit({ ...args, providers: ['opencode/openrouter'], models: ['opencode-openrouter-grok-4.5'] });
    const second = await cmdInit(args);

    expect(second.models).toEqual(['opencode-openrouter-grok-4.5']);
  });

  it('rejects a model no offered provider serves', async () => {
    await expect(cmdInit({
      cwd, home, packageRoot: '/pkg', yes: true, detect,
      providers: ['opencode/openrouter'], models: ['nope'], roles: ['code'], scope: 'skip', write,
    })).rejects.toThrow(/does not offer nope/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/init.test.ts -t "provider selection"`
Expected: FAIL — `cmdInit` has no `providers` option and `Detection` has no `harnesses`.

- [ ] **Step 3: Reshape `Detection` and `InitOptions`**

```ts
export interface Detection {
  tmux: { installed: boolean; version?: string; problems: Problem[] };
  harnesses: HarnessStatus[];
}

export const defaultDetector: Detector = async (env) => ({
  tmux: await detectTmux(),
  harnesses: await detectHarnesses(env),
});
```

In `InitOptions`, add:

```ts
  /** Picker keys, `harness/provider`. Non-interactive override. */
  providers?: string[];
```

- [ ] **Step 4: Rewrite the selection block of `cmdInit`**

Replace the detection banner and the model-selection block:

```ts
  const { tmux, harnesses } = await detect({ home: opts.home, supportedVersions: OPENCODE_RANGE });
  const problems: Problem[] = [...tmux.problems, ...harnesses.flatMap((h) => h.problems)];

  out(tmux.installed ? `  ✓ tmux ${tmux.version}` : '  ✗ tmux not found');
  for (const h of harnesses) {
    out(h.installed
      ? `  ✓ ${h.name} ${h.version} · ${h.refs.length} models`
      : `  · ${h.name} not installed`);
  }
  out('');

  const allRefs = harnesses.flatMap((h) => h.refs);
  const authed = harnesses.flatMap((h) => h.authedProviders);
  const offered = offerableProviders(allRefs, authed);

  if (offered.length === 0) {
    problems.push({
      severity: 'error',
      message: 'no harness reported a usable model provider',
      fix: 'opencode auth login',
    });
  }
```

Keep the existing blocking-problem early return, then:

```ts
  const configPath = join(opts.cwd, 'sonata.toml');
  const configText = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  const enabled = preTickedRefs(configText, allRefs);

  // ---- choose providers -------------------------------------------------
  let providerKeys: string[];
  if (opts.providers) {
    providerKeys = opts.providers;
  } else if (interactive) {
    providerKeys = await multiselect(
      'Providers',
      offered.map((p) => ({
        value: p.key,
        label: `${p.harness} · ${p.provider}`,
        hint: `${p.count} models`,
        checked: allRefs.some((r) => `${r.harness}/${r.provider}` === p.key && enabled.has(r.ref)),
      })),
    );
  } else {
    providerKeys = offered
      .filter((p) => allRefs.some((r) => `${r.harness}/${r.provider}` === p.key && enabled.has(r.ref)))
      .map((p) => p.key);
  }

  const unknownProviders = providerKeys.filter((k) => !offered.some((p) => p.key === k));
  if (unknownProviders.length > 0) {
    throw new Error(
      `sonata init: no harness offers ${unknownProviders.join(', ')}. ` +
      `Available: ${offered.map((p) => p.key).join(', ')}`,
    );
  }

  const inScope = allRefs.filter((r) => providerKeys.includes(`${r.harness}/${r.provider}`));

  // ---- choose models ----------------------------------------------------
  let keys: string[];
  if (opts.models) {
    keys = opts.models;
  } else if (interactive) {
    keys = await multiselect(
      'Models to enable',
      inScope.map((r) => ({
        value: configKeyFor(r),
        label: r.ref,
        hint: r.name,
        checked: enabled.has(r.ref),
      })),
    );
  } else {
    keys = inScope.filter((r) => enabled.has(r.ref)).map(configKeyFor);
  }

  const byKey = new Map(inScope.map((r) => [configKeyFor(r), r]));
  const unknown = keys.filter((k) => !byKey.has(k));
  if (unknown.length > 0) {
    throw new Error(
      `sonata init: the selected providers do not offer ${unknown.join(', ')}. ` +
      `Available: ${[...byKey.keys()].join(', ')}`,
    );
  }
  if (keys.length === 0) {
    throw new Error('sonata init: no models selected — nothing to generate.');
  }

  const chosen = keys.map((k) => byKey.get(k)!);
```

Before writing, check collisions across everything about to be written:

```ts
  const carried = carriedEntries(configText, ['opencode', 'pi']);
  const clashes = duplicateKeys([...keys, ...Object.keys(carried)]);
  if (clashes.length > 0) {
    throw new Error(
      `sonata init: ${clashes.join(', ')} would name two different models. ` +
      'Rename the hand-written entry, or enable only one of the colliding refs.',
    );
  }
```

and write:

```ts
  writeFileSync(configPath, tomlFor(chosen, roles, carried));
```

`InitResult.models` becomes `keys`. The summary line becomes:

```ts
  out(`    models  ${chosen.map((r) => r.ref).join(', ')}`);
```

- [ ] **Step 5: Add the `--providers` flag**

In `src/cli.ts`, add `providers: { type: 'string' }` to the `parseArgs` options, pass `providers: split(values.providers)` into `cmdInit`, and extend the usage text:

```
  init flags (skip the prompts):
    --yes                    accept defaults, no prompts
    --providers opencode/openrouter,pi/opencode-go   providers to draw models from
    --models a,b             models to enable (config keys)
    --roles code,review      roles to generate
    --scope project|global|skip   where to install the permission hook
```

- [ ] **Step 6: Run the full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 7: Update the README**

Replace the "Adding Codex or Pi models" section (lines 103-122). Pi is now discovered by the wizard; only codex is hand-written, and it survives a re-run:

````markdown
### Adding Codex models

**The wizard discovers OpenCode and Pi models.** Both are picked by provider,
then by model. Codex has no provider dimension and takes a bare model id, so
codex models are still added to `sonata.toml` by hand:

```toml
[models."gpt-5-6-sol"]
harness = "codex"
id = "gpt-5.6-sol"
```

Hand-written entries survive `sonata init` — the wizard carries through any
model whose harness it does not manage, and adds it to `generate.models`.

Then `sonata sync` to regenerate the agent files, and restart Claude Code.
````

Also update the `sonata init --yes` example on line 100 to use ref-shaped keys:

```
sonata init --yes --providers opencode/openrouter --models opencode-openrouter-kimi-k3 --roles code,review --scope project
```

- [ ] **Step 8: Commit and push**

```bash
npx tsc --noEmit && npx vitest run
git add src/commands/init.ts src/cli.ts README.md tests/init.test.ts
git commit -m "$(cat <<'EOF'
feat: pick a provider, then a model, in sonata init

Providers are listed as `harness · provider` across opencode and pi, so
the same model served by three providers is three independent choices.
The config key is harness-qualified, and everything about to be written
is checked for key collisions first.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0119sDQT9AWqPyL87rHHtkFN
EOF
)"
git push origin main
```

---

### Task 13: Verify against the real harnesses

The pi table format is the one thing this plan could not verify: pi is not installed on the development machine, and the fixture it is built from was written from memory rather than captured.

**Files:**
- Modify: `src/adapters/pi.ts` (only if the real format differs)
- Modify: `tests/adapters/pi.test.ts`

- [ ] **Step 1: Capture real pi output**

On a machine with pi installed:

```bash
pi --list-models | head -20
```

- [ ] **Step 2: Compare against the fixture**

The fixture assumes whitespace-aligned columns with `provider` first and `model` second. If the real output is delimited differently, or orders the columns differently, only `parsePiRefs` changes — nothing downstream depends on the table shape.

- [ ] **Step 3: Replace the fixture with captured output**

Update `HEADER` and the sample rows in `tests/adapters/pi.test.ts` to the real strings, and adjust `parsePiRefs` if needed. Run `npx vitest run tests/adapters/pi.test.ts`.

- [ ] **Step 4: Run `sonata init` end to end**

```bash
npx tsx src/cli.ts init
```

Walk providers → models → hook scope → confirm. Verify the written `sonata.toml` has quoted, harness-qualified keys and refs in `id`, then dispatch one run:

```bash
npx tsx src/cli.ts run --role explore --model <key> --task "list the files in src/"
```

Confirm from `.sonata/runs/<id>/harness.sh` that `-m` or `--model` carries the full ref.

- [ ] **Step 5: Commit and push**

```bash
git add tests/adapters/pi.test.ts src/adapters/pi.ts
git commit -m "$(cat <<'EOF'
test: replace the pi listing fixture with captured output

The parser was written against a fixture composed from memory, since pi
was not installed on the development machine. This replaces it with real
`pi --list-models` output.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0119sDQT9AWqPyL87rHHtkFN
EOF
)"
git push origin main
```

---

## Self-Review

**Spec coverage.** Every section maps to a task: catalogue sources → 1, 2, 11; auth filter asymmetry → 3; merged provider list → 12; harness-qualified key → 4; non-injective flattening → 4, 12; pre-ticking on `(harness, id)` → 5; carrying hand-written entries → 6; harness-aware bare-id rejection → 8; adapter prefix → 7; viewport → 9; filter → 10; `Detection` reshape → 11; `--providers` and README → 12; the pi format risk → 13.

**Placeholders.** None. Every code step carries the code; every test step carries the test.

**Type consistency.** `ModelRef` is defined once in Task 1 and used unchanged throughout. `configKeyFor` takes a `ModelRef` in Tasks 4, 6, and 12. `duplicateKeys` takes `string[]` in Tasks 4 and 12. `HarnessStatus.refs` replaces `.models` in Task 11 and is consumed as `.refs` in Task 12. `parseKey` gains its second parameter in Task 10 and every call site is updated in that same task.

**Known temporary breakage.** Tasks 5 and 6 stub their `cmdInit` call sites so each commit stays green; Task 12 removes both stubs and re-enables the tests skipped in Task 6. This is called out in the steps so a fresh implementer does not mistake it for an oversight.
