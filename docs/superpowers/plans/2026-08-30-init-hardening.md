# `sonata init` Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `src/commands/init.ts` (1502 lines; `cmdInit` alone is 814 of them) into a `discover → choose → validate → plan → apply` pipeline, and add the three test levels that would have caught the 0.3.2–0.3.4 wizard defects.

**Architecture:** All machine I/O moves into `discover()`, which returns an `InitEnvironment` computed once. Two front ends — the Ink wizard and the `--yes` flag path — each produce the same `InitState` and nothing else. Everything downstream of that is shared: `validate()` returns `Problem[]`, `plan()` turns environment plus state into an `InitPlan` describing every write, and `apply()` performs them with no decisions of its own. The confirm gate renders the `InitPlan`, so what the user approves is the object that gets applied.

**Tech Stack:** TypeScript (NodeNext, strict), React 19 + Ink 7, vitest 2, `smol-toml`.

**Spec:** `docs/superpowers/specs/2026-08-30-init-hardening-design.md`

## Global Constraints

- **`sonata` on PATH runs `dist/`, not `src/`.** Run `npm run build` after any `src/` change before exercising the CLI by hand. Two bugs in this repo's history were "fixed" but still reproducing for exactly this reason.
- **Do not restart or kill the router on port 4100.** The developer's own session routes through it. If a change requires a restart, say so and let the user run `sonata restart`.
- **Existing user-facing error message strings are preserved verbatim.** They are tested and quoted in docs. Where this plan moves a `throw`, the message text does not change.
- **Every TOML key and value is written through `tomlKey`.** An unquoted `[models.grok-4.5]` nests as `models → "grok-4" → "5"`. This includes control-character escaping.
- **Credentials never reach a log, a print, or a test fixture's expected output.** `InitState.byokKeys` and `InitPlan.keysToStore` are in-memory only; logs record the *gateway*, never the key.
- **Tests need no API keys and no network.** The suite runs against a fake harness and captured fixtures. Anything reaching `/models` takes an injected `fetchModels`.
- **`tsconfig.json` sets `include: ["src/**"]`, so `npm run typecheck` does not check test files.** A type error in a test surfaces only as a vitest failure. Do not assume a green typecheck means the tests compile.
- **Wizard tests use `React.createElement`, never JSX.** There is no `vitest.config.*` in this repo and `tsconfig.json`'s `include` excludes `tests/`, so esbuild's JSX handling for a `.test.tsx` file is unverified. `src/tui-ink/run.ts` already constructs the wizard with `React.createElement`; the tests do the same and stay `.test.ts`.
- **The test fixtures in this plan are written from call sites, not from the type declarations.** Before using one, check the real shape and correct the fixture rather than the code: `Detection` and `HarnessSummary` in `src/commands/init.ts` and `src/detect.ts`, `FetchModelsResult` in `src/native/models.ts`, `NativeCandidate` in `src/commands/init.ts`. Tests are not type-checked here (see above), so a wrong fixture shape surfaces as a confusing runtime failure, not a compile error.
- Run `npm test` and `npm run typecheck` before every commit. CI runs both on Linux with tmux installed.

## Baseline

At the start of this plan: **1236 tests across 66 files, all passing.** Every task below states the expected count after it. If a count comes out lower than stated, a test was dropped — find it before committing.

---

## Task 1: Wizard test harness, and the first-run ranking regression

The decisive test of the whole plan. `initialRankedFor` returned an empty list for a role's *complex* tier on a first run, `RankedSelect` refuses to submit an empty ranking, and the wizard could not be advanced at all — while 1231 tests stayed green. This task makes that class of defect visible.

**Files:**
- Modify: `package.json` (devDependencies)
- Create: `tests/tui-ink/wizard-flow.test.ts`

**Interfaces:**
- Consumes: `InitWizard` and `WizardData` from `src/tui-ink/app.js`; `TuiResult` from `src/tui-ink/types.js`.
- Produces: `renderWizard(data)` — a local helper in this test file returning `{ lastFrame, press, result }`. Later wizard tests (Task 2) reuse it.

- [ ] **Step 1: Install the test renderer**

```bash
npm install --save-dev ink-testing-library@4
```

- [ ] **Step 2: Write the harness and the failing regression test**

Create `tests/tui-ink/wizard-flow.test.ts`. Note there is no JSX here — `React.createElement`, per the Global Constraints.

```ts
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { InitWizard, type WizardData } from '../../src/tui-ink/app.js';
import type { TuiResult } from '../../src/tui-ink/types.js';

const ENTER = '\r';
const DOWN = '\x1B[B';
const SPACE = ' ';

/** Lets Ink flush a render before the next keystroke is read. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

function renderWizard(data: WizardData) {
  let result: TuiResult | undefined;
  const app = render(React.createElement(InitWizard, {
    data,
    onDone: (r: TuiResult) => { result = r; },
  }));
  return {
    lastFrame: app.lastFrame,
    press: async (...keys: string[]) => {
      for (const key of keys) { app.stdin.write(key); await tick(); }
    },
    result: () => result,
  };
}

/**
 * A first run: no config anywhere, so no `initialState` and no saved tiers.
 * This is the shape two of the three 0.3.x defects needed to reproduce, and
 * the shape no existing user has.
 */
function firstRunData(): WizardData {
  return {
    home: '/tmp/does-not-exist',
    harnesses: [{ name: 'opencode', installed: true }],
    providers: [{ key: 'opencode/acme', harness: 'opencode', provider: 'acme', count: 2 }],
    candidates: [
      { key: 'acme-fast', gateway: 'acme', id: 'fast', label: 'opencode/acme/fast' },
      { key: 'acme-deep', gateway: 'acme', id: 'deep', label: 'opencode/acme/deep' },
    ],
    roles: ['code'],
    byokProviders: [],
    storedKeys: {},
    fetchModels: async () => ({ kind: 'ok', ids: [] }),
  };
}

describe('the wizard on a first run', () => {
  it('renders a non-empty ranking on the complex tier and lets it be submitted', async () => {
    const w = renderWizard(firstRunData());

    // step 0 config scope -> project
    await w.press(ENTER);
    // step 1 providers -> accept the single provider, continue
    await w.press(SPACE, ENTER);
    // step 2 models -> tick both, continue
    await w.press(SPACE, DOWN, SPACE, ENTER);
    // step 3 roles -> accept `code`
    await w.press(ENTER);
    // step 4a code:simple -> accept the proposal
    await w.press(ENTER);

    // step 4b code:complex. The regression: this screen rendered with an
    // empty ranking, and RankedSelect refuses to submit one — so the wizard
    // could not be advanced past here at all.
    expect(w.lastFrame()).toContain('code: complex models');
    expect(w.lastFrame()).toMatch(/acme-(fast|deep)/);

    await w.press(ENTER);
    expect(w.lastFrame()).toContain('Summary');
  });
});
```

- [ ] **Step 3: Run it and confirm the harness works at all**

Run: `npx vitest run tests/tui-ink/wizard-flow.test.ts`

Two possible outcomes, and they need different responses:

- **The test passes.** `initialRankedFor` was already fixed in `3548c28`, so a *passing* test here is the correct result — it is now a regression guard. Confirm it is really exercising the screen by temporarily reverting `initialRankedFor` to `saved ?? proposal` and watching it fail, then restore.
- **`render` throws, or `lastFrame()` is empty.** `ink-testing-library@4` is incompatible with ink 7. Do not fight it — go to Step 4.

- [ ] **Step 4 (only if Step 3 showed incompatibility): fall back to an in-house renderer**

Ink's own `render` accepts custom streams. Replace the `ink-testing-library` import with a local harness and drop the dependency:

```ts
import { render } from 'ink';
import { PassThrough } from 'node:stream';

function renderWizard(data: WizardData) {
  let frame = '';
  const stdout = new PassThrough();
  stdout.on('data', (chunk: Buffer) => { frame = chunk.toString(); });
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  (stdin as unknown as { isTTY: boolean }).isTTY = true;
  (stdin as unknown as { setRawMode: () => void }).setRawMode = () => {};

  let result: TuiResult | undefined;
  render(React.createElement(InitWizard, { data, onDone: (r: TuiResult) => { result = r; } }), {
    stdin,
    stdout: stdout as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  return {
    lastFrame: () => frame,
    press: async (...keys: string[]) => {
      for (const key of keys) { stdin.push(key); await tick(); }
    },
    result: () => result,
  };
}
```

Then `npm uninstall ink-testing-library`.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: **1237 passed** (1236 + 1).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tests/tui-ink/wizard-flow.test.ts
git commit -m "test(init): drive the wizard end to end, guarding the first-run ranking"
```

---

## Task 2: The rest of the wizard flow

Level B stays small — React renders are the slow tests. Four more cases, chosen because each covers a transition the pure `app-state` tests cannot reach.

**Files:**
- Modify: `tests/tui-ink/wizard-flow.test.ts`

**Interfaces:**
- Consumes: `renderWizard`, `firstRunData`, `ENTER`, `DOWN`, `SPACE` from Task 1.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the four failing tests**

Append to `tests/tui-ink/wizard-flow.test.ts`:

```ts
const ESC = '\x1B';
const LEFT = '\x1B[D';

describe('the wizard, remaining flow', () => {
  it('returns the full state through the summary screen', async () => {
    const w = renderWizard(firstRunData());
    await w.press(ENTER, SPACE, ENTER, SPACE, DOWN, SPACE, ENTER, ENTER, ENTER, ENTER, ENTER);
    const r = w.result();
    expect(r?.cancelled).toBe(false);
    expect(r?.state.configScope).toBe('project');
    expect(r?.state.nativeKeys).toEqual(['acme-fast', 'acme-deep']);
    expect(r?.state.roles).toEqual(['code']);
    expect(r?.state.tiers?.code.simple.length).toBeGreaterThan(0);
    expect(r?.state.tiers?.code.complex.length).toBeGreaterThan(0);
  });

  it('reports a cancel without losing the state gathered so far', async () => {
    const w = renderWizard(firstRunData());
    await w.press(ENTER, SPACE, ENTER, ESC);
    expect(w.result()?.cancelled).toBe(true);
    expect(w.result()?.state.configScope).toBe('project');
  });

  it('refuses to finish with no models selected', async () => {
    const w = renderWizard(firstRunData());
    // providers accepted, models step submitted with nothing ticked
    await w.press(ENTER, SPACE, ENTER, ENTER, ENTER, ENTER, ENTER);
    expect(w.lastFrame()).toContain('Select at least one model before continuing.');
    await w.press(ENTER);
    expect(w.result()).toBeUndefined();
  });

  it('walks back from the complex tier to the simple one, not to roles', async () => {
    const w = renderWizard(firstRunData());
    await w.press(ENTER, SPACE, ENTER, SPACE, ENTER, ENTER, ENTER);
    expect(w.lastFrame()).toContain('code: complex models');
    await w.press(LEFT);
    expect(w.lastFrame()).toContain('code: simple models');
  });
});
```

- [ ] **Step 2: Run them**

Run: `npx vitest run tests/tui-ink/wizard-flow.test.ts`
Expected: 5 passed. If the "refuses to finish" case fails because the summary screen was never reached, adjust the keypress count — the models step is skipped entirely when no candidates match, and `firstRunData` has two.

- [ ] **Step 3: Run the whole suite**

Run: `npm test`
Expected: **1241 passed**.

- [ ] **Step 4: Commit**

```bash
git add tests/tui-ink/wizard-flow.test.ts
git commit -m "test(init): cover wizard cancel, empty-model refusal and tier back-navigation"
```

---

## Task 3: Extract `src/init/toml.ts`

Pure functions, zero behavioural risk. Done first so the later, riskier extractions land in a smaller file.

**Files:**
- Create: `src/init/toml.ts`
- Modify: `src/commands/init.ts` (remove `tomlKey` at 228–257 and `nativeTomlFor` at 582–668; import them instead)
- Create: `tests/init/toml.test.ts`
- Modify: `tests/init.test.ts` (move the `nativeTomlFor` and `tomlKey` cases out)

**Interfaces:**
- Produces:
  - `tomlKey(key: string): string`
  - `nativeTomlFor(nativeRoleModels: Record<string, NativeCandidate[]>, credentialSources: Record<string, CredentialSource>, tiers: Record<string, { simple: string[]; complex: string[] }>, migratedModels: Record<string, { harness?: string; harnessId?: string }>, chosenNative: NativeCandidate[], run: SonataConfig['run'] | undefined, avoidGateways: string[]): string`
  - Both re-exported from `src/init/index.ts` is **not** wanted — import from `src/init/toml.js` directly.

- [ ] **Step 1: Create the module by moving the code verbatim**

Move `tomlKey` (`init.ts:228–257`) and `nativeTomlFor` (`init.ts:582–668`) into `src/init/toml.ts`, unchanged including their comments. Carry across only the imports they actually use (`NativeCandidate` moves later — for now import it from `../commands/init.js`; Task 4 relocates the type).

- [ ] **Step 2: Point `init.ts` at the new module**

In `src/commands/init.ts`, delete both function bodies and add:

```ts
import { nativeTomlFor, tomlKey } from '../init/toml.js';
```

Keep `export { nativeTomlFor }` in `init.ts` for now — `tests/init.test.ts` still imports it from there, and Task 11 moves those tests.

- [ ] **Step 3: Run the suite to prove the move changed nothing**

Run: `npm test`
Expected: **1241 passed** — identical to Task 2. A move that changes a count is not a move.

- [ ] **Step 4: Move the tests**

Create `tests/init/toml.test.ts` and move every `describe` block from `tests/init.test.ts` that exercises `nativeTomlFor` or `tomlKey`, changing only the import path to `../../src/init/toml.js`. Do not rewrite the assertions.

- [ ] **Step 5: Re-run**

Run: `npm test`
Expected: **1241 passed**. Same count, different files — if it dropped, a `describe` was moved but not its tests.

- [ ] **Step 6: Commit**

```bash
git add src/init/toml.ts src/commands/init.ts tests/init/toml.test.ts tests/init.test.ts
git commit -m "refactor(init): extract TOML emission into src/init/toml.ts"
```

---

## Task 4: Extract `src/init/discover.ts`

**Files:**
- Create: `src/init/discover.ts`
- Modify: `src/commands/init.ts` (remove `runInit:715–882`; call `discover` instead)
- Create: `tests/init/discover.test.ts`

**Interfaces:**
- Consumes: `Detector`, `DetectEnv`, `Detection` from `src/commands/init.js`; `ProviderSummary` from `src/detect.js`.
- Produces:

```ts
export interface InitEnvironment {
  tmux: Detection['tmux'];
  harnesses: Detection['harnesses'];
  problems: Problem[];
  offered: ProviderSummary[];
  allNativeCandidates: NativeCandidate[];
  providerBaseUrls: Record<string, string>;
  gatewayAuth: Map<string, NativeGatewayAuth>;
  oauthProviders: Map<string, NativeGatewayAuth>;
  byokProviders: Array<{ name: string; url: string }>;
  configsByScope: Partial<Record<ConfigScope, SonataConfig>>;
  existingHookScope: HookScope | undefined;
  copilotUsable: boolean;
}

export async function discover(
  opts: Pick<InitOptions, 'cwd' | 'home' | 'packageRoot' | 'detect'>,
  out: (line: string) => void,
): Promise<InitEnvironment>;
```

- [ ] **Step 1: Move the block**

Move `runInit:715–882` into `discover()` verbatim — detection printing, `configsByScope` loading with its legacy migration, `configuredGateways`, `providerBaseUrls`, the copilot probe, `oauthProviders`, `gatewayAuth`, `allNativeCandidates`, `byokProviders`, `dedupeOauthProviders`, and the no-harness warning. Also move the `existingHookScope` computation from `:1305–1311` (`hookCommand`, `hookInstalled` against both settings paths), since it is discovery, not decision.

Return the `InitEnvironment`. The `blocking` early-return at `:876–882` does **not** move — it is a `cmdInit` concern and stays there, reading `env.problems`.

- [ ] **Step 2: Call it from `runInit`**

```ts
const env = await discover(opts, out);
if (env.problems.some((p) => p.severity === 'error')) {
  for (const p of env.problems) out(renderProblem(p));
  out('');
  out('  Fix the errors above, then run `sonata init` again.');
  return { /* unchanged early-return shape */ };
}
for (const p of env.problems) out(renderProblem(p));
```

Then replace each former local (`offered`, `allNativeCandidates`, `providerBaseUrls`, `gatewayAuth`, `configsByScope`, `byokProviders`, `copilotUsable`) with `env.*` at its use sites.

- [ ] **Step 3: Run the suite**

Run: `npm test`
Expected: **1241 passed**.

- [ ] **Step 4: Write discovery tests**

Create `tests/init/discover.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discover } from '../../src/init/discover.js';

let home: string;
let cwd: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sonata-disc-home-'));
  cwd = mkdtempSync(join(tmpdir(), 'sonata-disc-cwd-'));
});

const detector = async () => ({
  tmux: { installed: true, version: '3.4', problems: [] },
  harnesses: [],
});

describe('discover', () => {
  it('warns rather than errors when no harness offers a provider', async () => {
    const env = await discover({ cwd, home, packageRoot: cwd, detect: detector }, () => {});
    expect(env.problems.every((p) => p.severity !== 'error')).toBe(true);
    expect(env.problems.map((p) => p.message)).toContain('no harness reported a usable model provider');
  });

  it('offers a gateway named only by the config as a config/ provider', async () => {
    writeFileSync(join(cwd, 'sonata.toml'), [
      '[models."acme-fast"]',
      'gateway = "acme"',
      'id = "fast"',
      '',
      '[native.gateways."acme"]',
      'base_url = "https://gateway.acme.example/v1"',
      '',
      '[tiers.code]',
      'simple = ["acme-fast"]',
      'complex = ["acme-fast"]',
    ].join('\n'));
    const env = await discover({ cwd, home, packageRoot: cwd, detect: detector }, () => {});
    expect(env.offered.map((p) => p.key)).toContain('config/acme');
  });

  it('reports no existing hook scope on a machine with no settings', async () => {
    const env = await discover({ cwd, home, packageRoot: cwd, detect: detector }, () => {});
    expect(env.existingHookScope).toBeUndefined();
  });
});
```

- [ ] **Step 5: Run**

Run: `npx vitest run tests/init/discover.test.ts`
Expected: 3 passed.

Run: `npm test`
Expected: **1244 passed**.

- [ ] **Step 6: Commit**

```bash
git add src/init/discover.ts src/commands/init.ts tests/init/discover.test.ts
git commit -m "refactor(init): extract discovery into src/init/discover.ts"
```

---

## Task 5: Fix the `config/*` provider-key mismatch

The one behavioural change in the decomposition. `deriveInitState` (`init.ts:449`) emits `config/<gateway>` when `matches.length === 0 || distinctHarnesses.size > 1`, but discovery synthesizes a `config/<gateway>` entry in `offered` only when **no** provider matches the name. So a gateway that two harnesses both catalogue — opencode and pi both listing `opencode-go`, which the existing comment records as verified live — produces `config/opencode-go` in `providerKeys` while `offered` holds `opencode/opencode-go` and `pi/opencode-go`. The `--yes` path's `unknownProviders` check then throws `no harness offers config/opencode-go` before role selection is reached.

**Files:**
- Modify: `src/init/discover.ts`
- Modify: `tests/init/discover.test.ts`

**Interfaces:**
- Consumes: `InitEnvironment` from Task 4.
- Produces: no signature change. `offered` gains a `config/<gateway>` row for ambiguous gateways.

- [ ] **Step 1: Write the failing test**

Append to `tests/init/discover.test.ts`:

```ts
const twoHarnessDetector = async () => ({
  tmux: { installed: true, version: '3.4', problems: [] },
  harnesses: [
    {
      name: 'opencode', installed: true, version: '1.18.16', problems: [],
      refs: [{ harness: 'opencode', provider: 'shared-gw', model: 'a' }],
      authedProviders: ['shared-gw'],
      providerBaseUrls: { 'shared-gw': 'https://shared.example/v1' },
    },
    {
      name: 'pi', installed: true, version: '0.9.0', problems: [],
      refs: [{ harness: 'pi', provider: 'shared-gw', model: 'a' }],
      authedProviders: ['shared-gw'],
      providerBaseUrls: { 'shared-gw': 'https://shared.example/v1' },
    },
  ],
});

it('offers a config/ provider for a gateway two harnesses both catalogue', async () => {
  // deriveInitState emits `config/<gateway>` for an ambiguous gateway, so
  // `offered` must contain that key or the --yes path rejects a config it
  // just derived from the user's own sonata.toml.
  //
  // The config write is load-bearing: `configuredGateways` is built from the
  // loaded configs, so a gateway only earns a `config/` row if sonata.toml
  // names it. Without this the test would fail for the wrong reason.
  writeFileSync(join(cwd, 'sonata.toml'), [
    '[models."shared-gw-a"]',
    'gateway = "shared-gw"',
    'id = "a"',
    '',
    '[native.gateways."shared-gw"]',
    'base_url = "https://shared.example/v1"',
    '',
    '[tiers.code]',
    'simple = ["shared-gw-a"]',
    'complex = ["shared-gw-a"]',
  ].join('\n'));

  const env = await discover(
    { cwd, home, packageRoot: cwd, detect: twoHarnessDetector }, () => {});
  expect(env.offered.map((p) => p.key)).toContain('config/shared-gw');
  // The harness rows survive alongside it — they are what the picker shows.
  expect(env.offered.map((p) => p.key)).toEqual(
    expect.arrayContaining(['opencode/shared-gw', 'pi/shared-gw']));
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/init/discover.test.ts -t "two harnesses both catalogue"`
Expected: FAIL — `offered` contains `opencode/shared-gw` and `pi/shared-gw` but not `config/shared-gw`.

- [ ] **Step 3: Make it pass**

In `src/init/discover.ts`, replace the synthesis condition. It currently reads:

```ts
for (const [gateway, count] of configuredGateways) {
  if (!offered.some((provider) => provider.provider === gateway)) {
    offered.push({ harness: 'config', provider: gateway, key: `config/${gateway}`, count });
  }
}
```

Synthesize for the ambiguous case too — `!== 1` covers both "no harness offers
it" and "more than one distinct harness does", which is exactly the condition
`deriveInitState` uses — so `offered` and `deriveInitState` agree on what an
unattributable gateway is called:

```ts
// `deriveInitState` names a gateway `config/<gateway>` when no harness
// offers it OR when more than one distinct harness does — both are equally
// unattributable. Only the first case was synthesized here, so an ambiguous
// gateway produced a providerKey that `offered` never contained, and the
// --yes path rejected it as unknown. The harness rows stay: they are what
// the picker shows, and `config/` is what a config-derived state names.
const distinctHarnessesFor = (gateway: string): number =>
  new Set(offered.filter((p) => p.provider === gateway).map((p) => p.harness)).size;
for (const [gateway, count] of configuredGateways) {
  if (distinctHarnessesFor(gateway) !== 1) {
    offered.push({ harness: 'config', provider: gateway, key: `config/${gateway}`, count });
  }
}
```

- [ ] **Step 4: Run**

Run: `npx vitest run tests/init/discover.test.ts`
Expected: 4 passed.

Run: `npm test`
Expected: **1245 passed**.

- [ ] **Step 5: Commit**

```bash
git add src/init/discover.ts tests/init/discover.test.ts
git commit -m "fix(init): offer config/<gateway> for a gateway two harnesses share"
```

---

## Task 6: Extract `src/init/validate.ts`

**Files:**
- Create: `src/init/validate.ts`
- Modify: `src/commands/init.ts` (the `--yes` branch's five throws at `:1118`, `:1160`, `:1167`, `:1180`, `:1186`, plus the shared credential-source block at `:1218–1247`)
- Create: `tests/init/validate.test.ts`

**Interfaces:**
- Consumes: `InitEnvironment` (Task 4), `InitState` (`src/tui-ink/types.js`).
- Produces:

```ts
export function validate(env: InitEnvironment, state: InitState): Problem[];
```

`validate` resolves the candidates it needs from `env.allNativeCandidates` and
`state.nativeKeys` itself — a map lookup. It deliberately does **not** take
`chosenNative` from `plan`, because that would force `plan` to run before
validation and invert the pipeline order the spec sets out.

Every returned `Problem` has `severity: 'error'` and a `message` **identical to the string the corresponding `throw` used**, so the scripted front end can convert back with no wording change.

- [ ] **Step 1: Write the failing tests**

Create `tests/init/validate.test.ts`. Message strings are copied from `init.ts` verbatim — do not paraphrase them.

```ts
import { describe, it, expect } from 'vitest';
import { validate } from '../../src/init/validate.js';
import type { InitEnvironment } from '../../src/init/discover.js';

const env = (over: Partial<InitEnvironment> = {}): InitEnvironment => ({
  tmux: { installed: true, version: '3.4', problems: [] },
  harnesses: [],
  problems: [],
  offered: [{ harness: 'opencode', provider: 'acme', key: 'opencode/acme', count: 1 }],
  allNativeCandidates: [{ key: 'acme-fast', gateway: 'acme', id: 'fast', contextWindow: 128000, baseUrl: 'https://a.example/v1', auth: 'api-key' }],
  providerBaseUrls: { acme: 'https://a.example/v1' },
  gatewayAuth: new Map([['acme', 'api-key' as const]]),
  oauthProviders: new Map(),
  byokProviders: [],
  configsByScope: {},
  existingHookScope: undefined,
  copilotUsable: false,
  ...over,
});


describe('validate', () => {
  it('accepts a well-formed state', () => {
    expect(validate(env(), { configScope: 'project', providerKeys: ['opencode/acme'], nativeKeys: ['acme-fast'], roles: ['code'] })).toEqual([]);
  });

  it('rejects a provider no harness offers', () => {
    const problems = validate(env(), { configScope: 'project', providerKeys: ['opencode/nope'], nativeKeys: ['acme-fast'], roles: ['code'] });
    expect(problems[0].message).toBe(
      'sonata init: no harness offers opencode/nope. Available: opencode/acme');
  });

  it('rejects an empty model selection', () => {
    const problems = validate(env(), { configScope: 'project', providerKeys: ['opencode/acme'], nativeKeys: [], roles: ['code'] });
    expect(problems.map((p) => p.message)).toContain(
      'sonata init: no models selected — nothing to generate.');
  });

  it('rejects an unknown role', () => {
    const problems = validate(env(), { configScope: 'project', providerKeys: ['opencode/acme'], nativeKeys: ['acme-fast'], roles: ['frobnicate'] });
    expect(problems.map((p) => p.message)).toContain(
      'sonata init: unknown role(s) frobnicate');
  });

  it('rejects a codex credential source on an api-key gateway', () => {
    const problems = validate(env(), {
      configScope: 'project', providerKeys: ['opencode/acme'], nativeKeys: ['acme-fast'],
      roles: ['code'], credentialSources: { acme: 'codex' },
    });
    expect(problems[0].message).toBe(
      'sonata init: gateway "acme" is auth = "api-key", so it cannot take its credential from codex — ' +
      'that is a subscription, not a key.');
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run tests/init/validate.test.ts`
Expected: FAIL — `Cannot find module '../../src/init/validate.js'`.

- [ ] **Step 3: Implement**

Create `src/init/validate.ts`. Each check is the body of an existing `throw`, converted to a pushed `Problem`. Move, in order: `unknownProviders` (`:1118`), the BYOK missing-key check (`:1160`), the unknown-model check (`:1167`), `no models selected` (`:1180`), `--credential-source` naming an unselected gateway (`:1186`), `unknown role(s)` and `no roles selected`, then the whole credential-source/auth block at `:1218–1247`.

The `--routing global` vs `--config-scope project` conflict at `:1350` and the shadowing-`sonata.toml` check at `:1364` also move here — they are validation, and sharing them means the interactive path gets them too.

- [ ] **Step 4: Call it from both paths**

In the `--yes` branch, replace each `throw` with a single conversion after state is assembled:

```ts
const problems = validate(env, state);
if (problems.length > 0) throw new Error(problems[0].message);
```

In the interactive branch, call `validate` after the wizard returns and render any problem through `renderProblem`, then return the cancelled-shaped `InitResult`. A problem here means a wizard bug; it must be loud, not silent.

- [ ] **Step 5: Run**

Run: `npx vitest run tests/init/validate.test.ts`
Expected: 5 passed.

Run: `npm test`
Expected: **1250 passed**.

- [ ] **Step 6: Commit**

```bash
git add src/init/validate.ts src/commands/init.ts tests/init/validate.test.ts
git commit -m "refactor(init): share validation between the wizard and --yes paths"
```

---

## Task 7: Extract `src/init/plan.ts`

The centre of the plan. Once `InitPlan` exists, "what will `init` write?" is a value you can assert instead of a side effect you have to observe.

**Files:**
- Create: `src/init/plan.ts`
- Modify: `src/commands/init.ts` (the duplicated `migratedModels` blocks at `:1032` and `:1098`; the duplicated tiers blocks at `:1063` and `:1200`; the key check at `:1248–1300`; the summary at `:1376–1386`)
- Create: `tests/init/plan.test.ts`

**Interfaces:**
- Consumes: `InitEnvironment` (Task 4), `InitState`, `nativeTomlFor` (Task 3).
- Produces:

```ts
export interface CredentialProbe {
  /** A resolvable bearer key for this gateway from this source. */
  hasKey(gateway: string, source: CredentialSource): boolean;
  /** A device-login credential file written by sonata for this gateway. */
  hasOauthCredential(gateway: string, auth: NativeGatewayAuth): boolean;
  /** Automatic precedence result, as `keyReport` computes it. */
  autoSource(gateway: string): string | null;
  /** Whether opencode's GitHub token can mint a Copilot key. */
  copilotUsable: boolean;
}

export interface InitPlan {
  configScope: ConfigScope;
  configPath: string;
  configToml: string;
  keysToStore: Array<{ gateway: string; key: string }>;
  hook: { scope: HookScope | 'skip'; settingsPath?: string; allowListScope?: HookScope };
  skillPath: string;
  routing: 'project' | 'global' | 'skip';
  syncCwd: string;
  agentsDir: string;
  chosenNative: NativeCandidate[];
  roles: string[];
  nativeKeys: string[];
  notices: string[];
  summary: string[];
}

export function plan(
  env: InitEnvironment,
  state: InitState,
  credentials: CredentialProbe,
  opts: Pick<InitOptions, 'cwd' | 'home' | 'packageRoot'>,
): InitPlan;

/** Production `CredentialProbe`, backed by the key store and the filesystem. */
export function fsCredentialProbe(home: string, copilotUsable: boolean): CredentialProbe;
```

- [ ] **Step 1: Write the failing tests — the two 0.3.x config defects first**

Create `tests/init/plan.test.ts`. **The `avoid_gateways` assertion must round-trip through `parseConfig`.** A placement assertion would have passed the broken version: the TOML parsed fine and bound the key to the preceding table.

```ts
import { describe, it, expect } from 'vitest';
import { parseConfig } from '../../src/config.js';
import { plan, type CredentialProbe } from '../../src/init/plan.js';
import type { InitEnvironment } from '../../src/init/discover.js';

const noCredentials: CredentialProbe = {
  hasKey: () => false,
  hasOauthCredential: () => false,
  autoSource: () => null,
  copilotUsable: false,
};

const candidate = (key: string, gateway: string, id: string) =>
  ({ key, gateway, id, contextWindow: 128000, baseUrl: `https://${gateway}.example/v1`, auth: 'api-key' as const });

const env = (over: Partial<InitEnvironment> = {}): InitEnvironment => ({
  tmux: { installed: true, version: '3.4', problems: [] },
  harnesses: [], problems: [],
  offered: [{ harness: 'opencode', provider: 'acme', key: 'opencode/acme', count: 2 }],
  allNativeCandidates: [candidate('acme-fast', 'acme', 'fast'), candidate('flaky-slow', 'flaky-gw', 'slow')],
  providerBaseUrls: { acme: 'https://acme.example/v1', 'flaky-gw': 'https://flaky.example/v1' },
  gatewayAuth: new Map([['acme', 'api-key' as const], ['flaky-gw', 'api-key' as const]]),
  oauthProviders: new Map(), byokProviders: [], configsByScope: {},
  existingHookScope: undefined, copilotUsable: false,
  ...over,
});

const state = {
  configScope: 'project' as const,
  providerKeys: ['opencode/acme'],
  nativeKeys: ['acme-fast', 'flaky-slow'],
  roles: ['code'],
  tiers: { code: { simple: ['acme-fast'], complex: ['acme-fast', 'flaky-slow'] } },
  hookScope: 'project' as const,
  routing: 'project' as const,
};

const opts = { cwd: '/repo', home: '/home/u', packageRoot: '/pkg' };

describe('plan — the config it emits', () => {
  it('keeps avoid_gateways bound to the top level, not to a table', () => {
    // The 0.3.4 defect: avoid_gateways was written after a [table] header,
    // so TOML bound it to that table and it was silently ignored. Only a
    // round-trip catches this — the broken output still parsed.
    const p = plan(
      env({ configsByScope: { project: { avoidGateways: ['flaky-gw'] } as never } }),
      state, noCredentials, opts);
    const back = parseConfig(p.configToml);
    expect(back.avoidGateways).toEqual(['flaky-gw']);
  });

  it('emits a config that parses and defines every model its tiers name', () => {
    const p = plan(env(), state, noCredentials, opts);
    const back = parseConfig(p.configToml);
    const defined = new Set(Object.keys(back.unifiedModels));
    for (const key of [...back.tiers!.code.simple, ...back.tiers!.code.complex]) {
      expect(defined).toContain(key);
    }
  });

  it('never writes a model key twice', () => {
    const p = plan(env(), state, noCredentials, opts);
    const keys = [...p.configToml.matchAll(/^\[models\."([^"]+)"\]$/gm)].map((m) => m[1]);
    expect(keys).toEqual([...new Set(keys)]);
  });
});

describe('plan — the key-check notices', () => {
  it('names the sonata repair path for a gateway with no key', () => {
    const p = plan(env(), state, noCredentials, opts);
    expect(p.notices).toContain('  ! acme: no key — run `sonata auth add acme`');
  });

  it('reports the pinned source rather than automatic precedence', () => {
    const credentials: CredentialProbe = { ...noCredentials, hasKey: (g, s) => g === 'acme' && s === 'sonata' };
    const p = plan(env(), { ...state, credentialSources: { acme: 'sonata' } }, credentials, opts);
    expect(p.notices).toContain('  ✓ acme: key from sonata');
  });

  it('tells an opencode-sourced gateway that sonata does not manage its credentials', () => {
    const p = plan(env(), { ...state, credentialSources: { acme: 'opencode' } }, noCredentials, opts);
    expect(p.notices).toContain(
      '  ! acme: no key from opencode — log into opencode itself, sonata does not manage its credentials');
  });
});

describe('plan — paths', () => {
  it('points sync at the global config directory when the scope is global', () => {
    const p = plan(env(), { ...state, configScope: 'global' }, noCredentials, opts);
    expect(p.syncCwd).toBe('/home/u/.config/sonata');
    expect(p.skillPath).toBe('/home/u/.claude/skills/sonata-loop/SKILL.md');
  });

  it('points sync at the repository when the scope is project', () => {
    const p = plan(env(), state, noCredentials, opts);
    expect(p.syncCwd).toBe('/repo');
    expect(p.skillPath).toBe('/repo/.claude/skills/sonata-loop/SKILL.md');
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run tests/init/plan.test.ts`
Expected: FAIL — `Cannot find module '../../src/init/plan.js'`.

- [ ] **Step 3: Implement `plan`**

Write `src/init/plan.ts`. It contains, **once**, what the two branches currently do twice:

- `migratedModels` — the block duplicated at `:1032` and `:1098`, including its four-line comment about `parseConfig` already building `unifiedModels`.
- The tiers block — duplicated at `:1063` and `:1200`: `validTierKeys`, `loadAaCatalog`, `addedKeys`, then `proposeTiers` + `reconcileTierList` per role.
- `chosenNative` — `nativeKeys` resolved through a key→candidate map.
- `nativeRoleModels` — via `reconcilePerRoleModels`.
- `configToml` — `nativeTomlFor(...)` with `avoidGateways` read from `env.configsByScope[state.configScope]`.
- `notices` — the key check from `:1248–1300`, every `out(...)` becoming a pushed string with its leading spaces preserved.
- `summary` — the block from `:1376–1386`, same treatment.
- `hook`, `skillPath`, `syncCwd`, `agentsDir`, `routing` — the path computations from `:1303–1311`, `:1428`, `:1443`, `:1466`.

Add `fsCredentialProbe(home, copilotUsable)` wrapping `resolveKeyFromSource`, `existsSync(join(credentialDir(...), credentialFileFor(auth)))`, `keyReport`, and `readChatGptOAuth` — the calls the key check makes today.

- [ ] **Step 4: Call it from `runInit`**

Both branches now stop after producing `InitState`. Replace everything from the `migratedModels` computation through the summary print with:

```ts
const initPlan = plan(env, state, fsCredentialProbe(opts.home, env.copilotUsable), opts);
for (const line of initPlan.notices) out(line);
out('');
for (const line of initPlan.summary) out(line);
```

- [ ] **Step 5: Run**

Run: `npx vitest run tests/init/plan.test.ts`
Expected: 8 passed.

Run: `npm test`
Expected: **1258 passed**.

- [ ] **Step 6: Commit**

```bash
git add src/init/plan.ts src/commands/init.ts tests/init/plan.test.ts
git commit -m "refactor(init): compute every write as one InitPlan value"
```

---

## Task 8: Extract `src/init/apply.ts`

**Files:**
- Create: `src/init/apply.ts`
- Modify: `src/commands/init.ts` (the write section, `:1398–1499`)
- Create: `tests/init/apply.test.ts`

**Interfaces:**
- Consumes: `InitPlan` (Task 7).
- Produces:

```ts
export interface ApplyIo {
  out: (line: string) => void;
  /** Stale agents are only known after cmdSync runs, so prune cannot be pre-planned. */
  prune: boolean | ((stale: string[]) => Promise<boolean>);
}

export async function apply(plan: InitPlan, opts: Pick<InitOptions, 'cwd' | 'home' | 'packageRoot'>, io: ApplyIo): Promise<{
  agentsWritten: string[];
  pruned: string[];
  hookChanged: boolean;
}>;
```

**The write order is a contract, not an accident:** credentials, config, settings, skill, routing, sync, prune. Credentials are written first *within* `apply` but `apply` itself runs only after the confirm gate — that ordering is why a cancelled run leaves no credential behind.

- [ ] **Step 1: Write the failing test**

Create `tests/init/apply.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { apply } from '../../src/init/apply.js';
import { loadConfig } from '../../src/config.js';
import type { InitPlan } from '../../src/init/plan.js';

let home: string;
let cwd: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sonata-apply-home-'));
  cwd = mkdtempSync(join(tmpdir(), 'sonata-apply-cwd-'));
});

const planFor = (): InitPlan => ({
  configScope: 'project',
  configPath: join(cwd, 'sonata.toml'),
  configToml: [
    '[models."acme-fast"]', 'gateway = "acme"', 'id = "fast"', '',
    '[native.gateways."acme"]', 'base_url = "https://acme.example/v1"', '',
    '[tiers.code]', 'simple = ["acme-fast"]', 'complex = ["acme-fast"]', '',
  ].join('\n'),
  keysToStore: [],
  hook: { scope: 'skip' },
  skillPath: join(cwd, '.claude', 'skills', 'sonata-loop', 'SKILL.md'),
  routing: 'skip',
  syncCwd: cwd,
  agentsDir: join(cwd, '.claude', 'agents'),
  chosenNative: [], roles: ['code'], nativeKeys: ['acme-fast'],
  notices: [], summary: [],
});

describe('apply', () => {
  it('writes a config that loads back', async () => {
    await apply(planFor(), { cwd, home, packageRoot: resolve('.') }, { out: () => {}, prune: false });
    expect(loadConfig(cwd, home).tiers?.code.simple).toEqual(['acme-fast']);
  });

  it('installs the loop skill', async () => {
    const p = planFor();
    await apply(p, { cwd, home, packageRoot: resolve('.') }, { out: () => {}, prune: false });
    expect(existsSync(p.skillPath)).toBe(true);
    expect(readFileSync(p.skillPath, 'utf8')).toContain('sonata');
  });

  it('generates one agent file per role and tier', async () => {
    const res = await apply(planFor(), { cwd, home, packageRoot: resolve('.') }, { out: () => {}, prune: false });
    expect(res.agentsWritten.map((p) => p.split('/').pop()).sort()).toEqual(['code.md']);
  });

  it('asks before pruning and honours a refusal', async () => {
    let asked = false;
    const res = await apply(planFor(), { cwd, home, packageRoot: resolve('.') },
      { out: () => {}, prune: async () => { asked = true; return false; } });
    // Nothing stale on a fresh directory, so the callback must not fire.
    expect(asked).toBe(false);
    expect(res.pruned).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run tests/init/apply.test.ts`
Expected: FAIL — `Cannot find module '../../src/init/apply.js'`.

- [ ] **Step 3: Implement**

Move `:1398–1499` into `apply()`, in the contract order above. Every `out(...)` becomes `io.out(...)`. The prune block becomes:

```ts
let pruned: string[] = [];
if (stale.length > 0) {
  io.out('');
  io.out(`  ! ${stale.length} stale agent file(s) no longer in your config:`);
  for (const f of stale.slice(0, 5)) io.out(`      ${f}`);
  if (stale.length > 5) io.out(`      … and ${stale.length - 5} more`);
  const remove = typeof io.prune === 'function' ? await io.prune(stale) : io.prune;
  if (remove) {
    pruned = pruneAgents(plan.agentsDir, stale);
    io.out(`  ✓ removed ${pruned.length} stale agent file(s)`);
  } else {
    io.out('      ❯ delete them by hand, or re-run with --prune');
  }
}
```

- [ ] **Step 4: Call it from `runInit`**

```ts
const { agentsWritten, pruned, hookChanged } = await apply(initPlan, opts, {
  out,
  prune: opts.prune ?? (interactive ? async () => confirm('Delete them?', true) : false),
});
```

- [ ] **Step 5: Run**

Run: `npx vitest run tests/init/apply.test.ts`
Expected: 4 passed.

Run: `npm test`
Expected: **1262 passed**.

- [ ] **Step 6: Commit**

```bash
git add src/init/apply.ts src/commands/init.ts tests/init/apply.test.ts
git commit -m "refactor(init): extract the write phase into src/init/apply.ts"
```

---

## Task 9: Extract the two front ends

**Files:**
- Create: `src/init/interactive-state.ts`
- Create: `src/init/scripted-state.ts`
- Modify: `src/tui-ink/types.ts` (add `routing` to `InitState`)
- Modify: `src/commands/init.ts`

**Interfaces:**
- Consumes: `InitEnvironment` (Task 4).
- Produces:

```ts
// src/init/interactive-state.ts
export async function interactiveState(
  env: InitEnvironment,
  opts: Pick<InitOptions, 'cwd' | 'home' | 'packageRoot' | 'scope' | 'routing'>,
  log: InitLog,
): Promise<{ state: InitState; cancelled: boolean }>;

// src/init/scripted-state.ts
export function scriptedState(
  env: InitEnvironment,
  opts: InitOptions,
): InitState;
```

- [ ] **Step 1: Add the two missing state fields**

In `src/tui-ink/types.ts`, add to `InitState`:

```ts
  /**
   * Where the permission hook goes. Already declared, but until now `cmdInit`
   * prompted for it separately and ignored this field.
   */
  hookScope?: HookScope;
  /** Whether tier agents get routed, and at which scope. */
  routing?: 'project' | 'global' | 'skip';
```

(`hookScope` already exists — leave it, and add the comment.)

- [ ] **Step 2: Move the interactive branch**

Move `init.ts:961–1089` into `interactiveState`, plus the hook-scope prompt (`:1313–1332`) and the routing prompt (`:1336–1348`), which now write into the returned `InitState` rather than into loose `let`s. The `WizardData` construction, `addByokCandidates`, `addLiveCandidates` and the BYOK base-URL fixups all move with it.

Return `{ state, cancelled }`. The cancelled-`InitResult` shape stays in `cmdInit`.

- [ ] **Step 3: Move the scripted branch**

Move `init.ts:1090–1217` into `scriptedState`, minus the validations Task 6 already moved. It sets `hookScope` from `opts.scope ?? (env.existingHookScope ? 'skip' : 'project')` and `routing` from `opts.routing ?? 'project'`, so its output is the same shape the wizard produces.

- [ ] **Step 4: Run**

Run: `npm test`
Expected: **1262 passed** — a pure move.

- [ ] **Step 5: Commit**

```bash
git add src/init/interactive-state.ts src/init/scripted-state.ts src/tui-ink/types.ts src/commands/init.ts
git commit -m "refactor(init): split the wizard and --yes front ends into two modules"
```

---

## Task 10: Reduce `cmdInit`, and assert parity

The parity test is the strongest single case in the plan. The duplication arose by drift, and nothing currently notices drift.

**Files:**
- Modify: `src/commands/init.ts`
- Create: `tests/init/run.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 4–9.
- Produces: `cmdInit` unchanged in signature — `(opts: InitOptions) => Promise<InitResult>`.

- [ ] **Step 1: Reduce `runInit` to the pipeline**

```ts
async function runInit(opts: InitOptions, out: (line: string) => void, log: InitLog, interactive: boolean): Promise<InitResult> {
  out('');
  out(interactive ? banner() : '  sonata init');
  out('');

  const env = await discover(opts, out);
  if (env.problems.some((p) => p.severity === 'error')) {
    for (const p of env.problems) out(renderProblem(p));
    out('');
    out('  Fix the errors above, then run `sonata init` again.');
    return blockedResult(env.problems, opts);
  }
  for (const p of env.problems) out(renderProblem(p));

  const chosen = interactive
    ? await interactiveState(env, opts, log)
    : { state: scriptedState(env, opts), cancelled: false };
  if (chosen.cancelled) {
    out('  Nothing written.');
    return cancelledResult(env.problems, chosen.state, opts);
  }

  // Validation precedes planning: a plan built from an invalid state is a
  // plan nobody should see, and `validate` resolves its own candidates so it
  // has no dependency on `plan` having run.
  const problems = validate(env, chosen.state);
  if (problems.length > 0) {
    if (!interactive) throw new Error(problems[0].message);
    for (const p of problems) out(renderProblem(p));
    return cancelledResult(env.problems, chosen.state, opts);
  }

  const credentials = fsCredentialProbe(opts.home, env.copilotUsable);
  const initPlan = plan(env, chosen.state, credentials, opts);

  for (const line of initPlan.notices) out(line);
  out('');
  for (const line of initPlan.summary) out(line);
  out('');

  log.line(`hook scope resolved: ${initPlan.hook.scope}`);
  if (interactive) log.line('prompting for write confirmation');
  if (interactive && !(await confirm('Write these changes?', true))) {
    out('  Nothing written.');
    return cancelledResult(env.problems, chosen.state, opts);
  }

  const applied = await apply(initPlan, opts, {
    out,
    prune: opts.prune ?? (interactive ? async () => confirm('Delete them?', true) : false),
  });

  out('');
  out('  Done. Run /reload-plugins to pick up the new agents.');
  out('  Native sessions: run `sonata code`, or `sonata route on` to route plain claude sessions.');
  out('');

  return {
    problems: env.problems, models: initPlan.nativeKeys, roles: initPlan.roles,
    scope: initPlan.hook.scope, routing: initPlan.routing,
    hookChanged: applied.hookChanged, agentsWritten: applied.agentsWritten,
    configPath: initPlan.configPath, pruned: applied.pruned,
  };
}
```

Add the two small helpers `blockedResult` and `cancelledResult` beside it, each returning the `InitResult` shape the old early-returns built.

- [ ] **Step 2: Write the full-run and parity tests**

Create `tests/init/run.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cmdInit } from '../../src/commands/init.js';
import { discover } from '../../src/init/discover.js';
import { scriptedState } from '../../src/init/scripted-state.js';
import { plan } from '../../src/init/plan.js';
import { loadConfig } from '../../src/config.js';
import { nullInitLog } from '../../src/commands/init-log.js';

let home: string;
let cwd: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sonata-run-home-'));
  cwd = mkdtempSync(join(tmpdir(), 'sonata-run-cwd-'));
});

const detect = async () => ({
  tmux: { installed: true, version: '3.4', problems: [] },
  harnesses: [{
    name: 'opencode', installed: true, version: '1.18.16', problems: [],
    refs: [{ harness: 'opencode', provider: 'acme', model: 'fast' }],
    authedProviders: ['acme'],
    providerBaseUrls: { acme: 'https://acme.example/v1' },
  }],
});

const base = () => ({
  cwd, home, packageRoot: resolve('.'), detect, yes: true,
  providers: ['opencode/acme'], models: ['acme-fast'], roles: ['code'],
  configScope: 'project' as const, scope: 'skip' as const, routing: 'skip' as const,
  log: nullInitLog(), write: () => {},
});

describe('a stranger’s first run', () => {
  it('writes a config that loads, plus agents and no hook', async () => {
    const res = await cmdInit(base());
    expect(existsSync(join(cwd, 'sonata.toml'))).toBe(true);
    expect(loadConfig(cwd, home).tiers?.code.simple).toEqual(['acme-fast']);
    expect(res.agentsWritten.length).toBeGreaterThan(0);
    expect(res.hookChanged).toBe(false);
  });

  it('is idempotent — a second run keeps the saved tiers', async () => {
    await cmdInit(base());
    const first = loadConfig(cwd, home).tiers;
    await cmdInit(base());
    expect(loadConfig(cwd, home).tiers).toEqual(first);
  });
});

describe('front-end parity', () => {
  it('produces an identical InitPlan from the wizard state and the flag state', async () => {
    // The duplication this refactor removed arose by drift between the two
    // branches. Asserting the two plans are equal is what notices drift.
    //
    // The wizard state is written out as a literal on purpose. Deriving it
    // from `scripted` — even by spreading it — compares a value to a copy of
    // itself and passes no matter how far the two front ends diverge.
    const env = await discover({ cwd, home, packageRoot: resolve('.'), detect }, () => {});
    const opts = { cwd, home, packageRoot: resolve('.') };
    const credentials = {
      hasKey: () => false, hasOauthCredential: () => false,
      autoSource: () => null, copilotUsable: false,
    };

    const scripted = scriptedState(env, base());

    // What the Ink wizard returns for the same choices: project scope, the one
    // provider ticked, the one model ticked, the `code` role, both tiers
    // ranked to that model, hook skipped, routing skipped.
    const fromWizard = {
      configScope: 'project' as const,
      harnesses: ['opencode'],
      providerKeys: ['opencode/acme'],
      nativeKeys: ['acme-fast'],
      roles: ['code'],
      tiers: { code: { simple: ['acme-fast'], complex: ['acme-fast'] } },
      perRoleModels: { code: ['acme-fast'] },
      credentialSources: {},
      hookScope: 'skip' as const,
      routing: 'skip' as const,
    };

    // Guard the guard: if the two states already differ, the plan comparison
    // below is testing something other than what it claims.
    expect(fromWizard.nativeKeys).toEqual(scripted.nativeKeys);
    expect(fromWizard.roles).toEqual(scripted.roles);

    expect(plan(env, fromWizard, credentials, opts))
      .toEqual(plan(env, scripted, credentials, opts));
  });
});
```

- [ ] **Step 3: Run**

Run: `npx vitest run tests/init/run.test.ts`
Expected: 3 passed.

Run: `npm test`
Expected: **1265 passed**.

- [ ] **Step 4: Verify by hand, since this is the wizard**

```bash
npm run build
```

Then drive the real TUI via `/cmux` — address the surface by **UUID** (`surface.read_text` / `surface.send_key` with `surface_id`); a bare `workspace_ref` follows whatever is focused. Run `sonata init` in a scratch directory, walk every screen, and confirm the written config loads. Level B mocks stdin, and the mocked stdin is exactly what the Ink-teardown class breaks — so this step is not optional.

- [ ] **Step 5: Commit**

```bash
git add src/commands/init.ts tests/init/run.test.ts
git commit -m "refactor(init): reduce cmdInit to the discover/choose/plan/apply pipeline"
```

---

## Task 11: Migrate the remaining tests

**Files:**
- Modify: `tests/init.test.ts`
- Modify: `tests/init/discover.test.ts`, `tests/init/plan.test.ts`, `tests/init/validate.test.ts`

**Interfaces:**
- Consumes: everything above. Produces nothing new.

- [ ] **Step 1: Record the baseline count**

Run: `npm test`
Write the number down. It should be **1265**.

- [ ] **Step 2: Move each remaining `describe` to the module it now tests**

`tests/init.test.ts` still holds cases for `deriveInitState`, `nativeCandidatesFrom`, `oauthProvidersFor`, `configNativeCandidates`, `preTickedNative`, `reconcileTierList`, `reconcilePerRoleModels`, `dedupeOauthProviders`, `credentialAvailabilityFor`, `avoidedKeysOf`, `gatewayNamesOf` and `duplicateKeys`. Move each `describe` to whichever new module now owns the function, changing only the import path. Anything still genuinely owned by `init.ts` stays.

- [ ] **Step 3: Confirm nothing was dropped**

Run: `npm test`
Expected: **exactly 1265 passed.** A lower number means a `describe` was moved without its body — find it. A test count is the only thing that notices a silently dropped test.

- [ ] **Step 4: Confirm the structural bar is met**

```bash
wc -l src/commands/init.ts src/init/*.ts
```

Expected: `init.ts` well under 300 lines, and no single `src/init/*.ts` over ~400. If `plan.ts` is the outlier, that is expected — it absorbed two duplicated blocks and the key check.

- [ ] **Step 5: Commit**

```bash
git add tests/
git commit -m "test(init): split init.test.ts across the extracted modules"
```

---

## Task 12: Update the docs

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/roadmap.md`
- Modify: `docs/superpowers/README.md`

- [ ] **Step 1: Update the source layout in `CLAUDE.md`**

In the `### Source layout` tree, replace the `commands/` line's implied monolith with the new directory:

```text
├── init/                 init pipeline — discover.ts (machine state, once), validate.ts
│                         (shared problems), plan.ts (every write as one InitPlan value),
│                         apply.ts (I/O only), interactive-state.ts / scripted-state.ts
│                         (two front ends, one InitState), toml.ts (nativeTomlFor)
```

Add a bullet to the Configuration section recording the `config/<gateway>` fix from Task 5 — that an unattributable gateway means *ambiguous or absent*, and why offering only the absent case broke `--yes`.

- [ ] **Step 2: Mark item 06 shipped in `docs/roadmap.md`**

Change item 06's status cell from `🔸 in progress — …` to `✅ shipped in 0.4.0`. **The roadmap mirrors a claude.ai Artifact** (linked at the top of that file) — tell the user it needs the same edit; do not assume it syncs.

- [ ] **Step 3: Link the plan in the design-history index**

In `docs/superpowers/README.md`, change the 2026-08-30 row's Plan column from `— **queued**, plan not yet written` to `[plan](plans/2026-08-30-init-hardening.md)`.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/roadmap.md docs/superpowers/README.md
git commit -m "docs: record the init pipeline and mark roadmap item 06 shipped"
```

---

## Done when

- `npm test` passes with **1265** tests and `npm run typecheck` is clean.
- `src/commands/init.ts` is under 300 lines and `cmdInit` is no longer an 814-line function.
- Each of the three 0.3.x defects has a test that fails when the fix is reverted — verified by actually reverting, not by inspection.
- `sonata init` has been hand-driven through the real TUI end to end after the final build.
- The Ink stdin-teardown class remains uncovered, and `CLAUDE.md` says so.
