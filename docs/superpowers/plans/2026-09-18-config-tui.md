# Config TUI Implementation Plan (Phase 1: foundation, Health, Budget)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bare `sonata` opens a persistent Ink TUI that boots into a health check, shows doctor's findings as a home screen, and can edit `[budget] daily_usd` — a value nothing in sonata currently writes.

**Architecture:** A flat step machine in `src/tui-ink/app.tsx` renders one screen per step, mirroring claude-swap. Screens are thin and call the existing headless modules (`cmdDoctor`, `loadConfig`, `src/init/`); no new services layer. Writes go through a generalised `replaceBlock` that edits only the table it owns and leaves every other byte untouched — never `nativeTomlFor`, which deletes what it does not emit.

**Tech Stack:** TypeScript (ESM, Node 22+), Ink 6 + React 19 (already dependencies), vitest.

**Spec:** `docs/superpowers/specs/2026-09-18-config-tui-design.md`

## Scope

This plan delivers a **working, shippable TUI**: it opens, reports health, and edits the budget. The spec's remaining screens — Tiers, Models, Providers, Keys, Actions — are a second plan. They are deliberately excluded: each is independently shippable, and Tiers in particular means relocating `sonata agents`, which is its own migration.

Task 1 is not TUI work at all. It fixes a live data-loss bug and must land first, because a Budget screen writing a value the next `sonata init` deletes would be worse than no screen.

## Global Constraints

- **Node 22+**, ESM, `.js` extensions on relative imports (the repo compiles with `tsc` to `dist/`).
- **`sonata` on PATH runs `dist/`, not `src/`.** Run `npm run build` before manual verification, or the old behaviour persists.
- **Never call `nativeTomlFor` from the TUI.** It is `sonata init`'s full-rewrite path and deletes settings it does not emit.
- **Every new config key gets a round-trip test through `parseConfig`.** Asserting on emitted text cannot catch a key written into the wrong table.
- **No `--key` flag, ever.** Credentials go to the store, never to argv, a log, or a config file.
- **Existing exit codes are unchanged:** bare `sonata` without a TTY returns **2**, `sonata --help` returns **0**. `main` returns `command ? 0 : 2`.
- Tests must not require a TTY. Pure logic is tested directly; no Ink rendering in tests for this phase.
- `npm run typecheck` and `npm test` must pass before every commit.

---

### Task 1: Preserve `[budget]` across a config rewrite

`src/init/` contains no non-comment reference to `budget`. `nativeTomlFor` preserves `[run]` via `existingRun` and `pricing_provider`/`[price]` via `existing`, but has no budget parameter and no emission path — so a hand-added `[budget]` block is deleted by the next `sonata init`. Same bug that once un-priced a gateway; still live.

**Files:**
- Modify: `src/init/toml.ts` (`nativeTomlFor`)
- Modify: `src/commands/init.ts` (the `nativeTomlFor` call site)
- Test: `tests/init/toml.test.ts`

**Interfaces:**
- Consumes: `SonataConfig['budget']`, which is `{ dailyUsd: number } | undefined` (`src/config.ts:227`).
- Produces: `nativeTomlFor` gains a final optional parameter `existingBudget?: SonataConfig['budget']`, emitting a `[budget]` table when it is defined.

- [ ] **Step 1: Write the failing round-trip test**

In `tests/init/toml.test.ts`:

```ts
it('preserves [budget] across a rewrite', () => {
  // `sonata init` is the sole writer of the whole file, so a key it does not
  // emit is deleted. A cap's only visible effect is a refusal that has not
  // happened yet, so a silently dropped one reads exactly like a working one.
  const toml = nativeTomlFor(
    { code: [candidate('m1')] },
    {},
    { code: { simple: ['m1'], complex: ['m1'] } },
    {},
    [candidate('m1')],
    undefined,
    [],
    undefined,
    { dailyUsd: 25 },
  );
  expect(parseConfig(toml).budget).toEqual({ dailyUsd: 25 });
});

it('emits no [budget] table when the config has no cap', () => {
  // Absent must stay absent: emitting a zero would turn "no cap" into a cap
  // of $0, refusing every request.
  const toml = nativeTomlFor(
    { code: [candidate('m1')] },
    {},
    { code: { simple: ['m1'], complex: ['m1'] } },
    {},
    [candidate('m1')],
    undefined,
    [],
    undefined,
    undefined,
  );
  expect(toml).not.toContain('[budget]');
  expect(parseConfig(toml).budget).toBeUndefined();
});
```

Use the file's existing candidate helper. If none exists, add at the top of the describe block:

```ts
const candidate = (key: string): NativeCandidate => ({
  key, gateway: 'gw', id: `${key}-1`, harness: 'byok', provider: 'gw',
} as NativeCandidate);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/init/toml.test.ts -t 'budget'`
Expected: FAIL — the first with `parseConfig(toml).budget` being `undefined`, because nothing emits the table. The second may pass vacuously; that is fine, it is the guard for Step 3.

- [ ] **Step 3: Add the parameter and the emission**

In `src/init/toml.ts`, add the parameter after `existing`:

```ts
  /**
   * The cap being preserved, read only because this writer would otherwise
   * destroy it. `[budget]` was read in nine places and written by none, so a
   * hand-added cap survived exactly until the next `sonata init` — and a cap's
   * only visible effect is a refusal that has not happened yet, so its loss is
   * indistinguishable from it working.
   */
  existingBudget?: SonataConfig['budget'],
```

Emit it above every table header, beside `schema_version` and `avoid_gateways` — a bare key after a table header belongs to *that* table:

```ts
  if (existingBudget !== undefined) {
    lines.push('[budget]', `daily_usd = ${existingBudget.dailyUsd}`, '');
  }
```

Place this push immediately after the `avoid_gateways` block, so `[budget]` is a table of its own and no later bare key can fall into it.

- [ ] **Step 4: Pass it at the call site**

In `src/commands/init.ts`, find the `nativeTomlFor(` call and add the config's budget as the final argument:

```ts
    config.budget,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/init/toml.test.ts -t 'budget'`
Expected: PASS, both.

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npm run typecheck && npm test`
Expected: typecheck silent, all tests pass.

- [ ] **Step 7: Add the changelog entry**

Under `## [Unreleased]` → `### Fixed` in `CHANGELOG.md`:

```markdown
- `sonata init` no longer deletes a hand-added `[budget] daily_usd`.
  `nativeTomlFor` preserved `[run]`, `pricing_provider` and `[price]`, but had
  no budget parameter at all, so the cap survived only until the next rewrite.
  Its loss was invisible by construction: a cap's only effect is a refusal that
  has not happened yet, so a deleted one reads exactly like a working one.
```

- [ ] **Step 8: Commit**

```bash
git add src/init/toml.ts src/commands/init.ts tests/init/toml.test.ts CHANGELOG.md
git commit -m "fix: preserve [budget] across a sonata init rewrite"
```

---

### Task 2: Generalise `replaceTiersBlock` into `replaceBlock`

The TUI is the third writer of `sonata.toml` and writes by targeted block replacement. `replaceTiersBlock` already does this correctly for one table — including multiline-string handling, and reinserting at the position the old table occupied rather than at the end of a file someone has ordered. Generalising it is what lets a Budget screen write without a second implementation of that care.

**Files:**
- Modify: `src/init/toml.ts`
- Test: `tests/init/toml.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `export function replaceBlock(toml: string, matches: (line: string) => boolean, block: string[]): string`. `matches` decides whether a table header starts a table being replaced; `block` is the replacement lines. `replaceTiersBlock(toml, tiers)` becomes a caller and keeps its exact signature and behaviour.

- [ ] **Step 1: Write the failing test**

```ts
describe('replaceBlock', () => {
  const isBudget = (line: string): boolean =>
    /^\s*\[\s*(?:budget|"budget"|'budget')\s*\]/.test(line);

  it('replaces a table in place, leaving every other byte alone', () => {
    const toml = '# mine\n[budget]\ndaily_usd = 5\n\n[run]\ntail_window_seconds = 20\n';
    const out = replaceBlock(toml, isBudget, ['[budget]', 'daily_usd = 25', '']);
    expect(out).toContain('daily_usd = 25');
    expect(out).not.toContain('daily_usd = 5');
    expect(out).toContain('# mine');
    expect(out).toContain('tail_window_seconds = 20');
    // Reinserted where it was, not appended after [run].
    expect(out.indexOf('[budget]')).toBeLessThan(out.indexOf('[run]'));
  });

  it('appends when the table is absent', () => {
    const toml = '[run]\ntail_window_seconds = 20\n';
    const out = replaceBlock(toml, isBudget, ['[budget]', 'daily_usd = 25', '']);
    expect(out).toContain('[budget]');
    expect(out).toContain('tail_window_seconds = 20');
  });

  it('does not treat a table name inside a multiline string as structure', () => {
    const toml = 'note = """\n[budget]\ndaily_usd = 1\n"""\n\n[run]\ntail_window_seconds = 20\n';
    const out = replaceBlock(toml, isBudget, ['[budget]', 'daily_usd = 25', '']);
    // The string's contents survive verbatim; only a real table is replaced.
    expect(out).toContain('daily_usd = 1');
    expect(out).toContain('daily_usd = 25');
  });

  it('leaves replaceTiersBlock behaviour unchanged', () => {
    const toml = '[tiers.code]\nsimple = ["a"]\ncomplex = ["a"]\n';
    const out = replaceTiersBlock(toml, { code: { simple: ['b'], complex: ['b'] } });
    expect(out).toContain('simple = ["b"]');
    expect(out).not.toContain('"a"');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/init/toml.test.ts -t 'replaceBlock'`
Expected: FAIL with `replaceBlock is not a function` (it is not exported yet).

- [ ] **Step 3: Extract the scanner**

In `src/init/toml.ts`, move the body of `replaceTiersBlock` into a new exported function, parameterising only the header predicate and the emitted block:

```ts
/**
 * Replace one table (or family of tables) in place, leaving every other byte
 * where it was.
 *
 * Extracted from `replaceTiersBlock` so a second writer does not reimplement
 * the two things that are easy to get wrong: a multiline string's contents are
 * content rather than structure, so a `[table]` inside one neither opens a
 * table nor ends the one being dropped; and the replacement lands where the
 * old table began rather than at the end of a file someone has ordered.
 *
 * `matches` is given each *header* line and decides whether the table it opens
 * is being replaced. It is a predicate rather than a name because a family
 * (`[tiers.code]`, `[tiers.review]`) and a single table (`[budget]`) need
 * different tests, and both spellings — bare and quoted — name one table.
 */
export function replaceBlock(
  toml: string,
  matches: (line: string) => boolean,
  block: string[],
): string {
```

The body is the existing `replaceTiersBlock` body verbatim, with two substitutions: `isTierHeader(line)` becomes `matches(line)`, and the locally-built `block` constant is removed in favour of the parameter. Keep `isHeader`, `inString`, `openDelimiterAfter`, `insertAt` and the trailing insert logic exactly as they are.

- [ ] **Step 4: Reduce `replaceTiersBlock` to a caller**

```ts
export function replaceTiersBlock(
  toml: string,
  tiers: Record<string, TierLists>,
): string {
  // The segment may be bare or quoted; `["tiers".code]` names the same table.
  const isTierHeader = (line: string): boolean => /^\s*\[\s*(?:tiers|"tiers"|'tiers')\s*[.\]]/.test(line);
  const block = Object.entries(tiers).flatMap(([role, lists]) => [
    `[tiers.${tomlKey(role)}]`,
    `simple = [${lists.simple.map(tomlKey).join(', ')}]`,
    ...(lists.normal === undefined ? [] : [`normal = [${lists.normal.map(tomlKey).join(', ')}]`]),
    `complex = [${lists.complex.map(tomlKey).join(', ')}]`,
    '',
  ]);
  return replaceBlock(toml, isTierHeader, block);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/init/toml.test.ts && npx vitest run tests/commands/agents.test.ts`
Expected: PASS. The agents tests are the regression guard — `sonata agents` is the existing `replaceTiersBlock` caller, and its behaviour must be byte-identical.

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npm run typecheck && npm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/init/toml.ts tests/init/toml.test.ts
git commit -m "refactor: generalise replaceTiersBlock into replaceBlock"
```

---

### Task 3: TTY-guarded entry point

Bare `sonata` currently prints help and returns 2. It renders the TUI only when stdout is a TTY; without that guard, `sonata` inside a SessionStart hook renders Ink into a pipe.

**Files:**
- Modify: `src/cli.ts` (`main`, around line 129)
- Create: `src/tui-ink/launch.ts`
- Test: `tests/cli-tui-entry.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `export function shouldLaunchTui(command: string | undefined, isTty: boolean): boolean` in `src/tui-ink/launch.ts`. Returns `true` only for an absent command or the exact string `tui`, and only when `isTty`.

- [ ] **Step 1: Write the failing test**

Create `tests/cli-tui-entry.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { shouldLaunchTui } from '../src/tui-ink/launch.js';

describe('shouldLaunchTui', () => {
  it('launches for a bare command on a TTY', () => {
    expect(shouldLaunchTui(undefined, true)).toBe(true);
  });

  it('launches for an explicit `tui` on a TTY', () => {
    // Named explicitly so the behaviour is addressable without relying on
    // argv being empty.
    expect(shouldLaunchTui('tui', true)).toBe(true);
  });

  it('never launches without a TTY', () => {
    // A SessionStart hook and CI both run sonata with stdout piped. Rendering
    // Ink into a pipe is the failure this guard exists to prevent.
    expect(shouldLaunchTui(undefined, false)).toBe(false);
    expect(shouldLaunchTui('tui', false)).toBe(false);
  });

  it('never launches for another command', () => {
    for (const command of ['doctor', 'init', 'serve', '--help', '-h', '--version']) {
      expect(shouldLaunchTui(command, true)).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/cli-tui-entry.test.ts`
Expected: FAIL — cannot resolve `../src/tui-ink/launch.js`.

- [ ] **Step 3: Write the predicate**

Create `src/tui-ink/launch.ts`:

```ts
/**
 * Whether this invocation opens the TUI.
 *
 * Pure, and separated from `main` so the decision is testable without a TTY
 * and without rendering anything.
 *
 * The TTY test is a requirement rather than a refinement. Bare `sonata` is
 * already called from places with no terminal — a SessionStart hook, CI, a
 * pipe — and rendering Ink into one of those produces escape sequences where a
 * caller expected help text. Without a TTY the caller gets today's help and
 * today's exit code, so this is a pure addition.
 */
export function shouldLaunchTui(command: string | undefined, isTty: boolean): boolean {
  if (!isTty) return false;
  return command === undefined || command === 'tui';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/cli-tui-entry.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire it into `main`**

In `src/cli.ts`, immediately **before** the existing help branch (so a bare command reaches it first, and `--help` never does):

```ts
  if (shouldLaunchTui(command, process.stdout.isTTY === true)) {
    const { runConfigTui } = await import('./tui-ink/app.js');
    return runConfigTui({ cwd: process.cwd() });
  }
```

Import `shouldLaunchTui` at the top of the file. `runConfigTui` does not exist yet — Task 4 creates it. Until then this will not compile, so **this step and Task 4 land in one commit**; leave `src/cli.ts` unmodified until Task 4 Step 3 is done, and do Step 6 below only after that.

Add `tui` to the `USAGE` string, beside `init`:

```
  sonata tui       open the config TUI (bare `sonata` does the same on a terminal)
```

- [ ] **Step 6: Commit (after Task 4's implementation exists)**

```bash
git add src/tui-ink/launch.ts tests/cli-tui-entry.test.ts
git commit -m "feat: TTY-guarded entry predicate for the config TUI"
```

---

### Task 4: App shell — step machine and boot

A flat step machine, per the spec: one `step` string and a switch. The TUI owns its entire lifetime and never unmounts to hand off to a `src/tui.ts` prompt, because Ink unrefs stdin on unmount and a waiting prompt then exits 0 mid-prompt with no error.

**Files:**
- Create: `src/tui-ink/app.tsx`
- Create: `src/tui-ink/steps.ts`
- Test: `tests/tui-ink/steps.test.ts`

**Interfaces:**
- Consumes: `shouldLaunchTui` (Task 3).
- Produces:
  - `export type Step = 'checking' | 'overview' | 'budget';`
  - `export function nextStep(step: Step, key: string): Step` in `src/tui-ink/steps.ts` — pure navigation.
  - `export async function runConfigTui(opts: { cwd: string; home?: string }): Promise<number>` in `src/tui-ink/app.tsx` — renders, resolves with the process exit code (0).

- [ ] **Step 1: Write the failing navigation test**

Create `tests/tui-ink/steps.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { nextStep } from '../../src/tui-ink/steps.js';

describe('nextStep', () => {
  it('opens the budget screen from the overview', () => {
    expect(nextStep('overview', 'b')).toBe('budget');
  });

  it('returns to the overview from a screen', () => {
    expect(nextStep('budget', 'escape')).toBe('overview');
  });

  it('ignores an unknown key', () => {
    expect(nextStep('overview', 'z')).toBe('overview');
    expect(nextStep('budget', 'z')).toBe('budget');
  });

  it('never leaves the boot step on a keypress', () => {
    // Boot advances when the health check resolves, never because someone
    // pressed a key while it was running.
    expect(nextStep('checking', 'b')).toBe('checking');
    expect(nextStep('checking', 'escape')).toBe('checking');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/tui-ink/steps.test.ts`
Expected: FAIL — cannot resolve `steps.js`.

- [ ] **Step 3: Write the step machine and the shell**

Create `src/tui-ink/steps.ts`:

```ts
/** The screens this phase of the TUI has. */
export type Step = 'checking' | 'overview' | 'budget';

/**
 * Where a keypress moves the TUI.
 *
 * Pure and separate from the component so navigation is provable without a
 * TTY — the same discipline `src/tui.ts`'s `parseKey`/`reduce` already follow.
 *
 * `checking` is deliberately inert: boot advances when the health check
 * resolves, and a keypress that skipped it would land on an overview with no
 * results to show.
 */
export function nextStep(step: Step, key: string): Step {
  if (step === 'checking') return 'checking';
  if (key === 'escape') return 'overview';
  if (step === 'overview' && key === 'b') return 'budget';
  return step;
}
```

Create `src/tui-ink/app.tsx`:

```tsx
import React, { useEffect, useState } from 'react';
import { homedir } from 'node:os';
import { Box, Text, render, useApp, useInput } from 'ink';
import { cmdDoctor } from '../commands/doctor.js';
import type { Check } from '../commands/doctor.js';
import { nextStep, type Step } from './steps.js';
import { OverviewScreen } from './screens/overview.js';
import { BudgetScreen } from './screens/budget.js';

/**
 * The config TUI.
 *
 * A flat step machine rather than a router: it is the smallest thing that
 * works at this size, and it keeps navigation in one pure function.
 *
 * The app owns its whole lifetime and never unmounts to hand off to a
 * `src/tui.ts` prompt. Ink unrefs stdin on unmount, so a prompt waiting on a
 * keystroke is not work node knows about and the process exits 0 mid-prompt —
 * with no error, because there is no error. Every confirmation is a screen.
 */
function ConfigTui({ cwd, home }: { cwd: string; home: string }): React.ReactElement {
  const { exit } = useApp();
  const [step, setStep] = useState<Step>('checking');
  const [checks, setChecks] = useState<Check[]>([]);

  useEffect(() => {
    if (step !== 'checking') return;
    let cancelled = false;
    cmdDoctor({ cwd, home })
      .then((result) => {
        if (cancelled) return;
        setChecks(result.checks);
        setStep('overview');
      })
      .catch(() => {
        // A machine doctor cannot describe is still one the TUI must open on,
        // so an empty result routes to an overview that says so rather than
        // leaving a spinner running forever.
        if (cancelled) return;
        setChecks([]);
        setStep('overview');
      });
    return () => { cancelled = true; };
  }, [step, cwd, home]);

  useInput((input, key) => {
    if (step === 'overview' && (input === 'q' || key.escape)) { exit(); return; }
    setStep((current) => nextStep(current, key.escape ? 'escape' : input));
  });

  if (step === 'checking') return <Text>checking…</Text>;
  if (step === 'budget') return <BudgetScreen cwd={cwd} home={home} />;
  return (
    <Box flexDirection="column">
      <OverviewScreen checks={checks} />
    </Box>
  );
}

/** Render the TUI and resolve with the process exit code. */
export async function runConfigTui(opts: { cwd: string; home?: string }): Promise<number> {
  // Resolved once here so every screen takes a required `home`. `configPath`
  // and `loadConfig` both demand one, and threading an optional down would put
  // the same `?? homedir()` in each screen.
  const home = opts.home ?? homedir();
  const instance = render(<ConfigTui cwd={opts.cwd} home={home} />);
  await instance.waitUntilExit();
  return 0;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/tui-ink/steps.test.ts`
Expected: PASS. `app.tsx` will not typecheck yet — the two screens land in Tasks 5 and 6. Complete Task 5 and Task 6 Step 3 before running `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/tui-ink/steps.ts tests/tui-ink/steps.test.ts
git commit -m "feat: step machine for the config TUI"
```

---

### Task 5: Overview screen — doctor as the home screen

Doctor's results become the home screen, so a problem is opened rather than looked up. `cmdDoctor` already computes everything.

**Files:**
- Create: `src/tui-ink/screens/overview.tsx`
- Create: `src/tui-ink/screens/overview-rows.ts`
- Test: `tests/tui-ink/overview-rows.test.ts`

**Interfaces:**
- Consumes: `Check` from `src/commands/doctor.js`, which is `{ name: string; ok: boolean; detail: string }` (`src/commands/doctor.ts:81`).
- Produces: `export function overviewRows(checks: readonly Check[]): OverviewRow[]` where `export interface OverviewRow { name: string; ok: boolean; detail: string }`, and `export function summarise(checks: readonly Check[]): string`.

- [ ] **Step 1: Write the failing test**

Create `tests/tui-ink/overview-rows.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { overviewRows, summarise } from '../../src/tui-ink/screens/overview-rows.js';

const check = (name: string, ok: boolean, detail = ''): { name: string; ok: boolean; detail: string } =>
  ({ name, ok, detail });

describe('overviewRows', () => {
  it('puts failures first, so the screen opens on what is wrong', () => {
    const rows = overviewRows([check('tmux', true), check('routing', false, 'not routed')]);
    expect(rows.map((r) => r.name)).toEqual(['routing', 'tmux']);
  });

  it('keeps the original order within failures and within passes', () => {
    const rows = overviewRows([
      check('a', false), check('b', true), check('c', false), check('d', true),
    ]);
    expect(rows.map((r) => r.name)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('carries each check detail through unchanged', () => {
    // The detail is what names the fix; a row that drops it sends the reader
    // back to the CLI, which is the flow this screen exists to replace.
    const rows = overviewRows([check('routing', false, 'run sonata route auto')]);
    expect(rows[0]!.detail).toBe('run sonata route auto');
  });
});

describe('summarise', () => {
  it('counts the warnings', () => {
    expect(summarise([check('a', false), check('b', true), check('c', false)]))
      .toBe('2 warnings');
  });

  it('uses the singular for one', () => {
    expect(summarise([check('a', false), check('b', true)])).toBe('1 warning');
  });

  it('says so when everything passes', () => {
    expect(summarise([check('a', true)])).toBe('all checks pass');
  });

  it('says so when there is nothing to report', () => {
    // An empty result is what a failed doctor routes to, and "all checks pass"
    // would be a false claim about a machine nothing could describe.
    expect(summarise([])).toBe('no checks ran');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/tui-ink/overview-rows.test.ts`
Expected: FAIL — cannot resolve `overview-rows.js`.

- [ ] **Step 3: Write the row logic**

Create `src/tui-ink/screens/overview-rows.ts`:

```ts
import type { Check } from '../../commands/doctor.js';

/** One doctor finding as the overview draws it. */
export interface OverviewRow { name: string; ok: boolean; detail: string }

/**
 * Doctor's checks in the order the overview shows them: failures first.
 *
 * Stable within each group, so a reader who has learned where a check sits
 * does not have it move when an unrelated one starts failing.
 */
export function overviewRows(checks: readonly Check[]): OverviewRow[] {
  const failed = checks.filter((check) => !check.ok);
  const passed = checks.filter((check) => check.ok);
  return [...failed, ...passed].map((check) => ({
    name: check.name, ok: check.ok, detail: check.detail,
  }));
}

/**
 * The one-line state for the header.
 *
 * An empty list is reported as "no checks ran" rather than as everything
 * passing: it is what a thrown `cmdDoctor` routes to, and claiming health from
 * an absence of results is the wrong direction to be wrong in.
 */
export function summarise(checks: readonly Check[]): string {
  if (checks.length === 0) return 'no checks ran';
  const warnings = checks.filter((check) => !check.ok).length;
  if (warnings === 0) return 'all checks pass';
  return `${warnings} warning${warnings === 1 ? '' : 's'}`;
}
```

Create `src/tui-ink/screens/overview.tsx`:

```tsx
import React from 'react';
import { Box, Text } from 'ink';
import type { Check } from '../../commands/doctor.js';
import { overviewRows, summarise } from './overview-rows.js';

/** Doctor's findings as the TUI's home screen. */
export function OverviewScreen({ checks }: { checks: readonly Check[] }): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text bold>sonata — {summarise(checks)}</Text>
      <Box flexDirection="column" marginTop={1}>
        {overviewRows(checks).map((row) => (
          <Text key={row.name}>
            <Text color={row.ok ? 'green' : 'yellow'}>{row.ok ? '  ok ' : '  !  '}</Text>
            {row.name}
            {row.detail === '' ? '' : `  ${row.detail}`}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}><Text dimColor>b budget · q quit</Text></Box>
    </Box>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/tui-ink/overview-rows.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tui-ink/screens/overview.tsx src/tui-ink/screens/overview-rows.ts tests/tui-ink/overview-rows.test.ts
git commit -m "feat: overview screen showing doctor findings"
```

---

### Task 6: Budget screen — the first writing screen

The first screen that writes, and the proof that the write discipline holds: it edits `[budget]` through `replaceBlock`, parses the result before writing it, and leaves every other byte untouched.

**Files:**
- Create: `src/tui-ink/screens/budget.tsx`
- Create: `src/tui-ink/screens/budget-write.ts`
- Test: `tests/tui-ink/budget-write.test.ts`

**Interfaces:**
- Consumes: `replaceBlock` (Task 2), `parseConfig` from `src/config.js`, `configPath` from `src/config.js`.
- Produces:
  - `export function budgetToml(toml: string, dailyUsd: number | undefined): string` — the pure edit.
  - `export function writeBudget(path: string, dailyUsd: number | undefined): void` — reads, edits, parses back, writes.
- Note: `configPath(cwd: string, home: string): string | null` — `home` is
  **required** and the miss is `null`, not `undefined`. `loadConfig` **throws**
  `NoConfigError` rather than returning undefined, so it must not be called
  before the null check.

- [ ] **Step 1: Write the failing test**

Create `tests/tui-ink/budget-write.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { budgetToml } from '../../src/tui-ink/screens/budget-write.js';
import { parseConfig } from '../../src/config.js';

const base = [
  'schema_version = 1',
  '',
  '# a comment the user wrote',
  '[models."m1"]',
  'gateway = "gw"',
  'id = "x-1"',
  '',
  '[native.gateways."gw"]',
  'base_url = "https://example.test/v1"',
  '',
  '[tiers.code]',
  'simple = ["m1"]',
  'complex = ["m1"]',
  '',
].join('\n');

describe('budgetToml', () => {
  it('sets a cap on a config that had none', () => {
    const out = budgetToml(base, 25);
    expect(parseConfig(out).budget).toEqual({ dailyUsd: 25 });
  });

  it('replaces an existing cap', () => {
    const out = budgetToml(budgetToml(base, 25), 50);
    expect(parseConfig(out).budget).toEqual({ dailyUsd: 50 });
    // One table, not two: a second [budget] would be a parse error waiting.
    expect(out.match(/^\[budget\]$/gm)).toHaveLength(1);
  });

  it('removes the cap when given undefined', () => {
    const out = budgetToml(budgetToml(base, 25), undefined);
    expect(parseConfig(out).budget).toBeUndefined();
    expect(out).not.toContain('[budget]');
  });

  it('leaves every other byte alone', () => {
    // The whole reason this does not go through nativeTomlFor: a full rewrite
    // deletes what it cannot represent, which once un-priced a gateway.
    const out = budgetToml(base, 25);
    expect(out).toContain('# a comment the user wrote');
    expect(parseConfig(out).tiers?.code.simple).toEqual(['m1']);
    expect(parseConfig(out).unifiedModels?.m1?.id).toBe('x-1');
  });

  it('round-trips a no-op edit byte-identically', () => {
    // Opening a screen and confirming it unchanged must not alter the file.
    const withCap = budgetToml(base, 25);
    expect(budgetToml(withCap, 25)).toBe(withCap);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/tui-ink/budget-write.test.ts`
Expected: FAIL — cannot resolve `budget-write.js`.

- [ ] **Step 3: Write the edit and the writer**

Create `src/tui-ink/screens/budget-write.ts`:

```ts
import { readFileSync, writeFileSync } from 'node:fs';
import { replaceBlock } from '../../init/toml.js';
import { parseConfig } from '../../config.js';

/** `[budget]` in either spelling; the table has no sub-tables. */
const isBudgetHeader = (line: string): boolean =>
  /^\s*\[\s*(?:budget|"budget"|'budget')\s*\]/.test(line);

/**
 * The config text with `[budget] daily_usd` set, replaced, or removed.
 *
 * Pure, so the interesting property — that nothing outside the table moves —
 * is testable without a filesystem.
 *
 * `undefined` removes the table rather than writing a zero. `costOf` charges
 * an absent dimension at 0, so a zero here would turn "no cap" into a cap of
 * $0 and refuse every request.
 */
export function budgetToml(toml: string, dailyUsd: number | undefined): string {
  const block = dailyUsd === undefined ? [] : ['[budget]', `daily_usd = ${dailyUsd}`, ''];
  return replaceBlock(toml, isBudgetHeader, block);
}

/**
 * Write the edited config back.
 *
 * The result is parsed **before** it is written: a rewrite that will not load
 * leaves no working config at all, and would surface later from an unrelated
 * command with nothing to connect it to this edit.
 */
export function writeBudget(path: string, dailyUsd: number | undefined): void {
  const next = budgetToml(readFileSync(path, 'utf8'), dailyUsd);
  parseConfig(next);
  writeFileSync(path, next);
}
```

Create `src/tui-ink/screens/budget.tsx`:

```tsx
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { configPath, loadConfig } from '../../config.js';
import { writeBudget } from './budget-write.js';

/** Edit `[budget] daily_usd` — the only config value with a dollar consequence. */
export function BudgetScreen({ cwd, home }: { cwd: string; home: string }): React.ReactElement {
  // `configPath` returns `string | null`, and `loadConfig` *throws*
  // `NoConfigError` when there is none — so the null check has to come first
  // and the read has to be guarded, not merely defaulted.
  const path = configPath(cwd, home);
  const [draft, setDraft] = useState<string>(() => {
    if (path === null) return '';
    const current = loadConfig(cwd, home).budget;
    return current === undefined ? '' : String(current.dailyUsd);
  });
  const [note, setNote] = useState('');

  useInput((input, key) => {
    if (key.return) {
      if (path === null) { setNote('no sonata.toml — run sonata init first'); return; }
      const trimmed = draft.trim();
      if (trimmed === '') { writeBudget(path, undefined); setNote('cap removed'); return; }
      const value = Number(trimmed);
      // Refused here for the reason parseConfig refuses it: a cap's only
      // effect is a refusal that has not happened yet, so one silently
      // dropped for being the wrong type reads exactly like one that works.
      if (!Number.isFinite(value) || value <= 0) { setNote('must be a positive number of US dollars'); return; }
      writeBudget(path, value);
      setNote(`cap set to $${value}/day`);
      return;
    }
    if (key.delete || key.backspace) { setDraft((d) => d.slice(0, -1)); setNote(''); return; }
    if (/^[0-9.]$/.test(input)) { setDraft((d) => d + input); setNote(''); }
  });

  return (
    <Box flexDirection="column">
      <Text bold>Budget — priced spend per UTC day</Text>
      <Box marginTop={1}><Text>daily_usd: {draft === '' ? '(no cap)' : draft}</Text></Box>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>Counts priced volume on the native path only.</Text>
        <Text dimColor>A `sonata dispatch` run never transits the router.</Text>
      </Box>
      {note !== '' && <Box marginTop={1}><Text color="yellow">{note}</Text></Box>}
      <Box marginTop={1}><Text dimColor>enter save · esc back</Text></Box>
    </Box>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/tui-ink/budget-write.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the entry point (Task 3 Step 5)**

Now that `runConfigTui` exists, make the `src/cli.ts` edit described in Task 3 Step 5.

- [ ] **Step 6: Typecheck and run the full suite**

Run: `npm run typecheck && npm test`
Expected: all pass, including `tests/cli-tui-entry.test.ts` and `tests/tui-ink/steps.test.ts`.

- [ ] **Step 7: Verify by hand against the real binary**

```bash
npm run build && sonata
```

Expected: a health screen; `b` opens Budget; a value plus enter reports the cap; `esc` returns; `q` quits.

```bash
sonata | cat; echo "exit: ${PIPESTATUS[0]}"
sonata --help >/dev/null; echo "help exit: $?"
```

Expected: help text and `exit: 2`; `help exit: 0`. **`sonata` on PATH runs `dist/`**, so the build is required or this checks the old behaviour.

- [ ] **Step 8: Add the changelog entry**

Under `## [Unreleased]` → `### Added`:

```markdown
- `sonata tui` — a persistent config TUI, which bare `sonata` also opens on a
  terminal. It boots into a health check, shows doctor's findings as its home
  screen, and edits `[budget] daily_usd`, which nothing in sonata could
  previously write. Without a TTY, `sonata` prints help and exits 2 exactly as
  before. Writes go through targeted block replacement and are parsed before
  they are written, so nothing outside the edited table can move.
```

- [ ] **Step 9: Commit**

```bash
git add src/tui-ink/screens/budget.tsx src/tui-ink/screens/budget-write.ts \
        src/tui-ink/app.tsx src/cli.ts tests/tui-ink/budget-write.test.ts CHANGELOG.md
git commit -m "feat: config TUI with health overview and budget editing"
```

- [ ] **Step 10: Open the PR**

This touches config writing and money, so it goes through a PR.

```bash
git push -u origin feat/config-tui
gh pr create --title "feat: a persistent config TUI" --body "Implements docs/superpowers/specs/2026-09-18-config-tui-design.md phase 1.

Closes nothing; the remaining screens are a follow-up plan."
node scripts/pr-status.mjs --watch=60
```

Keep the watch running until the PR is clean. `pr-status.mjs --watch` exits 0 on a network error, so confirm it is still alive rather than assuming a quiet watch means a quiet PR.

---

## Follow-up plan (not this one)

Tiers (relocating `sonata agents`), Models, Providers, Keys, and Actions. Each needs `replaceBlock` from Task 2 and the shell from Task 4, both of which this plan delivers.
