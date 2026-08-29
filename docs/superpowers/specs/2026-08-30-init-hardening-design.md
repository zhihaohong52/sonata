# `sonata init` hardening — decompose the front door, and test it

Roadmap item 06, the first of the three items that make up 0.4 ("Let strangers
in"). Sequenced ahead of 09 (managed LiteLLM venv) and 08 (npm publish), because
publishing before hardening means strangers meet the untested front door.

## Why this item, and the evidence for it

`src/commands/init.ts` is 1502 lines with 20 exports, and `cmdInit` alone is 814
of them (687–1500). `tests/init.test.ts` has 149 cases, all of which test
*exported helpers* rather than the command as a flow.

Every defect found during the 0.3.2–0.3.4 releases was in `init`, and **none was
caught by the 1231-test suite**. All three were found by hand-driving the real
TUI:

- **`initialRankedFor`** — `applyStep` seeds a role's other tier as `[]`, and
  `saved ?? proposal` kept the empty list. Every role's *complex* screen rendered
  unranked, and `RankedSelect` refuses to submit an empty ranking, so the wizard
  could not be advanced at all. Visible only when no tiers are saved — that is,
  on a first run. (`3548c28`)
- **`avoid_gateways` TOML placement** — written after a `[table]` header, so TOML
  bound it to that table. Silently ignored; `sonata doctor` green throughout.
  (`5f61ebb`)
- **Models-step regressions** — invalid config written, duplicate keys.
  (`c823ca2`)

Two of the three hit the **first-run** path specifically: the path every new user
takes and no existing user does. That is the argument for this item, and it is
why the acceptance bars below are written against those defects by name.

## Acceptance bars

Four, all of which must hold:

1. **Regression** — each of the three defects above would fail the suite.
2. **First-run coverage** — an end-to-end test drives a stranger's first run: no
   config, fresh machine, every wizard screen, through to the files on disk.
3. **Structural** — `cmdInit` stops being an 814-line function; `init.ts` splits
   into named units with stated inputs and outputs, each testable alone.
4. **Scripted parity** — the `--yes` branch stops being a parallel
   reimplementation of the interactive one. One shared core, two front ends.

Bar 3 is the means; 1, 2 and 4 are the ends it gets judged by.

The decomposition is **free to reshape the export surface**. `init.ts` keeps only
what `cli.ts` imports; the 149 existing cases move to test files matching the new
units and are rewritten where a signature changed. No re-export shim — a shim
would leave the seams wherever the old exports happened to fall.

## Architecture

Seven modules under `src/init/`, with `init.ts` reduced to orchestration. Six are
pipeline stages; the seventh, `toml.ts`, is a pure helper `plan` consumes.

```
discover(opts, detect)               → InitEnvironment    async, all machine I/O
  ├─ interactiveState(env, io)       → InitState          Ink wizard + prompts
  └─ scriptedState(env, flags)       → InitState          from flags
validate(env, state)                 → Problem[]          shared, no throw
plan(env, state, credentials)        → InitPlan           no I/O beyond the port
apply(plan, io)                      → InitResult         all I/O, no decisions
```

`cmdInit` becomes roughly 80 lines: open the log, run the stages, print, return.

### `InitEnvironment` — everything the machine told us, computed once

`tmux`, `harnesses`, `problems`, `offered`, `allNativeCandidates`,
`providerBaseUrls`, `gatewayAuth`, `oauthProviders`, `configsByScope` (post
legacy-migration), `existingHookScope`, `copilotUsable`. This is `runInit:715–882`
lifted wholesale. One injected `detect`; everything else is `fs` reads and the
single `copilotTokenCanExchange` network probe that already lives there.

### Two front ends, one output type

Both produce an `InitState` and nothing else.

`InitState` grows a `routing` field and starts actually using its existing
`hookScope`. Today the hook-scope and routing prompts are loose `await select()`
calls stranded between the key check and the write path (`:1303–1348`); as state
fields they are filled by prompting in the interactive front end and from
`opts.scope` / `opts.routing` in the scripted one, and every stage downstream
stops caring which produced them.

### The confirm gate renders the plan

Today the summary is hand-assembled from a dozen loose `let` bindings before
anything is written (`:1375–1396`). In the pipeline it sits between `plan` and
`apply` and renders the `InitPlan` itself, so what the user confirms is the
object that gets applied rather than a parallel description of it that can drift
from it.

### `InitPlan`

```ts
interface InitPlan {
  configPath: string;
  configToml: string;                                    // nativeTomlFor output
  keysToStore: Array<{ gateway: string; key: string }>;  // never logged
  hook: { scope: HookScope | 'skip'; settingsPath?: string; allowListScope?: HookScope };
  skillPath: string;
  routing: 'project' | 'global' | 'skip';
  syncCwd: string;
  agentsDir: string;
  notices: string[];
  summary: string[];
}
```

`summary` is the block the confirm gate renders (models, roles, agent count,
hook, routing, config path). `notices` is separate: it carries what the key check
currently prints inline at `:1248–1300` —
`✓ acme: key from sonata`, `! acme: no credential from codex — log in with
codex login`, and the rest. Those are eight `(source, auth)` branches with no
coverage today. As data on the plan they become assertions.

### `plan` is not literally pure, and the spec does not claim it is

The key check reads credential presence from disk for the *chosen* gateways,
which are not known until after state selection — so `discover` cannot
pre-resolve them. `plan(env, state, credentials)` takes a small `CredentialProbe`
port: `fs`-backed in production, a plain record in tests. Purity was always the
means; the testability is what matters and it is intact.

### One interactive callback survives inside `apply`

Stale agent files are only known after `cmdSync` runs, so prune cannot be
pre-planned. `apply` takes `prune: boolean | ((stale: string[]) => Promise<boolean>)`.
Everything else in `apply` is unconditional I/O.

## What the shared core fixes

### The duplication is verbatim, not merely parallel

Two blocks are near-identical copies across the interactive and scripted
branches:

- **`migratedModels`** — ~7 lines at `:1032` and `:1098`, both carrying the same
  four-line comment about `parseConfig` already building `unifiedModels`.
- **The tiers block** — ~12 lines at `:1063` and `:1200`: `validTierKeys`,
  `loadAaCatalog`, `addedKeys`, then `proposeTiers` + `reconcileTierList` per
  role.

Plus `chosenNative` and `nativeRoleModels`, the same computation over
differently-named bindings. Everything after "we have an `InitState`" is one
function. The genuine differences reduce to how the state is produced and which
validations fire — exactly the split the pipeline draws.

### The `config/*` bug, mechanism confirmed

`deriveInitState` (`:449`) emits `config/<gateway>` into `providerKeys` when
`matches.length === 0 || distinctHarnesses.size > 1`. But `runInit` synthesizes a
`config/<gateway>` entry in `offered` only when **no** provider matches that name
(`:777`).

So the second case — two harnesses cataloguing one gateway, which the code
comment records as verified live with opencode and pi both listing
`opencode-go` — puts `config/opencode-go` into `providerKeys` while `offered`
holds `opencode/opencode-go` and `pi/opencode-go`. The scripted path's
`unknownProviders` check then throws `no harness offers config/opencode-go`
before role selection is reached. The interactive path never hits it, because the
wizard supplies `providerKeys` from the picker.

**Fix:** `discover` synthesizes the `config/` entry whenever a gateway is
unattributable — ambiguous *or* absent — so `offered` and `deriveInitState` agree
on what a gateway with no single harness is called.

### Shared `validate` fires on both paths

Today the interactive path is protected only by the wizard being correct: the
"no models selected", "unknown role", and provider checks exist in the scripted
branch alone. Sharing them means they can now fire interactively. That is
intended. An unreachable check firing is a bug report, not a regression.

## Testing

Three levels, each earning its place by catching something the others cannot.

### A · Plan-level units

`(InitEnvironment, InitState, fake CredentialProbe) → InitPlan`. No `fs`, no
React, fast.

**The assertions must round-trip, not string-match.** For `avoid_gateways`, the
test parses the emitted TOML through `parseConfig` and asserts `avoidGateways`
survives. A placement assertion would have *passed* the broken version — the bug
was that the TOML parsed fine and bound the key to the preceding table. Same for
duplicate keys: parse and compare, do not grep.

Also covers the eight `(source, auth)` repair-hint branches in `notices`.

### B · Wizard flow

`ink-testing-library` renders `InitWizard` against fixture `WizardData`,
keystrokes in, `TuiResult` out.

The decisive case is one test: **`WizardData` with no `initialState`, driven to a
complex-tier screen, asserting the screen renders a non-empty ranking and that
Enter advances.** That is the `initialRankedFor` first-run freeze, which made the
wizard literally unadvanceable while 1231 tests stayed green.

Keep this level small — 8–12 tests. React renders are the slow ones.

### C · Full run

`cmdInit` against a temp home and temp cwd, injected `detect`, injected wizard,
asserting files on disk: `sonata.toml` loads through `loadConfig`, agent files
exist, settings carry the hook and the allow-list, the skill is installed. This
is the first-run coverage bar.

**The strongest single test in the set lives here:** feed one environment to both
front ends with equivalent inputs and assert the two `InitPlan`s are deep-equal.
That makes parity a continuously-checked property rather than a one-time
refactor. The duplication arose by drift, and nothing currently notices drift.

### Known coverage gap

The Ink stdin-teardown class — `readKeys` / `unref`, the bug that *was* "sonata
init never saves the config" — is invisible to all three levels, because the
mocked stdin is precisely the thing that breaks. A pty-driven test was considered
and declined: a flaky CI test guarding a once-seen bug is worse than a documented
gap. The mitigation is the standing requirement to hand-drive the real TUI via
`/cmux` before release.

## Sequencing

**Level B is built first, before any refactoring.** The `runInitTui` seam is
already clean (`WizardData` in, `TuiResult` out), so the ink harness does not
depend on the decomposition at all. Building it first proves the harness works
and catches the `initialRankedFor` class while the code is still the code those
bugs happened in.

Then, in order:

1. **`toml.ts`** — `nativeTomlFor` + `tomlKey`. Already pure; zero risk.
2. **`discover.ts`** — `:715–882` lifted, plus the `config/*` synthesis fix. First
   behavioural change; gets its own fixture.
3. **`validate.ts` + `plan.ts`** — the shared core. Both branches still inline at
   this point, both rewritten to call it. The duplication dies here, and the
   deep-equal parity test lands with it.
4. **`apply.ts`** — the write section.
5. **`interactiveState.ts` / `scriptedState.ts`** — what remains of the branches.
6. `cmdInit` reduced to orchestration; `tests/init.test.ts` split across the new
   units.

Level A attaches after step 3, level C after step 4.

## Error handling

- `validate` returns `Problem[]` rather than throwing, so both paths render them
  identically. The scripted front end converts to a thrown `Error` at its
  boundary. **The existing message strings are preserved verbatim** — they are
  user-facing and tested.
- `CancelledError` / `isCancellation` are unchanged. Cancellation short-circuits
  before `apply`, so a cancelled run still writes nothing — including no
  credential, which is why `keysToStore` is applied after the confirm gate and
  not before.
- Blocking problems (severity `error`) still return the early `InitResult`, now
  from `cmdInit`.
- `apply` remains the only stage that can leave partial state, as it already can
  today. Its write order becomes a recorded contract rather than an accident:
  credentials, config, settings, skill, routing, sync, prune.

## Risks

| Risk | Mitigation |
|---|---|
| `ink-testing-library@4` against ink 7 is unverified | ~30-line in-house harness; Ink's `render` already accepts custom `stdin`/`stdout`. Costs a day, not the approach. |
| Behaviour drift during extraction | Level C full-run tests written before steps 3–5; the deep-equal parity test. |
| The `config/*` fix changes real behaviour | Needs the exact fixture: opencode and pi both cataloguing one gateway name. |
| Shared `validate` fires on the interactive path | Intended, but the first run after may fail loudly where it passed quietly. Hand-drive via `/cmux` before release. |
| A dropped test in the 149-case migration is invisible | Assert the total case count does not regress. |

## Out of scope

- Roadmap items 08 (npm publish automation) and 09 (managed LiteLLM venv). Each
  gets its own spec.
- Any new wizard features. This item changes structure and coverage, not
  behaviour, with the two exceptions named above: the `config/*` synthesis fix
  and shared validation.
- The defects already fixed in 0.3.2–0.3.4. They are the evidence for this item,
  not work inside it.
