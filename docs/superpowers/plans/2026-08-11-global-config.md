# Machine-Level sonata.toml — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one `~/.config/sonata/sonata.toml` serve every repository, with a local `sonata.toml` overriding it entirely.

**Architecture:** `loadConfig` gains a second, optional `home` parameter and resolves `./sonata.toml` before `~/.config/sonata/sonata.toml`. `init` gains a scope select governing both the config path and the agents directory, so the two cannot drift apart. Making `home` optional is deliberate: it keeps all five existing call sites compiling, which is what lets the later tasks touch disjoint files.

**Tech Stack:** TypeScript (strict, ESM), Node ≥22, vitest, smol-toml. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-11-global-config-design.md`

## Global Constraints

- ESM: every relative import ends in `.js`, even from `.ts` sources.
- Strict TypeScript. `npx tsc --noEmit` must pass at every commit.
- Full suite green at every commit: `npx vitest run` (294 tests pass today).
- No new runtime dependencies.
- No test may read the real `$HOME`. Every test injects `home` as a temp dir, as `tests/init.test.ts` already does.
- The global config path is exactly `<home>/.config/sonata/sonata.toml`.
- Every commit message ends with these two trailers:
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_0119sDQT9AWqPyL87rHHtkFN
  ```

## Parallelism

Tasks are drawn so that concurrently-runnable ones never touch the same file.

```
Task 1  src/config.ts                    ← must complete first; everything reads it
   │
   ├── Task 2  src/commands/init.ts      ┐
   ├── Task 3  src/commands/doctor.ts    ├─ safe to run at the same time
   └── Task 4  src/commands/sync.ts      ┘
                    │
                    └── Task 5  src/cli.ts + README.md
```

Task 1 is foundational and must land alone. Tasks 2, 3 and 4 touch three disjoint source files and three disjoint test files, and may run concurrently. Task 5 consumes the option types the middle three produce, so it runs last.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/config.ts` | Config resolution: which file, and loading it | 1 |
| `src/commands/init.ts` | Scope selection; where config and agents are written | 2 |
| `src/commands/doctor.ts` | Reporting which config is in effect; stray-file warning | 3 |
| `src/commands/sync.ts` | Regenerating agents against the resolved config | 4 |
| `src/cli.ts` | `--config-scope`, usage text, passing `home` through | 5 |
| `README.md` | Documenting the two scopes | 5 |

---

### Task 1: Config resolution

**Files:**
- Modify: `src/config.ts:79-86` (`loadConfig`)
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `GLOBAL_CONFIG_RELATIVE = '.config/sonata/sonata.toml'`, `configPath(cwd: string, home: string): string | null`, and `loadConfig(cwd: string, home?: string): SonataConfig` — `home` defaults to `homedir()` so existing callers keep compiling unchanged.

- [ ] **Step 1: Write the failing test**

Append to `tests/config.test.ts`:

```ts
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configPath, loadConfig } from '../src/config.js';

describe('configPath', () => {
  const MINIMAL = `
[models."m"]
harness = "codex"
id = "gpt-5.6-sol"

[generate]
roles = ["code"]
models = ["m"]
`;

  let cwd: string;
  let home: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'cfg-cwd-'));
    home = mkdtempSync(join(tmpdir(), 'cfg-home-'));
  });

  const writeLocal = () => writeFileSync(join(cwd, 'sonata.toml'), MINIMAL);
  const writeGlobal = (body = MINIMAL) => {
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(join(home, '.config', 'sonata', 'sonata.toml'), body);
  };

  it('uses the project config when there is one', () => {
    writeLocal();
    expect(configPath(cwd, home)).toBe(join(cwd, 'sonata.toml'));
  });

  it('falls back to the machine config', () => {
    writeGlobal();
    expect(configPath(cwd, home)).toBe(join(home, '.config', 'sonata', 'sonata.toml'));
  });

  it('prefers the project config when both exist', () => {
    writeLocal();
    writeGlobal();
    expect(configPath(cwd, home)).toBe(join(cwd, 'sonata.toml'));
  });

  it('returns null when neither exists', () => {
    expect(configPath(cwd, home)).toBeNull();
  });
});

describe('loadConfig — resolution', () => {
  let cwd: string;
  let home: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'cfg-cwd-'));
    home = mkdtempSync(join(tmpdir(), 'cfg-home-'));
  });

  it('loads the machine config when the project has none', () => {
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(join(home, '.config', 'sonata', 'sonata.toml'), `
[models."m"]
harness = "codex"
id = "gpt-5.6-sol"

[generate]
roles = ["code"]
models = ["m"]
`);
    expect(Object.keys(loadConfig(cwd, home).models)).toEqual(['m']);
  });

  it('names both places it looked when neither exists', () => {
    // The old message named only the project path, which told a user with a
    // machine config nothing about why it was not being used.
    expect(() => loadConfig(cwd, home)).toThrow(/sonata\.toml/);
    expect(() => loadConfig(cwd, home)).toThrow(new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    expect(() => loadConfig(cwd, home)).toThrow(/\.config[/\\]sonata/);
  });
});
```

Add `beforeEach` to the existing `vitest` import in that file if it is not already there.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config.test.ts -t configPath`
Expected: FAIL — `configPath is not a function`.

- [ ] **Step 3: Write the implementation**

In `src/config.ts`, add `homedir` to the imports and replace `loadConfig`:

```ts
import { homedir } from 'node:os';

/** Where a machine-level config lives, relative to the home directory. */
export const GLOBAL_CONFIG_RELATIVE = join('.config', 'sonata', 'sonata.toml');

/**
 * The config file that will be used, or null if there is none.
 *
 * A project config wins outright — it is not merged with the machine one.
 * Exactly one file is ever in effect, so it is always possible to say which
 * file produced a run.
 */
export function configPath(cwd: string, home: string): string | null {
  const local = join(cwd, 'sonata.toml');
  if (existsSync(local)) return local;
  const global = join(home, GLOBAL_CONFIG_RELATIVE);
  if (existsSync(global)) return global;
  return null;
}

/**
 * `home` is optional so that callers which have not yet been threaded through
 * keep working; it is always injected in tests, which must never read the
 * real home directory.
 */
export function loadConfig(cwd: string, home: string = homedir()): SonataConfig {
  const path = configPath(cwd, home);
  if (path === null) {
    throw new Error(
      `No sonata.toml found. Looked in ${join(cwd, 'sonata.toml')} and ` +
      `${join(home, GLOBAL_CONFIG_RELATIVE)}. Run \`sonata init\` or create one.`,
    );
  }
  return parseConfig(readFileSync(path, 'utf8'));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS, including the pre-existing config tests.

- [ ] **Step 5: Typecheck, run the full suite, commit**

```bash
npx tsc --noEmit && npx vitest run
git add src/config.ts tests/config.test.ts
git commit -m "$(cat <<'EOF'
feat: resolve sonata.toml from the project, then the machine

loadConfig only ever looked in the cwd, so sonata had to be configured
per repository. It now falls back to ~/.config/sonata/sonata.toml, and
the not-found error names both places rather than only the first.

`home` is optional so the five existing call sites keep compiling; they
are threaded through in later tasks.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0119sDQT9AWqPyL87rHHtkFN
EOF
)"
```

---

### Task 2: `init` chooses a scope

Runs concurrently with Tasks 3 and 4. Touches only `src/commands/init.ts` and `tests/init.test.ts`.

**Files:**
- Modify: `src/commands/init.ts`
- Test: `tests/init.test.ts`

**Interfaces:**
- Consumes: `configPath`, `GLOBAL_CONFIG_RELATIVE` from `../config.js` (Task 1).
- Produces: `type ConfigScope = 'project' | 'global'`, `configPathFor(scope, cwd, home): string`, `agentsDirFor(scope, cwd, home): string`, and `InitOptions.configScope?: ConfigScope`.

- [ ] **Step 1: Write the failing test**

Append to `tests/init.test.ts`, adding `configPathFor, agentsDirFor` to the `../src/commands/init.js` import:

```ts
describe('configPathFor / agentsDirFor', () => {
  it('puts a project config and its agents beside the repo', () => {
    expect(configPathFor('project', '/repo', '/home')).toBe(join('/repo', 'sonata.toml'));
    expect(agentsDirFor('project', '/repo', '/home')).toBe(join('/repo', '.claude', 'agents'));
  });

  it('puts a global config and its agents under home', () => {
    // Both must follow the scope. Splitting them is the defect this fixes:
    // init in $HOME wrote agents globally and config where only $HOME reads it.
    expect(configPathFor('global', '/repo', '/home'))
      .toBe(join('/home', '.config', 'sonata', 'sonata.toml'));
    expect(agentsDirFor('global', '/repo', '/home')).toBe(join('/home', '.claude', 'agents'));
  });
});

describe('cmdInit — config scope', () => {
  const detect = async () => ({
    tmux: { installed: true, version: '3.7b', problems: [] },
    harnesses: [{
      name: 'opencode', installed: true, version: '1.18.16', supported: true,
      refs: parseOpenCodeRefs('openrouter/kimi-k3\n'),
      authedProviders: ['openrouter'], problems: [],
    }],
  });

  const args = {
    packageRoot: '/pkg', yes: true, detect,
    providers: ['opencode/openrouter'], models: ['opencode-openrouter-kimi-k3'],
    roles: ['code'], scope: 'skip' as const,
  };

  it('writes a global config and global agents, and nothing in the repo', async () => {
    const res = await cmdInit({ ...args, cwd, home, configScope: 'global', write });

    expect(res.configPath).toBe(join(home, '.config', 'sonata', 'sonata.toml'));
    expect(existsSync(join(home, '.config', 'sonata', 'sonata.toml'))).toBe(true);
    expect(existsSync(join(home, '.claude', 'agents', 'code-opencode-openrouter-kimi-k3.md'))).toBe(true);
    expect(existsSync(join(cwd, 'sonata.toml'))).toBe(false);
    expect(existsSync(join(cwd, '.claude', 'agents'))).toBe(false);
  });

  it('defaults to the project scope', async () => {
    const res = await cmdInit({ ...args, cwd, home, write });
    expect(res.configPath).toBe(join(cwd, 'sonata.toml'));
    expect(existsSync(join(cwd, '.claude', 'agents', 'code-opencode-openrouter-kimi-k3.md'))).toBe(true);
  });

  it('pre-ticks from the machine config when the repo has none', async () => {
    await cmdInit({ ...args, cwd, home, configScope: 'global', write });
    // A second run with no --models carries over whatever is already enabled,
    // which now has to be found in the global config rather than the cwd.
    const second = await cmdInit({
      packageRoot: '/pkg', yes: true, detect, cwd, home,
      roles: ['code'], scope: 'skip' as const, configScope: 'global' as const, write,
    });
    expect(second.models).toEqual(['opencode-openrouter-kimi-k3']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/init.test.ts -t configPathFor`
Expected: FAIL — `configPathFor is not a function`.

- [ ] **Step 3: Add the scope helpers**

In `src/commands/init.ts`, import `configPath, GLOBAL_CONFIG_RELATIVE` from `../config.js` alongside the existing `KNOWN_ROLES, parseConfig`, then add:

```ts
export type ConfigScope = 'project' | 'global';

/**
 * Where a config is written for a scope. The read-side counterpart is
 * `configPath`, which resolves a precedence chain; this picks one location.
 */
export function configPathFor(scope: ConfigScope, cwd: string, home: string): string {
  return scope === 'global'
    ? join(home, GLOBAL_CONFIG_RELATIVE)
    : join(cwd, 'sonata.toml');
}

/**
 * Agents follow the config's scope. Keeping them together is the whole point:
 * `init` in $HOME used to write agents globally and config where only $HOME
 * could read it, producing agents that were offered everywhere and worked
 * nowhere.
 */
export function agentsDirFor(scope: ConfigScope, cwd: string, home: string): string {
  return scope === 'global'
    ? join(home, '.claude', 'agents')
    : join(cwd, '.claude', 'agents');
}
```

- [ ] **Step 4: Add the option and the TUI step**

Add to `InitOptions`:

```ts
  /** Where the config and its agents are written. Defaults to `project`. */
  configScope?: ConfigScope;
```

In `cmdInit`, after the roles selection and before the hook-scope block, add:

```ts
  let configScope: ConfigScope;
  if (opts.configScope) {
    configScope = opts.configScope;
  } else if (interactive) {
    out('');
    configScope = await select<ConfigScope>('Where should this config apply', [
      { value: 'project', label: 'This project only', hint: './sonata.toml + ./.claude/agents/' },
      { value: 'global', label: 'All projects', hint: '~/.config/sonata/ + ~/.claude/agents/' },
    ]);
  } else {
    configScope = 'project';
  }
```

- [ ] **Step 5: Use the scope for both paths**

Replace the two hardcoded paths. The config path:

```ts
  const configPathResolved = configPathFor(configScope, opts.cwd, opts.home);
```

Use `configPathResolved` everywhere `configPath` was previously the local
constant — the summary line, the `writeFileSync`, and `InitResult.configPath`.
Before writing, ensure the directory exists, because `~/.config/sonata/` may
not:

```ts
  mkdirSync(dirname(configPathResolved), { recursive: true });
  writeFileSync(configPathResolved, tomlFor(chosen, roles, carried));
```

Add `mkdirSync` to the `node:fs` import and `dirname` to the `node:path` import.

The existing config read for pre-ticking and carry-forward must read the file
that is actually in effect, so replace the `existsSync(join(opts.cwd, 'sonata.toml'))`
lookup with:

```ts
  const resolved = configPath(opts.cwd, opts.home);
  const configText = resolved === null ? '' : readFileSync(resolved, 'utf8');
```

And the agents directory:

```ts
  const agentsDir = agentsDirFor(configScope, opts.cwd, opts.home);
  const agentsWritten = cmdSync({ cwd: opts.cwd, home: opts.home, agentsDir });
```

If Task 4 has not landed yet, `cmdSync` will not accept `home` and the
typechecker will say so. In that case pass only `{ cwd: opts.cwd, agentsDir }`
and leave a comment `// home added in task 4`; the two tasks are independent
and either order works.

- [ ] **Step 6: Run the full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/commands/init.ts tests/init.test.ts
git commit -m "$(cat <<'EOF'
feat: sonata init chooses whether a config is project or machine level

The scope governs both the config path and the agents directory. That
pairing is the point: init in $HOME used to write agents into
~/.claude/agents, which Claude Code offers everywhere, and the config
into ~/sonata.toml, which only $HOME can read.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0119sDQT9AWqPyL87rHHtkFN
EOF
)"
```

---

### Task 3: `doctor` names the config it used

Runs concurrently with Tasks 2 and 4. Touches only `src/commands/doctor.ts` and `tests/commands/doctor.test.ts`.

**Files:**
- Modify: `src/commands/doctor.ts:37-53`
- Test: `tests/commands/doctor.test.ts`

**Interfaces:**
- Consumes: `configPath`, `GLOBAL_CONFIG_RELATIVE`, `loadConfig` from `../config.js` (Task 1).
- Produces: `cmdDoctor(opts: { cwd: string; home?: string })` — `home` optional, defaulting to `homedir()`.

- [ ] **Step 1: Write the failing test**

Append to `tests/commands/doctor.test.ts`:

```ts
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdDoctor } from '../../src/commands/doctor.js';

describe('cmdDoctor — which config', () => {
  const MINIMAL = `
[models."m"]
harness = "codex"
id = "gpt-5.6-sol"

[generate]
roles = ["code"]
models = ["m"]
`;
  let cwd: string;
  let home: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'doc-cwd-'));
    home = mkdtempSync(join(tmpdir(), 'doc-home-'));
  });

  const check = async (name: string) =>
    (await cmdDoctor({ cwd, home })).checks.find((c) => c.name === name);

  it('reports the machine config path when that is what it used', async () => {
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(join(home, '.config', 'sonata', 'sonata.toml'), MINIMAL);

    const c = await check('sonata.toml');
    expect(c?.ok).toBe(true);
    // With two possible sources, a model count alone cannot be debugged from.
    expect(c?.detail).toContain(join(home, '.config', 'sonata', 'sonata.toml'));
    expect(c?.detail).toContain('1 model');
  });

  it('reports the project config path when the repo has one', async () => {
    writeFileSync(join(cwd, 'sonata.toml'), MINIMAL);
    expect((await check('sonata.toml'))?.detail).toContain(join(cwd, 'sonata.toml'));
  });

  it('warns about a stray ~/sonata.toml, which nothing reads', async () => {
    writeFileSync(join(cwd, 'sonata.toml'), MINIMAL);
    writeFileSync(join(home, 'sonata.toml'), MINIMAL);

    const c = await check('stray config');
    expect(c?.ok).toBe(false);
    expect(c?.detail).toContain(join(home, 'sonata.toml'));
    expect(c?.detail).toContain('mv');
  });

  it('says nothing about a stray file when there is none', async () => {
    writeFileSync(join(cwd, 'sonata.toml'), MINIMAL);
    expect(await check('stray config')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/commands/doctor.test.ts -t "which config"`
Expected: FAIL — the detail is a bare model count with no path, and there is no `stray config` check.

- [ ] **Step 3: Write the implementation**

In `src/commands/doctor.ts`, add `configPath, GLOBAL_CONFIG_RELATIVE` to the `../config.js` import and `existsSync` from `node:fs`. Change the signature and the config block:

```ts
export async function cmdDoctor(
  opts: { cwd: string; home?: string },
): Promise<{ ok: boolean; checks: Check[] }> {
  const home = opts.home ?? homedir();
```

Replace lines 46-53 with:

```ts
  let config;
  const resolved = configPath(opts.cwd, home);
  try {
    config = loadConfig(opts.cwd, home);
    checks.push({
      name: 'sonata.toml',
      ok: true,
      detail: `${resolved} · ${Object.keys(config.models).length} models`,
    });
  } catch (err) {
    checks.push({ name: 'sonata.toml', ok: false, detail: (err as Error).message });
    return { ok: false, checks };
  }

  // `sonata init` run in $HOME used to write here, and nothing reads it. It
  // looks exactly like configuration, which is worse than not existing.
  const stray = join(home, 'sonata.toml');
  if (existsSync(stray) && resolved !== stray) {
    checks.push({
      name: 'stray config',
      ok: false,
      detail: `${stray} is not read by sonata — mv it to ${join(home, GLOBAL_CONFIG_RELATIVE)}`,
    });
  }
```

`homedir` and `join` are already imported in this file.

- [ ] **Step 4: Run the full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS. The pre-existing doctor test asserts on check names, not on the `sonata.toml` detail string; if it does assert the old bare count, update it to the new `path · N models` form.

- [ ] **Step 5: Commit**

```bash
git add src/commands/doctor.ts tests/commands/doctor.test.ts
git commit -m "$(cat <<'EOF'
feat: doctor reports which config file is in effect

With a project and a machine location, a model count alone no longer
says enough to debug from. It also flags a stray ~/sonata.toml, which
nothing reads but which looks exactly like configuration — the file a
`sonata init` in $HOME leaves behind.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0119sDQT9AWqPyL87rHHtkFN
EOF
)"
```

---

### Task 4: `sync` resolves the same way

Runs concurrently with Tasks 2 and 3. Touches only `src/commands/sync.ts` and `tests/commands/sync.test.ts`.

**Files:**
- Modify: `src/commands/sync.ts:70-74`
- Test: `tests/commands/sync.test.ts`

**Interfaces:**
- Consumes: `loadConfig(cwd, home?)` from `../config.js` (Task 1).
- Produces: `SyncOptions { cwd: string; agentsDir: string; home?: string }`.

- [ ] **Step 1: Write the failing test**

Append to `tests/commands/sync.test.ts`:

```ts
describe('cmdSync — machine config', () => {
  it('generates from the machine config when the repo has none', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'sync-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'sync-home-'));
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(join(home, '.config', 'sonata', 'sonata.toml'), `
[models."m"]
harness = "codex"
id = "gpt-5.6-sol"

[generate]
roles = ["code"]
models = ["m"]
`);

    const agentsDir = join(home, '.claude', 'agents');
    const written = cmdSync({ cwd, home, agentsDir });

    expect(written).toHaveLength(1);
    expect(existsSync(join(agentsDir, 'code-m.md'))).toBe(true);
  });
});
```

Add whatever of `mkdtempSync`, `mkdirSync`, `existsSync`, `tmpdir` the file does not already import.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/commands/sync.test.ts -t "machine config"`
Expected: FAIL — `cmdSync` ignores `home` and `loadConfig` looks only in `cwd`, so it throws "No sonata.toml found".

- [ ] **Step 3: Write the implementation**

In `src/commands/sync.ts`:

```ts
export interface SyncOptions { cwd: string; agentsDir: string; home?: string }

export function cmdSync(opts: SyncOptions): string[] {
  const config = loadConfig(opts.cwd, opts.home);
```

`loadConfig` defaults `home` to `homedir()` when it is undefined, so callers that do not pass it behave exactly as before.

- [ ] **Step 4: Run the full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/sync.ts tests/commands/sync.test.ts
git commit -m "$(cat <<'EOF'
feat: sync generates against the resolved config

sync loaded from the cwd only, so a machine-level config produced no
agents. It now resolves the same way loadConfig does.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0119sDQT9AWqPyL87rHHtkFN
EOF
)"
```

---

### Task 5: CLI flag and documentation

Runs last: it consumes the option types Tasks 2, 3 and 4 produce.

**Files:**
- Modify: `src/cli.ts:25-30` (usage), `src/cli.ts:45-70` (init), `src/cli.ts:155-166` (sync, doctor)
- Modify: `README.md`

**Interfaces:**
- Consumes: `InitOptions.configScope` (Task 2), `cmdDoctor({cwd, home})` (Task 3), `SyncOptions.home` (Task 4).
- Produces: nothing.

- [ ] **Step 1: Add the flag**

In the `init` command's `parseArgs` options object, add:

```ts
        'config-scope': { type: 'string' },
```

After the existing `--scope` validation, add:

```ts
    const configScope = values['config-scope'] as 'project' | 'global' | undefined;
    if (configScope && !['project', 'global'].includes(configScope)) {
      throw new Error(
        `sonata init: --config-scope must be project or global (got "${configScope}")`,
      );
    }
```

Pass `configScope` into the `cmdInit` call alongside `scope`.

- [ ] **Step 2: Thread `home` through sync and doctor**

```ts
    const written = cmdSync({
      cwd: process.cwd(),
      home: homedir(),
      agentsDir: join(process.cwd(), '.claude', 'agents'),
    });
```

```ts
    const { ok, checks } = await cmdDoctor({ cwd: process.cwd(), home: homedir() });
```

`homedir` is already imported in `cli.ts`.

- [ ] **Step 3: Update the usage text**

Replace the init flags block with:

```
  init flags (skip the prompts):
    --yes                    accept defaults, no prompts
    --providers opencode/openrouter,pi/opencode-go   providers to draw models from
    --models a,b             models to enable (config keys)
    --roles code,review      roles to generate
    --config-scope project|global   where the config and its agents go
    --scope project|global|skip   where to install the permission hook
```

- [ ] **Step 4: Verify by hand**

```bash
npx tsc --noEmit && npx vitest run
npx tsx src/cli.ts help | grep config-scope
npx tsx src/cli.ts init --yes --config-scope nonsense 2>&1 | head -2
```

Expected: the usage line appears, and the bad value is refused with the message above.

- [ ] **Step 5: Document both scopes in the README**

In the configuration section, after the `sonata.toml` example, add:

````markdown
### Where sonata.toml lives

Sonata looks for a config in two places, in order:

1. `./sonata.toml` — the current repository
2. `~/.config/sonata/sonata.toml` — the machine

A project config wins outright; it is not merged with the machine one. So a
repository with its own `sonata.toml` sees only that file, and adding one
repo-specific model means copying the machine entries alongside it.

`sonata init` asks which you want, and writes the agents to match — project
agents into `./.claude/agents/`, machine agents into `~/.claude/agents/`, where
Claude Code offers them in every repository. Use `--config-scope project|global`
to skip the prompt.

`sonata doctor` prints the config path it actually used.
````

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts README.md
git commit -m "$(cat <<'EOF'
feat: add --config-scope, and document the two config locations

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0119sDQT9AWqPyL87rHHtkFN
EOF
)"
```

---

### Task 6: Migrate this machine

Not code. Runs after Task 5, by hand.

- [ ] **Step 1: Confirm doctor flags the stray file**

```bash
cd ~/Documents/workspace/sonata && sonata doctor
```

Expected: a `stray config` line naming `~/sonata.toml` and the `mv` command.

- [ ] **Step 2: Move it**

```bash
mkdir -p ~/.config/sonata && mv ~/sonata.toml ~/.config/sonata/sonata.toml
```

- [ ] **Step 3: Verify a repo with no local config now resolves**

```bash
cd ~/Documents/workspace/insurance && sonata doctor
```

Expected: `ok sonata.toml: /Users/…/.config/sonata/sonata.toml · 8 models`, and no stray warning.

- [ ] **Step 4: Rebuild the global binary**

`sonata` on PATH runs `dist/`, not `src/`, so it will keep the old behaviour until rebuilt:

```bash
cd ~/Documents/workspace/sonata && npm run build
```

## Self-Review

**Spec coverage.** Two fixed locations, project first → Task 1. Local replaces global → Task 1 (`configPath` returns the local path and stops). `init` scope select governing both paths → Task 2. `--config-scope` → Task 5. `doctor` names the file → Task 3. Stray `~/sonata.toml` warning → Task 3. `~/.config/sonata/` created on write → Task 2 Step 5. `cmdSync` gains `home` → Task 4. Migration → Task 6. Tests listed in the spec map onto Tasks 1-4.

**Placeholders.** None. Every code step carries its code, every test step its test.

**Type consistency.** `ConfigScope` is defined once in Task 2 and used in Tasks 2 and 5. `configPath(cwd, home)` is defined in Task 1 and consumed in Tasks 2 and 3 with the same signature. `loadConfig(cwd, home?)` is defined in Task 1 and called with two arguments in Tasks 3 and 4. `SyncOptions.home` is added in Task 4 and passed in Tasks 2 and 5 — Task 2 Step 5 notes the ordering dependency explicitly and gives the fallback.

**Parallel safety.** Tasks 2, 3 and 4 modify `init.ts`, `doctor.ts` and `sync.ts` respectively, with tests in `tests/init.test.ts`, `tests/commands/doctor.test.ts` and `tests/commands/sync.test.ts`. No file appears in two of them. The only cross-task coupling is `cmdSync`'s `home` parameter, which Task 2 calls and Task 4 adds; Task 2 Step 5 handles either order.
