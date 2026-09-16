# Three Tiers (simple / normal / complex) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional third tier, `normal`, ranked by capability per task-dollar, between `simple` (the same ranking under a cost cap) and `complex` (capability).

**Architecture:** Each tier becomes one pure sort key over the two quantities AA publishes. `normal` is optional everywhere — an existing config parses, syncs and routes unchanged — so there is no `schema_version` bump and no migration. `simple` is derived from `normal` by a cost filter, which makes the prefix property structural rather than incidental and guarantees the tier can never be empty.

**Tech Stack:** TypeScript (Node 22+), vitest, Ink for the wizard TUI.

**Spec:** `docs/superpowers/specs/2026-09-16-three-tiers-design.md` — read it first; the reasoning behind every constant here lives there.

## Global Constraints

- `normal` is **optional**. `simple` and `complex` stay required. Absent and present-but-empty are different states: absent is valid, empty is refused.
- **No `schema_version` bump, no migration.** A config without `normal` must parse, sync the same 8 agents, and route identically.
- `SIMPLE_COST_CEILING` stays **12**, re-anchored to the best-value model's `costPerTask`.
- `SIMPLE_CAPABILITY_FLOOR` is **retired** — delete the constant and its export.
- The ceiling multiplier must be **>= 1**, so the anchor always clears its own cap and `simple` is never empty.
- Never fall back from a `-normal` alias to another tier. An alias that cannot resolve returns `undefined`.
- Do not weaken or delete an existing test. Where one encodes two-tier behaviour, it changes because behaviour changed — say so in the commit.
- `npm test` and `npm run typecheck` pass **at integration**, not necessarily at
  every commit. Widening `TIER_NAMES` in Task 1 is a type error in
  `src/commands/agents.ts`, `src/commands/sync.ts` and
  `src/tui-ink/agents-app.tsx` until Tasks 5 and 8 land — measured, 7 errors. A
  task commits when its **own** tests pass and typecheck reports no error *in
  the files it owns*; the wave owner runs the full suite once the wave closes.
  Do not reach into another task's file to silence a type error. `sonata` on PATH runs `dist/`, so `npm run build` before any manual CLI check.
- Tests need no API keys; use the fixtures in `tests/fixtures/aa/`.
- **Mutation-check every new assertion before committing it.** Delete or soften
  the behaviour it covers, confirm the test fails, restore, confirm it passes.
  An assertion that still passes with its feature removed is the defect this
  repository's last two reviews both caught; a test costs nothing and proves
  nothing if it never bites.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/config.ts` | `TIER_NAMES`, `TierLists`, `tiersCollapse`, tier parsing, `resolveTierAlias` | 1, 2 |
| `src/catalog.ts` | `proposeTiers` returns three lists; ceiling re-anchored; floor retired | 3 |
| `src/init/toml.ts` | `nativeTomlFor` and `replaceTiersBlock` emit `normal` | 4 |
| `src/commands/sync.ts` | generate `<role>-normal` agents; rewrite tier descriptions | 5 |
| `src/init/guidance.ts` | the managed `CLAUDE.md` block names three tiers | 6 |
| `src/tui-ink/app.tsx`, `src/tui-ink/app-state.ts` | 12 ranking screens; bulk accept covers three tiers | 7 |
| `src/init/plan.ts` | assembles the config `sonata init` writes — must emit `normal` | 11 |
| `src/commands/agents.ts`, `src/tui-ink/agents-app.tsx`, `src/commands/doctor.ts` | editor rows, the editor TUI, doctor reporting | 8 |
| `skills/loop/SKILL.md` | escalation ladder gains a rung | 9 |
| `CLAUDE.md`, `README.md`, `docs/guide/*`, `docs/HANDOFF.md`, `CHANGELOG.md` | prose | 10 |

---

### Task 1: Config accepts an optional `normal` tier

**Files:**
- Modify: `src/config.ts:27` (`TIER_NAMES`), `src/config.ts:41-44` (`tiersCollapse`), `src/config.ts:80` (`TierLists`), `src/config.ts:390-427` (tier parsing)
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `TIER_NAMES: readonly ['simple', 'normal', 'complex']`; `interface TierLists { simple: string[]; normal?: string[]; complex: string[] }`; `tiersCollapse(lists: TierLists): boolean`

- [ ] **Step 1: Write the failing tests**

```ts
it('accepts a config with no normal tier', () => {
  const config = parseConfig(`
[models."a"]
gateway = "gw"
id = "a"
[native.gateways."gw"]
base_url = "https://example.test/v1"
[tiers.code]
simple = ["a"]
complex = ["a"]
`);
  expect(config.tiers?.code.normal).toBeUndefined();
});

it('accepts and validates a normal tier', () => {
  const config = parseConfig(`
[models."a"]
gateway = "gw"
id = "a"
[native.gateways."gw"]
base_url = "https://example.test/v1"
[tiers.code]
simple = ["a"]
normal = ["a"]
complex = ["a"]
`);
  expect(config.tiers?.code.normal).toEqual(['a']);
});

it('refuses an empty normal tier', () => {
  // Absent and empty are different states: absent means "this config predates
  // the tier", empty means "the author wrote a list with nothing in it".
  expect(() => parseConfig(`
[models."a"]
gateway = "gw"
id = "a"
[native.gateways."gw"]
base_url = "https://example.test/v1"
[tiers.code]
simple = ["a"]
normal = []
complex = ["a"]
`)).toThrow(/tiers\.code\.normal/);
});

it('refuses an unknown model in the normal tier', () => {
  expect(() => parseConfig(`
[models."a"]
gateway = "gw"
id = "a"
[native.gateways."gw"]
base_url = "https://example.test/v1"
[tiers.code]
simple = ["a"]
normal = ["nope"]
complex = ["a"]
`)).toThrow(/unknown model "nope"/);
});

it('collapses only when every present list is identical', () => {
  expect(tiersCollapse({ simple: ['a'], complex: ['a'] })).toBe(true);
  expect(tiersCollapse({ simple: ['a'], normal: ['a'], complex: ['a'] })).toBe(true);
  expect(tiersCollapse({ simple: ['a'], normal: ['a', 'b'], complex: ['a'] })).toBe(false);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/config.test.ts -t normal`
Expected: FAIL — `normal` is not read, and the empty-list case does not throw.

- [ ] **Step 3: Implement**

In `src/config.ts`:

```ts
export const TIER_NAMES = ['simple', 'normal', 'complex'] as const;

export interface TierLists { simple: string[]; normal?: string[]; complex: string[] }
```

`tiersCollapse` compares every list the role actually has — a role with no
`normal` must still collapse on two:

```ts
export function tiersCollapse(lists: TierLists): boolean {
  const present = [lists.simple, lists.normal, lists.complex].filter(
    (list): list is string[] => list !== undefined,
  );
  const [first, ...rest] = present;
  if (first === undefined) return false;
  return rest.every((list) =>
    list.length === first.length && list.every((key, index) => key === first[index]));
}
```

In the tier-parsing block (`src/config.ts:390-427`), keep the existing
required-list check for `simple`/`complex`, then add `normal` beside it:

```ts
      const normal = d.normal;
      // Absent is valid — a config predating the third tier. Present means it
      // must satisfy exactly what the other two do.
      if (normal !== undefined &&
          (!Array.isArray(normal) || normal.length === 0 || !normal.every((key) => typeof key === 'string'))) {
        throw new Error(`sonata.toml: tiers.${role}.normal must be a non-empty list of model keys, or absent.`);
      }
```

Extend the per-candidate validation loop to include `normal` when present:

```ts
      const lists: [string, string[]][] = [['simple', simple], ['complex', complex]];
      if (normal !== undefined) lists.push(['normal', normal as string[]]);
      for (const [tier, keys] of lists) {
```

and the assignment:

```ts
      tiers[role] = { simple, complex, ...(normal === undefined ? {} : { normal: normal as string[] }) };
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/config.test.ts` then `npm run typecheck`
Expected: PASS. Typecheck will surface every site that destructures `TierLists`; leave those to their own tasks unless the fix is a one-line optional guard.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat(config): accept an optional normal tier"
```

---

### Task 2: `resolveTierAlias` resolves `-normal`, and refuses to substitute

**Files:**
- Modify: `src/config.ts:775-805`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: `TIER_NAMES`, `TierLists` from Task 1
- Produces: `resolveTierAlias(config, 'sonata-<role>-normal')` returning `{ role, tier: 'normal', routes: TierRoute[] }` or `undefined`

- [ ] **Step 1: Write the failing tests**

```ts
it('resolves a normal alias to its own list', () => {
  const config = parseConfig(withTiers({ simple: ['a'], normal: ['b'], complex: ['c'] }));
  expect(resolveTierAlias(config, 'sonata-code-normal')?.routes.map((r) => r.key)).toEqual(['b']);
});

it('returns undefined for a normal alias on a config without one', () => {
  // Never substitute another tier: serving a different ranking than the alias
  // names is silent, and the caller has no way to see it happened.
  const config = parseConfig(withTiers({ simple: ['a'], complex: ['c'] }));
  expect(resolveTierAlias(config, 'sonata-code-normal')).toBeUndefined();
});

it('still resolves the unsuffixed alias when all three lists match', () => {
  const config = parseConfig(withTiers({ simple: ['a'], normal: ['a'], complex: ['a'] }));
  expect(resolveTierAlias(config, 'sonata-code')?.tier).toBe('complex');
});

it('refuses the unsuffixed alias when normal differs', () => {
  const config = parseConfig(withTiers({ simple: ['a'], normal: ['a', 'b'], complex: ['a'] }));
  expect(resolveTierAlias(config, 'sonata-code')).toBeUndefined();
});
```

Add the helper at the top of the describe block:

```ts
const withTiers = (lists: { simple: string[]; normal?: string[]; complex: string[] }): string => {
  const keys = [...new Set([...lists.simple, ...(lists.normal ?? []), ...lists.complex])];
  const models = keys.map((k) => `[models."${k}"]\ngateway = "gw"\nid = "${k}"`).join('\n');
  const normal = lists.normal === undefined ? '' : `normal = [${lists.normal.map((k) => `"${k}"`).join(', ')}]\n`;
  return `${models}
[native.gateways."gw"]
base_url = "https://example.test/v1"
[tiers.code]
simple = [${lists.simple.map((k) => `"${k}"`).join(', ')}]
${normal}complex = [${lists.complex.map((k) => `"${k}"`).join(', ')}]
`;
};
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/config.test.ts -t alias`
Expected: FAIL — `sonata-code-normal` currently parses as role `code-normal` and resolves to `undefined` for the wrong reason, so assert the *positive* case fails first.

- [ ] **Step 3: Implement**

The suffix loop already walks `TIER_NAMES`, so Task 1's constant makes
`-normal` split correctly. Replace the list selection (`src/config.ts:797`):

```ts
  const keys = tier === 'simple' ? lists.simple : tier === 'normal' ? lists.normal : lists.complex;
  // A role with no `normal` cannot serve a `-normal` alias, and must not quietly
  // serve a different one instead.
  if (keys === undefined) return undefined;
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/config.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat(config): resolve a -normal alias, never substituting another tier"
```

---

### Task 3: `proposeTiers` returns three lists

**Files:**
- Modify: `src/catalog.ts:496` (`TierProposal`), `src/catalog.ts:162` (delete `SIMPLE_CAPABILITY_FLOOR`), `src/catalog.ts:730-785` (tier construction)
- Test: `tests/catalog.test.ts`

**Interfaces:**
- Consumes: `valueOf`, `byValue`, `byCapability`, `scoreFor`, `lookupModel` (all already in `src/catalog.ts`)
- Produces: `interface TierProposal { simple: string[]; normal: string[]; complex: string[] }`

- [ ] **Step 1: Write the failing tests**

```ts
const aa: AaCatalog = { fetchedAt: '2026-09-16T00:00:00Z', models: {
  // One family at several efforts: capability nearly flat, cost spread wide.
  'flash-low':  { codingIndex: 44, blendedPriceUsd: 1, costPerTask: 0.010 },
  'flash-high': { codingIndex: 63, blendedPriceUsd: 1, costPerTask: 0.044 },
  'pro-max':    { codingIndex: 77, blendedPriceUsd: 1, costPerTask: 1.399 },
} };

it('ranks normal by value and complex by capability', () => {
  const p = proposeTiers(['flash-low', 'flash-high', 'pro-max'], aa);
  expect(p.normal).toEqual(['flash-low', 'flash-high', 'pro-max']);
  expect(p.complex).toEqual(['pro-max', 'flash-high', 'flash-low']);
});

it('makes simple a cost-capped prefix of normal', () => {
  // 12 x $0.010 = $0.120, so pro-max is out and the order is normal's.
  const p = proposeTiers(['flash-low', 'flash-high', 'pro-max'], aa);
  expect(p.simple).toEqual(['flash-low', 'flash-high']);
  expect(p.normal.slice(0, p.simple.length)).toEqual(p.simple);
});

it('always admits the anchor, so simple is never empty', () => {
  // Every model expensive: the cap is 12x the best-value model's own cost, and
  // that model therefore always clears it.
  const dear: AaCatalog = { fetchedAt: 'x', models: {
    'a': { codingIndex: 70, blendedPriceUsd: 1, costPerTask: 9.5 },
    'b': { codingIndex: 60, blendedPriceUsd: 1, costPerTask: 40 },
  } };
  const p = proposeTiers(['a', 'b'], dear);
  expect(p.simple.length).toBeGreaterThan(0);
  expect(p.simple[0]).toBe(p.normal[0]);
});

it('diverges from normal on a heterogeneous set', () => {
  // Capability varies at similar cost, which is what makes the tiers differ.
  const mixed: AaCatalog = { fetchedAt: 'x', models: {
    'glm':  { codingIndex: 58, blendedPriceUsd: 1, costPerTask: 0.09 },
    'luna': { codingIndex: 76, blendedPriceUsd: 1, costPerTask: 0.11 },
  } };
  const p = proposeTiers(['glm', 'luna'], mixed);
  expect(p.normal[0]).toBe('luna');
  expect(p.complex[0]).toBe('luna');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/catalog.test.ts -t "normal"`
Expected: FAIL — `p.normal` is `undefined`.

- [ ] **Step 3: Implement**

Replace the tier-construction block at the end of `proposeTiers`. Delete
`preferred`/`leaders`/`best`/`eligible`/`isCheap`/`costs`/`ceiling` and the
`SIMPLE_CAPABILITY_FLOOR` export, and write:

```ts
  const capable = (k: string): boolean => lookupModel(k, aa, providers, upstreamFor).capable;
  const perTask = (k: string): number | undefined => scoreFor(k, aa, providers, upstreamFor)?.costPerTask;

  const complex = candidates.filter(capable).sort(byCapability);
  const normal = candidates.filter(capable).sort(byValue);

  // The cap is anchored to the best-value model that can actually lead — an
  // avoided one setting the bar would move it for models the user asked to
  // demote. At a multiplier >= 1 the anchor always clears its own cap, so
  // `simple` is non-empty whenever `normal` is, on every config, with no
  // fallback rule needed.
  const anchor = normal.find((k) => !avoided.has(bareKey(k))) ?? normal[0];
  const anchorCost = anchor === undefined ? undefined : perTask(anchor);
  const ceiling = anchorCost === undefined ? undefined : anchorCost * SIMPLE_COST_CEILING;
  // Filtered from `normal` rather than re-sorted, which is what makes the
  // prefix property structural: `simple` cannot disagree with `normal` about
  // ordering because it never does its own sort.
  const simple = ceiling === undefined ? [] : normal.filter((k) => {
    const cost = perTask(k);
    return cost !== undefined && cost <= ceiling;
  });

  const complexFinal = complex.length > 0 ? complex : [...candidates].sort(byCapability);
  const normalFinal = normal.length > 0 ? normal : [...complexFinal].sort(byValue);
  const simpleFinal = simple.length > 0 ? simple : normalFinal;
  return { simple: simpleFinal, normal: normalFinal, complex: complexFinal };
```

Update the interface:

```ts
export interface TierProposal { simple: string[]; normal: string[]; complex: string[] }
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/catalog.test.ts && npm run typecheck`
Expected: PASS. Existing tests asserting the old floor behaviour will fail —
read each one, and where it encoded the floor, rewrite it to assert the new
rule and say why in the commit body. Do not delete a test to make it pass.

- [ ] **Step 5: Commit**

```bash
git add src/catalog.ts tests/catalog.test.ts
git commit -m "feat(catalog): propose three tiers, anchoring simple's cap to the best-value model"
```

---

### Task 4: The config writers emit `normal`

**Files:**
- Modify: `src/init/toml.ts:184` (`nativeTomlFor`), `src/init/toml.ts:273,308-312` (`replaceTiersBlock`)
- Test: `tests/init/toml.test.ts`

**Interfaces:**
- Consumes: `TierLists` (Task 1), `TierProposal` (Task 3)
- Produces: `replaceTiersBlock(existing: string, tiers: Record<string, TierLists>): string`

- [ ] **Step 1: Write the failing tests**

```ts
it('writes a normal tier and reads it back', () => {
  // The round trip is the test that matters: `sonata init` rewrites the whole
  // file, so a key it reads and does not write back is deleted on the next run.
  const toml = nativeTomlFor(configWith({ simple: ['a'], normal: ['a', 'b'], complex: ['b'] }));
  expect(parseConfig(toml).tiers?.code).toEqual({ simple: ['a'], normal: ['a', 'b'], complex: ['b'] });
});

it('omits normal entirely when a role has none', () => {
  const toml = nativeTomlFor(configWith({ simple: ['a'], complex: ['b'] }));
  expect(toml).not.toContain('normal');
  expect(parseConfig(toml).tiers?.code.normal).toBeUndefined();
});

it('replaceTiersBlock round-trips a normal tier', () => {
  const rewritten = replaceTiersBlock(existingToml, { code: { simple: ['a'], normal: ['a'], complex: ['b'] } });
  expect(parseConfig(rewritten).tiers?.code.normal).toEqual(['a']);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/init/toml.test.ts -t normal`
Expected: FAIL — the emitted TOML has no `normal` line.

- [ ] **Step 3: Implement**

`src/init/toml.ts:184`, inside `nativeTomlFor`:

```ts
    lines.push(
      `[tiers.${tomlKey(role)}]`,
      `simple = [${lists.simple.map(tomlKey).join(', ')}]`,
      ...(lists.normal === undefined ? [] : [`normal = [${lists.normal.map(tomlKey).join(', ')}]`]),
      `complex = [${lists.complex.map(tomlKey).join(', ')}]`,
      '',
    );
```

`src/init/toml.ts:308-312`, inside `replaceTiersBlock`, and widen its `tiers`
parameter type to `Record<string, TierLists>`:

```ts
  const block = Object.entries(tiers).flatMap(([role, lists]) => [
    `[tiers.${tomlKey(role)}]`,
    `simple = [${lists.simple.map(tomlKey).join(', ')}]`,
    ...(lists.normal === undefined ? [] : [`normal = [${lists.normal.map(tomlKey).join(', ')}]`]),
    `complex = [${lists.complex.map(tomlKey).join(', ')}]`,
    '',
  ]);
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/init/ && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/init/toml.ts tests/init/toml.test.ts
git commit -m "feat(init): write the normal tier back out"
```

---

### Task 5: `sync` generates normal agents and states how to choose a tier

**Files:**
- Modify: `src/commands/sync.ts` (`tierAgentMarkdown`, `cmdSync`'s role x tier loop)
- Test: `tests/commands/sync.test.ts`

**Interfaces:**
- Consumes: `TIER_NAMES`, `tiersCollapse` (Task 1)
- Produces: `tierAgentMarkdown(spec: { role: string; tier?: 'simple' | 'normal' | 'complex'; extendedContext?: boolean }): string`

- [ ] **Step 1: Write the failing tests**

```ts
it('generates a normal agent when the role has one', () => {
  const md = tierAgentMarkdown({ role: 'code', tier: 'normal' });
  expect(md).toMatch(/^name: code-normal$/m);
  expect(md).toMatch(/^model: sonata-code-normal$/m);
});

it('names normal the default and never tells the reader to default upward', () => {
  // The measured failure this fixes: "when unsure, use -complex" sent 74% of
  // tiered requests to the dearest tier.
  const md = tierAgentMarkdown({ role: 'code', tier: 'normal' });
  const description = /^description: (.+)$/m.exec(md)?.[1] ?? '';
  expect(description).toContain('default');
  for (const tier of ['simple', 'normal', 'complex'] as const) {
    const d = /^description: (.+)$/m.exec(tierAgentMarkdown({ role: 'code', tier }))?.[1] ?? '';
    expect(d).not.toContain('When unsure, use -complex');
    expect(d).not.toContain(': ');            // stays a plain YAML scalar
  }
});

it('says size is not difficulty', () => {
  // A model otherwise maps "many files" onto "cross-cutting" and escalates.
  expect(tierAgentMarkdown({ role: 'code', tier: 'normal' })).toContain('Size is not difficulty');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/commands/sync.test.ts -t normal`
Expected: FAIL — `code-normal` is not a name `tierAgentMarkdown` produces.

- [ ] **Step 3: Implement**

Replace the two-way `description` ternary with a per-tier table, and add the
shared selection guidance to the body. Exact copy:

```ts
const TIER_CRITERION: Record<'simple' | 'normal' | 'complex', string> = {
  simple: 'Use it when the task is specified closely enough that the diff could be written without asking a question — typically one or two files, no interface change.',
  normal: 'This is the default tier. Use it when you know what to change but not exactly how, so it needs reading the surrounding code to fit in; it may touch several files, but what "done" means is not in question.',
  complex: 'Use it when the task needs a design decision affecting other components, or is ambiguous about what "done" means, so the first job is deciding what to build.',
};

const TIER_CHOICE = `## Choosing a tier

Size is not difficulty. A large mechanical change is \`simple\`; a three-line
change that decides an interface is \`complex\`.

- \`-simple\` — writable without asking a question.
- \`-normal\` — the default. You know what to change, not exactly how.
- \`-complex\` — needs a design decision, or "done" is still ambiguous.

Start at the tier the task actually needs rather than a rung higher. A task
that fails review is re-run one tier up, so starting low is cheap to correct
and starting high is not cheap at all.`;
```

`description` for a tiered agent becomes:

```ts
    : `Runs ${blurb} on a ranked list of foreign models (${tier} tier), natively inside Claude Code's loop. ${TIER_CRITERION[tier]} Size is not difficulty — a large mechanical change is simple, a three-line change that decides an interface is complex. ${NO_MODEL_ARG} Requires a routed session (sonata code, or sonata route on/auto).`;
```

Append `TIER_CHOICE` to the body beside `FAN_OUT`. In `cmdSync`, iterate
`TIER_NAMES` and skip a tier the role does not have:

```ts
      for (const tier of TIER_NAMES) {
        if (lists[tier] === undefined) continue;
        ...
      }
```

- [ ] **Step 4: Run tests and inspect the real output**

Run: `npx vitest run tests/commands/sync.test.ts && npm run build && node dist/cli.js sync`
Expected: PASS, and `.claude/agents/` gains `code-normal.md` only if this
repo's own config has a `normal` list (it does not yet — so expect 8 files,
unchanged, which is the compatibility guarantee working).

- [ ] **Step 5: Commit**

```bash
git add src/commands/sync.ts tests/commands/sync.test.ts
git commit -m "feat(sync): generate normal agents and replace default-upward guidance"
```

---

### Task 6: The managed `CLAUDE.md` block names three tiers

**Files:**
- Modify: `src/init/guidance.ts` (`guidanceBlock`)
- Test: `tests/init/guidance.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `guidanceBlock(): string` — markers unchanged

- [ ] **Step 1: Write the failing test**

```ts
it('names three tiers and makes normal the default', () => {
  const block = guidanceBlock().replace(/\s+/g, ' ');
  expect(block).toContain('`code-simple`, `code-normal`, `code-complex`');
  expect(block).toContain('`-normal` is the default');
  expect(block).toContain('Size is not difficulty');
  expect(block).not.toContain('When unsure, use `-complex`');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/init/guidance.test.ts -t "three tiers"`
Expected: FAIL

- [ ] **Step 3: Implement**

Replace the tier-matching paragraph inside `guidanceBlock()` with:

```ts
    'Match the tier to the work. `-simple` is writable without asking a question',
    '(one or two files, no interface change). `-normal` is the default: you know',
    'what to change but not exactly how. `-complex` needs a design decision, or',
    '"done" is still ambiguous.',
    '',
    'Size is not difficulty — a large mechanical change is `simple`, a three-line',
    'change that decides an interface is `complex`. Start at the tier the task',
    'needs rather than a rung higher: a task that fails review is re-run one tier',
    'up, so starting low is cheap to correct.',
```

and update the agent list to `` `code-simple`, `code-normal`, `code-complex`, `review-*`, `explore-*`, `plan-*` ``. Keep the no-`model` rule, the fan-out rule and the `model_not_found` paragraph unchanged.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/init/guidance.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/init/guidance.ts tests/init/guidance.test.ts
git commit -m "feat(init): the guidance block names three tiers, normal by default"
```

---

### Task 7: The wizard ranks three tiers per role

**Files:**
- Modify: `src/tui-ink/app.tsx:301-302,421,424`, `src/tui-ink/app-state.ts:276-317` (`acceptRemainingTiers`)
- Test: `tests/tui-ink/app-state.test.ts`

**Interfaces:**
- Consumes: `TierProposal` (Task 3), `TIER_NAMES` (Task 1)
- Produces: `acceptRemainingTiers(state, roles, fromIndex, proposal: TierProposal, ...)` — signature otherwise unchanged

- [ ] **Step 1: Write the failing test**

```ts
it('bulk-accepts all three tiers for every remaining role', () => {
  // `A` must write exactly what pressing enter through the rest would write;
  // the two paths diverging is the bug this function exists to prevent.
  const next = acceptRemainingTiers(
    { nativeKeys: ['a', 'b'] } as InitState,
    ['code', 'review'],
    0,
    { simple: ['a'], normal: ['a', 'b'], complex: ['b', 'a'] },
  );
  expect(next.tiers?.code).toEqual({ simple: ['a'], normal: ['a', 'b'], complex: ['b', 'a'] });
  expect(next.tiers?.review).toEqual({ simple: ['a'], normal: ['a', 'b'], complex: ['b', 'a'] });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/tui-ink/app-state.test.ts -t "three tiers"`
Expected: FAIL — only `simple` and `complex` are written.

- [ ] **Step 3: Implement**

In `src/tui-ink/app-state.ts:300-303`, replace the two-tier arithmetic:

```ts
  for (let index = Math.max(0, fromIndex); index < roles.length * TIER_NAMES.length; index++) {
    const role = roles[Math.floor(index / TIER_NAMES.length)];
    if (role === undefined) continue;
    const tier = TIER_NAMES[index % TIER_NAMES.length]!;
```

In `src/tui-ink/app.tsx:301-302`:

```ts
      const role = roles[Math.floor(tierIndex / TIER_NAMES.length)];
      const tier = TIER_NAMES[tierIndex % TIER_NAMES.length]!;
```

and at `:421` and `:424` replace `roles.length * 2` with
`roles.length * TIER_NAMES.length`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/tui-ink/ && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tui-ink/ tests/tui-ink/
git commit -m "feat(init): rank three tiers per role in the wizard"
```

---

### Task 8: The agents editor and doctor know the third tier

**Files:**
- Modify: `src/commands/agents.ts:29` (`Tier`), `:84-88`, `:153`, `:166`, `:258`, `:272-274`; `src/tui-ink/agents-app.tsx:32,37,42` (`TierRow`, and the `lists[tier]` index — widening `Tier` makes these three a type error until the row type carries `normal`); `src/commands/doctor.ts`
- Test: `tests/commands/agents.test.ts`, `tests/commands/doctor.test.ts`

**Interfaces:**
- Consumes: `TierLists` (Task 1)
- Produces: `export type Tier = 'simple' | 'normal' | 'complex'`

- [ ] **Step 1: Write the failing tests**

```ts
it('lists a normal row for a role that has one', () => {
  const rows = agentRows(configWithNormal);
  expect(rows.map((r) => r.name)).toContain('code-normal');
});

it('keeps a hand-added uncosted key in the normal tier on a no-op edit', () => {
  // `RankedSelect` drops a seeded value missing from its rows, so an editor
  // that filtered uncosted models would delete one on write.
  const written = writeTiers(configWithNormal, sameTiers);
  expect(written).toBe(originalToml);
});

it('reports a config with no normal tier as information, not a warning', () => {
  const report = doctorReport(configWithoutNormal);
  expect(report.warnings.join(' ')).not.toContain('normal');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/commands/agents.test.ts -t normal`
Expected: FAIL

- [ ] **Step 3: Implement**

- `src/commands/agents.ts:29`: `export type Tier = 'simple' | 'normal' | 'complex';`
- `:84-88`: build one view row per present tier by iterating `TIER_NAMES` and skipping absent lists; `extendedContext` requires `tierQualifiesForExtendedContext` for **every present list**, so a role only claims a 1M window when all its tiers do.
- `:258`: include `normal` when collecting saved keys —
  `[...tiers.simple, ...(tiers.normal ?? []), ...tiers.complex]`.
- `:153`, `:166`, `:272-274`: widen the `Record<string, {...}>` parameter types to `Record<string, TierLists>`.
- `src/commands/doctor.ts`: a config without `normal` is reported at the `ok`/information level, never as a warning.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/commands/ && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands/agents.ts src/commands/doctor.ts tests/commands/
git commit -m "feat(agents): edit and report the normal tier"
```

---

### Task 9: The loop skill escalates through the middle rung

**Files:**
- Modify: `skills/loop/SKILL.md:17-21,25-37,43`
- Test: none (a prompt document; verified by reading)

**Interfaces:**
- Consumes: the agent names Task 5 generates
- Produces: the escalation ladder the whole design depends on for "starting low is cheap"

- [ ] **Step 1: Rewrite the tier description block (`:17-21`)**

```markdown
- **simple** — writable without asking a question: one or two files, no
  interface change.
- **normal** — the default. You know what to change but not exactly how; it
  needs reading the surrounding code and may touch several files, but what
  "done" means is not in question.
- **complex** — needs a design decision affecting other components, or "done"
  is still ambiguous.
- Size is not difficulty. A large mechanical change is `simple`; a three-line
  change that decides an interface is `complex`.
- When unsure, use `-normal`.
```

- [ ] **Step 2: Rewrite the escalation rule (`:33-34`)**

```markdown
   - **Escalation rule:** a task that fails review twice re-runs one tier up,
     from scratch — `simple` to `normal`, `normal` to `complex`. A task that
     fails twice at `complex` stops and is reported, not re-run: another
     attempt at the same tier is the definition of no progress.
```

- [ ] **Step 3: Update the dispatch steps (`:25-28`, `:37`, `:43`)**

Step 2 dispatches `code-simple`, `code-normal` or `code-complex`. Step 1's
planning dispatch stays `plan-complex` (planning is where a design decision
lives). Step 4's final gate stays `review-complex` — a gate exists to be
strict. Say both of those in one line each, so a later reader does not
"consistently" downgrade them.

- [ ] **Step 4: Verify the skill still reads as one procedure**

Run: `sed -n '1,60p' skills/loop/SKILL.md`
Expected: every dispatch names an agent that Task 5 can generate, and the
ladder has no rung that cannot be reached.

- [ ] **Step 5: Commit**

```bash
git add skills/loop/SKILL.md
git commit -m "feat(loop): escalate simple -> normal -> complex"
```

---

### Task 11: `plan()` emits the normal tier

Added during execution. Without this the feature ships dead: the parser
accepts a `normal` tier, the router resolves it, `sync` generates its agents
and the editor edits it — but `sonata init`, the only thing that creates a
config, never writes one. Every other task's tests stay green regardless,
because each proves its own layer in isolation.

**Files:**
- Modify: `src/init/plan.ts:187-200`
- Test: `tests/init/plan.test.ts`, and repair `tests/catalog.test.ts:844`

**Interfaces:**
- Consumes: `TierProposal` with three lists (Task 3), `TierLists` (Task 1)
- Produces: `plan(...).configToml` carrying a `[tiers.<role>] normal` list

- [ ] **Step 1: Write the failing test**

```ts
it('writes a normal tier for every role', () => {
  const planned = plan(env, state, noCredentials, { cwd: '/repo', home, packageRoot: '/pkg' });
  const tiers = parseConfig(planned.configToml).tiers!;
  // The whole feature is unreachable if init never writes the list.
  expect(tiers.code!.normal).toBeDefined();
  expect(tiers.code!.normal!.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/init/plan.test.ts -t normal`
Expected: FAIL — `tiers.code.normal` is `undefined`.

- [ ] **Step 3: Implement**

Widen `added` to the three-tier union and emit the third list, reconciled the
same way as the other two:

```ts
    const added = (tier: 'simple' | 'normal' | 'complex') =>
      [...new Set([...addedKeys, ...unpinnedVariants(saved?.[tier], catalog, gatewayNames, upstreamFor)])];
    return [role, {
      simple: reconcileTierList(saved?.simple, validTierKeys(saved?.simple), proposal.simple, added('simple')),
      normal: reconcileTierList(saved?.normal, validTierKeys(saved?.normal), proposal.normal, added('normal')),
      complex: reconcileTierList(saved?.complex, validTierKeys(saved?.complex), proposal.complex, added('complex')),
    }];
```

- [ ] **Step 4: Repair `tests/catalog.test.ts:844`**

That test asserts every effort-unpinned candidate is offered a pin by `plan()`
and by the agents editor. It fails because retiring the capability floor
changed which candidates `proposal.simple` holds, so the repair path stopped
offering a pin for one of them. Diagnose it before changing it: print
`emitted.code.simple` and compare against `refused`. If the repair path is
genuinely no longer offering a pin, that is a **defect in this branch**, not a
stale expectation — fix `plan.ts`, not the assertion. Only adjust the test if
the fixture's own premise changed.

- [ ] **Step 5: Run and commit**

Run: `npx vitest run tests/init/ tests/catalog.test.ts && npm run typecheck`

```bash
git add src/init/plan.ts tests/init/plan.test.ts tests/catalog.test.ts
git commit -m "fix(init): write the normal tier into the config init generates"
```

---

### Task 10: Documentation

**Files:**
- Modify: `CLAUDE.md` (27 tier mentions), `README.md` (18), `docs/guide/configuration.md` (4), `docs/HANDOFF.md` (8), `docs/guide/limitations.md` (2), `CHANGELOG.md`
- Test: none

**Interfaces:**
- Consumes: every decision above
- Produces: no shipped prose describing the tier set as exactly two

- [ ] **Step 1: `CLAUDE.md`**

Update: the tier-agent paragraph in Project Overview; the `[tiers.<role>]`
example and its prose; the ranking paragraph (replace the
`SIMPLE_CAPABILITY_FLOOR` sentence with the new anchor and the retirement);
`TIER_NAMES`; the alias grammar; agent counts (8 -> up to 12); the `sonata
init` description (eight ranking screens -> twelve). Add the measured
selection problem — 74% of tiered requests went to `complex` — and that
`-normal` is now the default, since a future reader will otherwise "fix" the
wording back.

- [ ] **Step 2: `README.md`**

The front-door explanation of tiers, the agent count, and the `[tiers]` sample.

- [ ] **Step 3: `docs/guide/configuration.md`**

The `[tiers.<role>]` reference: `normal` is optional, absent is valid, empty is
refused, and a config without it behaves exactly as before.

- [ ] **Step 4: `docs/HANDOFF.md` and `docs/guide/limitations.md`**

State the current tier set and that `normal` is optional. Check
`docs/roadmap.md` for tier mentions (there are none today); if it gains one,
update the claude.ai Artifact it mirrors too.

- [ ] **Step 5: `CHANGELOG.md`**

Under `## [Unreleased]`, an `### Added` entry: the third tier, optional, no
migration; and the selection rewrite with the 74% measurement.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md README.md docs/ CHANGELOG.md
git commit -m "docs: three tiers, and why normal is the default"
```

---

## Loose ends found during execution

- `src/init/guidance.ts:76` still reads "A plan is `plan-complex` or `plan-simple`"
  — the fan-out rule, written when there were two tiers. It is outside Task 6's
  scope (that task replaced the tier-matching paragraph only) and outside Task
  10's (prose files, not source). The wave owner fixes it at integration, or it
  ships describing a tier set that no longer exists.

## Verification after all tasks

- [ ] `npm test` and `npm run typecheck` pass.
- [ ] `npm run build && node dist/cli.js sync` on this repo (no `normal` in its config) writes the same 8 agents — the compatibility guarantee.
- [ ] Add `normal` to one role in a scratch config, `sync`, and confirm a 9th agent appears and `sonata agents` lists it.
- [ ] `node dist/cli.js usage --by tier --since 30d` recorded before and after, so the selection change can be judged on the ledger rather than on how the wording reads.
