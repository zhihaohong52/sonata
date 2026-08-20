# Ink TUI Rewrite — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace sonata init's hand-rolled TUI with an Ink (React for CLI) app that holds all selections in state, supports back-navigation without losing choices, runs in the alternate screen buffer, and adds a harness-selection step before providers.

**Architecture:** The Ink app is a single `<InitWizard>` component with a `useState<InitState>` holding every selection across all steps. Each step is a screen component; back-navigation decrements the step counter without clearing state. On confirm, the app writes the result to a temp JSON file and exits; the existing `cmdInit` reads it and performs all writes (TOML, agents, hooks, MCP). The non-interactive `--yes`/flag path is unchanged — it never touches Ink.

**Tech Stack:** `ink@7`, `react@19`, `@inkjs/ui@2` (MultiSelect, Select, ConfirmInput, TextInput), TypeScript with `jsx: "react-jsx"` in a separate tsconfig for the Ink source.

**Spec:** Approved design in conversation (2026-08-20).

## Global Constraints

- Only the interactive TUI path changes; the non-interactive flag path (`--yes`, `--models`, etc.) stays in `cmdInit` and never touches Ink.
- The write path (TOML, agents, hooks, MCP registration) stays in `cmdInit`. The Ink app produces a result JSON; `cmdInit` consumes it.
- Tests for the Ink app test the state logic and the result contract, not the React rendering — avoid snapshot tests of terminal output.
- `src/tui.ts` is NOT deleted: `banner()`, `isInteractive()`, and the pure list reducers may still be used by other code (`cli.ts` imports `banner`, `isInteractive`, `confirm`). Only init's usage of `multiselect`/`select` is replaced.
- `sonata` on PATH runs `dist/`. The TSX compilation must produce `.js` in `dist/` that Node can import.
- Run `npm test` and `npm run typecheck` before considering a task done.

## File Structure

- `src/tui-ink/app.tsx` (new) — the `<InitWizard>` root component, step machine, state type
- `src/tui-ink/screens/` (new) — one file per step screen:
  - `config-scope.tsx` — project / global
  - `harnesses.tsx` — which harnesses to import from (new step)
  - `providers.tsx` — provider picker, filtered by harness selection
  - `models.tsx` — model picker with Select All toggle, filtered by providers
  - `roles.tsx` — role picker
  - `per-role-models.tsx` — per-role model assignment with back-navigation within roles
  - `summary.tsx` — confirm and write
- `src/tui-ink/components/` (new) — reusable pieces:
  - `multi-select.tsx` — multiselect with Select All toggle, filter, back support
  - `banner.tsx` — the sonata wordmark
- `src/tui-ink/run.ts` (new) — launches the Ink app, waits for exit, returns the result
- `src/tui-ink/types.ts` (new) — `InitState`, `InitResult` (the JSON contract between Ink and cmdInit)
- `src/commands/init.ts` — modified: interactive path calls `runInitTui()` instead of the step machine
- `tsconfig.json` — add `"jsx": "react-jsx"`, extend `include` to `src/**/*.tsx`
- `package.json` — add deps
- `tests/tui-ink/` (new) — state logic tests

---

### Task 1: Dependencies and TSX compilation

**Files:**
- Modify: `package.json`, `tsconfig.json`

**Interfaces:**
- Produces: a project that compiles `.tsx` files under `src/` to `.js` in `dist/`.

- [ ] **Step 1: Install Ink and React**

```bash
npm install ink react @inkjs/ui
npm install -D @types/react
```

- [ ] **Step 2: Enable JSX in tsconfig.json**

Add to `compilerOptions`:
```json
"jsx": "react-jsx"
```

Change `include` to:
```json
"include": ["src/**/*.ts", "src/**/*.tsx"]
```

- [ ] **Step 3: Verify compilation**

Create a minimal `src/tui-ink/test-compile.tsx`:
```tsx
import React from 'react';
import { Text } from 'ink';
export const Hello = () => <Text>hello</Text>;
```

Run `npm run build` — must produce `dist/tui-ink/test-compile.js`. Then delete the test file.

- [ ] **Step 4: Verify tests still pass**

```bash
npm run typecheck
npm test
```

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json
git commit -m "chore: add ink, react, @inkjs/ui; enable JSX compilation"
```

---

### Task 2: State types and the result contract

**Files:**
- Create: `src/tui-ink/types.ts`
- Test: `tests/tui-ink/types.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface InitState {
    configScope?: 'project' | 'global';
    harnesses?: string[];           // which harnesses to import from
    providerKeys?: string[];
    nativeKeys?: string[];          // selected native model keys
    roles?: string[];
    perRoleModels?: Record<string, string[]>; // role -> model keys
    hookScope?: 'project' | 'global' | 'skip';
  }

  // The JSON written by the Ink app, read by cmdInit
  export interface TuiResult {
    cancelled: boolean;
    state: InitState;
  }
  ```

- [ ] **Step 1: Write the types file**
- [ ] **Step 2: Write a basic test** that validates the shape (a TuiResult can be JSON.stringify'd and parsed back).
- [ ] **Step 3: Commit** `feat(tui-ink): InitState and TuiResult types`

---

### Task 3: The MultiSelect component with Select All

**Files:**
- Create: `src/tui-ink/components/multi-select.tsx`
- Test: `tests/tui-ink/multi-select.test.ts`

**Interfaces:**
- Produces:
  ```tsx
  interface MultiSelectProps<T> {
    title: string;
    items: Array<{ value: T; label: string; hint?: string }>;
    initialSelected?: Set<T>;
    onSubmit: (selected: T[]) => void;
    onBack?: () => void;
    filterable?: boolean;  // default true
  }
  export function MultiSelect<T>(props: MultiSelectProps<T>): React.ReactElement
  ```

- [ ] **Step 1: Implement** the component using `ink`'s `useInput` hook:
  - First item is always `[ Select All ]` / `[ Deselect All ]` (toggles label on use)
  - `j`/`k` or arrow keys to navigate
  - Space to toggle, Enter to confirm
  - Left arrow calls `onBack` if provided
  - Esc cancels (throws or returns empty)
  - Optional filter input at the top (when `filterable`)
  - `initialSelected` pre-checks items (for back-navigation persistence)
  - Runs inside the alternate screen buffer (Ink's `<FullScreen>` or manual `enterAlternateScreen`)

- [ ] **Step 2: Test** the state logic (not rendering): given a set of items and simulated key presses, the correct `selected` array is passed to `onSubmit`. Test Select All toggle. Test filter. Test `initialSelected` persistence.

- [ ] **Step 3: Commit** `feat(tui-ink): MultiSelect component with Select All toggle`

---

### Task 4: The InitWizard app

**Files:**
- Create: `src/tui-ink/app.tsx`, `src/tui-ink/screens/*.tsx`, `src/tui-ink/run.ts`
- Test: `tests/tui-ink/app.test.ts`

**Interfaces:**
- Consumes: `InitState`, `TuiResult`, `MultiSelect`, detection data.
- Produces:
  ```ts
  // run.ts — the entry point cmdInit calls
  export function runInitTui(detection: Detection, candidates: NativeCandidate[]): Promise<TuiResult>
  ```

**Step flow (7 screens):**

1. **ConfigScope** — `<Select>` with project/global. Writes `state.configScope`.
2. **Harnesses** — `<MultiSelect>` over detected+installed harnesses (opencode, pi, codex, reasonix). Pre-checks all installed. Writes `state.harnesses`. This filters what appears in step 3.
3. **Providers** — `<MultiSelect>` over providers from the selected harnesses only. Writes `state.providerKeys`.
4. **Models** — `<MultiSelect>` over native candidates filtered to selected providers, with Select All. Writes `state.nativeKeys`.
5. **Roles** — `<MultiSelect>` over code/review/explore/plan. Writes `state.roles`.
6. **PerRoleModels** — "Same for all?" confirm, then per-role `<MultiSelect>` pickers. Each role's selection is remembered in `state.perRoleModels`. Back within roles goes to the previous role; back from the first role returns to the "same for all?" question.
7. **Summary** — shows all selections, Enter to confirm, Esc to cancel.

**State persistence:** All selections live in one `InitState` ref. Each screen reads its initial values from state. Going back decrements the step counter — the state is never cleared, so the previous screen renders with the saved selections.

- [ ] **Step 1: Implement `run.ts`** — renders `<InitWizard>` with Ink's `render()`, waits for the app to `exit()`, reads the result. Writes result to a temp JSON file and returns it.

- [ ] **Step 2: Implement each screen** as a focused component. Each receives `state`, `setState`, `onNext`, `onBack` props. Detection data and candidates are passed through context or props.

- [ ] **Step 3: Implement `app.tsx`** — the step machine as a `switch` on `step` state, rendering the appropriate screen. Handles the `onNext`/`onBack` callbacks by incrementing/decrementing `step`.

- [ ] **Step 4: Test** — the state transitions: given detection data and a sequence of `onNext(partialState)` calls, the final `TuiResult.state` has the expected shape. Test back-navigation preserves state.

- [ ] **Step 5: Commit** `feat(tui-ink): InitWizard app with 7-step wizard and persistent state`

---

### Task 5: Wire Ink into cmdInit

**Files:**
- Modify: `src/commands/init.ts`
- Test: `tests/init.test.ts`

**Interfaces:**
- Consumes: `runInitTui`, `TuiResult`, the existing write path.

- [ ] **Step 1: Replace the interactive step machine**

In `cmdInit`, replace the `for (let step = 0; step < 5;)` block (the interactive path only) with:

```ts
if (interactive) {
  const result = await runInitTui(detection, allNativeCandidates);
  if (result.cancelled) {
    out('  Nothing written.');
    return { ... cancelled: true };
  }
  // Map TuiResult.state to the variables the write path expects
  configScope = result.state.configScope!;
  nativeKeys = result.state.nativeKeys!;
  roles = result.state.roles!;
  // ... etc
}
```

The non-interactive (flag-driven) path stays as-is.

- [ ] **Step 2: Keep the write path unchanged** — it reads `configScope`, `chosenNative`, `roles`, `nativeRoleModels` and writes TOML, agents, hooks, MCP. Only the source of those variables changes (from the step machine to the TuiResult).

- [ ] **Step 3: Update tests** — existing non-interactive tests must pass unchanged. Interactive tests that drove the step machine via injected stdin are removed (the Ink app has its own tests). The write-path tests that assert TOML output stay.

- [ ] **Step 4: Verify**

```bash
npm run typecheck
npm test
npm run build
sonata init  # interactive smoke test
```

- [ ] **Step 5: Commit** `feat(init): wire Ink TUI into interactive init path`

---

### Task 6: Cleanup and docs

**Files:**
- Modify: `src/tui.ts` (remove dead code), `CLAUDE.md`, `README.md`

- [ ] **Step 1: Remove dead interactive code from `src/tui.ts`** — the `runList`, `multiselect`, `select`, `prompt` functions are no longer used by init. Check if anything else imports them (`cli.ts` uses `confirm`, `banner`, `isInteractive`). Remove only what is truly dead; keep what is still imported.

- [ ] **Step 2: Update CLAUDE.md** — note that `sonata init` uses Ink for its interactive TUI, and that the pure list primitives in `tui.ts` are retained for non-init uses.

- [ ] **Step 3: Verify and commit** `refactor: remove dead interactive TUI code, update docs`

---

## Self-Review Notes

- **Spec coverage:** All user requirements mapped — harness selection (T4 screen 2), persistent state (T4 app), Select All (T3), alternate screen (T3/Ink default), Ink framework (T1).
- **Type consistency:** `InitState` defined in T2, consumed in T3/T4/T5. `TuiResult` is the contract between T4 and T5. `NativeCandidate` and `Detection` are existing types passed through.
- **The non-interactive path is never touched.** Every `--yes` / flag-driven test passes without modification.
- **The write path is never touched.** TOML generation, agent files, hooks, MCP — all stay in `cmdInit`. Only the source of the selections changes.
- **Ordering:** T1 (deps) → T2 (types) → T3 (component) → T4 (app) → T5 (wiring) → T6 (cleanup). Each task is independently testable.
